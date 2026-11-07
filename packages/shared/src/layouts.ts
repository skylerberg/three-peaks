// A card layout: where the frame, the art and each line of copy go on a card,
// in millimetres, with each card supplying its own values for the slots. The
// API validates a layout against this and the CLI renders one from it, so a
// layout the server accepts is one the renderer can draw.
//
// Every optional setting is spelled out in the stored form. Defaults belong to
// whoever writes a layout -- the CLI's authoring format fills them -- so the
// renderer has no second set of defaults to disagree with.

export const LAYOUT_LIMITS = {
  name: [1, 120],
  dpi: [72, 1200],
  // Generous enough for a frame that bleeds past the trim, tight enough that a
  // typo of 6300 for 63.00 is refused rather than rendered as a blank card.
  coordinate_mm: [-100, 1000],
  font_size_pt: [1, 200],
  line_height: [0.5, 3],
  stroke_mm: [0, 20],
  radius_mm: [0, 100],
  opacity: [0, 1],
  max_elements: 200,
  max_fields: 50,
  max_fonts: 20,
  max_icons: 200,
  max_template_length: 2000,
  max_field_value_length: 4000,
} as const;

// One pattern for field, font and icon keys. Lower-case so that `{Coin}` and
// `{coin}` cannot be two icons, and no braces or asterisks so that a key can
// never be mistaken for markup.
export const LAYOUT_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;

export const LAYOUT_FIELD_TYPES = ['text', 'image'] as const;
export type LayoutFieldType = (typeof LAYOUT_FIELD_TYPES)[number];

export const IMAGE_FITS = ['cover', 'contain', 'fill'] as const;
export type ImageFit = (typeof IMAGE_FITS)[number];

export const TEXT_ALIGNS = ['left', 'center', 'right'] as const;
export type TextAlign = (typeof TEXT_ALIGNS)[number];

export const TEXT_VALIGNS = ['top', 'middle', 'bottom'] as const;
export type TextValign = (typeof TEXT_VALIGNS)[number];

// What a layout can draw, and so what the renderer can decode. GIF is left out
// for the reason the 3D studio leaves it out: an animated image has no single
// frame to print.
export const LAYOUT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml'] as const;

// The font formats the API recognises, and the ones opentype.js parses. WOFF2
// is absent because it needs a Brotli decoder the renderer does not carry.
export const FONT_CONTENT_TYPES = ['font/ttf', 'font/otf', 'font/woff'] as const;

export function isLayoutImageType(contentType: string): boolean {
  return (LAYOUT_IMAGE_TYPES as readonly string[]).includes(contentType);
}

export function isFontType(contentType: string): boolean {
  return (FONT_CONTENT_TYPES as readonly string[]).includes(contentType);
}

// x, y, width, height from the card's top-left corner.
export type LayoutBox = [number, number, number, number];

interface ElementBase {
  box: LayoutBox;
  // Drawn only when this field has a non-empty value: the cost badge on the
  // cards that have a cost.
  when: string | null;
}

// Named by `from` rather than told apart by which key is present: a union of
// two objects distinguished only by their keys is one ArkType cannot decide.
export type ImageSource = { from: 'field'; field: string } | { from: 'file'; file_id: string };

export interface ImageElement extends ElementBase {
  type: 'image';
  source: ImageSource;
  fit: ImageFit;
}

export interface RectElement extends ElementBase {
  type: 'rect';
  fill: string | null;
  stroke: string | null;
  stroke_mm: number;
  radius_mm: number;
  opacity: number;
}

export interface TextElement extends ElementBase {
  type: 'text';
  // `{{field}}` placeholders, filled before the markup is read.
  text: string;
  font: string;
  bold_font: string | null;
  size_pt: number;
  // Text that does not fit at size_pt is shrunk towards this. Equal to size_pt
  // means the text never shrinks.
  min_size_pt: number;
  line_height: number;
  color: string;
  align: TextAlign;
  valign: TextValign;
}

export type LayoutElement = ImageElement | RectElement | TextElement;

