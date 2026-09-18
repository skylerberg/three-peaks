import { type } from 'arktype';
import {
  DECK_NAME_LIMITS,
  DECK_QUANTITY_LIMITS,
  MAX_DECK_CARDS,
  MODEL_LIMITS,
} from '@three-peaks/shared';
import { numberRange as range, stringWithLength, uuid } from './common.ts';
import { fileSchema } from './files.ts';

const { card } = MODEL_LIMITS;

const deckName = stringWithLength(...DECK_NAME_LIMITS);

export const deckSchema = type({
  id: 'string',
  project_id: 'string',
  name: 'string',
  card_width_mm: 'number',
  card_height_mm: 'number',
  // The image on every card's reverse. Null is a deck whose back has not been
  // chosen yet; the print sheets then skip its backing pages.
  back_file_id: 'string | null',
  created_by: 'string',
  created_at: 'string',
  updated_at: 'string',
  // Null for a live deck. A deck owns its artwork, so deleting one is soft and
  // a screen resolving a deck by id has to tell a tombstone from a live row.
  deleted_at: 'string | null',
  // Distinct cards, and the number of pieces of card those add up to, leaving
  // out any whose image is deleted. Both are on the listing so the decks screen
  // needs no follow-up request per deck.
  card_count: 'number',
  total_copies: 'number',
});

export const deckCardSchema = type({
  file_id: 'string',
  quantity: 'number',
  position: 'number',
  // The whole row, not just the name: the editor draws a thumbnail and warns
  // about resolution, and both come off the pixel dimensions it already has.
  file: fileSchema,
});

export const deckWithCardsSchema = type({
  deck: deckSchema,
  cards: deckCardSchema.array(),
});

export const deckListSchema = type({ decks: deckSchema.array() });

export const createDeckRequestSchema = type({
  'id?': uuid,
  project_id: uuid,
  name: deckName,
  card_width_mm: range(card.width_mm),
  card_height_mm: range(card.height_mm),
  'back_file_id?': 'string.uuid | null',
});

export const updateDeckRequestSchema = type({
  'name?': deckName,
  'card_width_mm?': range(card.width_mm),
  'card_height_mm?': range(card.height_mm),
  'back_file_id?': 'string.uuid | null',
});

const [minQuantity, maxQuantity] = DECK_QUANTITY_LIMITS;

const deckCardInputSchema = type({
  file_id: uuid,
  // Integer, unlike the millimetres above: half a copy of a card is not a thing
  // a print run can produce, and a float here would round somewhere later.
  quantity: `${minQuantity} <= number.integer <= ${maxQuantity}`,
});

// The whole list, in order, rather than one card at a time. Position is the
// array index, so reordering, adding and removing are the same request and none
// of them can interleave with another.
export const putDeckCardsRequestSchema = type({
  cards: deckCardInputSchema.array().atMostLength(MAX_DECK_CARDS),
});
