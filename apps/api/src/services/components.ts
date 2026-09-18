import { type ComponentFileRole, type ComponentKind, missingRoles } from '@three-peaks/shared';
import { AppError } from '../utils/errors.ts';
import { FILE_COLUMNS, type FileRow, serializeFile } from './files.ts';
import type { ComponentSettings } from '../schemas/components.ts';
import type { AppContext, Connection } from '../types/index.ts';

// One reader for a component and one for its files, in a service rather than in
// the routes: an event announcing a component has to carry the same row the
// routes answer with, and so does the scene exporter's listing.

interface ComponentRow {
  id: string;
  project_id: string;
  kind: string;
  name: string;
  position: number;
  settings: unknown;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
}

const COMPONENT_COLUMNS = [
  'component.id as id',
  'component.project_id as project_id',
  'component.kind as kind',
  'component.name as name',
  'component.position as position',
  'component.settings as settings',
  'component.created_by as created_by',
  'component.created_at as created_at',
  'component.updated_at as updated_at',
  'component.deleted_at as deleted_at',
] as const;

export interface ComponentFile {
  role: ComponentFileRole;
  file: ReturnType<typeof serializeFile>;
}

function serializeComponent(row: ComponentRow, files: ComponentFile[]) {
  const kind = row.kind as ComponentKind;
  return {
    id: row.id,
    project_id: row.project_id,
    kind: row.kind,
    name: row.name,
    position: row.position,
    settings: row.settings as ComponentSettings,
    created_by: row.created_by,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    deleted_at: row.deleted_at === null ? null : new Date(row.deleted_at).toISOString(),
    files,
    missing_roles: missingRoles(
      kind,
      files.map((entry) => entry.role)
    ),
  };
}

// A tombstoned file stays on the component that owns it, the way a deleted card
// stays in its deck: it is what someone deciding whether to restore it reads.
async function filesFor(db: Connection, componentIds: readonly string[]) {
  if (componentIds.length === 0) return new Map<string, ComponentFile[]>();
  const rows = await db
    .selectFrom('file')
    .select(FILE_COLUMNS)
    .where('file.component_id', 'in', componentIds)
    .orderBy('file.component_role', 'asc')
    .execute();

  const byComponent = new Map<string, ComponentFile[]>();
  for (const row of rows as FileRow[]) {
    const list = byComponent.get(row.component_id ?? '') ?? [];
    list.push({
      role: (row.component_role ?? 'artwork') as ComponentFileRole,
      file: serializeFile(row),
    });
    byComponent.set(row.component_id ?? '', list);
  }
  return byComponent;
}

export async function listComponents(
  c: Pick<AppContext, 'get'>,
  projectId: string,
  kind?: ComponentKind
) {
  const db = c.get('db');
  const rows = await db
    .selectFrom('component')
    .select(COMPONENT_COLUMNS)
    .where('component.project_id', '=', projectId)
    .where('component.deleted_at', 'is', null)
    .$if(kind !== undefined, (qb) => qb.where('component.kind', '=', kind as string))
    .orderBy('component.position', 'asc')
    // A tombstone keeps the position it had, so a restore can collide with
    // whatever took it. The name settles that rather than leaving two rows to
    // arrive in whichever order the plan happened to read them.
    .orderBy('component.name', 'asc')
    .execute();

  const files = await filesFor(
    db,
    rows.map((row) => row.id)
  );
  return rows.map((row) => serializeComponent(row, files.get(row.id) ?? []));
}

export async function readComponent(c: Pick<AppContext, 'get'>, componentId: string) {
  const db = c.get('db');
  const row = await db
    .selectFrom('component')
    .select(COMPONENT_COLUMNS)
    .where('component.id', '=', componentId)
    .executeTakeFirst();
  if (!row) throw new AppError(404, 'Component not found');

  const files = await filesFor(db, [componentId]);
  return serializeComponent(row, files.get(componentId) ?? []);
}

// Where a component created now belongs: after everything its section already
// holds, tombstones included. A restore brings a row back at the position it
// had, so numbering a new one over the top of one that is merely deleted would
// put two components on one number for no reason.
export async function nextComponentPosition(
  db: Connection,
  projectId: string,
  kind: ComponentKind
): Promise<number> {
  const row = await db
    .selectFrom('component')
    .select((eb) => eb.fn.max('component.position').as('highest'))
    .where('component.project_id', '=', projectId)
    .where('component.kind', '=', kind)
    .executeTakeFirst();
  const highest = row?.highest ?? null;
  return highest === null ? 0 : highest + 1;
}

// The rows a section draws, in the order it draws them. A reorder request has
// to name exactly this list, which is what makes the order it sends an
// arrangement of the section rather than a claim about what is in it.
export async function liveComponentOrder(
  db: Connection,
  projectId: string,
  kind: ComponentKind
): Promise<{ id: string; position: number }[]> {
  return db
    .selectFrom('component')
    .select(['component.id as id', 'component.position as position'])
    .where('component.project_id', '=', projectId)
    .where('component.kind', '=', kind)
    .where('component.deleted_at', 'is', null)
    .orderBy('component.position', 'asc')
    .orderBy('component.name', 'asc')
    .execute();
}
