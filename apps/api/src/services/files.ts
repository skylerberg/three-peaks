import { createHash } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { sql } from 'kysely';
import {
  MAX_UPLOAD_BYTES,
  PROJECT_STORAGE_QUOTA_BYTES,
  uploadTooLargeMessage,
} from '@three-peaks/shared';
import { AppError, isUniqueViolation } from '../utils/errors.ts';
import { newId } from '../utils/uuid.ts';
import { type FileHome, deletedOwner, homeFilter, parseHome } from './fileHome.ts';
import { blockedMessage } from './folderTree.ts';
import { SNIFF_BYTES, sniffContentType } from './imageSniff.ts';
import { publishAfterCommit } from './realtime/index.ts';
import { requestCardRender, requestRendersOfFile } from './renderRequests.ts';
import { deleteStoredObjectsAfterCommit, storage } from './storage/index.ts';
import type { AppContext, Connection } from '../types/index.ts';

export interface FileRow {
  id: string;
  project_id: string;
  folder_id: string | null;
  deck_id: string | null;
  component_id: string | null;
  component_role: string | null;
  filename: string;
  content_type: string;
  byte_size: string | number;
  checksum: string | null;
  image_width: number | null;
  image_height: number | null;
  name_locked: boolean;
  uploaded_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
}

export function serializeFile(row: FileRow) {
  return {
    id: row.id,
    project_id: row.project_id,
    folder_id: row.folder_id,
    deck_id: row.deck_id,
    component_id: row.component_id,
    component_role: row.component_role,
    filename: row.filename,
    content_type: row.content_type,
    // bigint arrives as a string from pg; the wire type is a number.
    byte_size: Number(row.byte_size),
    checksum: row.checksum,
    image_width: row.image_width,
    image_height: row.image_height,
    name_locked: row.name_locked,
    uploaded_by: row.uploaded_by,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    deleted_at: row.deleted_at === null ? null : new Date(row.deleted_at).toISOString(),
  };
}

export const FILE_COLUMNS = [
  'file.id as id',
  'file.project_id as project_id',
  'file.folder_id as folder_id',
  'file.deck_id as deck_id',
  'file.component_id as component_id',
  'file.component_role as component_role',
  'file.filename as filename',
  'file.content_type as content_type',
  'file.byte_size as byte_size',
  'file.checksum as checksum',
  'file.image_width as image_width',
  'file.image_height as image_height',
  'file.name_locked as name_locked',
  'file.uploaded_by as uploaded_by',
  'file.created_at as created_at',
  'file.updated_at as updated_at',
  'file.deleted_at as deleted_at',
] as const;

// The file row plus the project total, which is what every event about a file's
// bytes carries: a row on its own cannot move the explorer's storage meter.
export async function fileWithUsage(
  c: Pick<AppContext, 'get'>,
  projectId: string,
  fileId: string
): Promise<ReturnType<typeof serializeFile> & { storage_used_bytes: number }> {
  const [row, used] = await Promise.all([
    c
      .get('db')
      .selectFrom('file')
      .select(FILE_COLUMNS)
      .where('file.id', '=', fileId)
      .executeTakeFirstOrThrow(),
    projectStorageUsed(c, projectId),
  ]);
  return { ...serializeFile(row), storage_used_bytes: used };
}

export async function projectStorageUsed(
  c: Pick<AppContext, 'get'>,
  projectId: string
): Promise<number> {
  const db = c.get('db');
  const row = await db
    .selectFrom('file_version')
    .innerJoin('file', 'file.id', 'file_version.file_id')
    .select((eb) =>
      eb.fn.coalesce(eb.fn.sum<string>('file_version.byte_size'), eb.lit(0)).as('total')
    )
    .where('file.project_id', '=', projectId)
    .executeTakeFirst();
  return Number(row?.total ?? 0);
}

// Refuses an oversized body on what the request claims, before a byte of it is
// read. The cap below is the gate that counts, but it can only trip partway
// through a transfer already paid for and can no longer say how big the file
// actually was — so the claim is worth answering when it is this far out.
export function assertUploadSize(declaredLength: number): void {
  if (declaredLength > MAX_UPLOAD_BYTES) {
    throw new AppError(413, uploadTooLargeMessage(MAX_UPLOAD_BYTES, declaredLength));
  }
}

