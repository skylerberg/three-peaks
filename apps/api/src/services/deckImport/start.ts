import { AppError, isUniqueViolation } from '../../utils/errors.ts';
import { newId } from '../../utils/uuid.ts';
import type { ImportAccess } from '../authorization.ts';
import { publishAfterCommit } from '../realtime/index.ts';
import { assertNoOpenRun } from './binding.ts';
import { assertDeckLive, detachMovedCards, lockImportFiles, type Ctx } from './common.ts';
import {
  assertPlanWithinCap,
  orderedManifest,
  planPages,
  readLiveMapping,
  summarizePlan,
  type StartRunInput,
  type StartedRun,
} from './planning.ts';
import { readRun } from './runs.ts';

// Opening a run: plan the whole export, write a row per page, and answer with
// the plan so somebody can read it before a byte is uploaded.

export async function startRun(
  c: Ctx,
  access: ImportAccess,
  input: StartRunInput
): Promise<StartedRun> {
  const db = c.get('db');
  await assertDeckLive(db, access.deckId);
  await assertNoOpenRun(db, access.importId);

  const pages = orderedManifest(input.pages);
  await lockImportFiles(db, access.importId);
  // Before the mapping is read, so what the plan sees and what the partial
  // unique index constrains cannot disagree: a row whose file has left the
  // deck is invisible to matching while it still holds its key.
  await detachMovedCards(db, access.importId, access.deckId);

  const mapping = await readLiveMapping(db, access.importId, access.deckId);
  const planned = planPages(pages, mapping);
  await assertPlanWithinCap(db, access.deckId, mapping, planned);

  const id = input.id ?? newId();
  try {
    await db
      .insertInto('import_run')
      .values({
        id,
        import_id: access.importId,
        status: 'open',
        source_label: input.sourceLabel,
        page_count: pages.length,
        started_by: c.get('user').id,
      })
      .execute();
  } catch (error) {
    // Either the client-supplied id or the one-open-run index. The pre-check
    // above cannot cover the second: two starts can pass it together.
    if (isUniqueViolation(error)) {
      throw new AppError(409, 'That run id is taken, or a run is already open for this deck');
    }
    throw error;
  }

  await db
    .insertInto('import_run_page')
    .values(
      planned.map((page) => ({
        id: newId(),
        run_id: id,
        page_number: page.pageNumber,
        card_id: page.cardId,
        matched_by: page.matchedBy,
        identity_key: page.identityKey,
        source_page_id: page.sourcePageId,
      }))
    )
    .execute();

  const run = await readRun(c, id);
  publishAfterCommit(
    c.get('postCommitHooks'),
    c.get('user').id,
    'deck_import_started',
    access.projectId,
    {
      deck_id: access.deckId,
      run,
    }
  );
  return { ...run, plan: summarizePlan(planned, mapping) };
}
