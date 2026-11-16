import { createHash } from 'node:crypto';
import {
  type CardFields,
  type CardSize,
  type LayoutFace,
  type PunchboardModelSettings,
  faceElements,
} from '@three-peaks/shared';
import { CardRenderer } from './cardRender/render.ts';
import { CardRenderError, type CardLayout } from './cardRender/svg.ts';
import { imageSize } from './cardRender/imageSize.ts';
import { assertNotDrawnElsewhere } from './cardLayouts.ts';
import { publishComponent } from './components.ts';
import { placeInDeck, publishDeck } from './decks.ts';
import { type FileHome, homeColumns } from './fileHome.ts';
import {
  FILE_COLUMNS,
  appendFileVersion,
  assertQuota,
  fileWithUsage,
  freeFilename,
  serializeFile,
  serializeVersion,
  versionEventData,
} from './files.ts';
import { publishAfterCommit } from './realtime/index.ts';
import { reclaim, storage } from './storage/index.ts';
import { ensureToken, setBack } from './tokens.ts';
import { AppError, isUniqueViolation } from '../utils/errors.ts';
import { newId } from '../utils/uuid.ts';
import type { AppContext, Connection } from '../types/index.ts';

// A laid-out card's image is drawn here, from its layout and its content, and
// saved as the card's next version only when the bytes come out different --
// which is the whole of the staleness bookkeeping: whether a card is up to date
// is answered by drawing it.

export { CardRenderError, type CardLayout };

const PNG = 'image/png';

function sizeText(size: CardSize): string {
  return `${String(size.width_mm)} × ${String(size.height_mm)} mm`;
}

/**
 * What a laid-out file is, which decides the size it is drawn at and what is
 * printed behind it: a deck's card, at the deck's size behind the deck's back,
 * or a punchboard's token, at the size the punchboard cuts it, with a back of
 * its own that its layout may draw too.
 */
export type Piece = {
  fileId: string;
  projectId: string;
  filename: string;
  checksum: string | null;
  // Whether it can take a version: neither it nor what holds it is deleted.
  live: boolean;
  size: CardSize;
} & ({ kind: 'card'; deckId: string } | { kind: 'token'; componentId: string });

export async function readPiece(db: Connection, fileId: string): Promise<Piece | null> {
  const row = await db
    .selectFrom('file')
    .leftJoin('deck', 'deck.id', 'file.deck_id')
    .leftJoin('component', 'component.id', 'file.component_id')
    .leftJoin('component_token', 'component_token.file_id', 'file.id')
    .select([
      'file.project_id as project_id',
      'file.filename as filename',
      'file.checksum as checksum',
      'file.deleted_at as deleted_at',
      'deck.id as deck_id',
      'deck.deleted_at as deck_deleted_at',
      'deck.card_width_mm as card_width_mm',
      'deck.card_height_mm as card_height_mm',
      'component.id as component_id',
      'component.deleted_at as component_deleted_at',
      'component.settings as settings',
      'component_token.id as token_id',
    ])
    .where('file.id', '=', fileId)
    .executeTakeFirst();
  if (!row) return null;
  const common = {
    fileId,
    projectId: row.project_id,
    filename: row.filename,
    checksum: row.checksum,
  };
  if (row.deck_id !== null) {
    return {
      ...common,
      kind: 'card',
      deckId: row.deck_id,
      live: row.deleted_at === null && row.deck_deleted_at === null,
      size: { width_mm: Number(row.card_width_mm), height_mm: Number(row.card_height_mm) },
    };
  }
  if (row.component_id !== null && row.token_id !== null) {
    const settings = row.settings as unknown as PunchboardModelSettings;
    return {
      ...common,
      kind: 'token',
      componentId: row.component_id,
      live: row.deleted_at === null && row.component_deleted_at === null,
      size: { width_mm: settings.token_width_mm, height_mm: settings.token_height_mm },
    };
  }
  return null;
}

