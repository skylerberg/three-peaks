import { Hono } from 'hono';
import { describeRoute, resolver } from 'hono-openapi';
import { sql } from 'kysely';
import { type ComponentKind, defaultSettingsFor } from '@three-peaks/shared';
import {
  assertComponentAccess,
  assertProjectAccess,
  assertProjectWrite,
} from '../services/authorization.ts';
import {
  liveComponentOrder,
  listComponents,
  nextComponentPosition,
  readComponent,
} from '../services/components.ts';
import { ownedStorageKeys } from '../services/files.ts';
import { publishAfterCommit } from '../services/realtime/index.ts';
import { deleteStoredObjectsAfterCommit } from '../services/storage/index.ts';
import { jsonValidator, queryValidator } from '../middleware/validators.ts';
import { AppError, isUniqueViolation } from '../utils/errors.ts';
import { newId } from '../utils/uuid.ts';
import {
  type ComponentSettings,
  componentListSchema,
  componentQuerySchema,
  componentSchema,
  createComponentRequestSchema,
  putComponentOrderRequestSchema,
  updateComponentRequestSchema,
} from '../schemas/components.ts';
import { purgeQuerySchema } from '../schemas/files.ts';
import {
  conflictErrorResponse,
  forbiddenErrorResponse,
  internalServerErrorResponse,
  notFoundErrorResponse,
  unauthorizedErrorResponse,
  validationErrorResponse,
} from '../schemas/errors.ts';
import type { AppHono } from '../types/index.ts';

export const componentsRouter: AppHono = new Hono();

const standardErrors = {
  ...unauthorizedErrorResponse,
  ...notFoundErrorResponse,
  ...internalServerErrorResponse,
};

// Only the literal word, the way a file purge reads it.
function purgeRequested(query: { purge?: string }): boolean {
  return query.purge === 'true';
}

componentsRouter.get(
  '/',
  describeRoute({
    tags: ['Components'],
    summary: 'List a project’s components',
    description:
      'Optionally narrowed to one kind, which is what a section screen asks for. Each row carries its own files, so a section draws its thumbnails without a request per component.',
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Components',
        content: { 'application/json': { schema: resolver(componentListSchema) } },
      },
      ...standardErrors,
    },
  }),
  queryValidator(componentQuerySchema),
  async (c) => {
    const query = c.req.valid('query') as { project_id: string; kind?: ComponentKind };
    await assertProjectAccess(c, query.project_id);
    return c.json({ components: await listComponents(c, query.project_id, query.kind) });
  }
);

componentsRouter.post(
  '/',
  describeRoute({
    tags: ['Components'],
    summary: 'Create a component',
    description:
      'Starts with no artwork: a component is named first and its images are uploaded into it afterwards, which is what `missing_roles` on the response reports. Settings default to the studio’s own defaults for the kind.',
    security: [{ bearerAuth: [] }],
    responses: {
      201: {
        description: 'Created',
        content: { 'application/json': { schema: resolver(componentSchema) } },
      },
      ...conflictErrorResponse,
      ...forbiddenErrorResponse,
      ...validationErrorResponse,
      ...standardErrors,
    },
  }),
  jsonValidator(createComponentRequestSchema),
  async (c) => {
    const body = c.req.valid('json') as {
      id?: string;
      project_id: string;
      kind: ComponentKind;
      name: string;
      settings?: ComponentSettings;
    };
    await assertProjectWrite(c, body.project_id);

    // defaultSettingsFor is typed against shared's looser union, and every value
    // it returns is inside the schema's -- the colours it names are literals.
    const settings = body.settings ?? (defaultSettingsFor(body.kind) as ComponentSettings);
    // The column and the blob are pinned to each other by a CHECK, so a
    // disagreement is a 422 here rather than a constraint violation the client
    // cannot read.
    if (settings.kind !== body.kind) {
      throw new AppError(422, `Those settings are for a ${settings.kind}, not a ${body.kind}`);
    }

    const id = body.id ?? newId();
    try {
      await c
        .get('db')
        .insertInto('component')
        .values({
          id,
          project_id: body.project_id,
          kind: body.kind,
          name: body.name,
          position: await nextComponentPosition(c.get('db'), body.project_id, body.kind),
          settings,
          created_by: c.get('user').id,
        })
        .execute();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError(409, 'A component with that id or name already exists in this project');
      }
      throw error;
    }

    const created = await readComponent(c, id);
    publishAfterCommit(
      c.get('postCommitHooks'),
      c.get('user').id,
      'component_created',
      body.project_id,
      created
    );
    return c.json(created, 201);
  }
);