export async function assertQuota(
  c: Pick<AppContext, 'get'>,
  projectId: string,
  incomingBytes: number
): Promise<void> {
  const used = await projectStorageUsed(c, projectId);
  if (used + incomingBytes > PROJECT_STORAGE_QUOTA_BYTES) {
    throw new AppError(413, 'Project storage quota exceeded', {
      used_bytes: used,
      quota_bytes: PROJECT_STORAGE_QUOTA_BYTES,
    });
  }
}

export interface StoredUpload {
  storageKey: string;
  byteSize: number;
  contentType: string;
  checksum: string;
}

// Streams to storage, capping as it goes. Never buffers the whole body: the cap
// exists precisely because the body can be larger than memory, so a check that
// requires reading it first is not a check.
export async function storeUpload(
  body: Readable,
  maxBytes: number,
  declaredContentType: string
): Promise<StoredUpload> {
  const storageKey = newId();
  const provider = storage();

  let byteSize = 0;
  const digest = createHash('sha256');
  const head: Buffer[] = [];
  let headLength = 0;
  let overflowed = false;

  const counted = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      byteSize += chunk.length;
      if (byteSize > maxBytes) {
        overflowed = true;
        callback(new AppError(413, uploadTooLargeMessage(maxBytes)));
        return;
      }
      if (headLength < SNIFF_BYTES) {
        head.push(chunk.subarray(0, SNIFF_BYTES - headLength));
        headLength += Math.min(chunk.length, SNIFF_BYTES - headLength);
      }
      // After the cap, so bytes that were refused never reach the hash.
      digest.update(chunk);
      callback(null, chunk);
    },
  });

  // The consumer attaches its own error handler, but not necessarily in this
  // tick: diskStorage awaits a mkdir before its pipeline, and a cap that trips
  // in the gap leaves the refusal on a stream nothing is listening to — an
  // uncaught exception, and with no process handler installed, the server gone.
  // The put still rejects, and `overflowed` is what tells the catch below which
  // rejection it is.
  counted.on('error', () => {});
  body.pipe(counted);

  try {
    // The content type written to storage is provisional; the sniffed answer
    // below is what the row records and what any later download serves.
    await provider.putStream(storageKey, counted, declaredContentType);
  } catch (error) {
    // A refused or failed upload can still have written bytes. Reclaim them,
    // and swallow any error doing so — a cleanup failure must not replace the
    // real response with a confusing one.
    await provider.delete(storageKey).catch(() => {});
    if (overflowed) throw new AppError(413, uploadTooLargeMessage(maxBytes));
    throw error;
  }

  const sniffed = sniffContentType(Buffer.concat(head));
  return {
    storageKey,
    byteSize,
    checksum: digest.digest('hex'),
    // Anything unrecognised is stored as an opaque stream regardless of what it
    // claimed. Serving a client-declared type back is how a stored .html
    // becomes XSS.
    contentType: sniffed ?? 'application/octet-stream',
  };
}

interface VersionCandidate {
  storageKey: string;
  contentType: string;
  byteSize: number;
  checksum: string | null;
  imageWidth?: number | null;
  imageHeight?: number | null;
}

interface FileVersionRow {
  id: string;
  file_id: string;
  version_number: number;
  storage_key: string;
  content_type: string;
  byte_size: string;
  checksum: string | null;
  image_width: number | null;
  image_height: number | null;
  created_by: string;
  created_at: Date;
}

// A new version is always the current one at the moment it is written, so the
// import path passes its own number; the versions route passes the file's.
export function serializeVersion(
  row: {
    file_id: string;
    version_number: number;
    content_type: string;
    byte_size: string | number;
    checksum: string | null;
    image_width: number | null;
    image_height: number | null;
    created_by: string;
    created_at: Date | string;
  },
  currentNumber: number
) {
  return {
    file_id: row.file_id,
    version_number: row.version_number,
    content_type: row.content_type,
    byte_size: Number(row.byte_size),
    checksum: row.checksum,
    image_width: row.image_width,
    image_height: row.image_height,
    created_by: row.created_by,
    created_at: new Date(row.created_at).toISOString(),
    is_current: row.version_number === currentNumber,
  };
}

