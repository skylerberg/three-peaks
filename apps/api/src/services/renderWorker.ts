import { sql } from 'kysely';
import { db } from '../db/index.ts';
import { CardRenderError, renderStoredCard } from './cardImages.ts';
import { CONTENT_COLUMNS, serializeContent } from './cardLayouts.ts';
import { publishAfterCommit } from './realtime/index.ts';
import { onRenderRequested } from './renderRequests.ts';
import { AppError } from '../utils/errors.ts';
import { logger } from '../utils/logger.ts';
import type { AppContext, AuthenticatedUser, Connection, PostCommitHook } from '../types/index.ts';

// Works through the cards whose picture was asked for (`renderRequests.ts`),
// on every API pod. A card is claimed for a lease rather than locked for the
// length of a render, so a pod that dies mid-card lets it go when the lease
// runs out, and the rest of the queue is never waiting on one card's lock.

const LEASE = '2 minutes';
// The poll is for requests made on other pods; this pod's own wake the worker
// as they commit.
const POLL_MS = 15_000;
// A failure that is not about the card -- storage or the database out from
// under it -- is retried with a growing pause, and after this many is recorded
// on the card like any other reason it cannot be drawn.
const MAX_ATTEMPTS = 5;
const RETRY_SECONDS = 30;

interface Claim {
  file_id: string;
  requested_at: Date;
  requested_by: string | null;
  attempts: number;
}

async function claim(): Promise<Claim | null> {
  const { rows } = await sql<Claim>`
    update card_content set
      render_claimed_until = now() + ${sql.lit(LEASE)}::interval,
      render_attempts = render_attempts + 1
    where file_id = (
      select file_id from card_content
      where render_requested_at is not null
        and render_error is null
        and (render_claimed_until is null or render_claimed_until < now())
      order by render_requested_at
      limit 1
      for update skip locked
    )
    returning file_id, render_requested_at as requested_at,
      render_requested_by as requested_by, render_attempts as attempts
  `.execute(db);
  return rows[0] ?? null;
}

// Whoever asked, or the project's owner when that account has since gone: a
// version is always by someone.
async function requester(claimed: Claim): Promise<AuthenticatedUser> {
  const user = await db
    .selectFrom('app_user')
    .select([
      'app_user.id as id',
      'app_user.email as email',
      'app_user.name as name',
      'app_user.email_verified as email_verified',
    ])
    .where((eb) =>
      claimed.requested_by === null
        ? eb(
            'app_user.id',
            '=',
            eb
              .selectFrom('card_content')
              .innerJoin('project', 'project.id', 'card_content.project_id')
              .select('project.created_by')
              .where('card_content.file_id', '=', claimed.file_id)
          )
        : eb('app_user.id', '=', claimed.requested_by)
    )
    .executeTakeFirstOrThrow();
  return user;
}

// The request is done with only if it is still the one this claim took: a
// newer one made during the render leaves the card asked for, and lets it go
// to be claimed again straight away. `error` is why it cannot be drawn, kept
// on the card until something about it changes; null is drawn and saved.
async function settle(connection: Connection, claimed: Claim, error: string | null) {
  const card = connection
    .updateTable('card_content')
    .where('card_content.file_id', '=', claimed.file_id);
  await card
    .set(
      error === null
        ? {
            render_requested_at: null,
            render_requested_by: null,
            render_claimed_until: null,
            render_attempts: 0,
          }
        : { render_claimed_until: null, render_error: error }
    )
    .where('card_content.render_requested_at', '=', claimed.requested_at)
    .execute();
  await card
    .set({ render_claimed_until: null })
    .where('card_content.render_requested_at', '<>', claimed.requested_at)
    .execute();
}

// Where the card stands now, to every screen showing its deck: drawn, or why
// it cannot be.
async function announce(
  connection: Connection,
  fileId: string,
  user: AuthenticatedUser,
  hooks: PostCommitHook[]
) {
  const row = await connection
    .selectFrom('card_content')
    .select(CONTENT_COLUMNS)
    .where('card_content.file_id', '=', fileId)
    .executeTakeFirst();
  if (!row) return;
  const content = serializeContent(row);
  publishAfterCommit(hooks, user.id, 'card_content_updated', content.project_id, {
    contents: [content],
  });
}

async function runHooks(hooks: readonly PostCommitHook[]) {
  for (const hook of hooks) {
    try {
      await hook();
    } catch (error) {
      logger.error('post-commit hook failed', { error });
    }
  }
}

// Why trying again cannot help, or null for a failure worth retrying: a card
// that cannot be drawn as it stands, or a refusal about its project, such as
// one over its storage, is about the card; the rest is storage or the
// database out from under it.
function lastingReason(error: unknown, attempts: number): string | null {
  if (error instanceof CardRenderError) return error.message;
  if (error instanceof AppError && error.statusCode < 500) return error.message;
  if (attempts >= MAX_ATTEMPTS) {
    return `The card could not be rendered: ${error instanceof Error ? error.message : String(error)}`;
  }
  return null;
}

async function work(claimed: Claim): Promise<void> {
  const hooks: PostCommitHook[] = [];
  let user: AuthenticatedUser | null = null;
  try {
    const by = await requester(claimed);
    user = by;
    await db.transaction().execute(async (trx) => {
      const variables = { db: trx, user: by, postCommitHooks: hooks };
      const c = {
        get: (key: keyof typeof variables) => variables[key],
      } as Pick<AppContext, 'get'>;
      await renderStoredCard(c, claimed.file_id);
      await settle(trx, claimed, null);
      await announce(trx, claimed.file_id, by, hooks);
    });
  } catch (error) {
    // The transaction rolled back, so nothing it queued to announce happened.
    hooks.length = 0;
    const reason = lastingReason(error, claimed.attempts);
    if (reason === null) {
      logger.error('card render failed', { error, fileId: claimed.file_id });
      await db
        .updateTable('card_content')
        .set({
          render_claimed_until: sql<Date>`now() + make_interval(secs => ${RETRY_SECONDS * claimed.attempts})`,
        })
        .where('card_content.file_id', '=', claimed.file_id)
        .execute();
      return;
    }
    await settle(db, claimed, reason);
    if (user !== null) await announce(db, claimed.file_id, user, hooks);
  }
  await runHooks(hooks);
}

// Every card there is to claim, one after another. What the loop runs, and
// what a test runs to see the renders a request led to.
export async function drainRenders(): Promise<number> {
  let rendered = 0;
  for (let claimed = await claim(); claimed !== null; claimed = await claim()) {
    await work(claimed);
    rendered++;
  }
  return rendered;
}

// Started with the server, never by importing the app: a test drives
// `drainRenders` itself. Returns the stop.
export function startRenderWorker(): () => Promise<void> {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let nudge: (() => void) | null = null;

  const loop = (async () => {
    while (!stopped) {
      try {
        await drainRenders();
      } catch (error) {
        logger.error('render queue failed', { error });
      }
      if (stopped) break;
      await new Promise<void>((resolve) => {
        nudge = resolve;
        timer = setTimeout(resolve, POLL_MS);
      });
      if (timer !== null) clearTimeout(timer);
      nudge = null;
    }
  })();

  onRenderRequested(() => nudge?.());
  return async () => {
    stopped = true;
    onRenderRequested(null);
    nudge?.();
    await loop;
  };
}