componentsRouter.put(
  '/order',
  describeRoute({
    tags: ['Components'],
    summary: 'Reorder a section',
    description:
      'The whole ordered list of one kind in one request, the way a deck’s cards are replaced. The ids have to be exactly the section’s live components, each once: a reorder arranges what is there and can neither add nor remove anything, so anything else is a client working from a listing that has moved on.',
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The section in its new order',
        content: { 'application/json': { schema: resolver(componentListSchema) } },
      },
      ...forbiddenErrorResponse,
      ...validationErrorResponse,
      ...standardErrors,
    },
  }),
  jsonValidator(putComponentOrderRequestSchema),
  async (c) => {
    const body = c.req.valid('json') as {
      project_id: string;
      kind: ComponentKind;
      component_ids: string[];
    };
    await assertProjectWrite(c, body.project_id);
    const db = c.get('db');

    const held = await liveComponentOrder(db, body.project_id, body.kind);
    const wanted = body.component_ids;
    const holds = new Map(held.map((row) => [row.id, row.position]));
    if (
      new Set(wanted).size !== wanted.length ||
      wanted.length !== held.length ||
      wanted.some((id) => !holds.has(id))
    ) {
      throw new AppError(
        422,
        'The order has to name each of this section’s components exactly once'
      );
    }

    // Only the rows that move, so a list dropped back where it came from writes
    // nothing and announces nothing -- which is what most drags end as.
    const moved = wanted
      .map((id, position) => ({ id, position }))
      .filter((row) => holds.get(row.id) !== row.position);

    if (moved.length > 0) {
      // `position` and nothing else, for the reason orderDeckToExport gives at
      // its own statement: a position is an index into one list rather than a
      // fact about the row, and writing the rest would take locks this has no
      // business taking.
      await sql`
        update component set position = place.position
        from (values ${sql.join(
          moved.map((row) => sql`(${row.id}::uuid, ${row.position}::int)`)
        )}) as place(id, position)
        where component.id = place.id
      `.execute(db);
    }

    const components = await listComponents(c, body.project_id, body.kind);
    if (moved.length > 0) {
      // The section as it now stands, because that is what the screen draws --
      // a list of ids would send every client that has it open back for the
      // rows they already hold.
      publishAfterCommit(
        c.get('postCommitHooks'),
        c.get('user').id,
        'component_order_changed',
        body.project_id,
        { kind: body.kind, components }
      );
    }
    return c.json({ components });
  }
);

componentsRouter.get(
  '/:componentId',
  describeRoute({
    tags: ['Components'],
    summary: 'Get one component',
    description:
      'Including a tombstoned one: its settings and its artwork are what somebody deciding whether to restore it reads first.',
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The component',
        content: { 'application/json': { schema: resolver(componentSchema) } },
      },
      ...standardErrors,
    },
  }),
  async (c) => {
    const componentId = c.req.param('componentId');
    await assertComponentAccess(c, componentId, 'read');
    return c.json(await readComponent(c, componentId));
  }
);

componentsRouter.patch(
  '/:componentId',
  describeRoute({
    tags: ['Components'],
    summary: 'Rename a component or save its settings',
    description:
      'Editors only. Both fields are optional; an absent one is left alone. Allowed on a tombstoned component, the way a deleted file’s 3D settings are — a component’s dial-in is not its contents.',
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Updated',
        content: { 'application/json': { schema: resolver(componentSchema) } },
      },
      ...conflictErrorResponse,
      ...forbiddenErrorResponse,
      ...validationErrorResponse,
      ...standardErrors,
    },
  }),
  jsonValidator(updateComponentRequestSchema),
  async (c) => {
    const componentId = c.req.param('componentId');
    const access = await assertComponentAccess(c, componentId, 'write');
    const body = c.req.valid('json') as { name?: string; settings?: ComponentSettings };
    const db = c.get('db');

    const current = await db
      .selectFrom('component')
      .select(['component.kind as kind'])
      .where('component.id', '=', componentId)
      .executeTakeFirst();
    if (!current) throw new AppError(404, 'Component not found');

    if (body.settings !== undefined && body.settings.kind !== current.kind) {
      throw new AppError(
        422,
        `Those settings are for a ${body.settings.kind}, not a ${current.kind}`
      );
    }

    try {
      await db
        .updateTable('component')
        .set({
          ...(body.name !== undefined && { name: body.name }),
          ...(body.settings !== undefined && { settings: body.settings }),
          updated_at: new Date(),
        })
        .where('component.id', '=', componentId)
        .execute();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError(409, 'A component with that name already exists in this project');
      }
      throw error;
    }

    const updated = await readComponent(c, componentId);
    publishAfterCommit(
      c.get('postCommitHooks'),
      c.get('user').id,
      'component_updated',
      access.projectId,
      updated
    );
    return c.json(updated);
  }
);

