import { Hono } from 'hono';
import { describeRoute, resolver } from 'hono-openapi';
import {
  assertPrintRunAccess,
  assertProjectAccess,
  assertProjectWrite,
} from '../services/authorization.ts';
import {
  type PrintRunCardInput,
  deleteRun,
  readOutstanding,
  recordRun,
} from '../services/printRuns.ts';
import { jsonValidator, queryValidator } from '../middleware/validators.ts';
import { isUniqueViolation } from '../utils/errors.ts';
import { AppError } from '../utils/errors.ts';
import { projectQuerySchema } from '../schemas/common.ts';
import {
  printOutstandingSchema,
  printRunSchema,
  recordPrintRunRequestSchema,
} from '../schemas/print.ts';
import {
  conflictErrorResponse,
  forbiddenErrorResponse,
  internalServerErrorResponse,
  notFoundErrorResponse,
  unauthorizedErrorResponse,
  validationErrorResponse,
} from '../schemas/errors.ts';
import type { AppHono } from '../types/index.ts';

// Its own router rather than more of routes/decks.ts, for the reason
// deckImports.ts gives: that file is the deck a person edits, and this one is
// what a printer has already been given.
export const printRunsRouter: AppHono = new Hono();

const standardErrors = {
  ...unauthorizedErrorResponse,
  ...notFoundErrorResponse,
  ...internalServerErrorResponse,
};

printRunsRouter.get(
  '/outstanding',
  describeRoute({
    tags: ['Print runs'],
    summary: 'What each card and token still owes the printer',
    description:
      "Every live card of every live deck in the project, and every live token of every live punchboard, with how many copies are already on paper at its current artwork and current back, and how many are not. A card's back is its deck's and a token's is its own. A card owes copies because nothing has printed it, because its artwork has been re-imported since, because it was given a new back, or because its copy count went up — four situations and one subtraction, and `reason` says which.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'What is outstanding',
        content: { 'application/json': { schema: resolver(printOutstandingSchema) } },
      },
      ...standardErrors,
    },
  }),
  queryValidator(projectQuerySchema),
  async (c) => {
    const { project_id: projectId } = c.req.valid('query') as { project_id: string };
    await assertProjectAccess(c, projectId);
    return c.json(await readOutstanding(c, projectId));
  }
);

printRunsRouter.post(
  '/runs',
  describeRoute({
    tags: ['Print runs'],
    summary: 'Record what came off the printer',
    description:
      'Written after the document has been built, and it names the version of each card that went into it — the client is the only end that knows which bytes it drew. Recording is what makes the next run able to leave those cards out.',
    security: [{ bearerAuth: [] }],
    responses: {
      201: {
        description: 'Recorded',
        content: { 'application/json': { schema: resolver(printRunSchema) } },
      },
      ...conflictErrorResponse,
      ...forbiddenErrorResponse,
      ...validationErrorResponse,
      ...standardErrors,
    },
  }),
  jsonValidator(recordPrintRunRequestSchema),
  async (c) => {
    const body = c.req.valid('json') as {
      id?: string;
      project_id: string;
      cards: PrintRunCardInput[];
    };
    await assertProjectWrite(c, body.project_id);

    try {
      return c.json(await recordRun(c, body.project_id, body), 201);
    } catch (error) {
      // The client-supplied id, the way every other POST here handles one.
      if (isUniqueViolation(error))
        throw new AppError(409, 'That print run has already been recorded');
      throw error;
    }
  }
);

printRunsRouter.delete(
  '/runs/:runId',
  describeRoute({
    tags: ['Print runs'],
    summary: 'Undo a recorded print run',
    description:
      'For the sheet that jammed. The run is removed rather than tombstoned — a claim that certain cards are on paper, withdrawn, was never true — and the cards it named go back to owing what they owed before it.',
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'Undone' },
      ...forbiddenErrorResponse,
      ...standardErrors,
    },
  }),
  async (c) => {
    const runId = c.req.param('runId');
    await assertPrintRunAccess(c, runId, 'write');
    await deleteRun(c.get('db'), runId);
    return c.body(null, 204);
  }
);