// Refused before anything is drawn: a layout on a card of another size would
// render without complaint and print at the wrong scale, and a back drawn for
// a card would be printed behind nothing, since a deck's cards share its back.
export function assertLayoutFits(layout: CardLayout, piece: Pick<Piece, 'kind' | 'size'>): void {
  const size = piece.size;
  if (layout.width_mm !== size.width_mm || layout.height_mm !== size.height_mm) {
    const pieces = piece.kind === 'card' ? "this deck's cards" : "this punchboard's tokens";
    throw new CardRenderError(
      `${layout.name} is drawn on a ${sizeText(layout)} card and ${pieces} are ${sizeText(size)}`
    );
  }
  if (piece.kind === 'card' && faceElements(layout.spec, 'back') !== null) {
    throw new CardRenderError(
      `${layout.name} draws a back of its own, and a deck's cards share the deck's back. A layout with a back draws a punchboard's tokens`
    );
  }
}

// One card at a time on a pod, whichever request or job asks: a card's
// pictures are decoded at full size while it is drawn, and two large ones at
// once is what would put a pod over its memory.
let slot: Promise<unknown> = Promise.resolve();

function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = slot.then(work, work);
  slot = run.catch(() => undefined);
  return run;
}

// One face of the card as PNG bytes. Fonts and pictures are read from storage
// as they stand: a file that has gained a version since the layout named it is
// drawn at that version, which is why a new version asks for its cards again.
export function drawCard(
  db: Connection,
  layout: CardLayout,
  fields: CardFields,
  face: LayoutFace = 'front'
): Promise<Uint8Array> {
  const renderer = new CardRenderer(async (fileId) => {
    const file = await db
      .selectFrom('file')
      .select([
        'file.storage_key as storage_key',
        'file.content_type as content_type',
        'file.filename as filename',
      ])
      .where('file.id', '=', fileId)
      .executeTakeFirst();
    if (!file) throw new CardRenderError(`file ${fileId} no longer exists`);
    const bytes = await storage().get(file.storage_key);
    // The row says the bytes exist and the bucket does not have them: nothing
    // about the card is wrong, so this is a failure to retry, not a refusal.
    if (bytes === null) throw new Error(`${file.filename} is missing from storage`);
    return { bytes: new Uint8Array(bytes), contentType: file.content_type };
  });
  return oneAtATime(() => renderer.render(layout, fields, face));
}

// Every face the layout draws: the front, and the back where it has one.
export interface DrawnFaces {
  front: Uint8Array;
  back: Uint8Array | null;
}

export async function drawFaces(
  db: Connection,
  layout: CardLayout,
  fields: CardFields
): Promise<DrawnFaces> {
  const front = await drawCard(db, layout, fields, 'front');
  const back =
    faceElements(layout.spec, 'back') === null ? null : await drawCard(db, layout, fields, 'back');
  return { front, back };
}

function checksumOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// Writes the bytes to storage under a new key, and takes them back if the
// write that was to point at them fails.
async function stored<T>(bytes: Uint8Array, use: (storageKey: string) => Promise<T>): Promise<T> {
  const storageKey = newId();
  await storage().put(storageKey, Buffer.from(bytes), PNG);
  try {
    return await use(storageKey);
  } catch (error) {
    await reclaim(storageKey);
    throw error;
  }
}

function candidate(storageKey: string, bytes: Uint8Array) {
  const size = imageSize({ bytes, contentType: PNG });
  return {
    storageKey,
    contentType: PNG,
    byteSize: bytes.byteLength,
    checksum: checksumOf(bytes),
    imageWidth: size?.width ?? null,
    imageHeight: size?.height ?? null,
  };
}

interface CardFile {
  fileId: string;
  projectId: string;
  checksum: string | null;
}

