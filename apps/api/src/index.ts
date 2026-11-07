import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { secureHeaders } from 'hono/secure-headers';
import { buildInfo } from './config/buildInfo.ts';
import { assertEmailConfig, assertProxyConfig, assertStorageConfig, env } from './config/env.ts';
import { reportPendingMigrations } from './db/migrate.ts';
import { authMiddleware, skipAuth } from './middleware/auth.ts';
import { corsMiddleware } from './middleware/cors.ts';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.ts';
import { transactionMiddleware } from './middleware/transaction.ts';
import { authRouter, publicAuthRouter } from './routes/auth.ts';
import { cardContentRouter } from './routes/cardContent.ts';
import { cardLayoutsRouter } from './routes/cardLayouts.ts';
import { componentsRouter } from './routes/components.ts';
import { canvaAppRouter, publicCanvaAppRouter } from './routes/canvaApp.ts';
import { deckImportsRouter } from './routes/deckImports.ts';
import { decksRouter } from './routes/decks.ts';
import { docsRouter } from './routes/docs.ts';
import { filesRouter } from './routes/files.ts';
import { healthCheck } from './routes/health.ts';
import { modelsRouter } from './routes/models.ts';
import { printRunsRouter } from './routes/printRuns.ts';
import { projectsRouter } from './routes/projects.ts';
import { openApiSpec } from './spec/openapi.ts';
import { attachRealtime, realtimeEventsDocument, startBus } from './services/realtime/index.ts';
import { startRenderWorker } from './services/renderWorker.ts';
import { assertPublicRoutes } from './utils/assert-public-routes.ts';
import { logger } from './utils/logger.ts';
import { REQUEST_TIMEOUT_MS, startupFailureMessage } from './utils/serverStartup.ts';
import type { Variables } from './types/index.ts';

// Fail the boot rather than the request. Each of these misconfigurations is
// otherwise invisible until it matters.
assertProxyConfig();
assertEmailConfig();
assertStorageConfig();

export const app = new Hono<{ Variables: Variables }>();

app.use('*', secureHeaders());
app.use('*', corsMiddleware);
app.use('*', compress());

// Default to no-store. A handler that means to be cached says so; the failure
// mode of the other default is a shared cache holding someone's project list.
app.use('*', async (c, next) => {
  await next();
  if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
});

// Order matters: the transaction has to exist before auth runs, so a credential
// lookup reads the same snapshot the handler will.
app.use('*', transactionMiddleware);
app.use('*', authMiddleware);

app.get('/', skipAuth, healthCheck);
app.get('/health', skipAuth, healthCheck);

app.get('/api/openapi.json', skipAuth, async (c) => c.json(await openApiSpec()));
// A second document, because /ws has no HTTP request or response the OpenAPI
// spec could describe. Served so a client can generate against a deployed API.
app.get('/api/realtime-events.json', skipAuth, async (c) => c.json(await realtimeEventsDocument()));

app.route('/api/docs', docsRouter);
app.route('/api/auth', publicAuthRouter);
app.route('/api/auth', authRouter);
app.route('/api/projects', projectsRouter);
app.route('/api/files', filesRouter);
app.route('/api/components', componentsRouter);
app.route('/api/models', modelsRouter);
app.route('/api/decks', decksRouter);
app.route('/api/decks', deckImportsRouter);
app.route('/api/print', printRunsRouter);
app.route('/api/layouts', cardLayoutsRouter);
app.route('/api/card-content', cardContentRouter);
app.route('/api/canva-app', publicCanvaAppRouter);
app.route('/api/canva-app', canvaAppRouter);

app.onError(errorHandler);
app.notFound(notFoundHandler);

// Runs at module load, so a route that gained or lost a public marker in a
// refactor fails the deploy rather than serving.
assertPublicRoutes(app.routes as never);

if (import.meta.url === `file://${process.argv[1]}`) {
  // Redis fan-out is a no-op without REDIS_URL, which is right for a single dev
  // process and wrong for the two-replica deployment.
  await startBus();

  // Before the port is announced, so a database that is behind is the first
  // thing in the log rather than something to work back to from a 500.
  await reportPendingMigrations();

  const server = serve({ fetch: app.fetch, port: env.port }, (info) => {
    const build = buildInfo();
    logger.info(`listening on :${info.port}`, {
      environment: env.environment,
      branch: build.branch,
      commit: build.commit,
    });
  });

  // Without this the process stays up under --watch with nothing bound, and the
  // port answers from whoever already owns it.
  server.on('error', (error: NodeJS.ErrnoException) => {
    logger.error(startupFailureMessage(error, env.port));
    process.exit(1);
  });

  const httpServer = server as unknown as import('node:http').Server;
  httpServer.requestTimeout = REQUEST_TIMEOUT_MS;

  // /ws rides the raw HTTP upgrade on the same server, so it is same-origin with
  // the API and needs no second port or certificate.
  attachRealtime(httpServer);

  // Laid-out cards asked to be drawn again, worked through on every replica.
  startRenderWorker();
}
