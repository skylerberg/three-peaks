import { type } from 'arktype';
import { LAYOUT_LIMITS, MODEL_LIMITS } from '@three-peaks/shared';
import { numberRange as range, stringWithLength, uuid } from './common.ts';
import { fileSchema } from './files.ts';

const { card } = MODEL_LIMITS;
const L = LAYOUT_LIMITS;

// Keys are checked by layoutReferenceErrors, which says which key and why;
// here they only have to be strings.
const key = type('string');
const hexColor = type('/^#[0-9a-f]{6}$/');
const coordinate = type(range(L.coordinate_mm));
// Pinned edges are checked against the other elements by layoutReferenceErrors.
const edge = coordinate.or({
  element: key,
  edge: "'left' | 'right' | 'top' | 'bottom'",
  offset_mm: coordinate,
});
const box = type({ left: edge, top: edge, right: edge, bottom: edge });
const when = key.or('null');
const id = key.or('null');
const rotate = type('0 | 90 | 180 | 270');
const sliceInset = type(`${L.slice_px[0]} <= number.integer <= ${L.slice_px[1]}`);

const imageElementSchema = type({
  type: "'image'",
  id,
  box,
  when,
  rotate,
  source: type({ from: "'field'", field: key }).or({ from: "'file'", file_id: uuid }),
  fit: "'cover' | 'contain' | 'fill'",
  slice: type([sliceInset, sliceInset, sliceInset, sliceInset]).or('null'),
});

const rectElementSchema = type({
  type: "'rect'",
  id,
  box,
  when,
  rotate,
  fill: hexColor.or('null'),
  stroke: hexColor.or('null'),
  stroke_mm: range(L.stroke_mm),
  radius_mm: range(L.radius_mm),
  opacity: range(L.opacity),
});

const textElementSchema = type({
  type: "'text'",
  id,
  box,
  when,
  rotate,
  text: `string <= ${L.max_template_length}`,
  font: key,
  bold_font: key.or('null'),
  size_pt: range(L.font_size_pt),
  min_size_pt: range(L.font_size_pt),
  line_height: range(L.line_height),
  color: hexColor,
  align: "'left' | 'center' | 'right'",
  valign: "'top' | 'middle' | 'bottom'",
  hug: 'boolean',
});

export const layoutSpecSchema = type({
  dpi: `${L.dpi[0]} <= number.integer <= ${L.dpi[1]}`,
  // How many of each there may be is counted by layoutReferenceErrors: a
  // narrowed record has no JSON Schema form, and the layout would then be
  // inlined in the spec instead of named.
  fonts: type({ '[string]': uuid }),
  icons: type({ '[string]': uuid }),
  fields: type({ '[string]': { type: "'text' | 'image'" } }),
  elements: imageElementSchema
    .or(rectElementSchema)
    .or(textElementSchema)
    .array()
    .atMostLength(L.max_elements),
});

const layoutName = stringWithLength(...L.name);

export const cardLayoutSchema = type({
  id: 'string',
  project_id: 'string',
  name: 'string',
  width_mm: 'number',
  height_mm: 'number',
  spec: layoutSpecSchema,
  // Null once the account that wrote it is gone; the layout stays.
  created_by: 'string | null',
  updated_by: 'string | null',
  created_at: 'string',
  updated_at: 'string',
});

export const cardLayoutListSchema = type({ layouts: cardLayoutSchema.array() });

// Which decks hold cards drawn from this layout. Deleted decks and deleted
// cards are left out: they are not drawn while deleted, and restoring one asks
// for it to be drawn again.
export const cardLayoutWithDecksSchema = type({
  layout: cardLayoutSchema,
  decks: type({ id: 'string', name: 'string', card_count: 'number' }).array(),
});

export const createCardLayoutRequestSchema = type({
  'id?': uuid,
  project_id: uuid,
  name: layoutName,
  width_mm: range(card.width_mm),
  height_mm: range(card.height_mm),
  spec: layoutSpecSchema,
});

export const putCardLayoutRequestSchema = type({
  name: layoutName,
  width_mm: range(card.width_mm),
  height_mm: range(card.height_mm),
  spec: layoutSpecSchema,
});

const fieldValues = type({ '[string]': 'string' });

export const cardContentSchema = type({
  file_id: 'string',
  project_id: 'string',
  layout_id: 'string',
  fields: fieldValues,
  // Whether the image is the picture of this content: `pending` while the
  // background renderer has yet to draw it after a change to its layout or a
  // file it draws, `failed` when it cannot be drawn as things stand, and why.
  render_status: "'current' | 'pending' | 'failed'",
  render_error: 'string | null',
  updated_by: 'string | null',
  created_at: 'string',
  updated_at: 'string',
});

// A save draws the card there and then, and says which version of its image
// that made -- null when the image came out as it already was.
export const savedCardContentSchema = type({
  content: cardContentSchema,
  image_version: 'number | null',
});

export const cardContentListSchema = type({ cards: cardContentSchema.array() });

export const cardContentQuerySchema = type({ deck_id: uuid });

export const putCardContentRequestSchema = type({
  layout_id: uuid,
  fields: fieldValues,
});

// A new card, drawn and added to the deck as its next image.
export const createCardRequestSchema = type({
  'id?': uuid,
  deck_id: uuid,
  filename: stringWithLength(1, 255),
  layout_id: uuid,
  fields: fieldValues,
});

export const createdCardSchema = type({
  file: fileSchema,
  content: cardContentSchema,
});

// Every card of a deck drawn from a layout, or only the ones named.
export const renderCardsRequestSchema = type({
  deck_id: uuid,
  'file_ids?': uuid.array().atLeastLength(1),
});

export const renderCardsResultSchema = type({ requested: 'number' });

// A card drawn without saving anything: a layout as it stands in an editor,
// and one card's values for it.
export const previewCardRequestSchema = type({
  project_id: uuid,
  width_mm: range(card.width_mm),
  height_mm: range(card.height_mm),
  spec: layoutSpecSchema,
  fields: fieldValues,
});