// The rendered bytes as the card's next version, announced as any new version
// is. Null when they are the bytes it already has, which writes nothing at all.
async function saveCardImage(
  c: Pick<AppContext, 'get'>,
  card: CardFile,
  bytes: Uint8Array
): Promise<number | null> {
  if (checksumOf(bytes) === card.checksum) return null;
  const result = await stored(bytes, async (storageKey) => {
    await assertQuota(c, card.projectId, bytes.byteLength);
    return appendFileVersion(c, card.fileId, candidate(storageKey, bytes));
  });
  if (!result.created) return null;
  const version = serializeVersion(result.version, result.version.version_number);
  publishAfterCommit(
    c.get('postCommitHooks'),
    c.get('user').id,
    'file_version_created',
    card.projectId,
    await versionEventData(c, card.projectId, card.fileId, version)
  );
  return version.version_number;
}

// A drawn image as a new file in `home`, announced as an upload is. Where it
// stands in the deck or the punchboard is the caller's.
async function createDrawnFile(
  c: Pick<AppContext, 'get'>,
  file: { id: string; projectId: string; home: FileHome; filename: string },
  bytes: Uint8Array
) {
  const db = c.get('db');
  const row = await stored(bytes, async (storageKey) => {
    await assertQuota(c, file.projectId, bytes.byteLength);
    const version = candidate(storageKey, bytes);
    let inserted;
    try {
      inserted = await db
        .insertInto('file')
        .values({
          id: file.id,
          project_id: file.projectId,
          ...homeColumns(file.home),
          filename: file.filename,
          storage_key: storageKey,
          content_type: PNG,
          byte_size: String(version.byteSize),
          checksum: version.checksum,
          image_width: version.imageWidth,
          image_height: version.imageHeight,
          uploaded_by: c.get('user').id,
        })
        .returning(FILE_COLUMNS)
        .executeTakeFirstOrThrow();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError(409, 'A card with that id or name already exists here');
      }
      throw error;
    }
    await appendFileVersion(c, inserted.id, version);
    return inserted;
  });
  publishAfterCommit(
    c.get('postCommitHooks'),
    c.get('user').id,
    'file_uploaded',
    file.projectId,
    await fileWithUsage(c, file.projectId, row.id)
  );
  return serializeFile(row);
}

// What a token's back is called: after its front, so the two sit together in
// any listing of the punchboard's files.
function backFilename(front: string): string {
  const dot = front.lastIndexOf('.');
  return `${dot > 0 ? front.slice(0, dot) : front} (back).png`;
}

/**
 * Saves a token's drawn back. It goes into the back the token already has when
 * that is a live image of the punchboard's own that no other token prints;
 * otherwise -- a token with no back, one printing its front on both sides, or
 * one sharing its back -- it becomes a new image that is this token's alone,
 * and the token's back from now on.
 */
async function saveDrawnBack(
  c: Pick<AppContext, 'get'>,
  piece: Extract<Piece, { kind: 'token' }>,
  bytes: Uint8Array
): Promise<void> {
  const db = c.get('db');
  const token = await db
    .selectFrom('component_token')
    .leftJoin('file', 'file.id', 'component_token.back_file_id')
    .select([
      'component_token.back_file_id as back_file_id',
      'file.checksum as checksum',
      'file.deleted_at as deleted_at',
      'file.component_id as component_id',
    ])
    .where('component_token.file_id', '=', piece.fileId)
    .executeTakeFirstOrThrow();

  const backId = token.back_file_id;
  if (
    backId !== null &&
    backId !== piece.fileId &&
    token.deleted_at === null &&
    token.component_id === piece.componentId
  ) {
    const shared = await db
      .selectFrom('component_token')
      .select('component_token.id')
      .where('component_token.back_file_id', '=', backId)
      .where('component_token.file_id', '<>', piece.fileId)
      .executeTakeFirst();
    if (shared === undefined) {
      // A picture something else draws cannot become one a layout draws.
      await assertNotDrawnElsewhere(c, piece.projectId, backId);
      await saveCardImage(
        c,
        { fileId: backId, projectId: piece.projectId, checksum: token.checksum },
        bytes
      );
      return;
    }
  }

  const home: FileHome = { kind: 'component', componentId: piece.componentId, role: 'token' };
  const created = await createDrawnFile(
    c,
    {
      id: newId(),
      projectId: piece.projectId,
      home,
      filename: await freeFilename(db, piece.projectId, home, backFilename(piece.filename)),
    },
    bytes
  );
  await setBack(db, piece.componentId, piece.fileId, created.id);
  await publishComponent(c, piece.projectId, piece.componentId);
}