export interface LayoutField {
  type: LayoutFieldType;
}

export interface LayoutSpec {
  dpi: number;
  fonts: Record<string, string>;
  icons: Record<string, string>;
  fields: Record<string, LayoutField>;
  elements: LayoutElement[];
}

// A card's own values, by field key: text for a text field, a file id for an
// image field.
export type CardFields = Record<string, string>;

export const MM_PER_PT = 25.4 / 72;

export function pixelSize(mm: number, dpi: number): number {
  return Math.max(1, Math.round((mm / 25.4) * dpi));
}

// ---------------------------------------------------------------------------
// Templates

const PLACEHOLDER = /\{\{\s*([^{}\s]+)\s*\}\}/g;

export function templateFields(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1]!);
}

// One pass, so a value that happens to contain `{{x}}` is printed as written
// rather than filled a second time.
export function fillTemplate(template: string, fields: CardFields): string {
  return template.replace(PLACEHOLDER, (_whole, key: string) => fields[key] ?? '');
}

export function hasValue(fields: CardFields, key: string): boolean {
  return (fields[key] ?? '').trim() !== '';
}

// ---------------------------------------------------------------------------
// Markup: `{icon}`, `**bold**`, newlines, and a backslash to print any of
// `{`, `}`, `*` or `\` as itself.

export type MarkupRun =
  { kind: 'text'; text: string; bold: boolean } | { kind: 'icon'; key: string } | { kind: 'break' };

export interface ParsedMarkup {
  runs: MarkupRun[];
  errors: string[];
}

export function parseMarkup(source: string): ParsedMarkup {
  const runs: MarkupRun[] = [];
  const errors: string[] = [];
  let bold = false;
  let buffer = '';

  const flush = () => {
    if (buffer === '') return;
    const last = runs.at(-1);
    if (last?.kind === 'text' && last.bold === bold) last.text += buffer;
    else runs.push({ kind: 'text', text: buffer, bold });
    buffer = '';
  };

  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (char === '\\') {
      const next = source[i + 1];
      if (next !== undefined && '{}*\\'.includes(next)) {
        buffer += next;
        i += 1;
      } else {
        buffer += char;
      }
    } else if (char === '\r') {
      continue;
    } else if (char === '\n') {
      flush();
      runs.push({ kind: 'break' });
    } else if (char === '*' && source[i + 1] === '*') {
      flush();
      bold = !bold;
      i += 1;
    } else if (char === '{') {
      const close = source.indexOf('}', i + 1);
      const key = close === -1 ? null : source.slice(i + 1, close);
      if (key === null || !LAYOUT_KEY_PATTERN.test(key)) {
        errors.push(
          `"{" at character ${String(i + 1)} does not start an icon like {coin}; write \\{ for a literal brace`
        );
        buffer += char;
      } else {
        flush();
        runs.push({ kind: 'icon', key });
        i = close;
      }
    } else {
      buffer += char;
    }
  }
  flush();
  if (bold) errors.push('a ** opens bold text that is never closed');
  return { runs, errors };
}

// Everything wrong with one piece of copy against the icons a layout declares,
// worded for whoever typed it.
export function markupErrors(source: string, iconKeys: Iterable<string>): string[] {
  const icons = new Set(iconKeys);
  const { runs, errors } = parseMarkup(source);
  const unknown = new Set<string>();
  for (const run of runs) {
    if (run.kind === 'icon' && !icons.has(run.key)) unknown.add(run.key);
  }
  for (const key of unknown) errors.push(`{${key}} is not one of this layout's icons`);
  return errors;
}

// ---------------------------------------------------------------------------
// References

