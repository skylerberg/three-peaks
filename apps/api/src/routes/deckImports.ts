import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { describeRoute, resolver } from 'hono-openapi';
import {
  assertDeckAccess,
  assertImportAccess,
  assertImportRunAccess,
} from '../services/authorization.ts';
import {
  abandonRun,
  ensureImport,
  finishRun,
  importPage,
  readBinding,
  readDeckAsOfRun,
  readRunDetail,
  readTimeline,
  startRun,
} from '../services/deckImport/index.ts';
import { jsonValidator, queryValidator } from '../middleware/validators.ts';
import { AppError } from '../utils/errors.ts';
import {
  conflictErrorResponse,
  forbiddenErrorResponse,
  internalServerErrorResponse,
  notFoundErrorResponse,
  payloadTooLargeErrorResponse,
  unauthorizedErrorResponse,
  validationErrorResponse,
} from '../schemas/errors.ts';
import {
  deckImportSchema,
  importPageQuerySchema,
  importPageResultSchema,
  importRunDeckSchema,
  importRunDetailSchema,
  importRunListSchema,
  importRunSchema,
  startImportRunRequestSchema,
  startedImportRunSchema,
} from '../schemas/imports.ts';
import type { AppHono } from '../types/index.ts';

// Its own router rather than more of routes/decks.ts: that file is the deck a
// person edits by hand, and this one is what an export does to it.
export const deckImportsRouter: AppHono = new Hono();

const standardErrors = {
  ...unauthorizedErrorResponse,
  ...notFoundErrorResponse,
  ...internalServerErrorResponse,
};

const writeErrors = {
  ...conflictErrorResponse,
  ...forbiddenErrorResponse,
  ...standardErrors,
};

deckImportsRouter.get(
  '/:deckId/import',
  describeRoute({
    tags: ['Deck imports'],
    summary: "Read a deck's import history marker",
    description:
      'What this deck was last imported from, and whether a run is open. 404 means it has never been imported into — the artwork goes into the deck itself, so there is nothing to set up first.',
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The binding',
        content: { 'application/json': { schema: resolver(deckImportSchema) } },
      },
      ...standardErrors,
    },
  }),
  async (c) => {
    const deckId = c.req.param('deckId');
    await assertImportAccess(c, deckId, 'read');
    return c.json(await readBinding(c, deckId));
  }
);

deckImportsRouter.post(
  '/:deckId/import/runs',
  describeRoute({
    tags: ['Deck imports'],
    summary: 'Start an import run',
    description:
      'Takes the whole export up front — every page number and title — and answers with the plan it computed: which pages land on cards that already exist, which are new, and which cards the export has stopped having, by name. Nothing is matched again while the pages upload. One run at a time per deck; a second answers 409 and names the open one, which is the only route back to abandoning it.',
    security: [{ bearerAuth: [] }],
    responses: {
      201: {
        description: 'Started, with the plan',
        content: { 'application/json': { schema: resolver(startedImportRunSchema) } },
      },
      ...validationErrorResponse,
      ...writeErrors,
    },
  }),
  jsonValidator(startImportRunRequestSchema),
  async (c) => {
    const deckId = c.req.param('deckId');
    const access = await assertDeckAccess(c, deckId, 'write');
    const body = c.req.valid('json') as {
      id?: string;
      source_label?: string | null;
      pages: { page_number: number; title?: string; page_id: string }[];
    };

    // Created on the first run rather than set up beforehand: the deck is the
    // destination, so there is nothing for a person to choose.
    const { importId } = await ensureImport(c, deckId);

    const run = await startRun(
      c,
      { ...access, deckId, importId },
      {
        id: body.id,
        sourceLabel: body.source_label ?? null,
        pages: body.pages.map((page) => ({
          pageNumber: page.page_number,
          title: page.title ?? null,
          pageId: page.page_id,
        })),
      }
    );
    return c.json(run, 201);
  }
);

deckImportsRouter.get(
  '/:deckId/import/runs',
  describeRoute({
    tags: ['Deck imports'],
    summary: "Read a deck's import history",
    description:
      'Newest first, and empty for a deck that has never been imported into — there is nothing to set up first, so having no history is not an error. Counts are derived from each run’s own rows rather than cached.',
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The runs',
        content: { 'application/json': { schema: resolver(importRunListSchema) } },
      },
      ...standardErrors,
    },
  }),
  async (c) => {
    const deckId = c.req.param('deckId');
    await assertDeckAccess(c, deckId, 'read');
    const row = await c
      .get('db')
      .selectFrom('deck_import')
      .select(['deck_import.id as id'])
      .where('deck_import.deck_id', '=', deckId)
      .executeTakeFirst();
    if (!row) return c.json({ runs: [] });
    return c.json({ runs: await readTimeline(c, row.id) });
  }
);