// Each face saved where it is printed, as a version only where it came out
// different. The front's new version, or null for one that came out the same.
export async function saveFaces(
  c: Pick<AppContext, 'get'>,
  piece: Piece,
  faces: DrawnFaces
): Promise<number | null> {
  const version = await saveCardImage(
    c,
    { fileId: piece.fileId, projectId: piece.projectId, checksum: piece.checksum },
    faces.front
  );
  if (faces.back !== null && piece.kind === 'token') await saveDrawnBack(c, piece, faces.back);
  return version;
}

// Where a new piece is made: the deck it is the next card of, or the
// punchboard it is the next token of.
export type PieceHome = { kind: 'deck'; deckId: string } | { kind: 'token'; componentId: string };

// A new piece, drawn: its front is the next card or token, the way an upload
// would make it, and a token's drawn back is its own new image.
export async function createPieceFile(
  c: Pick<AppContext, 'get'>,
  piece: { id: string; projectId: string; home: PieceHome; filename: string },
  faces: DrawnFaces
) {
  const db = c.get('db');
  const home: FileHome =
    piece.home.kind === 'deck'
      ? { kind: 'deck', deckId: piece.home.deckId }
      : { kind: 'component', componentId: piece.home.componentId, role: 'token' };
  const file = await createDrawnFile(
    c,
    { id: piece.id, projectId: piece.projectId, home, filename: piece.filename },
    faces.front
  );
  if (piece.home.kind === 'deck') {
    await placeInDeck(c, piece.home.deckId, file.id, 'card');
    await publishDeck(c, piece.projectId, piece.home.deckId);
    return file;
  }
  const componentId = piece.home.componentId;
  await ensureToken(db, componentId, file.id);
  if (faces.back !== null) {
    const back = await createDrawnFile(
      c,
      {
        id: newId(),
        projectId: piece.projectId,
        home,
        filename: await freeFilename(db, piece.projectId, home, backFilename(file.filename)),
      },
      faces.back
    );
    await setBack(db, componentId, file.id, back.id);
  }
  await publishComponent(c, piece.projectId, componentId);
  return file;
}

// A card drawn from its stored content as things stand, and saved if it came
// out different. Null for a card there is nothing to draw for any more: its
// content is gone, it is no longer a deck's card or a punchboard's token, or
// it or what holds it is deleted -- restoring either asks for it again.
export async function renderStoredCard(
  c: Pick<AppContext, 'get'>,
  fileId: string
): Promise<{ version: number | null } | null> {
  const db = c.get('db');
  const content = await db
    .selectFrom('card_content')
    .innerJoin('card_layout', 'card_layout.id', 'card_content.layout_id')
    .select([
      'card_content.fields as fields',
      'card_layout.name as name',
      'card_layout.width_mm as width_mm',
      'card_layout.height_mm as height_mm',
      'card_layout.spec as spec',
    ])
    .where('card_content.file_id', '=', fileId)
    .executeTakeFirst();
  if (!content) return null;
  const piece = await readPiece(db, fileId);
  if (piece === null || !piece.live) return null;

  const layout: CardLayout = {
    name: content.name,
    width_mm: Number(content.width_mm),
    height_mm: Number(content.height_mm),
    spec: content.spec,
  };
  assertLayoutFits(layout, piece);
  const faces = await drawFaces(db, layout, content.fields as CardFields);
  return { version: await saveFaces(c, piece, faces) };
}
