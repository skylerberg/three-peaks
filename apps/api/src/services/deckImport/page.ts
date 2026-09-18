import type { Readable } from 'node:stream';
import {
  ALLOWED_IMAGE_TYPES,
  MAX_UPLOAD_BYTES,
  deckPageFilename,
  extensionForImageType,
  isDeckBackTitle,
} from '@three-peaks/shared';
import { AppError, isUniqueViolation } from '../../utils/errors.ts';
import { newId } from '../../utils/uuid.ts';
import type { ImportRunAccess } from '../authorization.ts';
import {
  appendFileVersion,
  assertQuota,
  assertUploadSize,
  fileWithUsage,
  freeFilename,
  restoreFile,
  serializeVersion,
  storeUpload,
  type StoredUpload,
} from '../files.ts';
import { publishAfterCommit } from '../realtime/index.ts';
import { deleteStoredObjectsAfterCommit, reclaim } from '../storage/index.ts';
import {
  createCard,
  deckHome,
  lockPlannedCard,
  nameForCard,
  placeCardInDeck,
  renamedTo,
  type CardFile,
  type OpenRun,
} from './card.ts';
import { assertDeckLive, assertOpenRun, type Ctx } from './common.ts';
import type { Connection } from '../../types/index.ts';

// One page: one request, one transaction, one image. A run that dies half way
// therefore leaves every page that landed durably imported, and re-posting one
// answers with what happened the first time.
//
// Nothing here matches anything. Which card this page becomes was settled when
// the run started, so all this does is read the row that says so -- which is
// what leaves arrival order with nothing to decide.

export interface ImportPageInput {
  pageNumber: number;
  title: string | null;
  body: Readable;
  declaredContentType: string;
  declaredLength: number;
}

interface ImportPageResult {
  page_number: number;
  outcome: string;
  matched_by: string | null;
  restored: boolean;
  replayed: boolean;
  file_id: string | null;
  file_version_number: number | null;
  name: string;
}

export interface ImportPageOutcome {
  result: ImportPageResult;
  // Whether a file row or a version row came out of this request, which is the
  // difference between a 201 and a 200.
  created: boolean;
}

interface Memo {
  page_number: number;
  outcome: string;
  matched_by: string | null;
  restored: boolean;
  name: string;
  file_version_number: number | null;
  file_id: string | null;
}

async function readMemo(
  db: Connection,
  runId: string,
  pageNumber: number
): Promise<Memo | undefined> {
  const row = await db
    .selectFrom('import_run_card')
    .leftJoin('deck_import_card', 'deck_import_card.id', 'import_run_card.import_card_id')
    .select([
      'import_run_card.outcome as outcome',
      'import_run_card.matched_by as matched_by',
      'import_run_card.restored as restored',
      'import_run_card.name as name',
      'import_run_card.file_version_number as file_version_number',
      'deck_import_card.file_id as file_id',
    ])
    .where('import_run_card.run_id', '=', runId)
    .where('import_run_card.page_number', '=', pageNumber)
    .executeTakeFirst();
  return row === undefined ? undefined : { ...row, page_number: pageNumber };
}

// What happened the first time, and nothing worked out a second time: a retry
// of a page that landed as a restore would otherwise find nothing left to
// restore and overwrite the row that says it did.
function replayResult(memo: Memo): ImportPageResult {
  return {
    page_number: memo.page_number,
    outcome: memo.outcome,
    matched_by: memo.matched_by,
    restored: memo.restored,
    replayed: true,
    file_id: memo.file_id,
    file_version_number: memo.file_version_number,
    name: memo.name,
  };
}

interface PlannedCard {
  card_id: string;
  matched_by: string | null;
  identity_key: string;
  source_page_id: string | null;
}

async function readPlannedPage(
  db: Connection,
  runId: string,
  pageNumber: number
): Promise<PlannedCard | undefined> {
  return await db
    .selectFrom('import_run_page')
    .select([
      'import_run_page.card_id as card_id',
      'import_run_page.matched_by as matched_by',
      'import_run_page.identity_key as identity_key',
      'import_run_page.source_page_id as source_page_id',
    ])
    .where('import_run_page.run_id', '=', runId)
    .where('import_run_page.page_number', '=', pageNumber)
    .executeTakeFirst();
}

/**
 * Imports one page: one request, one transaction, one image.
 *
 * A run that dies half way therefore leaves every page that landed durably
 * imported, and re-posting one answers with what happened the first time.
 */
export async function importPage(
  c: Ctx,
  access: ImportRunAccess,
  input: ImportPageInput
): Promise<ImportPageOutcome> {
  const db = c.get('db');

  // Every refusal that can be made before a byte moves is made here.
  const declared = await db
    .selectFrom('import_run')
    .select(['import_run.status as status', 'import_run.page_count as page_count'])
    .where('import_run.id', '=', access.runId)
    .executeTakeFirstOrThrow();
  assertOpenRun(declared.status);

  // Which card this page becomes was settled when the run started, so all this
  // does is read the row that says so. A page the plan never named is not one
  // this run can take.
  const planned = await readPlannedPage(db, access.runId, input.pageNumber);
  if (!planned) {
    throw new AppError(
      409,
      `This run planned ${declared.page_count} pages, and page ${input.pageNumber} is not one of them`
    );
  }

  await assertDeckLive(db, access.deckId);

  assertUploadSize(input.declaredLength);
  if (input.declaredLength > 0) await assertQuota(c, access.projectId, input.declaredLength);

  const stored = await storeUpload(input.body, MAX_UPLOAD_BYTES, input.declaredContentType);
  const run: OpenRun = {
    runId: access.runId,
    importId: access.importId,
    deckId: access.deckId,
    projectId: access.projectId,
  };

  try {
    return await landPage(c, run, input, stored, planned);
  } catch (error) {
    await reclaim(stored.storageKey);
    throw error;
  }
}