interface AppendResult {
  created: boolean;
  version: FileVersionRow;
}

const VERSION_COLUMNS = [
  'file_version.id as id',
  'file_version.file_id as file_id',
  'file_version.version_number as version_number',
  'file_version.storage_key as storage_key',
  'file_version.content_type as content_type',
  'file_version.byte_size as byte_size',
  'file_version.checksum as checksum',
  'file_version.image_width as image_width',
  'file_version.image_height as image_height',
  'file_version.created_by as created_by',
  'file_version.created_at as created_at',
] as const;

// A null checksum is unknown, not empty, so two unknowns are never equal.
//
// The branch this answers reclaims candidate.storageKey and never the current
// version's, so what keeps it safe is the precondition documented below: the
// candidate names a freshly written object nothing else references. The one way
// a live object could reach it is a caller handing over the key the file row
// already points at, and the storage_key comparison on the adoption further
// down is what stops that key from becoming the version this then deduplicates
// away.
function sameBytes(current: { checksum: string | null }, candidate: VersionCandidate): boolean {
  return current.checksum !== null && current.checksum === candidate.checksum;
}

/**
 * Appends `candidate` to a file's history and re-points the mirror columns on
 * `file` at it. Every `file_version` row is written here, and so is every change
 * to the mirror bar the initial values `/upload` gives the row it creates.
 *
 * Runs on `c.get('db')` and opens no transaction of its own, so it must be
 * called from a method `transactionMiddleware` wraps — on a GET it would run
 * against the pool and the insert and the mirror update would not be atomic.
 *
 * `candidate.storageKey` must name a freshly written object nothing else
 * references: when the bytes turn out to be identical to the current version's
 * this reclaims that object.
 */
export async function appendFileVersion(
  c: Pick<AppContext, 'get'>,
  fileId: string,
  candidate: VersionCandidate
): Promise<AppendResult> {
  const db = c.get('db');

  // Held for the rest of the transaction, which is what makes
  // max(version_number) + 1 safe: without it two appends read the same number
  // and the second one dies on file_version_unique_number.
  const file = await db
    .selectFrom('file')
    .select([
      'file.storage_key as storage_key',
      'file.content_type as content_type',
      'file.byte_size as byte_size',
      'file.checksum as checksum',
      'file.image_width as image_width',
      'file.image_height as image_height',
      'file.uploaded_by as uploaded_by',
      'file.created_at as created_at',
      'file.deleted_at as deleted_at',
      'file.project_id as project_id',
    ])
    .where('file.id', '=', fileId)
    .forUpdate()
    .executeTakeFirst();

  // Gone by the time the lock was granted, which is what a delete that was
  // already waiting on it looks like from here. The row the caller resolved
  // access against no longer exists, so this is a 404 rather than a 500.
  if (!file) throw new AppError(404, 'File not found');

  // Refused here rather than in the routes, because this is the only writer:
  // one check covers the upload, the append, the version restore and every
  // import path that will ever reach them.
  if (file.deleted_at !== null) {
    throw new AppError(409, 'That file is deleted. Restore it before adding a version.');
  }

  let current = await db
    .selectFrom('file_version')
    .select(VERSION_COLUMNS)
    .where('file_version.file_id', '=', fileId)
    .orderBy('file_version.version_number', 'desc')
    .limit(1)
    .executeTakeFirst();

  // A file uploaded by a pod running the release before this table existed has
  // bytes and no version row. Adopt the mirror as version 1 before appending,
  // or this append overwrites the only reference to that object. The key
  // comparison is what tells such a row apart from the one /upload inserted
  // moments ago in this same transaction.
  if (!current && file.storage_key !== candidate.storageKey) {
    current = await db
      .insertInto('file_version')
      .values({
        id: newId(),
        file_id: fileId,
        version_number: 1,
        storage_key: file.storage_key,
        content_type: file.content_type,
        byte_size: file.byte_size,
        checksum: file.checksum,
        image_width: file.image_width,
        image_height: file.image_height,
        created_by: file.uploaded_by,
        created_at: file.created_at,
      })
      .returning(VERSION_COLUMNS)
      .executeTakeFirstOrThrow();
  }

  if (current && sameBytes(current, candidate)) {
    deleteStoredObjectsAfterCommit(c.get('postCommitHooks'), [candidate.storageKey]);
    return { created: false, version: current };
  }

  const inserted = await db
    .insertInto('file_version')
    .values({
      id: newId(),
      file_id: fileId,
      version_number: (current?.version_number ?? 0) + 1,
      storage_key: candidate.storageKey,
      content_type: candidate.contentType,
      byte_size: String(candidate.byteSize),
      checksum: candidate.checksum,
      image_width: candidate.imageWidth ?? null,
      image_height: candidate.imageHeight ?? null,
      created_by: c.get('user').id,
    })
    .returning(VERSION_COLUMNS)
    .executeTakeFirstOrThrow();

  await db
    .updateTable('file')
    .set({
      storage_key: candidate.storageKey,
      content_type: candidate.contentType,
      byte_size: String(candidate.byteSize),
      checksum: candidate.checksum,
      image_width: candidate.imageWidth ?? null,
      image_height: candidate.imageHeight ?? null,
      updated_at: new Date(),
    })
    .where('file.id', '=', fileId)
    .execute();

  // Every laid-out card drawing this file -- as a font, an icon, a frame or its
  // own art -- now draws the new version, so its image is asked for again.
  await requestRendersOfFile(c, file.project_id, fileId);

  return { created: true, version: inserted };
}

