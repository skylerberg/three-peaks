import { parse, stringify } from 'yaml';
import {
  CARD_PRESETS,
  IMAGE_FITS,
  LAYOUT_FIELD_TYPES,
  TEXT_ALIGNS,
  TEXT_VALIGNS,
  matchingCardPreset,
  type CardFields,
  type LayoutElement,
  type LayoutSpec,
} from '@three-peaks/shared';
import { CliError, EXIT } from '../errors.ts';

// The two files a person writes: a layout, and a deck's cards. Both name files
// the way the rest of the CLI does -- an Assets path or an id -- where the
// stored forms hold ids alone, and both leave settings out that the stored form
// spells out. This module is the whole of that translation, and the defaults
// below are the only defaults there are.

const DEFAULT_DPI = 300;
const DEFAULT_LINE_HEIGHT = 1.2;
const DEFAULT_COLOR = '#000000';
const DEFAULT_STROKE_MM = 0.25;

// A layout as written, its file references not yet looked up.
export interface LayoutDocument {
  name: string;
  width_mm: number;
  height_mm: number;
  spec: LayoutSpec;
}

export interface CardEntry {
  name: string;
  layout: string;
  copies: number | null;
  fields: CardFields;
}

class Reader {
  readonly errors: string[] = [];
  constructor(private readonly source: string) {}

  fail(): never {
    const shown = this.errors.slice(0, 20);
    const more = this.errors.length - shown.length;
    throw new CliError(
      [
        `${this.source} is not valid:`,
        ...shown.map((e) => `  ${e}`),
        ...(more > 0 ? [`  ...and ${String(more)} more`] : []),
      ].join('\n'),
      EXIT.invalid
    );
  }

  object(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> | null {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      this.errors.push(`${path} must be a mapping`);
      return null;
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!allowed.includes(key)) {
        this.errors.push(
          `${path === '' ? key : `${path}.${key}`} is not a setting here (expected one of ${allowed.join(', ')})`
        );
      }
    }
    return record;
  }

  map(value: unknown, path: string): Record<string, unknown> {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) {
      this.errors.push(`${path} must be a mapping`);
      return {};
    }
    return value as Record<string, unknown>;
  }

  string(value: unknown, path: string): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    this.errors.push(`${path} must be text`);
    return '';
  }

  // A missing value is one complaint, not that plus one about its type.
  required(record: Record<string, unknown>, key: string, path: string): unknown {
    if (record[key] === undefined || record[key] === null) {
      this.errors.push(`${path === '' ? key : `${path}.${key}`} is required`);
      return undefined;
    }
    return record[key];
  }

  requiredString(record: Record<string, unknown>, key: string, path: string): string {
    const value = this.required(record, key, path);
    return value === undefined ? '' : this.string(value, path === '' ? key : `${path}.${key}`);
  }

  requiredNumber(record: Record<string, unknown>, key: string, path: string): number {
    const value = this.required(record, key, path);
    return value === undefined ? 0 : this.number(value, `${path}.${key}`);
  }

  number(value: unknown, path: string, fallback?: number): number {
    if (value === undefined && fallback !== undefined) return fallback;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    this.errors.push(`${path} must be a number`);
    return 0;
  }

  choice<T extends string>(value: unknown, path: string, options: readonly T[], fallback: T): T {
    if (value === undefined) return fallback;
    if (typeof value === 'string' && (options as readonly string[]).includes(value))
      return value as T;
    this.errors.push(`${path} must be one of ${options.join(', ')}`);
    return fallback;
  }

  color(value: unknown, path: string, fallback: string | null): string | null {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'string') {
      const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
      if (short !== null)
        return `#${short
          .slice(1)
          .map((c) => c + c)
          .join('')}`.toLowerCase();
      if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
    }
    this.errors.push(`${path} must be a colour like #1a2b3c`);
    return fallback;
  }
}

function parseYaml(text: string, source: string): unknown {
  try {
    return parse(text);
  } catch (err) {
    throw new CliError(`${source} is not YAML: ${(err as Error).message}`, EXIT.invalid);
  }
}

