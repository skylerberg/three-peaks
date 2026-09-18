import { createApi, type Api } from './client.ts';
import { createCredentialStore, type CredentialStore } from './credentials/store.ts';
import {
  DEFAULT_API_URL,
  DEFAULT_WEB_URL,
  loadConfig,
  resolveConfigDir,
  type CliConfig,
} from './config.ts';
import { Output, type Writer } from './output.ts';

export interface CliDeps {
  env: Record<string, string | undefined>;
  platform: string;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: Writer;
  stderr: Writer;
  fetch?: (request: Request) => Promise<Response>;
  credentials?: CredentialStore;
  onInterrupt?: (handler: () => void) => () => void;
}

export interface GlobalFlags {
  json: boolean;
  apiUrl?: string;
  noInput: boolean;
  color: boolean;
}

export interface RuntimeContext {
  deps: CliDeps;
  api: Api;
  // Every request goes through `api` except the ones whose body is a stream of
  // bytes, which openapi-fetch would try to serialise; they share this fetch so
  // a test harness that swaps it reaches them too.
  fetch: (request: Request) => Promise<Response>;
  baseUrl: string;
  webUrl: string;
  credentials: CredentialStore;
  config: CliConfig;
  configDir: string;
  token: string | null;
  tokenFromEnv: boolean;
  out: Output;
  noInput: boolean;
}

export async function createContext(deps: CliDeps, flags: GlobalFlags): Promise<RuntimeContext> {
  const configDir = resolveConfigDir(deps.env);
  const config = await loadConfig(configDir);
  // Only trimmed, never refused: `config set` validates what it stores, and a
  // context that threw on a bad value would lock out the command that fixes it.
  // Tokens are keyed by this string, so a trailing slash must not make a second
  // login of the same server.
  const baseUrl = (
    flags.apiUrl ??
    deps.env.THREEPEAKS_API_URL ??
    config.api_url ??
    DEFAULT_API_URL
  ).replace(/\/+$/, '');
  // Left as given: it only shapes links, so a bad value should fail the command
  // that builds one rather than every command.
  const webUrl = deps.env.THREEPEAKS_WEB_URL ?? config.web_url ?? DEFAULT_WEB_URL;
  const credentials = deps.credentials ?? createCredentialStore(deps.platform, configDir);
  const envToken = deps.env.THREEPEAKS_TOKEN;
  const token = envToken ?? (await credentials.get(baseUrl));
  const fetch = deps.fetch ?? ((request: Request) => globalThis.fetch(request));
  const api = createApi({ baseUrl, getToken: () => token, fetch });
  const color = flags.color && !deps.env.NO_COLOR && deps.stdout.isTTY === true;
  const out = new Output({ stdout: deps.stdout, stderr: deps.stderr, json: flags.json, color });
  return {
    deps,
    api,
    fetch,
    baseUrl,
    webUrl,
    credentials,
    config,
    configDir,
    token,
    tokenFromEnv: envToken != null,
    out,
    noInput: flags.noInput,
  };
}
