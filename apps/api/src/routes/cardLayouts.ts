import { Hono } from 'hono';
import { sql } from 'kysely';
import { describeRoute, resolver } from 'hono-openapi';
import type { LayoutSpec } from '@three-peaks/shared';
import {
  assertLayoutAccess,
  assertProjectAccess,
  assertProjectWrite,
} from '../services/authorization.ts';
import {
  LAYOUT_COLUMNS,
  assertValidLayout,
  readLayout,
  serializeLayout,
} from '../services/cardLayouts.ts';
import { jsonValidator, queryValidator } from '../middleware/validators.ts';
import { AppError, isForeignKeyViolation, isUniqueViolation } from '../utils/errors.ts';
import { newId } from '../utils/uuid.ts';
import { projectQuerySchema } from '../schemas/common.ts';
import {
  cardLayoutListSchema,
  cardLayoutSchema,
  cardLayoutWithDecksSchema,
  createCardLayoutRequestSchema,
  putCardLayoutRequestSchema,
} from '../schemas/layouts.ts';
import {
  conflictErrorResponse,
  forbiddenErrorResponse,
  internalServerErrorResponse,
  notFoundErrorResponse,
  unauthorizedErrorResponse,
  validationErrorResponse,
} from '../schemas/errors.ts';
import type { AppHono } from '../types/index.ts';

// No realtime events: no screen draws a layout, and the images rendered from
// one announce themselves as file versions like any other upload.
export const cardLayoutsRouter: AppHono = new Hono();

const standardErrors = {
  ...unauthorizedErrorResponse,
  ...notFoundErrorResponse,
  ...internalServerErrorResponse,
};

const NAME_TAKEN = 'A layout with that id or name already exists in this project';

cardLayoutsRouter.get(
  '/',
  describeRoute({
    tags: ['Layouts'],
    summary: 'List the card layouts in a project',
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Layouts, by name',
        content: { 'application/json': { schema: resolver(cardLayoutListSchema) } },
      },
      ...standardErrors,
    },
  }),
  queryValidator(projectQuerySchema),
  async (c) => {
    const { project_id: projectId } = c.req.valid('query') as { project_id: string };
    await assertProjectAccess(c, projectId);
    const rows = await c
      .get('db')
      .selectFrom('card_layout')
      .select(LAYOUT_COLUMNS)
      .where('card_layout.project_id', '=', projectId)
      .orderBy(sql`lower(card_layout.name)`)
      .execute();
    return c.json({ layouts: rows.map(serializeLayout) });
  }
);

cardLayoutsRouter.post(
  '/',
  describeRoute({
    tags: ['Layouts'],
    summary: 'Create a card layout',
    description:
      'Editors only. Every font, icon and fixed image the layout names must be a live file in the same project, and every key it uses must be one it declares.',
    security: [{ bearerAuth: [] }],
    responses: {
      201: {
        description: 'Created',
        content: { 'application/json': { schema: resolver(cardLayoutSchema) } },
      },
      ...conflictErrorResponse,
      ...forbiddenErrorResponse,
      ...validationErrorResponse,
      ...standardErrors,
    },
  }),
  jsonValidator(createCardLayoutRequestSchema),
  async (c) => {
    const body = c.req.valid('json') as typeof createCardLayoutRequestSchema.infer;
    await assertProjectWrite(c, body.project_id);
    const spec = body.spec as LayoutSpec;
    await assertValidLayout(c, body.project_id, spec);

    const id = body.id ?? newId();
    try {
      await c
        .get('db')
        .insertInto('card_layout')
        .values({
          id,
          project_id: body.project_id,
          name: body.name,
          width_mm: body.width_mm,
          height_mm: body.height_mm,
          spec,
          created_by: c.get('user').id,
          updated_by: c.get('user').id,
        })
        .execute();
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError(409, NAME_TAKEN);
      throw error;
    }
    return c.json(await readLayout(c, id), 201);
  }
);

