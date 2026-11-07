import { Hono } from 'hono';
import { describeRoute, resolver } from 'hono-openapi';
import {
  assertDeckAccess,
  assertProjectAccess,
  assertProjectWrite,
} from '../services/authorization.ts';
import {
  assertCardFiles,
  readDeck,
  readDeckCards,
  serializeDeck,
  withCounts,
} from '../services/decks.ts';
import { ownedStorageKeys } from '../services/files.ts';
import { deleteStoredObjectsAfterCommit } from '../services/storage/index.ts';
import { requestDeckRenders } from '../services/renderRequests.ts';
import { publishAfterCommit } from '../services/realtime/index.ts';
import { jsonValidator, queryValidator } from '../middleware/validators.ts';
import { AppError, isUniqueViolation } from '../utils/errors.ts';
import { newId } from '../utils/uuid.ts';
import { projectQuerySchema } from '../schemas/common.ts';
import { purgeQuerySchema } from '../schemas/files.ts';
import {
  createDeckRequestSchema,
  deckListSchema,
  deckSchema,
  deckWithCardsSchema,
  putDeckCardsRequestSchema,
  updateDeckRequestSchema,
} from '../schemas/decks.ts';
import {
  conflictErrorResponse,
  forbiddenErrorResponse,
  internalServerErrorResponse,
  notFoundErrorResponse,
  unauthorizedErrorResponse,
  validationErrorResponse,
} from '../schemas/errors.ts';
import type { AppHono } from '../types/index.ts';

export const decksRouter: AppHono = new Hono();

const standardErrors = {
  ...unauthorizedErrorResponse,
  ...notFoundErrorResponse,
  ...internalServerErrorResponse,
};

decksRouter.get(
  '/',
  describeRoute({
    tags: ['Decks'],
    summary: 'List the decks in a project',
    description:
      'Each deck carries how many distinct cards it holds and how many pieces of card those add up to, so the screen needs no follow-up request per deck. The cards themselves come from the single-deck route.',
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Decks',
        content: { 'application/json': { schema: resolver(deckListSchema) } },
      },
      ...standardErrors,
    },
  }),
  queryValidator(projectQuerySchema),
  async (c) => {
    const { project_id: projectId } = c.req.valid('query') as { project_id: string };
    await assertProjectAccess(c, projectId);

    const rows = await withCounts(c.get('db'))
      .where('deck.project_id', '=', projectId)
      .where('deck.deleted_at', 'is', null)
      .orderBy('deck.name', 'asc')
      .execute();

    return c.json({ decks: rows.map(serializeDeck) });
  }
);

decksRouter.post(
  '/',
  describeRoute({
    tags: ['Decks'],
    summary: 'Create a deck',
    description: 'Starts empty. Cards are added with the card-list route.',
    security: [{ bearerAuth: [] }],
    responses: {
      201: {
        description: 'Created',
        content: { 'application/json': { schema: resolver(deckSchema) } },
      },
      ...conflictErrorResponse,
      ...forbiddenErrorResponse,
      ...validationErrorResponse,
      ...standardErrors,
    },
  }),
  jsonValidator(createDeckRequestSchema),
  async (c) => {
    const body = c.req.valid('json') as {
      id?: string;
      project_id: string;
      name: string;
      card_width_mm: number;
      card_height_mm: number;
      back_file_id?: string | null;
    };
    await assertProjectWrite(c, body.project_id);

    // A deck's back is one of its own images, and it has none yet: the deck is
    // created, the artwork is uploaded into it, and the back is chosen then.
    if (body.back_file_id !== undefined && body.back_file_id !== null) {
      throw new AppError(
        422,
        'A new deck has no images yet. Create it, upload the back into it, then set it'
      );
    }

    const id = body.id ?? newId();
    try {
      await c
        .get('db')
        .insertInto('deck')
        .values({
          id,
          project_id: body.project_id,
          name: body.name,
          card_width_mm: body.card_width_mm,
          card_height_mm: body.card_height_mm,
          back_file_id: null,
          created_by: c.get('user').id,
        })
        .execute();
    } catch (error) {
      // Covers both unique indexes: the client-supplied id and the deck name.
      // A pre-check on either is two statements with a gap between them.
      if (isUniqueViolation(error)) {
        throw new AppError(409, 'A deck with that id or name already exists in this project');
      }
      throw error;
    }

    const created = await readDeck(c, id);
    publishAfterCommit(
      c.get('postCommitHooks'),
      c.get('user').id,
      'deck_created',
      body.project_id,
      created
    );
    return c.json(created, 201);
  }
);

