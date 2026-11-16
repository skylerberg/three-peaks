import { sql } from 'kysely';
import { MAX_PUNCHBOARD_TOKENS } from '@three-peaks/shared';
import { drawsBack } from './cardLayouts.ts';
import { AppError } from '../utils/errors.ts';
import { newId } from '../utils/uuid.ts';
import { FILE_COLUMNS, type FileRow, serializeFile } from './files.ts';
import type { AppContext, Connection } from '../types/index.ts';

// A punchboard's tokens: which of its files is which face of which token, how
// many of each are cut, and in what order. The list is the punchboard's the way
// `deck_card` is a deck's, and is held to the same rule -- every live file the
// punchboard owns is a token's front or some token's back, so there is no
// third place for one of its images to be.

export interface TokenEntry {
  file_id: string;
  back_file_id: string | null;
  quantity: number;
  position: number;
  file: ReturnType<typeof serializeFile>;
  back_file: ReturnType<typeof serializeFile> | null;
}

// Each punchboard's list in order, with both faces' rows. Two reads rather than
// a join, because a join to `file` twice needs the column list spelled out a
// second time under other names, and that copy is the one that drifts.
export async function tokensFor(
  db: Connection,
  componentIds: readonly string[]
): Promise<Map<string, TokenEntry[]>> {
  const byComponent = new Map<string, TokenEntry[]>();
  if (componentIds.length === 0) return byComponent;
  const rows = await db
    .selectFrom('component_token')
    .select([
      'component_token.component_id as component_id',
      'component_token.file_id as file_id',
      'component_token.back_file_id as back_file_id',
      'component_token.quantity as quantity',
      'component_token.position as position',
    ])
    .where('component_token.component_id', 'in', componentIds)
    .orderBy('component_token.position', 'asc')
    .orderBy('component_token.id', 'asc')
    .execute();
  if (rows.length === 0) return byComponent;

  const ids = [
    ...new Set(
      rows.flatMap((row) => [row.file_id, ...(row.back_file_id ? [row.back_file_id] : [])])
    ),
  ];
  const files = new Map(
    (
      (await db
        .selectFrom('file')
        .select(FILE_COLUMNS)
        .where('file.id', 'in', ids)
        .execute()) as FileRow[]
    ).map((row) => [row.id, serializeFile(row)])
  );

  for (const row of rows) {
    const list = byComponent.get(row.component_id) ?? [];
    list.push({
      file_id: row.file_id,
      back_file_id: row.back_file_id,
      quantity: row.quantity,
      position: row.position,
      file: files.get(row.file_id)!,
      back_file: row.back_file_id === null ? null : (files.get(row.back_file_id) ?? null),
    });
    byComponent.set(row.component_id, list);
  }
  return byComponent;
}

async function nextTokenPosition(db: Connection, componentId: string): Promise<number> {
  const top = await db
    .selectFrom('component_token')
    .select((eb) => eb.fn.max('component_token.position').as('position'))
    .where('component_token.component_id', '=', componentId)
    .executeTakeFirst();
  return (top?.position ?? -1) + 1;
}

/**
 * Gives one of a punchboard's images a place in its list as a token of its
 * own, at the end with one copy and an unprinted back, and says whether it had
 * to. Every arrival of a front comes through here -- an upload, a move in, a
 * token drawn from a layout and a restore -- and, like `ensureDeckCard`, it is
 * idempotent: a token deleted by hand kept its row, and gets it back.
 */
export async function ensureToken(
  db: Connection,
  componentId: string,
  fileId: string
): Promise<boolean> {
  const inserted = await db
    .insertInto('component_token')
    .values({
      id: newId(),
      component_id: componentId,
      file_id: fileId,
      back_file_id: null,
      quantity: 1,
      position: await nextTokenPosition(db, componentId),
    })
    .onConflict((oc) => oc.columns(['component_id', 'file_id']).doNothing())
    .returning(['component_token.id as id'])
    .executeTakeFirst();
  return inserted !== undefined;
}

// Refuses a new token for a punchboard already holding as many as one holds.
// A front that still has its row needs no room, so a restore is never refused.
export async function assertRoomForToken(
  db: Connection,
  componentId: string,
  fileId: string
): Promise<void> {
  const rows = await db
    .selectFrom('component_token')
    .select(['component_token.file_id as file_id'])
    .where('component_token.component_id', '=', componentId)
    .execute();
  if (rows.some((row) => row.file_id === fileId)) return;
  if (rows.length >= MAX_PUNCHBOARD_TOKENS) {
    throw new AppError(
      422,
      `That punchboard already holds ${String(MAX_PUNCHBOARD_TOKENS)} tokens, which is as many as one holds.`,
      { tokens: rows.length, limit: MAX_PUNCHBOARD_TOKENS }
    );
  }
}