componentsRouter.delete(
  '/:componentId',
  describeRoute({
    tags: ['Components'],
    summary: 'Delete a component',
    description:
      'Soft by default: the component is tombstoned and its artwork keeps every byte, so restoring it is exact. `purge=true` is the irreversible one — it takes the artwork with it and reclaims every stored object. Only the literal word is accepted.',
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'Deleted' },
      ...forbiddenErrorResponse,
      ...standardErrors,
    },
  }),
  queryValidator(purgeQuerySchema),
  async (c) => {
    const componentId = c.req.param('componentId');
    const access = await assertComponentAccess(c, componentId, 'write');
    const db = c.get('db');

    if (!purgeRequested(c.req.valid('query') as { purge?: string })) {
      // Only this row. Its files are never marked: visibility is derived from
      // the component above them, so restoring it is symmetric with deleting it
      // rather than resurrecting artwork somebody deleted beforehand.
      // A repeat delete leaves the first one's record intact.
      const marked = await db
        .updateTable('component')
        .set({ deleted_at: new Date(), deleted_by: c.get('user').id })
        .where('component.id', '=', componentId)
        .where('component.deleted_at', 'is', null)
        .returning(['component.id as id'])
        .executeTakeFirst();

      if (marked) {
        publishAfterCommit(
          c.get('postCommitHooks'),
          c.get('user').id,
          'component_deleted',
          access.projectId,
          { ...(await readComponent(c, componentId)), purged: false }
        );
      }
      return c.body(null, 204);
    }

    // Before the delete: the cascade takes the file rows with the component and
    // nothing else names the objects they point at.
    const keys = await ownedStorageKeys(db, { componentId });
    const doomed = await readComponent(c, componentId);

    await db.deleteFrom('component').where('component.id', '=', componentId).execute();

    deleteStoredObjectsAfterCommit(c.get('postCommitHooks'), keys);
    publishAfterCommit(
      c.get('postCommitHooks'),
      c.get('user').id,
      'component_deleted',
      access.projectId,
      { ...doomed, purged: true }
    );
    return c.body(null, 204);
  }
);

componentsRouter.post(
  '/:componentId/restore',
  describeRoute({
    tags: ['Components'],
    summary: 'Restore a deleted component',
    description:
      'Brings the component back with whatever artwork it still has. Artwork deleted on its own stays deleted — a tombstone above a row is not a tombstone on it. Restoring a live component answers 200 and changes nothing.',
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Restored',
        content: { 'application/json': { schema: resolver(componentSchema) } },
      },
      ...conflictErrorResponse,
      ...forbiddenErrorResponse,
      ...standardErrors,
    },
  }),
  async (c) => {
    const componentId = c.req.param('componentId');
    const access = await assertComponentAccess(c, componentId, 'write');

    try {
      await c
        .get('db')
        .updateTable('component')
        .set({ deleted_at: null, deleted_by: null, updated_at: new Date() })
        .where('component.id', '=', componentId)
        .execute();
    } catch (error) {
      // The name it had may have been taken while it was gone.
      if (isUniqueViolation(error)) {
        throw new AppError(409, 'A component with that name already exists in this project');
      }
      throw error;
    }

    const restored = await readComponent(c, componentId);
    publishAfterCommit(
      c.get('postCommitHooks'),
      c.get('user').id,
      'component_updated',
      access.projectId,
      restored
    );
    return c.json(restored);
  }
);
