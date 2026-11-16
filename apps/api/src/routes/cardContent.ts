import { Hono } from 'hono';
import { describeRoute, resolver } from 'hono-openapi';
import type { CardFields, CardSize, PunchboardModelSettings } from '@three-peaks/shared';
import {
  assertComponentAccess,
  assertDeckAccess,
  assertFileAccess,
} from '../services/authorization.ts';
import {
  CONTENT_COLUMNS,
  assertNotDrawnElsewhere,
  assertValidCardFields,
  serializeContent,
} from '../services/cardLayouts.ts';
import {
  CardRenderError,
  type CardLayout,
  type Piece,
  type PieceHome,
  assertLayoutFits,
  createPieceFile,
  drawFaces,
  readPiece,
  saveFaces,
} from '../services/cardImages.ts';
import { assertRoomForCard } from '../services/decks.ts';
import { resolveHome } from '../services/fileHome.ts';
import { publishAfterCommit } from '../services/realtime/index.ts';
import { requestComponentRenders, requestDeckRenders } from '../services/renderRequests.ts';
import { assertRoomForToken } from '../services/tokens.ts';
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
// of the file whenever it comes out different. A punchboard's token is drawn
// the same way, addressed by its front, and its layout may draw its back too.
export const cardContentRouter: AppHono = new Hono();

// Which of a deck or a punchboard a request names. Both are optional in the
// schema, because a union of objects told apart only by which key is present
// is one ArkType cannot decide, so exactly one is asked for here.
function oneHome(body: { deck_id?: string; component_id?: string }) {
  const named = [body.deck_id, body.component_id].filter((id) => id !== undefined);
  if (named.length !== 1) {
    throw new AppError(422, 'Name one deck (deck_id) or one punchboard (component_id)');
  }
  return body.deck_id !== undefined
    ? ({ kind: 'deck', id: body.deck_id } as const)
    : ({ kind: 'component', id: body.component_id! } as const);
}

const NOT_A_PIECE = "Only a deck's card or a punchboard's token can be drawn from a layout";

const standardErrors = {
  ...unauthorizedErrorResponse,
  ...notFoundErrorResponse,
  ...internalServerErrorResponse,
};