// The backs the punchboard's layouts draw, by the front they belong to.
async function drawnBacks(db: Connection, componentId: string): Promise<Map<string, string>> {
  const rows = await db
    .selectFrom('component_token')
    .select(['component_token.file_id as file_id', 'component_token.back_file_id as back_file_id'])
    .where('component_token.component_id', '=', componentId)
    .where(drawsBack)
    .execute();
  return new Map(rows.map((row) => [row.file_id, row.back_file_id!]));
}

// Whether the token fronted by `fileId` is drawn from a layout with a back,
// which is then the layout's to draw rather than anybody's to choose.
async function layoutDrawsBack(db: Connection, fileId: string): Promise<boolean> {
  const row = await db
    .selectFrom('card_content')
    .innerJoin('card_layout', 'card_layout.id', 'card_content.layout_id')
    .select(sql<boolean>`jsonb_typeof(card_layout.spec -> 'back') = 'array'`.as('has_back'))
    .where('card_content.file_id', '=', fileId)
    .executeTakeFirst();
  return row?.has_back === true;
}

export interface TokenInput {
  file_id: string;
  back_file_id: string | null;
  quantity: number;
}

/**
 * Refuses a token list that is not exactly the punchboard's own images.
 *
 * Every front and every back has to be a file the punchboard owns, tombstone
 * or not, for the reason `assertCardFiles` gives: the list sent back is the
 * list that was read, deleted tokens and all. A back is the token's own front,
 * or a file that is no token's front; and a live file the list names as
 * neither would be an image in the punchboard with no place in it.
 *
 * A back a token's layout draws is the layout's: it stays that token's back,
 * and it is nobody else's.
 */
export async function assertTokenFiles(
  c: Pick<AppContext, 'get'>,
  componentId: string,
  tokens: readonly TokenInput[]
): Promise<void> {
  const db = c.get('db');
  const owned = await db
    .selectFrom('file')
    .select(['file.id as id', 'file.filename as filename', 'file.deleted_at as deleted_at'])
    .where('file.component_id', '=', componentId)
    .orderBy('file.filename', 'asc')
    .execute();
  const byId = new Map(owned.map((row) => [row.id, row]));
  const name = (id: string) => `"${byId.get(id)?.filename ?? id}"`;

  const fronts = new Set<string>();
  for (const token of tokens) {
    if (
      !byId.has(token.file_id) ||
      (token.back_file_id !== null && !byId.has(token.back_file_id))
    ) {
      throw new AppError(
        422,
        'Every token has to be made of images this punchboard holds. Upload them here first.'
      );
    }
    if (fronts.has(token.file_id)) {
      throw new AppError(
        422,
        `${name(token.file_id)} is in the list twice; raise its copies instead`
      );
    }
    fronts.add(token.file_id);
  }

  const drawn = await drawnBacks(db, componentId);
  const drawnOwners = new Map([...drawn].map(([front, back]) => [back, front]));
  const backs = new Set<string>();
  for (const token of tokens) {
    const back = token.back_file_id;
    const drawnBack = drawn.get(token.file_id);
    if (drawnBack !== undefined && back !== drawnBack) {
      throw new AppError(422, `${name(token.file_id)}'s back is drawn by its layout`);
    }
    if (back === null || back === token.file_id) continue;
    if (fronts.has(back)) {
      throw new AppError(
        422,
        `${name(back)} is a token of its own, so it cannot also be the back of ${name(token.file_id)}`
      );
    }
    const owner = drawnOwners.get(back);
    if (owner !== undefined && owner !== token.file_id) {
      throw new AppError(422, `${name(back)} is the back ${name(owner)}'s layout draws`);
    }
    backs.add(back);
  }

  const stranded = owned.filter(
    (row) => row.deleted_at === null && !fronts.has(row.id) && !backs.has(row.id)
  );
  if (stranded.length > 0) {
    const rest = stranded.length === 1 ? '' : ` and ${String(stranded.length - 1)} more`;
    throw new AppError(
      422,
      `"${stranded[0]!.filename}"${rest} would be left in this punchboard as neither a token nor a back. Delete it, or move it to Assets.`
    );
  }
}

// Writes the whole list, in the order given. The rows are replaced, the way a
// deck's are on every save.
export async function writeTokens(
  db: Connection,
  componentId: string,
  tokens: readonly TokenInput[]
): Promise<void> {
  await db
    .deleteFrom('component_token')
    .where('component_token.component_id', '=', componentId)
    .execute();
  if (tokens.length === 0) return;
  await db
    .insertInto('component_token')
    .values(
      tokens.map((token, position) => ({
        id: newId(),
        component_id: componentId,
        file_id: token.file_id,
        back_file_id: token.back_file_id,
        quantity: token.quantity,
        position,
      }))
    )
    .execute();
}