cardLayoutsRouter.get(
  '/:layoutId',
  describeRoute({
    tags: ['Layouts'],
    summary: 'Get a card layout and the decks drawn from it',
    description:
      'The decks are the live ones holding at least one live card whose content names this layout, with how many such cards each holds -- exactly what has to be re-rendered after the layout changes.',
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The layout',
        content: { 'application/json': { schema: resolver(cardLayoutWithDecksSchema) } },
      },
      ...standardErrors,
    },
  }),
  async (c) => {
    const layoutId = c.req.param('layoutId');
    await assertLayoutAccess(c, layoutId, 'read');
    const [layout, decks] = await Promise.all([
      readLayout(c, layoutId),
      c
        .get('db')
        .selectFrom('card_content')
        .innerJoin('file', 'file.id', 'card_content.file_id')
        .innerJoin('deck', 'deck.id', 'file.deck_id')
        .select(['deck.id as id', 'deck.name as name'])
        .select((eb) => eb.fn.countAll<string>().as('card_count'))
        .where('card_content.layout_id', '=', layoutId)
        .where('file.deleted_at', 'is', null)
        .where('deck.deleted_at', 'is', null)
        .groupBy(['deck.id', 'deck.name'])
        .orderBy(sql`lower(deck.name)`)
        .execute(),
    ]);
    return c.json({
      layout,
      decks: decks.map((deck) => ({ ...deck, card_count: Number(deck.card_count) })),
    });
  }
);

cardLayoutsRouter.put(
  '/:layoutId',
  describeRoute({
    tags: ['Layouts'],
    summary: 'Replace a card layout',
    description:
      "Editors only. The whole layout, validated as on create. Cards already drawn from it are not touched: their images change when they are next rendered, which is the client's to do.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Saved',
        content: { 'application/json': { schema: resolver(cardLayoutSchema) } },
      },
      ...conflictErrorResponse,
      ...forbiddenErrorResponse,
      ...validationErrorResponse,
      ...standardErrors,
    },
  }),
  jsonValidator(putCardLayoutRequestSchema),
  async (c) => {
    const layoutId = c.req.param('layoutId');
    const access = await assertLayoutAccess(c, layoutId, 'write');
    const body = c.req.valid('json') as typeof putCardLayoutRequestSchema.infer;
    const spec = body.spec as LayoutSpec;
    await assertValidLayout(c, access.projectId, spec);

    try {
      await c
        .get('db')
        .updateTable('card_layout')
        .set({
          name: body.name,
          width_mm: body.width_mm,
          height_mm: body.height_mm,
          spec,
          updated_by: c.get('user').id,
          updated_at: new Date(),
        })
        .where('id', '=', layoutId)
        .execute();
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError(409, NAME_TAKEN);
      throw error;
    }
    return c.json(await readLayout(c, layoutId));
  }
);

cardLayoutsRouter.delete(
  '/:layoutId',
  describeRoute({
    tags: ['Layouts'],
    summary: 'Delete a card layout',
    description:
      'Editors only, and permanent: a layout owns no bytes, so there is nothing to restore. Refused with 409 while any card -- deleted ones included -- is drawn from it, because restoring that card would bring back content naming nothing.',
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'Deleted' },
      ...conflictErrorResponse,
      ...forbiddenErrorResponse,
      ...standardErrors,
    },
  }),
  async (c) => {
    const layoutId = c.req.param('layoutId');
    await assertLayoutAccess(c, layoutId, 'write');
    const db = c.get('db');

    // Counted first so the refusal can say how many; the foreign key is what
    // actually holds, should a card be given this layout in between.
    const { count } = await db
      .selectFrom('card_content')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('layout_id', '=', layoutId)
      .executeTakeFirstOrThrow();
    const inUse = Number(count);
    const refusal = (cards: number) =>
      new AppError(
        409,
        `${cards === 1 ? 'A card is' : `${String(cards)} cards are`} drawn from this layout. Give them another layout or remove their content first`
      );
    if (inUse > 0) throw refusal(inUse);

    try {
      await db.deleteFrom('card_layout').where('id', '=', layoutId).execute();
    } catch (error) {
      if (isForeignKeyViolation(error)) throw refusal(1);
      throw error;
    }
    return c.body(null, 204);
  }
);
