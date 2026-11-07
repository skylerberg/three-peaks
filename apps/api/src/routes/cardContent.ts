import { Hono } from 'hono';
import { describeRoute, resolver } from 'hono-openapi';
import type { CardFields } from '@three-peaks/shared';
import { assertDeckAccess, assertFileAccess } from '../services/authorization.ts';
import {
  CONTENT_COLUMNS,
  assertNotDrawnElsewhere,
  assertValidCardFields,
  serializeContent,
} from '../services/cardLayouts.ts';
import {
  CardRenderError,
  type CardLayout,
  assertLayoutFits,
  createCardFile,
  drawCard,
  saveCardImage,
} from '../services/cardImages.ts';
import { assertRoomForCard } from '../services/decks.ts';
import { resolveHome } from '../services/fileHome.ts';
import { requestDeckRenders } from '../services/renderRequests.ts';
import { newId } from '../utils/uuid.ts';
import { jsonValidator, queryValidator } from '../middleware/validators.ts';
import { AppError } from '../utils/errors.ts';
import {
  cardContentListSchema,
  cardContentQuerySchema,
  createCardRequestSchema,
  createdCardSchema,
  putCardContentRequestSchema,
  renderCardsRequestSchema,
  renderCardsResultSchema,
  savedCardContentSchema,
} from '../schemas/layouts.ts';
import {
  conflictErrorResponse,
  forbiddenErrorResponse,
  internalServerErrorResponse,
  notFoundErrorResponse,
  unauthorizedErrorResponse,
  validationErrorResponse,
} from '../schemas/errors.ts';
import type { AppContext, AppHono } from '../types/index.ts';

// A card's own values for the layout it is drawn from. Addressed by the card's
// file, the way the 3D settings are: the file is the card, so there is nothing
// else to name. Saving content draws the card, and its image is a new version
// of the file whenever it comes out different.
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

// The layout a card is drawn from, checked against the deck it is drawn into.
async function layoutForDeck(
  c: AppContext,
  projectId: string,
  layoutId: string,
  deck: { width_mm: number; height_mm: number }
): Promise<CardLayout> {
  // Another project's layout gets the sentence a missing one does, so this
  // cannot be used to ask whether an id is real.
  const row = await c
    .get('db')
    .selectFrom('card_layout')
    .select(['spec', 'width_mm', 'height_mm', 'name'])
    .where('id', '=', layoutId)
    .where('project_id', '=', projectId)
    .executeTakeFirst();
  if (!row) throw new AppError(422, 'The layout must be one in the same project');
  const layout = {
    name: row.name,
    width_mm: Number(row.width_mm),
    height_mm: Number(row.height_mm),
    spec: row.spec,
  };
  await refusingUndrawable(() => assertLayoutFits(layout, deck));
  return layout;
}

// A card that cannot be drawn as written is the caller's to fix, and changes
// nothing.
async function refusingUndrawable<T>(draw: () => T | Promise<T>): Promise<T> {
  try {
    return await draw();
  } catch (error) {
    if (error instanceof CardRenderError) throw new AppError(422, error.message);
    throw error;
  }
}

async function readContent(c: AppContext, fileId: string) {
  const row = await c
    .get('db')
    .selectFrom('card_content')
    .select(CONTENT_COLUMNS)
    .where('card_content.file_id', '=', fileId)
    .executeTakeFirstOrThrow();
  return serializeContent(row);
}