cardContentRouter.get(
  '/',
  describeRoute({
    tags: ['Layouts'],
    summary: "List the content of a deck's cards, or a punchboard's tokens",
    description:
      'Every card in the deck, or token of the punchboard, that is drawn from a layout, deleted ones included -- a restore brings back the content with the image. Pieces that are only artwork have no row.',
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
    const home = oneHome(c.req.valid('query') as { deck_id?: string; component_id?: string });
    if (home.kind === 'deck') await assertDeckAccess(c, home.id, 'read');
    else await assertComponentAccess(c, home.id, 'read');
    const rows = await c
      .get('db')
      .selectFrom('card_content')
      .innerJoin('file', 'file.id', 'card_content.file_id')
      .select(CONTENT_COLUMNS)
      .where(home.kind === 'deck' ? 'file.deck_id' : 'file.component_id', '=', home.id)
      .orderBy('card_content.file_id')
      .execute();
    return c.json({ cards: rows.map(serializeContent) });
  }
);

// The layout a card is drawn from, checked against the piece it is drawn as.
async function layoutForPiece(
  c: AppContext,
  projectId: string,
  layoutId: string,
  piece: Pick<Piece, 'kind' | 'size'>
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
  await refusingUndrawable(() => assertLayoutFits(layout, piece));
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

// The content as saved, announced to every screen showing the deck.
async function announceContent(c: AppContext, fileId: string) {
  const row = await c
    .get('db')
    .selectFrom('card_content')
    .select(CONTENT_COLUMNS)
    .where('card_content.file_id', '=', fileId)
    .executeTakeFirstOrThrow();
  const content = serializeContent(row);
  publishAfterCommit(
    c.get('postCommitHooks'),
    c.get('user').id,
    'card_content_updated',
    content.project_id,
    { contents: [content] }
  );
  return content;
}

cardContentRouter.put(
  '/:fileId',
  describeRoute({
    tags: ['Layouts'],
    summary: 'Save the content of one card',
    description:
      "Editors only, and an upsert: one row per card. The file must be one of a deck's cards or the front of a punchboard's token, the layout one of the same project's and the size of the deck's cards or the punchboard's tokens, and the fields the layout's own -- text whose icons the layout declares, and images that are live pictures in the project, none of them itself a card drawn from a layout. A layout with a back draws only a token, whose back it draws into a back of the token's own, made if it has none. The card is drawn before anything is saved: one that cannot be drawn is refused with 422, and one whose image comes out different gets it as a new version. Allowed on a deleted card, like its 3D settings, which is drawn once it is restored.",
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

    const piece = await readPiece(db, fileId);
    if (piece === null) throw new AppError(422, NOT_A_PIECE);

    const layout = await layoutForPiece(c, access.projectId, body.layout_id, piece);
    await assertValidCardFields(c, access.projectId, layout.spec, fields);
    await assertNotDrawnElsewhere(c, access.projectId, fileId);

    // Drawn first, so a card whose copy cannot be set changes nothing. A
    // deleted card cannot take a version, and is drawn when it comes back.
    const faces = piece.live ? await refusingUndrawable(() => drawFaces(db, layout, fields)) : null;

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
      faces === null ? null : await refusingUndrawable(() => saveFaces(c, piece, faces));
    return c.json({ content: await announceContent(c, fileId), image_version: imageVersion });
  }
);

cardContentRouter.post(
  '/',
  describeRoute({
    tags: ['Layouts'],
    summary: 'Create a card drawn from a layout',
    description:
      "Editors only. Draws the card and adds the image to the deck as its next card, the way an upload into the deck would, with its content saved beside it -- or, given a punchboard, adds it as the punchboard's next token, with the back its layout draws as a new image of its own. Validated as a save is; the name has to be free there, and there must be room.",
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
    const target = oneHome(body);
    const db = c.get('db');

    // The checks an upload makes: a live home, with room.
    let home: PieceHome;
    let size: CardSize;
    let projectId: string;
    if (target.kind === 'deck') {
      projectId = (await assertDeckAccess(c, target.id, 'write')).projectId;
      await resolveHome(db, projectId, { deck_id: target.id });
      await assertRoomForCard(db, target.id, id);
      const deck = await db
        .selectFrom('deck')
        .select(['deck.card_width_mm as width_mm', 'deck.card_height_mm as height_mm'])
        .where('deck.id', '=', target.id)
        .executeTakeFirstOrThrow();
      home = { kind: 'deck', deckId: target.id };
      size = { width_mm: Number(deck.width_mm), height_mm: Number(deck.height_mm) };
    } else {
      projectId = (await assertComponentAccess(c, target.id, 'write')).projectId;
      const resolved = await resolveHome(db, projectId, { component_id: target.id });
      if (resolved.home.kind !== 'component' || resolved.home.role !== 'token') {
        throw new AppError(422, NOT_A_PIECE);
      }
      await assertRoomForToken(db, target.id, id);
      const component = await db
        .selectFrom('component')
        .select(['component.settings as settings'])
        .where('component.id', '=', target.id)
        .executeTakeFirstOrThrow();
      const settings = component.settings as unknown as PunchboardModelSettings;
      home = { kind: 'token', componentId: target.id };
      size = { width_mm: settings.token_width_mm, height_mm: settings.token_height_mm };
    }

    const layout = await layoutForPiece(c, projectId, body.layout_id, {
      kind: home.kind === 'deck' ? 'card' : 'token',
      size,
    });
    await assertValidCardFields(c, projectId, layout.spec, fields);
    const faces = await refusingUndrawable(() => drawFaces(db, layout, fields));

    const file = await createPieceFile(c, { id, projectId, home, filename: body.filename }, faces);
    await db
      .insertInto('card_content')
      .values({
        file_id: id,
        project_id: projectId,
        layout_id: body.layout_id,
        fields,
        updated_by: c.get('user').id,
      })
      .execute();
    return c.json({ file, content: await announceContent(c, id) }, 201);
  }
);

cardContentRouter.post(
  '/render',
  describeRoute({
    tags: ['Layouts'],
    summary: "Ask for a deck's laid-out cards, or a punchboard's tokens, to be drawn again",
    description:
      "Editors only. Every card of the deck, or token of the punchboard, drawn from a layout, or only the ones named, is drawn again in the background, and gets a new version where its image comes out different. The API asks for this itself whenever a layout or a file a card draws changes; this is for anything it cannot see, such as a new release of the renderer. Each card's content says when it is done.",
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
    const home = oneHome(body);
    if (home.kind === 'deck') await assertDeckAccess(c, home.id, 'write');
    else await assertComponentAccess(c, home.id, 'write');
    const requested =
      home.kind === 'deck'
        ? await requestDeckRenders(c, home.id, body.file_ids)
        : await requestComponentRenders(c, home.id, body.file_ids);
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
    const access = await assertFileAccess(c, fileId, 'write');
    const removed = await c
      .get('db')
      .deleteFrom('card_content')
      .where('file_id', '=', fileId)
      .executeTakeFirst();
    if (removed.numDeletedRows === 0n) throw new AppError(404, 'This card has no content');
    publishAfterCommit(
      c.get('postCommitHooks'),
      c.get('user').id,
      'card_content_deleted',
      access.projectId,
      { file_id: fileId }
    );
    return c.body(null, 204);
  }
);