const ELEMENT_KEYS = {
  image: ['type', 'box', 'when', 'file', 'field', 'fit'],
  rect: ['type', 'box', 'when', 'fill', 'stroke', 'stroke_mm', 'radius_mm', 'opacity'],
  text: [
    'type',
    'box',
    'when',
    'text',
    'font',
    'bold_font',
    'size_pt',
    'min_size_pt',
    'line_height',
    'color',
    'align',
    'valign',
  ],
} as const;

function readElement(r: Reader, value: unknown, path: string): LayoutElement | null {
  const peek = r.map(value, path);
  const kind = peek.type;
  if (kind !== 'image' && kind !== 'rect' && kind !== 'text') {
    r.errors.push(`${path}.type must be image, rect or text`);
    return null;
  }
  const record = r.object(value, path, ELEMENT_KEYS[kind]);
  if (record === null) return null;

  const rawBox = r.required(record, 'box', path);
  let box: [number, number, number, number] = [0, 0, 0, 0];
  if (Array.isArray(rawBox) && rawBox.length === 4) {
    box = rawBox.map((v, i) => r.number(v, `${path}.box[${String(i)}]`)) as typeof box;
  } else if (rawBox !== undefined) {
    r.errors.push(`${path}.box must be [x, y, width, height] in millimetres`);
  }
  const when =
    record.when === undefined || record.when === null
      ? null
      : r.string(record.when, `${path}.when`);

  if (kind === 'image') {
    const hasFile = record.file !== undefined;
    const hasField = record.field !== undefined;
    if (hasFile === hasField) {
      r.errors.push(`${path} needs exactly one of file (a fixed image) or field (each card's own)`);
    }
    return {
      type: 'image',
      box,
      when,
      source: hasField
        ? { from: 'field', field: r.string(record.field, `${path}.field`) }
        : { from: 'file', file_id: r.string(record.file, `${path}.file`) },
      fit: r.choice(record.fit, `${path}.fit`, IMAGE_FITS, 'cover'),
    };
  }
  if (kind === 'rect') {
    const stroke = r.color(record.stroke, `${path}.stroke`, null);
    return {
      type: 'rect',
      box,
      when,
      fill: r.color(record.fill, `${path}.fill`, null),
      stroke,
      stroke_mm: r.number(
        record.stroke_mm,
        `${path}.stroke_mm`,
        stroke === null ? 0 : DEFAULT_STROKE_MM
      ),
      radius_mm: r.number(record.radius_mm, `${path}.radius_mm`, 0),
      opacity: r.number(record.opacity, `${path}.opacity`, 1),
    };
  }
  const size = r.requiredNumber(record, 'size_pt', path);
  return {
    type: 'text',
    box,
    when,
    text: r.requiredString(record, 'text', path),
    font: r.requiredString(record, 'font', path),
    bold_font:
      record.bold_font === undefined || record.bold_font === null
        ? null
        : r.string(record.bold_font, `${path}.bold_font`),
    size_pt: size,
    min_size_pt: r.number(record.min_size_pt, `${path}.min_size_pt`, size),
    line_height: r.number(record.line_height, `${path}.line_height`, DEFAULT_LINE_HEIGHT),
    color: r.color(record.color, `${path}.color`, DEFAULT_COLOR)!,
    align: r.choice(record.align, `${path}.align`, TEXT_ALIGNS, 'left'),
    valign: r.choice(record.valign, `${path}.valign`, TEXT_VALIGNS, 'top'),
  };
}