cardContentRouter.put(
  '/:fileId',
  describeRoute({
    tags: ['Layouts'],
    summary: 'Save the content of one card',
    description:
      "Editors only, and an upsert: one row per card. The file must be one of a deck's images, the layout one of the same project's and the size of the deck, and the fields the layout's own -- text whose icons the layout declares, and images that are live pictures in the project, none of them itself a card drawn from a layout. The card is drawn before anything is saved: one that cannot be drawn is refused with 422, and one whose image comes out different gets it as a new version. Allowed on a deleted card, like its 3D settings, which is drawn once it is restored.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Saved',
        content: { 'application/json': { schema: resolver(savedCardContentSchema) } },
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
        'file.checksum as checksum',
        'file.deleted_at as deleted_at',
        'deck.deleted_at as deck_deleted_at',
        'deck.card_width_mm as width_mm',
        'deck.card_height_mm as height_mm',
      ])
      .where('file.id', '=', fileId)
      .executeTakeFirstOrThrow();
    if (card.deck_id === null) {
      throw new AppError(422, "Only a deck's card can be drawn from a layout");
    }

    const layout = await layoutForDeck(c, access.projectId, body.layout_id, {
      width_mm: Number(card.width_mm),
      height_mm: Number(card.height_mm),
    });
    await assertValidCardFields(c, access.projectId, layout.spec, fields);
    await assertNotDrawnElsewhere(c, access.projectId, fileId);

    // Drawn first, so a card whose copy cannot be set changes nothing. A
    // deleted card cannot take a version, and is drawn when it comes back.
    const live = card.deleted_at === null && card.deck_deleted_at === null;
    const bytes = live ? await refusingUndrawable(() => drawCard(db, layout, fields)) : null;

    const now = new Date();
    await db
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
          // Whatever stopped the last render was about the card as it was.
          render_error: null,
          updated_by: c.get('user').id,
          updated_at: now,
        })
      )
      .execute();

    const imageVersion =
      bytes === null
        ? null
        : await saveCardImage(
            c,
            { fileId, projectId: access.projectId, checksum: card.checksum },
            bytes
          );
    return c.json({ content: await readContent(c, fileId), image_version: imageVersion });
  }
);

cardContentRouter.post(
  '/',
  describeRoute({
    tags: ['Layouts'],
    summary: 'Create a card drawn from a layout',
    description:
      'Editors only. Draws the card and adds the image to the deck as its next card, the way an upload into the deck would, with its content saved beside it. Validated as a save is; the name has to be free in the deck, and the deck must have room.',
    security: [{ bearerAuth: [] }],
    responses: {
      201: {
        description: 'Created',
        content: { 'application/json': { schema: resolver(createdCardSchema) } },
      },
      ...conflictErrorResponse,
      ...forbiddenErrorResponse,
      ...validationErrorResponse,
      ...standardErrors,
    },
  }),
  jsonValidator(createCardRequestSchema),
  async (c) => {
    const body = c.req.valid('json') as typeof createCardRequestSchema.infer;
    const fields = body.fields as CardFields;
    const id = body.id ?? newId();
    const access = await assertDeckAccess(c, body.deck_id, 'write');
    const db = c.get('db');

    // The checks an upload into the deck makes: a live deck, with room.
    await resolveHome(db, access.projectId, { deck_id: body.deck_id });
    await assertRoomForCard(db, body.deck_id, id);
    const deck = await db
      .selectFrom('deck')
      .select(['deck.card_width_mm as width_mm', 'deck.card_height_mm as height_mm'])
      .where('deck.id', '=', body.deck_id)
      .executeTakeFirstOrThrow();

    const layout = await layoutForDeck(c, access.projectId, body.layout_id, {
      width_mm: Number(deck.width_mm),
      height_mm: Number(deck.height_mm),
    });
    await assertValidCardFields(c, access.projectId, layout.spec, fields);
    const bytes = await refusingUndrawable(() => drawCard(db, layout, fields));

    const file = await createCardFile(
      c,
      { id, projectId: access.projectId, deckId: body.deck_id, filename: body.filename },
      bytes
    );
    await db
      .insertInto('card_content')
      .values({
        file_id: id,
        project_id: access.projectId,
        layout_id: body.layout_id,
        fields,
        updated_by: c.get('user').id,
      })
      .execute();
    return c.json({ file, content: await readContent(c, id) }, 201);
  }
);

cardContentRouter.post(
  '/render',
  describeRoute({
    tags: ['Layouts'],
    summary: "Ask for a deck's laid-out cards to be drawn again",
    description:
      "Editors only. Every card of the deck drawn from a layout, or only the ones named, is drawn again in the background, and gets a new version where its image comes out different. The API asks for this itself whenever a layout or a file a card draws changes; this is for anything it cannot see, such as a new release of the renderer. Each card's content says when it is done.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'How many cards were asked for',
        content: { 'application/json': { schema: resolver(renderCardsResultSchema) } },
      },
      ...forbiddenErrorResponse,
      ...validationErrorResponse,
      ...standardErrors,
    },
  }),
  jsonValidator(renderCardsRequestSchema),
  async (c) => {
    const body = c.req.valid('json') as typeof renderCardsRequestSchema.infer;
    await assertDeckAccess(c, body.deck_id, 'write');
    const requested = await requestDeckRenders(c, body.deck_id, body.file_ids);
    return c.json({ requested });
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
