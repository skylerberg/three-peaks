import { type } from 'arktype';
import { LAYOUT_LIMITS, MODEL_LIMITS } from '@three-peaks/shared';
import { numberRange as range, stringWithLength, uuid } from './common.ts';

const { card } = MODEL_LIMITS;
const L = LAYOUT_LIMITS;

// Keys are checked by layoutReferenceErrors, which says which key and why;
// here they only have to be strings.
const key = type('string');
const hexColor = type('/^#[0-9a-f]{6}$/');
const coordinate = type(range(L.coordinate_mm));
const box = type([coordinate, coordinate, coordinate, coordinate]);
const when = key.or('null');

const imageElementSchema = type({
  type: "'image'",
  box,
  when,
  source: type({ from: "'field'", field: key }).or({ from: "'file'", file_id: uuid }),
  fit: "'cover' | 'contain' | 'fill'",
});

const rectElementSchema = type({
  type: "'rect'",
  box,
  when,
  fill: hexColor.or('null'),
  stroke: hexColor.or('null'),
  stroke_mm: range(L.stroke_mm),
  radius_mm: range(L.radius_mm),
  opacity: range(L.opacity),
});

const textElementSchema = type({
  type: "'text'",
  box,
  when,
  text: `string <= ${L.max_template_length}`,
  font: key,
  bold_font: key.or('null'),
  size_pt: range(L.font_size_pt),
  min_size_pt: range(L.font_size_pt),
  line_height: range(L.line_height),
  color: hexColor,
  align: "'left' | 'center' | 'right'",
  valign: "'top' | 'middle' | 'bottom'",
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

// Which decks hold cards drawn from this layout, so that whoever changes it can
// re-render exactly those. Deleted decks and deleted cards are left out: they
// are not re-rendered, and a restore brings back the image they had.
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
  updated_by: 'string | null',
  created_at: 'string',
  updated_at: 'string',
});

export const cardContentListSchema = type({ cards: cardContentSchema.array() });

export const cardContentQuerySchema = type({ deck_id: uuid });

export const putCardContentRequestSchema = type({
  layout_id: uuid,
  fields: fieldValues,
});