// The layout with every font, icon and fixed image still named as written.
// `resolveLayoutFiles` turns those names into ids.
export function readLayoutDocument(text: string, source: string): LayoutDocument {
  const r: Reader = new Reader(source);
  const root = r.object(parseYaml(text, source), '', [
    'name',
    'size',
    'width_mm',
    'height_mm',
    'dpi',
    'fonts',
    'icons',
    'fields',
    'elements',
  ]);
  if (root === null) r.fail();

  const name = r.requiredString(root, 'name', '').trim();
  let width = 0;
  let height = 0;
  if (root.size !== undefined) {
    if (root.width_mm !== undefined || root.height_mm !== undefined) {
      r.errors.push('give size or width_mm and height_mm, not both');
    }
    const preset = CARD_PRESETS.find((p) => p.id === root.size);
    if (preset === undefined) {
      r.errors.push(`size must be one of ${CARD_PRESETS.map((p) => p.id).join(', ')}`);
    } else {
      width = preset.width_mm;
      height = preset.height_mm;
    }
  } else {
    width = r.number(root.width_mm, 'width_mm');
    height = r.number(root.height_mm, 'height_mm');
  }

  const strings = (value: unknown, path: string) =>
    Object.fromEntries(
      Object.entries(r.map(value, path)).map(([key, v]) => [key, r.string(v, `${path}.${key}`)])
    );
  const fields = Object.fromEntries(
    Object.entries(r.map(root.fields, 'fields')).map(([key, v]) => [
      key,
      { type: r.choice(v, `fields.${key}`, LAYOUT_FIELD_TYPES, 'text') },
    ])
  );
  const rawElements = root.elements ?? [];
  if (!Array.isArray(rawElements)) r.errors.push('elements must be a list');
  const elements = (Array.isArray(rawElements) ? rawElements : [])
    .map((value, index) => readElement(r, value, `elements[${String(index)}]`))
    .filter((element): element is LayoutElement => element !== null);

  const spec: LayoutSpec = {
    dpi: r.number(root.dpi, 'dpi', DEFAULT_DPI),
    fonts: strings(root.fonts, 'fonts'),
    icons: strings(root.icons, 'icons'),
    fields,
    elements,
  };
  if (r.errors.length > 0) r.fail();
  return { name, width_mm: width, height_mm: height, spec };
}

// Every file reference in a layout, run through `resolve` -- which turns a
// name into an id, or an id into a name.
export async function mapLayoutFiles(
  spec: LayoutSpec,
  resolve: (ref: string, what: string) => Promise<string>
): Promise<LayoutSpec> {
  const mapRecord = async (record: Record<string, string>, what: string) =>
    Object.fromEntries(
      await Promise.all(
        Object.entries(record).map(async ([key, ref]) => [
          key,
          await resolve(ref, `${what} "${key}"`),
        ])
      )
    ) as Record<string, string>;
  return {
    ...spec,
    fonts: await mapRecord(spec.fonts, 'font'),
    icons: await mapRecord(spec.icons, 'icon'),
    elements: await Promise.all(
      spec.elements.map(async (element, index) =>
        element.type === 'image' && element.source.from === 'file'
          ? {
              ...element,
              source: {
                from: 'file' as const,
                file_id: await resolve(
                  element.source.file_id,
                  `element ${String(index + 1)} (image)`
                ),
              },
            }
          : element
      )
    ),
  };
}

function writeElement(element: LayoutElement): Record<string, unknown> {
  const out: Record<string, unknown> = { type: element.type, box: element.box };
  if (element.when !== null) out.when = element.when;
  if (element.type === 'image') {
    if (element.source.from === 'file') out.file = element.source.file_id;
    else out.field = element.source.field;
    if (element.fit !== 'cover') out.fit = element.fit;
  } else if (element.type === 'rect') {
    if (element.fill !== null) out.fill = element.fill;
    if (element.stroke !== null) out.stroke = element.stroke;
    const strokeDefault = element.stroke === null ? 0 : DEFAULT_STROKE_MM;
    if (element.stroke_mm !== strokeDefault) out.stroke_mm = element.stroke_mm;
    if (element.radius_mm !== 0) out.radius_mm = element.radius_mm;
    if (element.opacity !== 1) out.opacity = element.opacity;
  } else {
    out.text = element.text;
    out.font = element.font;
    if (element.bold_font !== null) out.bold_font = element.bold_font;
    out.size_pt = element.size_pt;
    if (element.min_size_pt !== element.size_pt) out.min_size_pt = element.min_size_pt;
    if (element.line_height !== DEFAULT_LINE_HEIGHT) out.line_height = element.line_height;
    if (element.color !== DEFAULT_COLOR) out.color = element.color;
    if (element.align !== 'left') out.align = element.align;
    if (element.valign !== 'top') out.valign = element.valign;
  }
  return out;
}