// The token a file is the front of, or null.
async function tokenOf(db: Connection, fileId: string) {
  return (
    (await db
      .selectFrom('component_token')
      .select([
        'component_token.component_id as component_id',
        'component_token.back_file_id as back_file_id',
      ])
      .where('component_token.file_id', '=', fileId)
      .executeTakeFirst()) ?? null
  );
}

/**
 * Refuses a new back for the token fronted by `frontId` unless it can take
 * one: the token has to be live, and have no back of its own yet. A back it
 * already has takes a new version instead, which keeps the old picture one
 * revert away rather than leaving it in the punchboard naming nothing. Asked
 * before an upload's bytes are sent, for the reason the quota is.
 */
export async function assertTakesBack(
  db: Connection,
  componentId: string,
  frontId: string
): Promise<void> {
  const token = await db
    .selectFrom('component_token')
    .innerJoin('file', 'file.id', 'component_token.file_id')
    .select([
      'component_token.back_file_id as back_file_id',
      'file.deleted_at as deleted_at',
      'file.filename as filename',
    ])
    .where('component_token.component_id', '=', componentId)
    .where('component_token.file_id', '=', frontId)
    .executeTakeFirst();
  if (!token || token.deleted_at !== null) {
    throw new AppError(404, 'That token is not one of this punchboard’s');
  }
  if (await layoutDrawsBack(db, frontId)) {
    throw new AppError(422, `${token.filename}'s back is drawn by its layout`);
  }
  if (token.back_file_id !== null && token.back_file_id !== frontId) {
    throw new AppError(
      409,
      `${token.filename} already has a back. Add a version of that image instead`
    );
  }
}

export async function setBack(
  db: Connection,
  componentId: string,
  frontId: string,
  backId: string
): Promise<void> {
  await db
    .updateTable('component_token')
    .set({ back_file_id: backId })
    .where('component_token.component_id', '=', componentId)
    .where('component_token.file_id', '=', frontId)
    .execute();
}

// What leaving the punchboard does to its list. A front takes its token out,
// and is refused while the token has a back of its own, which would be left
// behind naming nothing; a back leaves its tokens with the board unprinted.
export async function leavePunchboard(
  db: Connection,
  componentId: string,
  fileId: string
): Promise<void> {
  const token = await db
    .selectFrom('component_token')
    .select(['component_token.back_file_id as back_file_id'])
    .where('component_token.component_id', '=', componentId)
    .where('component_token.file_id', '=', fileId)
    .executeTakeFirst();
  if (token && token.back_file_id !== null && token.back_file_id !== fileId) {
    throw new AppError(
      409,
      'That token has a back of its own, which would be left behind. Move or delete the back first'
    );
  }
  if (await layoutDrawsBackOf(db, componentId, fileId)) {
    throw new AppError(409, 'That image is a back a layout draws. Move its token instead');
  }
  await db
    .deleteFrom('component_token')
    .where('component_token.component_id', '=', componentId)
    .where('component_token.file_id', '=', fileId)
    .execute();
  await db
    .updateTable('component_token')
    .set({ back_file_id: null })
    .where('component_token.component_id', '=', componentId)
    .where('component_token.back_file_id', '=', fileId)
    .execute();
}

async function layoutDrawsBackOf(
  db: Connection,
  componentId: string,
  fileId: string
): Promise<boolean> {
  return [...(await drawnBacks(db, componentId)).values()].includes(fileId);
}

/**
 * The files purging `fileId` takes with it: a token's front takes the back of
 * its own that no other token prints, because the token goes with the front
 * and that back would be left in the punchboard naming nothing.
 */
export async function backsGoingWith(db: Connection, fileId: string): Promise<string[]> {
  const token = await tokenOf(db, fileId);
  if (token === null || token.back_file_id === null || token.back_file_id === fileId) return [];
  const others = await db
    .selectFrom('component_token')
    .select(['component_token.file_id as file_id'])
    .where('component_token.back_file_id', '=', token.back_file_id)
    .where('component_token.file_id', '<>', fileId)
    .executeTakeFirst();
  return others === undefined ? [token.back_file_id] : [];
}

/**
 * A restored image's place in the punchboard. A front whose token kept its row
 * needs nothing, and nor does a back some token still names; anything else
 * lost its place and becomes a token of its own, the way a restored card
 * rejoins its deck.
 */
export async function rejoinPunchboard(
  db: Connection,
  componentId: string,
  fileId: string
): Promise<void> {
  const named = await db
    .selectFrom('component_token')
    .select(['component_token.id as id'])
    .where('component_token.component_id', '=', componentId)
    .where((eb) =>
      eb.or([
        eb('component_token.file_id', '=', fileId),
        eb('component_token.back_file_id', '=', fileId),
      ])
    )
    .executeTakeFirst();
  if (named) return;
  await assertRoomForToken(db, componentId, fileId);
  await ensureToken(db, componentId, fileId);
}
