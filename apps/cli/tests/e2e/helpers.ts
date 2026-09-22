import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { app } from '../../../api/src/index.ts';
import { createUser, type TestUser } from '../../../api/tests/setup/testContext.ts';
import { run } from '../../src/run.ts';
import { MemoryStore } from '../../src/credentials/memory.ts';
import type { CliDeps } from '../../src/context.ts';

interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  json<T = unknown>(): T;
}

export interface CliRunHandle {
  output(): string;
  errorOutput(): string;
  interrupt(): void;
  done: Promise<CliRunResult>;
}

interface CliRunOptions {
  stdin?: string;
  stdinIsTty?: boolean;
  env?: Record<string, string>;
  onRequest?: (request: Request) => void;
}

export interface CliHarness {
  credentials: MemoryStore;
  configDir: string;
  // A scratch directory for the files a command reads or writes.
  workDir: string;
  runCli(argv: string[], options?: CliRunOptions): Promise<CliRunResult>;
  startCli(argv: string[], options?: CliRunOptions): CliRunHandle;
}

export const API_URL = 'http://localhost:17310';

// `apiUrl` matters only to a test with a real server listening -- the watch,
// whose socket cannot ride the in-process fetch, and the transfers, whose
// streamed bodies only a real socket exercises. `network` sends every request
// there too. Credentials are keyed by the URL, so every call in such a file has
// to agree on it.
export async function createCliHarness(
  apiUrl = API_URL,
  options: { network?: boolean } = {}
): Promise<CliHarness> {
  const credentials = new MemoryStore();
  const root = await mkdtemp(join(tmpdir(), 'threepeaks-e2e-'));
  const configDir = join(root, 'config');
  const workDir = join(root, 'work');

  const network = options.network === true;

  function startCli(argv: string[], runOptions: CliRunOptions = {}): CliRunHandle {
    let stdout = '';
    let stderr = '';
    let interruptHandler: (() => void) | null = null;
    const stdin: PassThrough & { isTTY?: boolean } = new PassThrough();
    if (runOptions.stdinIsTty === true) {
      stdin.isTTY = true;
    }
    stdin.end(runOptions.stdin ?? '');
    const decoder = new TextDecoder();
    const deps: CliDeps = {
      env: {
        THREEPEAKS_CONFIG_DIR: configDir,
        THREEPEAKS_API_URL: apiUrl,
        ...runOptions.env,
      },
      platform: 'linux',
      stdin,
      stdout: {
        write: (chunk: string | Uint8Array) => {
          stdout += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
          return true;
        },
      },
      stderr: {
        write: (chunk: string | Uint8Array) => {
          stderr += typeof chunk === 'string' ? chunk : decoder.decode(chunk);
          return true;
        },
      },
      // In-process: the request never leaves this worker, so the CLI is exercised
      // against the real routes, middleware and database with no port to bind.
      fetch: async (request) => {
        runOptions.onRequest?.(request);
        return network ? fetch(request) : app.request(request);
      },
      credentials,
      onInterrupt: (handler) => {
        interruptHandler = handler;
        return () => {
          if (interruptHandler === handler) {
            interruptHandler = null;
          }
        };
      },
    };
    const done = run(deps, ['node', 'threepeaks', ...argv]).then((exitCode) => ({
      exitCode,
      stdout,
      stderr,
      // Bare "Unexpected end of JSON input" names neither the command nor what
      // it printed instead, which is most of the cost of chasing a rare one.
      json: <T = unknown>() => {
        try {
          return JSON.parse(stdout) as T;
        } catch (error) {
          throw new Error(
            `threepeaks ${argv.join(' ')} exited ${String(exitCode)} without JSON on stdout.\n` +
              `stdout: ${JSON.stringify(stdout)}\nstderr: ${JSON.stringify(stderr)}`,
            { cause: error }
          );
        }
      },
    }));
    return {
      output: () => stdout,
      errorOutput: () => stderr,
      interrupt: () => {
        const handler = interruptHandler;
        if (handler === null) {
          // Throwing beats hanging: the command never registered a handler, so it
          // would ignore the interrupt and never finish.
          throw new Error('the command has not registered an interrupt handler');
        }
        handler();
      },
      done,
    };
  }

  return {
    credentials,
    configDir,
    workDir,
    runCli: (argv, options) => startCli(argv, options).done,
    startCli,
  };
}

// A harness already holding a session for a fresh account, which is where
// nearly every test starts. The token goes into the credential store the way
// `threepeaks login` would put it there.
export async function signedInHarness(
  prefix: string,
  apiUrl = API_URL
): Promise<{ h: CliHarness; user: TestUser }> {
  const user = await createUser(prefix);
  const h = await createCliHarness(apiUrl);
  await h.credentials.set(apiUrl, user.token);
  return { h, user };
}

// The smallest PNG the API's sniffer recognises as one, for tests that need an
// image rather than arbitrary bytes.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

export function pngBytes(seed: number): Buffer {
  // Distinct bytes per seed, so two uploads are two versions rather than the
  // identical-bytes no-op the API answers a repeat with.
  return Buffer.concat([PNG_BYTES, Buffer.from(`seed:${String(seed)}`)]);
}