deckImportsRouter.get(
  '/:deckId/import/runs/:runId',
  describeRoute({
    tags: ['Deck imports'],
    summary: 'Read one import run',
    description:
      "The run and a row per card it touched. A row whose image has since been purged keeps the name and the page number it had. Scoped to the deck, like the as-of read beside it: a run of another deck is 404 here rather than another deck's history under this one's name.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The run',
        content: { 'application/json': { schema: resolver(importRunDetailSchema) } },
      },
      ...standardErrors,
    },
  }),
  async (c) => {
    const access = await assertImportAccess(c, c.req.param('deckId'), 'read');
    return c.json(await readRunDetail(c, access.importId, c.req.param('runId')));
  }
);

// Superseded by the deck-scoped route above, and kept for one release only.
// The SPA is a cached bundle, so a tab still running the previous release calls
// this path until it reloads. Nothing in this release calls it; drop it in the
// release after, the way a renamed column is dropped in a follow-up.
deckImportsRouter.get(
  '/import/runs/:runId',
  describeRoute({
    tags: ['Deck imports'],
    summary: 'Read one import run, without naming its deck',
    description:
      'Superseded. Answers whatever run the caller can reach in their project, which is what it always did; the deck-scoped route is the one that can refuse a run belonging to another deck.',
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The run',
        content: { 'application/json': { schema: resolver(importRunDetailSchema) } },
      },
      ...standardErrors,
    },
  }),
  async (c) => {
    const runId = c.req.param('runId');
    const access = await assertImportRunAccess(c, runId, 'read');
    return c.json(await readRunDetail(c, access.importId, runId));
  }
);

deckImportsRouter.get(
  '/:deckId/import/runs/:runId/deck',
  describeRoute({
    tags: ['Deck imports'],
    summary: 'The cards this deck held after one import',
    description:
      'Per card, the newest ledger row at or before that run, minus the cards it removed. Only a finished run has an answer: an open one has not removed anything yet and an abandoned one handed the deck nothing, and both are 409. A card whose image was purged cannot be recovered from the ledger at all and is reported as a flag rather than a row.',
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The cards this deck held after that import',
        content: { 'application/json': { schema: resolver(importRunDeckSchema) } },
      },
      ...conflictErrorResponse,
      ...standardErrors,
    },
  }),
  async (c) => {
    const access = await assertImportAccess(c, c.req.param('deckId'), 'read');
    return c.json(await readDeckAsOfRun(c, access.importId, c.req.param('runId')));
  }
);

deckImportsRouter.post(
  '/import/runs/:runId/pages',
  describeRoute({
    tags: ['Deck imports'],
    summary: 'Import one page of an export',
    description:
      'The request body is the page image itself and its metadata travels in the query string, the way the upload route does it. The page has to be one the run planned; its title names the file and decides nothing else. Posting the same page twice answers 200 with what happened the first time.',
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The page, already imported',
        content: { 'application/json': { schema: resolver(importPageResultSchema) } },
      },
      201: {
        description: 'Imported',
        content: { 'application/json': { schema: resolver(importPageResultSchema) } },
      },
      ...payloadTooLargeErrorResponse,
      ...validationErrorResponse,
      ...writeErrors,
    },
  }),
  queryValidator(importPageQuerySchema),
  async (c) => {
    const runId = c.req.param('runId');
    const access = await assertImportRunAccess(c, runId, 'write');
    const query = c.req.valid('query') as { page_number: string; title?: string };

    const body = c.req.raw.body;
    if (!body) throw new AppError(400, 'Request body is required');

    const { result, created } = await importPage(c, access, {
      pageNumber: Number(query.page_number),
      title: query.title ?? null,
      body: Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
      declaredContentType: c.req.header('content-type') ?? 'application/octet-stream',
      declaredLength: Number(c.req.header('content-length') ?? 0),
    });
    return created ? c.json(result, 201) : c.json(result);
  }
);

deckImportsRouter.post(
  '/import/runs/:runId/finish',
  describeRoute({
    tags: ['Deck imports'],
    summary: 'Finish an import run',
    description:
      'The only destructive step: it applies the identities the plan decided, tombstones every card no page was planned onto, and hands the deck what it created. Refuses until every page the run declared has landed, and refuses with 422 if a hand edit has pushed the deck past its card cap while the run was open.',
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Finished',
        content: { 'application/json': { schema: resolver(importRunDetailSchema) } },
      },
      // Takes no body, and still answers 422: the card-cap backstop runs here.
      // Undeclared, the generated client types the status as never.
      ...validationErrorResponse,
      ...writeErrors,
    },
  }),
  async (c) => {
    const runId = c.req.param('runId');
    const access = await assertImportRunAccess(c, runId, 'write');
    return c.json(await finishRun(c, access));
  }
);

deckImportsRouter.post(
  '/import/runs/:runId/abandon',
  describeRoute({
    tags: ['Deck imports'],
    summary: 'Abandon an import run',
    description:
      'Leaves everything already imported in place. Nothing is tombstoned, nothing is undone, and the deck is not touched.',
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Abandoned',
        content: { 'application/json': { schema: resolver(importRunSchema) } },
      },
      ...writeErrors,
    },
  }),
  async (c) => {
    const runId = c.req.param('runId');
    const access = await assertImportRunAccess(c, runId, 'write');
    return c.json(await abandonRun(c, access));
  }
);
