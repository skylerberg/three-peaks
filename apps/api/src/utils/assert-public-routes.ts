import { skipAuth, optionalAuth } from '../middleware/auth.ts';

interface RouteEntry {
  method: string;
  path: string;
  handler: unknown;
}

// The routes that serve without a token, written out. This list is the
// specification; the marker middlewares are the implementation. assertPublicRoutes
// fails the boot when they disagree, in either direction — so a route that
// gains a skipAuth marker in a refactor cannot quietly become public, and one
// that loses it cannot quietly break.
const PUBLIC_ROUTES = new Set([
  'GET /',
  'GET /health',
  'GET /api/openapi.json',
  'GET /api/realtime-events.json',
  'GET /api/docs',
  'GET /api/docs/static/swagger-ui-dist/:asset',
  'POST /api/auth/signup',
  'POST /api/auth/login',
  'POST /api/auth/forgot-password',
  'POST /api/auth/reset-password',
  // Carries a Canva credential rather than one of ours, and answers with one of
  // ours when it recognises the person behind it.
  'POST /api/canva-app/session',
  // Names a build and nothing else, the way /health names the API's own.
  'GET /api/canva-app/build',
]);

const OPTIONAL_AUTH_ROUTES = new Set<string>([]);

function collect(routes: RouteEntry[], marker: unknown): Set<string> {
  const found = new Set<string>();
  for (const route of routes) {
    if (route.handler === marker) found.add(`${route.method} ${route.path}`);
  }
  return found;
}

function describeDrift(label: string, expected: Set<string>, actual: Set<string>): string[] {
  const problems: string[] = [];
  for (const route of actual) {
    if (!expected.has(route)) problems.push(`${label}: ${route} is marked but not in the list`);
  }
  for (const route of expected) {
    if (!actual.has(route)) problems.push(`${label}: ${route} is listed but not marked`);
  }
  return problems;
}

export function assertPublicRoutes(routes: RouteEntry[]): void {
  const problems = [
    ...describeDrift('public', PUBLIC_ROUTES, collect(routes, skipAuth)),
    ...describeDrift('optional-auth', OPTIONAL_AUTH_ROUTES, collect(routes, optionalAuth)),
  ];

  if (problems.length > 0) {
    throw new Error(
      `Public route set has drifted from src/utils/assert-public-routes.ts:\n  ${problems.join('\n  ')}`
    );
  }
}
