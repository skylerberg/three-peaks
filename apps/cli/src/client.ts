import createClient, { type Client, type Middleware } from 'openapi-fetch';
import type { paths } from '@three-peaks/shared/api';
import { VERSION } from './version.ts';

export type Api = Client<paths>;

// The session list shows the user agent a session was created with, and this is
// what lets someone tell the CLI's sessions apart from a browser's there.
export const USER_AGENT = `threepeaks-cli/${VERSION}`;

export interface ApiOptions {
  baseUrl: string;
  getToken: () => string | null;
  fetch?: (request: Request) => Promise<Response>;
}

export function createApi(options: ApiOptions): Api {
  const client = createClient<paths>({ baseUrl: options.baseUrl, fetch: options.fetch });
  const bearerAuth: Middleware = {
    onRequest({ request }) {
      request.headers.set('User-Agent', USER_AGENT);
      const token = options.getToken();
      if (token) {
        request.headers.set('Authorization', `Bearer ${token}`);
      }
    },
  };
  client.use(bearerAuth);
  return client;
}
