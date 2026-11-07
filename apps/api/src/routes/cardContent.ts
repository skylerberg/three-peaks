import { Hono } from 'hono';
import { describeRoute, resolver } from 'hono-openapi';
import type { CardFields } from '@three-peaks/shared';
import { assertDeckAccess, assertFileAccess } from '../services/authorization.ts';
import {
  CONTENT_COLUMNS,
  assertValidCardFields,
  serializeContent,
} from '../services/cardLayouts.ts';
import { jsonValidator, queryValidator } from '../middleware/validators.ts';
import { AppError } from '../utils/errors.ts';
import {
  cardContentListSchema,
  cardContentQuerySchema,
  cardContentSchema,
  putCardContentRequestSchema,
} from '../schemas/layouts.ts';
import {
  forbiddenErrorResponse,
  internalServerErrorResponse,
  notFoundErrorResponse,
  unauthorizedErrorResponse,
  validationErrorResponse,
} from '../schemas/errors.ts';
import type { AppHono } from '../types/index.ts';

// A card's own values for the layout it is drawn from. Addressed by the card's
// file, the way the 3D settings are: the file is the card, so there is nothing
// else to name. Writing content renders nothing -- the client renders and
// uploads the image, which is why storing the truth comes first and a failed
// render is something the next one repairs.
export const cardContentRouter: AppHono = new Hono();

const standardErrors = {
  ...unauthorizedErrorResponse,
  ...notFoundErrorResponse,
  ...internalServerErrorResponse,
};

cardContentRouter.get(
  '/',
  describeRoute({
    tags: ['Layouts'],
    summary: "List the content of a deck's cards",
    description:
      'Every card in the deck that is drawn from a layout, deleted ones included -- a restore brings back the content with the image. Cards that are only artwork have no row.',
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Card content',
        content: { 'application/json': { schema: resolver(cardContentListSchema) } },
      },
      ...standardErrors,
    },
  }),
  queryValidator(cardContentQuerySchema),
  async (c) => {
    const { deck_id: deckId } = c.req.valid('query') as { deck_id: string };
    await assertDeckAccess(c, deckId, 'read');
    const rows = await c
      .get('db')
      .selectFrom('card_content')
      .innerJoin('file', 'file.id', 'card_content.file_id')
      .select(CONTENT_COLUMNS)
      .where('file.deck_id', '=', deckId)
      .orderBy('card_content.file_id')
      .execute();
    return c.json({ cards: rows.map(serializeContent) });
  }
);

cardContentRouter.put(
  '/:fileId',
  describeRoute({
    tags: ['Layouts'],
    summary: 'Save the content of one card',
    description:
      "Editors only, and an upsert: one row per card. The file must be one of a deck's images, the layout one of the same project's and the size of the deck, and the fields the layout's own -- text whose icons the layout declares, and images that are live pictures in the project. Allowed on a deleted card, like its 3D settings: the content is not the image.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Saved',
        content: { 'application/json': { schema: resolver(cardContentSchema) } },
      },
      ...forbiddenErrorResponse,
      ...validationErrorResponse,
      ...standardErrors,
    },
  }),
  jsonValidator(putCardContentRequestSchema),
  async (c) => {
    const fileId = c.req.param('fileId');
    const access = await assertFileAccess(c, fileId, 'write');
    const body = c.req.valid('json') as typeof putCardContentRequestSchema.infer;
    const fields = body.fields as CardFields;
    const db = c.get('db');

    const card = await db
      .selectFrom('file')
      .leftJoin('deck', 'deck.id', 'file.deck_id')
      .select([
        'file.deck_id as deck_id',
        'deck.card_width_mm as width_mm',
        'deck.card_height_mm as height_mm',
      ])
      .where('file.id', '=', fileId)
      .executeTakeFirstOrThrow();
    if (card.deck_id === null) {
      throw new AppError(422, "Only a deck's card can be drawn from a layout");
    }

    // Another project's layout gets the sentence a missing one does, so this
    // cannot be used to ask whether an id is real.
    const layout = await db
      .selectFrom('card_layout')
      .select(['spec', 'width_mm', 'height_mm', 'name'])
      .where('id', '=', body.layout_id)
      .where('project_id', '=', access.projectId)
      .executeTakeFirst();
    if (!layout) throw new AppError(422, 'The layout must be one in the same project');

    const deckSize = `${String(Number(card.width_mm))} × ${String(Number(card.height_mm))} mm`;
    const layoutSize = `${String(Number(layout.width_mm))} × ${String(Number(layout.height_mm))} mm`;
    if (deckSize !== layoutSize) {
      throw new AppError(
        422,
        `${layout.name} is drawn on a ${layoutSize} card and this deck's cards are ${deckSize}`
      );
    }

    await assertValidCardFields(c, access.projectId, layout.spec, fields);

    const now = new Date();
    const row = await db
      .insertInto('card_content')
      .values({
        file_id: fileId,
        project_id: access.projectId,
        layout_id: body.layout_id,
        fields,
        updated_by: c.get('user').id,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.column('file_id').doUpdateSet({
          layout_id: body.layout_id,
          fields,
          updated_by: c.get('user').id,
          updated_at: now,
        })
      )
      .returning([
        'file_id',
        'project_id',
        'layout_id',
        'fields',
        'updated_by',
        'created_at',
        'updated_at',
      ])
      .executeTakeFirstOrThrow();
    return c.json(serializeContent(row));
  }
);

cardContentRouter.delete(
  '/:fileId',
  describeRoute({
    tags: ['Layouts'],
    summary: 'Stop drawing a card from a layout',
    description:
      'Editors only. The image stays exactly as it was last rendered, and is from now on plain artwork. 404 when the card has no content.',
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'Removed' },
      ...forbiddenErrorResponse,
      ...standardErrors,
    },
  }),
  async (c) => {
    const fileId = c.req.param('fileId');
    await assertFileAccess(c, fileId, 'write');
    const removed = await c
      .get('db')
      .deleteFrom('card_content')
      .where('file_id', '=', fileId)
      .executeTakeFirst();
    if (removed.numDeletedRows === 0n) throw new AppError(404, 'This card has no content');
    return c.body(null, 204);
  }
);