/**
 * Brings a tombstoned file back, optionally under a different name because the
 * old one may have been taken while it was gone. Renaming first would leave a
 * window in which the tombstone still held it.
 *
 * `lockName` says the name came from a person, so `name_locked` is set. It is
 * never cleared here: a false only means this caller chose the name itself, not
 * that whoever typed the last one has changed their mind.
 *
 * `notify` is off for a caller that announces the whole operation itself -- an
 * import page is one event whatever combination of restore, version and rename
 * it turned out to be, and a second event per page is what a five-hundred page
 * run would multiply.
 *
 * Runs on `c.get('db')` like the append above, so it must be called from a
 * method transactionMiddleware wraps.
 */
export async function restoreFile(
  c: Pick<AppContext, 'get'>,
  fileId: string,
  opts: { filename?: string; lockName: boolean; notify?: boolean }
): Promise<ReturnType<typeof serializeFile>> {
  const db = c.get('db');

  const file = await db
    .selectFrom('file')
    .select(FILE_COLUMNS)
    .where('file.id', '=', fileId)
    .forUpdate()
    .executeTakeFirst();
  if (!file) throw new AppError(404, 'File not found');
  if (file.deleted_at === null) return serializeFile(file);

  // Nothing is auto-restored on the way up: un-deleting the folder, deck or
  // component somebody else deleted, without being asked to, is not this
  // route's decision.
  const home = parseHome(file);
  const blocked = await deletedOwner(db, home);
  if (blocked !== null) throw new AppError(409, blockedMessage(blocked, 'That file'));

  const filename = opts.filename ?? file.filename;
  const taken = await db
    .selectFrom('file')
    .select(['file.id as id'])
    .where('file.project_id', '=', file.project_id)
    .where('file.deleted_at', 'is', null)
    .where(homeFilter(home))
    .where(sql<boolean>`lower(file.filename) = lower(${filename})`)
    .executeTakeFirst();
  if (taken) throw new AppError(409, `A file named "${filename}" is already there`);

  try {
    const row = await db
      .updateTable('file')
      .set({
        filename,
        deleted_at: null,
        deleted_by: null,
        ...(opts.lockName ? { name_locked: true } : {}),
        updated_at: new Date(),
      })
      .where('file.id', '=', fileId)
      .returning(FILE_COLUMNS)
      .executeTakeFirstOrThrow();
    // A laid-out card may have fallen behind its layout while it was gone.
    await requestCardRender(c, fileId);
    const restored = serializeFile(row);
    if (opts.notify !== false) {
      publishAfterCommit(
        c.get('postCommitHooks'),
        c.get('user').id,
        'file_updated',
        file.project_id,
        restored
      );
    }
    return restored;
  } catch (error) {
    // Two restores of one file can pass the pre-check at once. The partial
    // name index is what refuses the second.
    if (isUniqueViolation(error)) {
      throw new AppError(409, `A file named "${filename}" is already there`);
    }
    throw error;
  }
}