decksRouter.get(
  '/:deckId',
  describeRoute({
    tags: ['Decks'],
    summary: 'Get a deck and its cards',
    description:
      'Cards come back in print order, each with the whole file row behind it. A card whose image has been deleted is still listed — restoring the image puts it back in the run.',
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The deck',
        content: { 'application/json': { schema: resolver(deckWithCardsSchema) } },
      },
      ...standardErrors,
    },
  }),
  async (c) => {
    const deckId = c.req.param('deckId');
    await assertDeckAccess(c, deckId, 'read');
    const [deck, cards] = await Promise.all([readDeck(c, deckId), readDeckCards(c, deckId)]);
    return c.json({ deck, cards });
  }
);

decksRouter.patch(
  '/:deckId',
  describeRoute({
    tags: ['Decks'],
    summary: 'Update a deck',
    description: 'Editors only. Every field is optional; an absent one is left alone.',
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Updated',
        content: { 'application/json': { schema: resolver(deckSchema) } },
      },
      ...conflictErrorResponse,
      ...forbiddenErrorResponse,
      ...validationErrorResponse,
      ...standardErrors,
    },
  }),
  jsonValidator(updateDeckRequestSchema),
  async (c) => {
    const deckId = c.req.param('deckId');
    const access = await assertDeckAccess(c, deckId, 'write');
    const body = c.req.valid('json') as {
      name?: string;
      card_width_mm?: number;
      card_height_mm?: number;
      back_file_id?: string | null;
    };

    if (body.back_file_id !== undefined && body.back_file_id !== null) {
      // The deck's own, not the project's: a back living in Assets would be
      // deck artwork the explorer still lists, which is the duplication owning
      // artwork exists to remove.
      const own = await c
        .get('db')
        .selectFrom('file')
        .select(['file.id as id'])
        .where('file.id', '=', body.back_file_id)
        .where('file.deck_id', '=', deckId)
        .where('file.deleted_at', 'is', null)
        .executeTakeFirst();
      if (!own) {
        throw new AppError(
          422,
          'The card back has to be an image this deck holds. Upload it here, or move it in from Assets.'
        );
      }
    }

    const patch = {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.card_width_mm !== undefined && { card_width_mm: body.card_width_mm }),
      ...(body.card_height_mm !== undefined && { card_height_mm: body.card_height_mm }),
      ...(body.back_file_id !== undefined && { back_file_id: body.back_file_id }),
      updated_at: new Date(),
    };

    try {
      await c.get('db').updateTable('deck').set(patch).where('deck.id', '=', deckId).execute();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError(409, 'A deck with that name already exists in this project');
      }
      throw error;
    }
    // A new size is drawn, or refused on each card until its layout matches.
    if (body.card_width_mm !== undefined || body.card_height_mm !== undefined) {
      await requestDeckRenders(c, deckId);
    }

    // Both halves, even though this route left the cards alone: one fixed shape
    // costs a read here and saves every client testing which half arrived.
    const [updated, cards] = await Promise.all([readDeck(c, deckId), readDeckCards(c, deckId)]);
    publishAfterCommit(
      c.get('postCommitHooks'),
      c.get('user').id,
      'deck_updated',
      access.projectId,
      {
        deck: updated,
        cards,
      }
    );
    return c.json(updated);
  }
);

decksRouter.delete(
  '/:deckId',
  describeRoute({
    tags: ['Decks'],
    summary: 'Delete a deck',
    description:
      'Soft by default: the deck is tombstoned and its artwork keeps every byte, so a restore is exact. `purge=true` is the irreversible one \u2014 it takes the cards with it and reclaims every stored object. Only the literal word is accepted.',
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'Deleted' },
      ...forbiddenErrorResponse,
      ...standardErrors,
    },
  }),
  queryValidator(purgeQuerySchema),
  async (c) => {
    const deckId = c.req.param('deckId');
    const access = await assertDeckAccess(c, deckId, 'write');
    const db = c.get('db');

    if ((c.req.valid('query') as { purge?: string }).purge !== 'true') {
      // Only this row. Its cards are never marked: visibility is derived from
      // the deck above them, so a restore is symmetric with the delete rather
      // than resurrecting artwork somebody took out one card at a time.
      const marked = await db
        .updateTable('deck')
        .set({ deleted_at: new Date(), deleted_by: c.get('user').id })
        // A repeat delete leaves the first one's record intact.
        .where('deck.id', '=', deckId)
        .where('deck.deleted_at', 'is', null)
        .returning(['deck.id as id'])
        .executeTakeFirst();

      if (marked) {
        publishAfterCommit(
          c.get('postCommitHooks'),
          c.get('user').id,
          'deck_deleted',
          access.projectId,
          { ...(await readDeck(c, deckId)), purged: false }
        );
      }
      return c.body(null, 204);
    }

    // Before the delete: the cascade takes every card's file row with the deck,
    // and nothing else names the objects those rows point at.
    const keys = await ownedStorageKeys(db, { deckId });
    const doomed = await readDeck(c, deckId);

    await db.deleteFrom('deck').where('deck.id', '=', deckId).execute();

    deleteStoredObjectsAfterCommit(c.get('postCommitHooks'), keys);
    publishAfterCommit(
      c.get('postCommitHooks'),
      c.get('user').id,
      'deck_deleted',
      access.projectId,
      { ...doomed, purged: true }
    );
    return c.body(null, 204);
  }
);

