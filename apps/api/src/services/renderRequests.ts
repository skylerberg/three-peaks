import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely';
import type { DB } from '../db/types.ts';
import type { AppContext } from '../types/index.ts';

// Asking for laid-out cards to be drawn again, in the transaction of whatever
// made them stale. Nothing here draws: the background renderer works through
// what is asked for once it has committed (`renderWorker.ts`), and a card that
// changes again before then is simply asked for again.
//
// Kept free of the file and rendering services so that `appendFileVersion`,
// the one writer of a new version, can ask for the cards that draw the file.

type Where = (eb: ExpressionBuilder<DB, 'card_content'>) => Expression<SqlBool>;

let wake: (() => void) | null = null;

// The worker on this pod listens, so a request made here is picked up as soon
// as it commits rather than at the next poll.
export function onRenderRequested(listener: (() => void) | null): void {
  wake = listener;
}

async function request(c: Pick<AppContext, 'get'>, where: Where): Promise<number> {
  const result = await c
    .get('db')
    .updateTable('card_content')
    .set({
      // Milliseconds, so the time survives the round trip through a JavaScript
      // Date and a finished render can tell whether it is still the latest ask.
      render_requested_at: sql<Date>`date_trunc('milliseconds', now())`,
      render_requested_by: c.get('user').id,
      render_attempts: 0,
      render_error: null,
    })
    .where(where)
    .executeTakeFirst();
  const count = Number(result.numUpdatedRows);
  if (count > 0) c.get('postCommitHooks').push(() => wake?.());
  return count;
}

export function requestLayoutRenders(c: Pick<AppContext, 'get'>, layoutId: string) {
  return request(c, (eb) => eb('card_content.layout_id', '=', layoutId));
}

// Every card of a deck drawn from a layout, or only the ones named -- at least
// one, since `in ()` is not SQL.
export function requestDeckRenders(
  c: Pick<AppContext, 'get'>,
  deckId: string,
  fileIds?: readonly string[]
) {
  return request(c, (eb) =>
    eb.and([
      eb(
        'card_content.file_id',
        'in',
        eb.selectFrom('file').select('file.id').where('file.deck_id', '=', deckId)
      ),
      ...(fileIds === undefined ? [] : [eb('card_content.file_id', 'in', fileIds)]),
    ])
  );
}

export function requestCardRender(c: Pick<AppContext, 'get'>, fileId: string) {
  return request(c, (eb) => eb('card_content.file_id', '=', fileId));
}

// The cards that draw `fileId`: through their layout, as a font, an icon or a
// fixed picture, or through one of their own image fields. A layout and a
// card's fields hold file ids only as whole string values, so matching any
// value equal to the id finds each of those without naming where they sit.
export function requestRendersOfFile(
  c: Pick<AppContext, 'get'>,
  projectId: string,
  fileId: string
) {
  const names = sql<boolean>`jsonb_path_exists(card_layout.spec, '$.** ? (@ == $id)', jsonb_build_object('id', ${fileId}::text))`;
  const drawsIt = sql<boolean>`jsonb_path_exists(card_content.fields, '$.* ? (@ == $id)', jsonb_build_object('id', ${fileId}::text))`;
  return request(c, (eb) =>
    eb.and([
      eb('card_content.project_id', '=', projectId),
      eb.or([
        eb(
          'card_content.layout_id',
          'in',
          eb
            .selectFrom('card_layout')
            .select('card_layout.id')
            .where('card_layout.project_id', '=', projectId)
            .where(names)
        ),
        drawsIt,
      ]),
    ])
  );
}