/**
 * Every stored object belonging to one owner, with its files locked in id order
 * first -- the order every bulk file lock in the repo takes, so a purge and an
 * import wait on each other rather than deadlocking.
 *
 * Every version's key, not just the mirror's: the mirror names one object out
 * of N and the rest would be left in the bucket with nothing pointing at them.
 * The mirror key stays in the set as well, for a file written before
 * file_version existed and so having no row of its own.
 */
export async function ownedStorageKeys(
  db: Connection,
  owner: { deckId: string } | { componentId: string }
): Promise<string[]> {
  const locked = await db
    .selectFrom('file')
    .select(['file.id as id'])
    .$if('deckId' in owner, (qb) =>
      qb.where('file.deck_id', '=', (owner as { deckId: string }).deckId)
    )
    .$if('componentId' in owner, (qb) =>
      qb.where('file.component_id', '=', (owner as { componentId: string }).componentId)
    )
    .forUpdate()
    .orderBy('file.id')
    .execute();

  const fileIds = locked.map((row) => row.id);
  if (fileIds.length === 0) return [];

  const rows = await db
    .selectFrom('file')
    .leftJoin('file_version', 'file_version.file_id', 'file.id')
    .select(['file.storage_key as storage_key', 'file_version.storage_key as version_storage_key'])
    .where('file.id', 'in', fileIds)
    .execute();

  const keys = new Set<string>();
  for (const row of rows) {
    keys.add(row.storage_key);
    if (row.version_storage_key !== null) keys.add(row.version_storage_key);
  }
  return [...keys];
}

// The suffix a taken name is retried under, and the point past which retrying
// is not the answer to anything.
const MAX_NAME_SUFFIX = 999;

/**
 * The nearest free name to `desired` in one directory: itself, or itself under
 * a " (2)" suffix placed before the extension.
 *
 * A pre-check rather than an insert retried on 23505, because a caught unique
 * violation leaves the transaction aborted and there is no savepoint to come
 * back to. The partial name indexes are still what decide a race, in the catch
 * that follows the write this feeds.
 */
export async function freeFilename(
  db: Connection,
  projectId: string,
  home: FileHome,
  desired: string
): Promise<string> {
  const rows = await db
    .selectFrom('file')
    .select(['file.filename as filename'])
    .where('file.project_id', '=', projectId)
    .where('file.deleted_at', 'is', null)
    .where(homeFilter(home))
    .execute();

  // Names are compared case-insensitively, the way the unique indexes do it.
  const taken = new Set(rows.map((row) => row.filename.toLowerCase()));
  if (!taken.has(desired.toLowerCase())) return desired;

  // A leading dot is the whole name, not an extension.
  const dot = desired.lastIndexOf('.');
  const stem = dot > 0 ? desired.slice(0, dot) : desired;
  const extension = dot > 0 ? desired.slice(dot) : '';
  for (let suffix = 2; suffix <= MAX_NAME_SUFFIX; suffix += 1) {
    const candidate = `${stem} (${suffix})${extension}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  throw new AppError(409, `A file named "${desired}" is already there`);
}

// A new version moves the file's mirror columns and the project's total as well
// as adding a row, so the event carries all three rather than the one a client
// would then have to read the others back for.
export async function versionEventData(
  c: Pick<AppContext, 'get'>,
  projectId: string,
  fileId: string,
  version: ReturnType<typeof serializeVersion>
) {
  const { storage_used_bytes: used, ...file } = await fileWithUsage(c, projectId, fileId);
  return { version, file, storage_used_bytes: used };
}
