import { createHash } from 'node:crypto';
import type { CardFields } from '@three-peaks/shared';
import { CardRenderer } from './cardRender/render.ts';
import { CardRenderError, type CardLayout } from './cardRender/svg.ts';
import { imageSize } from './cardRender/imageSize.ts';
import { placeInDeck, publishDeck } from './decks.ts';
import {
  FILE_COLUMNS,
  appendFileVersion,
  assertQuota,
  fileWithUsage,
  serializeFile,
  serializeVersion,
  versionEventData,
} from './files.ts';
import { publishAfterCommit } from './realtime/index.ts';
import { reclaim, storage } from './storage/index.ts';
import { AppError, isUniqueViolation } from '../utils/errors.ts';
import { newId } from '../utils/uuid.ts';
import type { AppContext, Connection } from '../types/index.ts';

// A laid-out card's image is drawn here, from its layout and its content, and
// saved as the card's next version only when the bytes come out different --
// which is the whole of the staleness bookkeeping: whether a card is up to date
// is answered by drawing it.

export { CardRenderError, type CardLayout };

const PNG = 'image/png';

interface CardSize {
  width_mm: number;
  height_mm: number;
}

function sizeText(size: CardSize): string {
  return `${String(size.width_mm)} × ${String(size.height_mm)} mm`;
}

// Refused before anything is drawn: a layout on a card of another size would
// render without complaint and print at the wrong scale.
export function assertLayoutFits(layout: CardLayout, deck: CardSize): void {
  if (layout.width_mm !== deck.width_mm || layout.height_mm !== deck.height_mm) {
    throw new CardRenderError(
      `${layout.name} is drawn on a ${sizeText(layout)} card and this deck's cards are ${sizeText(deck)}`
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

// The card as PNG bytes. Fonts and pictures are read from storage as they
// stand: a file that has gained a version since the layout named it is drawn
// at that version, which is why a new version asks for its cards again.
export function drawCard(
  db: Connection,
  layout: CardLayout,
  fields: CardFields
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
  return oneAtATime(() => renderer.render(layout, fields));
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
export async function saveCardImage(
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

// A new card: its image is the deck's next card, the way an upload into the
// deck would make it.
export async function createCardFile(
  c: Pick<AppContext, 'get'>,
  card: { id: string; projectId: string; deckId: string; filename: string },
  bytes: Uint8Array
) {
  const db = c.get('db');
  const row = await stored(bytes, async (storageKey) => {
    await assertQuota(c, card.projectId, bytes.byteLength);
    const version = candidate(storageKey, bytes);
    let inserted;
    try {
      inserted = await db
        .insertInto('file')
        .values({
          id: card.id,
          project_id: card.projectId,
          deck_id: card.deckId,
          folder_id: null,
          component_id: null,
          filename: card.filename,
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
        throw new AppError(409, 'A card with that id or name already exists in this deck');
      }
      throw error;
    }
    await appendFileVersion(c, inserted.id, version);
    return inserted;
  });
  await placeInDeck(c, card.deckId, row.id, 'card');
  publishAfterCommit(
    c.get('postCommitHooks'),
    c.get('user').id,
    'file_uploaded',
    card.projectId,
    await fileWithUsage(c, card.projectId, row.id)
  );
  await publishDeck(c, card.projectId, card.deckId);
  return serializeFile(row);
}

// A card drawn from its stored content as things stand, and saved if it came
// out different. Null for a card there is nothing to draw for any more: its
// content is gone, or its image or its deck is deleted -- restoring either asks
// for it again.
export async function renderStoredCard(
  c: Pick<AppContext, 'get'>,
  fileId: string
): Promise<{ version: number | null } | null> {
  const db = c.get('db');
  const card = await db
    .selectFrom('card_content')
    .innerJoin('file', 'file.id', 'card_content.file_id')
    .innerJoin('deck', 'deck.id', 'file.deck_id')
    .innerJoin('card_layout', 'card_layout.id', 'card_content.layout_id')
    .select([
      'card_content.fields as fields',
      'file.project_id as project_id',
      'file.checksum as checksum',
      'file.deleted_at as deleted_at',
      'deck.deleted_at as deck_deleted_at',
      'deck.card_width_mm as deck_width_mm',
      'deck.card_height_mm as deck_height_mm',
      'card_layout.name as name',
      'card_layout.width_mm as width_mm',
      'card_layout.height_mm as height_mm',
      'card_layout.spec as spec',
    ])
    .where('card_content.file_id', '=', fileId)
    .executeTakeFirst();
  if (!card || card.deleted_at !== null || card.deck_deleted_at !== null) return null;

  const layout: CardLayout = {
    name: card.name,
    width_mm: Number(card.width_mm),
    height_mm: Number(card.height_mm),
    spec: card.spec,
  };
  assertLayoutFits(layout, {
    width_mm: Number(card.deck_width_mm),
    height_mm: Number(card.deck_height_mm),
  });
  const bytes = await drawCard(db, layout, card.fields as CardFields);
  const version = await saveCardImage(
    c,
    { fileId, projectId: card.project_id, checksum: card.checksum },
    bytes
  );
  return { version };
}