async function landPage(
  c: Ctx,
  run: OpenRun,
  input: ImportPageInput,
  stored: StoredUpload,
  planned: PlannedCard
): Promise<ImportPageOutcome> {
  const db = c.get('db');
  await assertQuota(c, run.projectId, stored.byteSize);

  // storeUpload calls anything unrecognised an octet stream. Without this gate
  // that becomes a card every screen downstream tries to draw.
  if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(stored.contentType)) {
    throw new AppError(422, 'That page is not an image');
  }

  // Taken now that no network transfer is left to hold it, and it is what
  // serialises the pages of one import against each other and against its
  // finish.
  const locked = await db
    .selectFrom('import_run')
    .select(['import_run.status as status'])
    .where('import_run.id', '=', run.runId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  // A finish that was queued ahead of this page closed the run while it waited.
  assertOpenRun(locked.status);

  const memo = await readMemo(db, run.runId, input.pageNumber);
  if (memo) {
    // The bytes just stored are an orphan; the answer belongs to the ledger.
    deleteStoredObjectsAfterCommit(c.get('postCommitHooks'), [stored.storageKey]);
    return { result: replayResult(memo), created: false };
  }

  // The title decides what the card is called; which card it is was settled
  // when the run started.
  const derivedName = deckPageFilename(
    input.pageNumber,
    input.title,
    extensionForImageType(stored.contentType)
  );

  const matched = await lockPlannedCard(db, planned.card_id);
  let file: CardFile;
  let createdFile = false;
  if (matched) {
    file = matched;
  } else {
    file = await createCard(c, run, {
      cardId: planned.card_id,
      identityKey: planned.identity_key,
      sourcePageId: planned.source_page_id,
      pageNumber: input.pageNumber,
      derivedName,
      stored,
    });
    createdFile = true;
  }

  // Before the append, not after: appendFileVersion refuses a tombstone, and it
  // is the only writer, so there is no way round it.
  let restored = false;
  if (file.deleted_at !== null) {
    const wanted = nameForCard(file, derivedName);
    const filename = await freeFilename(db, run.projectId, deckHome(run.deckId), wanted);
    await restoreFile(c, file.id, { filename, lockName: false, notify: false });
    file = { ...file, filename, deleted_at: null };
    restored = true;
  }

  const appended = await appendFileVersion(c, file.id, {
    storageKey: stored.storageKey,
    contentType: stored.contentType,
    byteSize: stored.byteSize,
    checksum: stored.checksum,
  });

  // The moment its bytes land, not at finish. The file is in the deck either
  // way now, and artwork a deck holds with no place in its arrangement is the
  // one state owning it is meant not to have -- which an abandoned run would
  // otherwise leave behind for every page that got through.
  await placeCardInDeck(db, run.deckId, planned.card_id, file.id, isDeckBackTitle(input.title));

  const previousName = file.filename;
  const finalName = createdFile
    ? previousName
    : await renamedTo(db, run, file, input.title, derivedName);

  const outcome =
    createdFile || restored
      ? 'added'
      : !appended.created && finalName === previousName
        ? 'unchanged'
        : 'updated';
  // Null whatever the plan said when the card had to be created after all: the
  // plan can name a card a purge has taken away since.
  const matchedBy = matched ? planned.matched_by : null;

  await db
    .insertInto('import_run_card')
    .values({
      id: newId(),
      run_id: run.runId,
      import_card_id: planned.card_id,
      outcome,
      matched_by: matchedBy,
      restored,
      page_number: input.pageNumber,
      name: finalName,
      file_version_number: appended.version.version_number,
    })
    .execute();

  // The last statement of the handler on purpose: a caught 23505 leaves the
  // transaction aborted, so nothing may follow it. Rolling the page back whole
  // is what makes the 409 worth retrying.
  if (finalName !== previousName) {
    try {
      await db
        .updateTable('file')
        .set({ filename: finalName, updated_at: new Date() })
        .where('file.id', '=', file.id)
        .execute();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError(409, 'A file with that name already exists here');
      }
      throw error;
    }
  }

  // One event per page, whatever combination of create, restore, version and
  // rename this page turned out to be.
  if (createdFile) {
    publishAfterCommit(
      c.get('postCommitHooks'),
      c.get('user').id,
      'file_uploaded',
      run.projectId,
      await fileWithUsage(c, run.projectId, file.id)
    );
  } else if (appended.created) {
    const { storage_used_bytes: used, ...row } = await fileWithUsage(c, run.projectId, file.id);
    publishAfterCommit(
      c.get('postCommitHooks'),
      c.get('user').id,
      'file_version_created',
      run.projectId,
      {
        version: serializeVersion(appended.version, appended.version.version_number),
        file: row,
        storage_used_bytes: used,
      }
    );
  } else if (restored || finalName !== previousName) {
    const { storage_used_bytes: _used, ...row } = await fileWithUsage(c, run.projectId, file.id);
    publishAfterCommit(
      c.get('postCommitHooks'),
      c.get('user').id,
      'file_updated',
      run.projectId,
      row
    );
  }

  return {
    result: {
      page_number: input.pageNumber,
      outcome,
      matched_by: matchedBy,
      restored,
      replayed: false,
      file_id: file.id,
      file_version_number: appended.version.version_number,
      name: finalName,
    },
    created: createdFile || appended.created,
  };
}