// The layout as a person would write it: defaults left out, files named by
// whatever `mapLayoutFiles` was handed. Reading this back gives the same spec.
export function writeLayoutDocument(document: LayoutDocument): string {
  const preset = matchingCardPreset(document);
  const out: Record<string, unknown> = { name: document.name };
  if (preset !== undefined) out.size = preset.id;
  else {
    out.width_mm = document.width_mm;
    out.height_mm = document.height_mm;
  }
  const { spec } = document;
  if (spec.dpi !== DEFAULT_DPI) out.dpi = spec.dpi;
  if (Object.keys(spec.fonts).length > 0) out.fonts = spec.fonts;
  if (Object.keys(spec.icons).length > 0) out.icons = spec.icons;
  if (Object.keys(spec.fields).length > 0) {
    out.fields = Object.fromEntries(
      Object.entries(spec.fields).map(([key, field]) => [key, field.type])
    );
  }
  out.elements = spec.elements.map(writeElement);
  return stringify(out, { lineWidth: 0 });
}

// A deck's cards as written: an optional layout every card uses unless it
// names its own, and per card its name, its fields and optionally its copies.
export function readCardsDocument(text: string, source: string): CardEntry[] {
  const r: Reader = new Reader(source);
  const root = r.object(parseYaml(text, source), '', ['layout', 'cards']);
  if (root === null) r.fail();
  const fallback = root.layout === undefined ? null : r.string(root.layout, 'layout');
  const raw = root.cards ?? [];
  if (!Array.isArray(raw)) r.errors.push('cards must be a list');

  const seen = new Set<string>();
  const cards = (Array.isArray(raw) ? raw : []).flatMap((value, index): CardEntry[] => {
    const path = `cards[${String(index)}]`;
    const record = r.object(value, path, ['name', 'layout', 'copies', 'fields']);
    if (record === null) return [];
    const name = r.requiredString(record, 'name', path).trim();
    if (seen.has(name.toLowerCase())) r.errors.push(`${path}.name: ${name} is listed twice`);
    seen.add(name.toLowerCase());
    const layout =
      record.layout === undefined ? fallback : r.string(record.layout, `${path}.layout`);
    if (layout === null)
      r.errors.push(`${path} names no layout, and the file gives none for every card`);
    let copies: number | null = null;
    if (record.copies !== undefined) {
      copies = r.number(record.copies, `${path}.copies`);
      if (!Number.isInteger(copies) || copies < 0)
        r.errors.push(`${path}.copies must be a whole number`);
    }
    const fields = Object.fromEntries(
      Object.entries(r.map(record.fields, `${path}.fields`)).map(([key, v]) => [
        key,
        v === null ? '' : r.string(v, `${path}.fields.${key}`),
      ])
    );
    return [{ name, layout: layout ?? '', copies, fields }];
  });
  if (r.errors.length > 0) r.fail();
  return cards;
}

export function writeCardsDocument(cards: readonly CardEntry[]): string {
  const layouts = new Set(cards.map((card) => card.layout));
  const shared = layouts.size === 1 ? [...layouts][0]! : null;
  const out: Record<string, unknown> = {};
  if (shared !== null) out.layout = shared;
  out.cards = cards.map((card) => {
    const entry: Record<string, unknown> = { name: card.name };
    if (shared === null) entry.layout = card.layout;
    if (card.copies !== null) entry.copies = card.copies;
    entry.fields = card.fields;
    return entry;
  });
  return stringify(out, { lineWidth: 0 });
}