// Everything a layout names by key has to be something the same layout
// declares. The schema checks each value's shape; this checks that the values
// agree with one another, which a schema of one field at a time cannot.
export function layoutReferenceErrors(spec: LayoutSpec): string[] {
  const errors: string[] = [];
  const fields = spec.fields;
  const declared = (key: string) => Object.hasOwn(fields, key);

  const caps = {
    fields: LAYOUT_LIMITS.max_fields,
    fonts: LAYOUT_LIMITS.max_fonts,
    icons: LAYOUT_LIMITS.max_icons,
  } as const;
  for (const group of ['fields', 'fonts', 'icons'] as const) {
    const keys = Object.keys(spec[group]);
    if (keys.length > caps[group]) {
      errors.push(
        `a layout has at most ${String(caps[group])} ${group}, and this one has ${String(keys.length)}`
      );
    }
    for (const key of keys) {
      if (!LAYOUT_KEY_PATTERN.test(key)) {
        errors.push(
          `${group} key "${key}" must be lower-case letters, digits, - or _, starting with a letter`
        );
      }
    }
  }

  spec.elements.forEach((element, index) => {
    const where = `element ${String(index + 1)} (${element.type})`;
    if (element.when !== null && !declared(element.when)) {
      errors.push(`${where}: when names "${element.when}", which is not a field`);
    }
    const [, , width, height] = element.box;
    if (width <= 0 || height <= 0) errors.push(`${where}: box width and height must be positive`);

    if (element.type === 'image' && element.source.from === 'field') {
      const key = element.source.field;
      if (!declared(key)) errors.push(`${where}: source names "${key}", which is not a field`);
      else if (fields[key]!.type !== 'image') {
        errors.push(`${where}: source field "${key}" is a text field, not an image`);
      }
    }

    if (element.type === 'text') {
      for (const key of templateFields(element.text)) {
        if (!declared(key)) errors.push(`${where}: {{${key}}} is not a field`);
        else if (fields[key]!.type !== 'text') {
          errors.push(`${where}: {{${key}}} is an image field and cannot be printed as text`);
        }
      }
      // The template's own literal copy is markup too, checked with the
      // placeholders emptied so a value's braces are not blamed on it.
      for (const message of markupErrors(fillTemplate(element.text, {}), Object.keys(spec.icons))) {
        errors.push(`${where}: ${message}`);
      }
      if (!Object.hasOwn(spec.fonts, element.font)) {
        errors.push(`${where}: font "${element.font}" is not one of this layout's fonts`);
      }
      if (element.bold_font !== null && !Object.hasOwn(spec.fonts, element.bold_font)) {
        errors.push(`${where}: bold_font "${element.bold_font}" is not one of this layout's fonts`);
      }
      if (element.min_size_pt > element.size_pt) {
        errors.push(`${where}: min_size_pt is larger than size_pt`);
      }
    }
  });
  return errors;
}

// Every file a layout itself names: its fonts, its icons, and its fixed images.
export function layoutFileIds(spec: LayoutSpec): string[] {
  const ids = [...Object.values(spec.fonts), ...Object.values(spec.icons)];
  for (const element of spec.elements) {
    if (element.type === 'image' && element.source.from === 'file')
      ids.push(element.source.file_id);
  }
  return [...new Set(ids)];
}

// Everything wrong with one card's values against its layout, before any file
// id has been looked up: unknown keys, over-long values, and copy whose markup
// names an icon the layout lacks.
export function cardFieldErrors(spec: LayoutSpec, values: CardFields): string[] {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const field = spec.fields[key];
    if (field === undefined || !Object.hasOwn(spec.fields, key)) {
      errors.push(`"${key}" is not a field of this layout`);
      continue;
    }
    if (value.length > LAYOUT_LIMITS.max_field_value_length) {
      errors.push(
        `${key} is longer than ${String(LAYOUT_LIMITS.max_field_value_length)} characters`
      );
    }
    if (field.type === 'text') {
      for (const message of markupErrors(value, Object.keys(spec.icons))) {
        errors.push(`${key}: ${message}`);
      }
    }
  }
  return errors;
}

// The file ids a card's image fields name, the empty ones left out.
export function cardImageIds(spec: LayoutSpec, values: CardFields): string[] {
  return Object.entries(values)
    .filter(([key, value]) => spec.fields[key]?.type === 'image' && value.trim() !== '')
    .map(([, value]) => value);
}
