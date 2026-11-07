import {
  type CardFields,
  type LayoutSpec,
  cardFieldErrors,
  cardImageIds,
  isFontType,
  isLayoutImageType,
  layoutReferenceErrors,
} from '@three-peaks/shared';
import { AppError } from '../utils/errors.ts';
import { isValidUuid } from '../utils/uuid.ts';
import type { AppContext } from '../types/index.ts';

// The layouts a card is drawn from, and the per-card values that fill one.
// Nothing here renders: the CLI does, and the API's half is making sure that
// whatever it stores is something the renderer can draw.

interface LayoutRow {
  id: string;
  project_id: string;
  name: string;
  width_mm: string | number;
  height_mm: string | number;
  spec: LayoutSpec;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export const LAYOUT_COLUMNS = [
  'card_layout.id as id',
  'card_layout.project_id as project_id',
  'card_layout.name as name',
  'card_layout.width_mm as width_mm',
  'card_layout.height_mm as height_mm',
  'card_layout.spec as spec',
  'card_layout.created_by as created_by',
  'card_layout.updated_by as updated_by',
  'card_layout.created_at as created_at',
  'card_layout.updated_at as updated_at',
] as const;

export function serializeLayout(row: LayoutRow) {
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    width_mm: Number(row.width_mm),
    height_mm: Number(row.height_mm),
    spec: row.spec,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

export async function readLayout(c: Pick<AppContext, 'get'>, id: string) {
  const row = await c
    .get('db')
    .selectFrom('card_layout')
    .select(LAYOUT_COLUMNS)
    .where('card_layout.id', '=', id)
    .executeTakeFirst();
  if (!row) throw new AppError(404, 'Layout not found');
  return serializeLayout(row);
}

interface ContentRow {
  file_id: string;
  project_id: string;
  layout_id: string;
  fields: CardFields;
  updated_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export const CONTENT_COLUMNS = [
  'card_content.file_id as file_id',
  'card_content.project_id as project_id',
  'card_content.layout_id as layout_id',
  'card_content.fields as fields',
  'card_content.updated_by as updated_by',
  'card_content.created_at as created_at',
  'card_content.updated_at as updated_at',
] as const;

export function serializeContent(row: ContentRow) {
  return {
    file_id: row.file_id,
    project_id: row.project_id,
    layout_id: row.layout_id,
    fields: row.fields,
    updated_by: row.updated_by,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

// The 422 the request validator answers with, so a client reads one shape
// whichever check refused it.
function invalid(error: string, path: string, messages: readonly string[]): AppError {
  return new AppError(422, error, {
    details: messages.map((message) => ({ path, message })),
  });
}

interface ReferencedFile {
  id: string;
  filename: string;
  content_type: string;
  deleted_at: Date | string | null;
}

async function filesInProject(
  c: Pick<AppContext, 'get'>,
  ids: readonly string[],
  projectId: string
): Promise<Map<string, ReferencedFile>> {
  if (ids.length === 0) return new Map();
  const rows = await c
    .get('db')
    .selectFrom('file')
    .select([
      'file.id as id',
      'file.filename as filename',
      'file.content_type as content_type',
      'file.deleted_at as deleted_at',
    ])
    .where('file.id', 'in', [...new Set(ids)])
    .where('file.project_id', '=', projectId)
    .execute();
  return new Map(rows.map((row) => [row.id, row]));
}

// What one referenced file has to be, worded for the person who named it.
function fileErrors(
  what: string,
  id: string,
  file: ReferencedFile | undefined,
  accepts: 'font' | 'image'
): string[] {
  // A file in another project gets the same sentence as one that does not
  // exist, so a layout cannot be used to ask whether an id is real.
  if (file === undefined) return [`${what} must be a file in the same project (${id})`];
  const errors: string[] = [];
  if (file.deleted_at !== null) errors.push(`${what} is ${file.filename}, which is deleted`);
  const fits =
    accepts === 'font' ? isFontType(file.content_type) : isLayoutImageType(file.content_type);
  if (!fits) {
    const expected = accepts === 'font' ? 'a TTF, OTF or WOFF font' : 'a PNG, JPEG or SVG image';
    errors.push(`${what} is ${file.filename}, which is not ${expected}`);
  }
  return errors;
}

// Everything a layout has to satisfy beyond the shape the schema checked: its
// keys agree with one another, and every file it names is a live font or image
// in this project. Deleted files are refused here and only here -- a layout
// already naming one keeps rendering, because the bytes are still stored, but a
// new reference to a tombstone is a trap for whoever restores nothing.
export async function assertValidLayout(
  c: Pick<AppContext, 'get'>,
  projectId: string,
  spec: LayoutSpec
): Promise<void> {
  const errors = layoutReferenceErrors(spec);

  const fixedImages = spec.elements.flatMap((element, index) =>
    element.type === 'image' && element.source.from === 'file'
      ? [{ what: `element ${String(index + 1)} (image)`, id: element.source.file_id }]
      : []
  );
  const wanted = [
    ...Object.entries(spec.fonts).map(([key, id]) => ({
      what: `font "${key}"`,
      id,
      accepts: 'font' as const,
    })),
    ...Object.entries(spec.icons).map(([key, id]) => ({
      what: `icon "${key}"`,
      id,
      accepts: 'image' as const,
    })),
    ...fixedImages.map((entry) => ({ ...entry, accepts: 'image' as const })),
  ];
  const files = await filesInProject(
    c,
    wanted.map((entry) => entry.id),
    projectId
  );
  for (const entry of wanted) {
    errors.push(...fileErrors(entry.what, entry.id, files.get(entry.id), entry.accepts));
  }

  if (errors.length > 0) throw invalid('The layout is invalid', 'spec', errors);
}

// A card's values against its layout: every key is one of the layout's fields,
// its copy names only the layout's icons, and every image is a live picture in
// this project.
export async function assertValidCardFields(
  c: Pick<AppContext, 'get'>,
  projectId: string,
  spec: LayoutSpec,
  fields: CardFields
): Promise<void> {
  const errors = cardFieldErrors(spec, fields);
  // A value that is not an id at all is said so here: handed to the query, it
  // is a uuid cast Postgres refuses, and that surfaces as a 500.
  const imageIds = cardImageIds(spec, fields);
  // Typed out: isValidUuid is a guard, and its negation narrows a string to never.
  const malformed = new Set<string>(imageIds.filter((id) => !isValidUuid(id)));
  const files = await filesInProject(
    c,
    imageIds.filter((id) => !malformed.has(id)),
    projectId
  );
  for (const [key, value] of Object.entries(fields)) {
    if (spec.fields[key]?.type !== 'image' || value.trim() === '') continue;
    if (malformed.has(value)) errors.push(`${key} must be a file id, not "${value}"`);
    else errors.push(...fileErrors(key, value, files.get(value), 'image'));
  }
  if (errors.length > 0) throw invalid("The card's fields are invalid", 'fields', errors);
}