decksRouter.post(
  '/:deckId/restore',
  describeRoute({
    tags: ['Decks'],
    summary: 'Restore a deleted deck',
    description:
      'Brings the deck back with whatever cards it still has. A card deleted on its own stays deleted \u2014 a tombstone above a row is not a tombstone on it. Restoring a live deck answers 200 and changes nothing.',
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Restored',
        content: { 'application/json': { schema: resolver(deckWithCardsSchema) } },
      },
      ...conflictErrorResponse,
      ...forbiddenErrorResponse,
      ...standardErrors,
    },
  }),
  async (c) => {
    const deckId = c.req.param('deckId');
    const access = await assertDeckAccess(c, deckId, 'write');

    try {
      await c
        .get('db')
        .updateTable('deck')
        .set({ deleted_at: null, deleted_by: null, updated_at: new Date() })
        .where('deck.id', '=', deckId)
        .execute();
      // Its laid-out cards may have fallen behind while it was gone.
      await requestDeckRenders(c, deckId);
    } catch (error) {
      // The name it had may have been taken while it was gone.
      if (isUniqueViolation(error)) {
        throw new AppError(409, 'A deck with that name already exists in this project');
      }
      throw error;
    }

    const [deck, cards] = await Promise.all([readDeck(c, deckId), readDeckCards(c, deckId)]);
    publishAfterCommit(
      c.get('postCommitHooks'),
      c.get('user').id,
      'deck_updated',
      access.projectId,
      { deck, cards }
    );
    return c.json({ deck, cards });
  }
);

decksRouter.put(
  '/:deckId/cards',
  describeRoute({
    tags: ['Decks'],
    summary: 'Replace a deck’s cards',
    description:
      'The whole ordered list in one request. Position is the array index, so adding, removing and reordering are the same call and none of them can interleave with another.',
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The deck as it now stands',
        content: { 'application/json': { schema: resolver(deckWithCardsSchema) } },
      },
      ...forbiddenErrorResponse,
      ...validationErrorResponse,
      ...standardErrors,
    },
  }),
  jsonValidator(putDeckCardsRequestSchema),
  async (c) => {
    const deckId = c.req.param('deckId');
    const access = await assertDeckAccess(c, deckId, 'write');
    const { cards } = c.req.valid('json') as { cards: { file_id: string; quantity: number }[] };

    const fileIds = cards.map((entry) => entry.file_id);
    // Caught here rather than left to the unique constraint: the same image
    // twice is a client that meant to raise a quantity, and "already in the
    // deck" says so where a 409 on a constraint name would not.
    if (new Set(fileIds).size !== fileIds.length) {
      throw new AppError(422, 'A card can only appear in a deck once — raise its quantity instead');
    }
    await assertCardFiles(c, deckId, fileIds);

    const db = c.get('db');
    await db.deleteFrom('deck_card').where('deck_card.deck_id', '=', deckId).execute();

    if (cards.length > 0) {
      await db
        .insertInto('deck_card')
        .values(
          cards.map((entry, index) => ({
            id: newId(),
            deck_id: deckId,
            file_id: entry.file_id,
            quantity: entry.quantity,
            position: index,
          }))
        )
        .execute();
    }

    // The deck itself is what a listing sorts and a client caches on, so an
    // edit to its contents has to move its timestamp too.
    await db
      .updateTable('deck')
      .set({ updated_at: new Date() })
      .where('deck.id', '=', deckId)
      .execute();

    const [deck, saved] = await Promise.all([readDeck(c, deckId), readDeckCards(c, deckId)]);

    // A deck holds at most MAX_DECK_CARDS rows and each carries its file, so
    // this is the largest event the bus carries -- the trade against every
    // client with the deck open reading that same list back a moment later.
    publishAfterCommit(
      c.get('postCommitHooks'),
      c.get('user').id,
      'deck_updated',
      access.projectId,
      {
        deck,
        cards: saved,
      }
    );

    return c.json({ deck, cards: saved });
  }
);
