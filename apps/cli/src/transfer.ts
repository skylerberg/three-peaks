import { createReadStream, createWriteStream } from 'node:fs';
import { access, rename, rm, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { MAX_UPLOAD_BYTES, uploadTooLargeMessage } from '@three-peaks/shared';
import type { components } from '@three-peaks/shared/api';
import { USER_AGENT } from './client.ts';
import { ApiError, CliError, EXIT, exitCodeForStatus, toApiError } from './errors.ts';
import type { RuntimeContext } from './context.ts';

type Query = Record<string, string | number | undefined>;
type FileRow = components['schemas']['File'];
type FileVersionResult = components['schemas']['FileVersionResult'];

// Refused here in a millisecond rather than by the server after the whole
// transfer, with the sentence the server would have used.
async function localFileSize(filePath: string): Promise<number> {
  let size: number;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new CliError(`${filePath} is not a file`, EXIT.usage);
    size = info.size;
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(`Cannot read ${filePath}: ${(err as Error).message}`, EXIT.usage);
  }
  if (size > MAX_UPLOAD_BYTES) {
    throw new CliError(uploadTooLargeMessage(MAX_UPLOAD_BYTES, size, filePath), EXIT.invalid);
  }
  return size;
}

// The routes whose body is the file itself. openapi-fetch serialises a body it
// is given and these declare none, so they are sent by hand -- through the
// context's fetch, so a harness that swaps it reaches them too. The server
// sniffs the type from the bytes and ignores any declared one, which is why
// every upload is sent as an opaque stream.
export async function sendFile<T>(
  ctx: RuntimeContext,
  path: string,
  query: Query,
  filePath: string
): Promise<{ status: number; body: T }> {
  const size = await localFileSize(filePath);

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const headers = new Headers({
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(size),
    'User-Agent': USER_AGENT,
  });
  if (ctx.token !== null) headers.set('Authorization', `Bearer ${ctx.token}`);
  // Streamed rather than read into memory: an upload may be hundreds of
  // megabytes, and holding one here would be the only place on its path that
  // could not.
  const request = new Request(`${ctx.baseUrl}${path}?${search.toString()}`, {
    method: 'POST',
    headers,
    body: Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>,
    duplex: 'half',
  } as RequestInit);

  const response = await ctx.fetch(request);
  const text = await response.text();
  let body: unknown;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  if (!response.ok) throw toApiError(response, body);
  return { status: response.status, body: body as T };
}

export async function assertAbsent(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    return;
  }
  throw new CliError(`${path} already exists; pass --force to overwrite it`, EXIT.conflict);
}

// A download names no file on disk until it has arrived whole: it is written
// beside the target and renamed over it, so an interrupted transfer never
// leaves a truncated file under the real name.
export async function fetchFileBytes(
  ctx: RuntimeContext,
  fileId: string,
  version: number | undefined,
  target: string
): Promise<number> {
  const result = await ctx.api.GET('/api/files/{id}/download', {
    params: {
      path: { id: fileId },
      // A string on the wire, which is what the spec declares a query to be.
      ...(version === undefined ? {} : { query: { version: String(version) } }),
    },
    parseAs: 'stream',
  });
  if (!result.response.ok) {
    throw toApiError(result.response, result.error);
  }
  // openapi-fetch hands back no body at all for a zero-length response, which
  // is a legitimate empty file rather than a failure.
  const stream = result.data as unknown as ReadableStream<Uint8Array> | null | undefined;
  const source =
    stream == null
      ? Readable.from([])
      : Readable.fromWeb(stream as Parameters<typeof Readable.fromWeb>[0]);

  if (target === '-') {
    let written = 0;
    const out = ctx.deps.stdout as NodeJS.WritableStream & { write(chunk: Uint8Array): boolean };
    for await (const chunk of source) {
      const bytes = chunk as Buffer;
      written += bytes.length;
      if (!out.write(bytes) && typeof out.once === 'function') {
        await once(out, 'drain');
      }
    }
    return written;
  }

  const partial = `${target}.${String(process.pid)}.part`;
  try {
    await pipeline(source, createWriteStream(partial));
    await rename(partial, target);
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  }
  return (await stat(target)).size;
}

// Where a download lands: a file named outright, into a directory under the
// file's own name, or `-` for stdout. Nothing is overwritten without `force`.
export async function downloadTarget(
  output: string | undefined,
  name: string,
  force: boolean
): Promise<string> {
  let target = output ?? name;
  if (target === '-') return target;
  if (output !== undefined) {
    const info = await stat(output).catch(() => null);
    if (info?.isDirectory() === true) target = join(output, name);
  }
  if (!force) await assertAbsent(target);
  return target;
}

type UploadOutcome = 'uploaded' | 'versioned' | 'unchanged';

export interface UploadResult {
  path: string;
  outcome: UploadOutcome | 'failed';
  file_id?: string;
  filename?: string;
  file?: FileRow;
  version?: FileVersionResult['version'];
  error?: string;
}

// The bytes as the next version of a file that already exists. Identical bytes
// create nothing, and the API says so rather than refusing them.
export async function appendVersion(
  ctx: RuntimeContext,
  file: Pick<FileRow, 'id' | 'filename'>,
  localPath: string
): Promise<UploadResult> {
  const { body } = await sendFile<FileVersionResult>(
    ctx,
    `/api/files/${file.id}/versions`,
    {},
    localPath
  );
  return {
    path: localPath,
    outcome: body.created ? 'versioned' : 'unchanged',
    file_id: file.id,
    filename: file.filename,
    version: body.version,
  };
}

function describeUpload(result: UploadResult, where: string): string {
  const name = result.filename ?? result.path;
  const id = result.file_id === undefined ? '' : `  ${result.file_id.slice(0, 8)}`;
  switch (result.outcome) {
    case 'uploaded':
      return `Uploaded ${name} to ${where}${id}`;
    case 'versioned':
      return `Updated ${name} in ${where} to version ${String(result.version?.version_number)}${id}`;
    case 'unchanged':
      return `Unchanged ${name}: identical to version ${String(result.version?.version_number)}${id}`;
    case 'failed':
      return `${result.path}: ${result.error ?? 'failed'}`;
  }
}

// Every local path is checked before the first byte goes up, so a typo in the
// fifth path does not leave four files uploaded. Then one at a time -- the quota
// is checked per request, so a parallel burst could have every upload pass a
// check the set of them fails -- and a file the server refuses is reported and
// passed over rather than stranding the ones after it. A refusal that is about
// the caller rather than the file stops the batch, because every later file
// would meet it too.
export async function uploadEach(
  ctx: RuntimeContext,
  paths: readonly string[],
  where: string,
  upload: (path: string) => Promise<UploadResult>
): Promise<void> {
  for (const path of paths) await localFileSize(path);

  const results: UploadResult[] = [];
  let firstFailure: number | null = null;
  for (const path of paths) {
    let result: UploadResult;
    try {
      result = await upload(path);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : null;
      if (
        status === 401 ||
        status === 403 ||
        !(err instanceof ApiError || err instanceof CliError)
      ) {
        throw err;
      }
      firstFailure ??= err instanceof ApiError ? exitCodeForStatus(err.status) : err.exitCode;
      const hint = status === 409 ? '; pass --replace to add it as a new version instead' : '';
      result = { path, outcome: 'failed', error: `${err.message}${hint}` };
    }
    results.push(result);
    if (ctx.out.json) continue;
    if (result.outcome === 'failed') ctx.out.error(describeUpload(result, where));
    else ctx.out.line(describeUpload(result, where));
  }
  if (ctx.out.json) ctx.out.line(JSON.stringify(results, null, 2));
  if (firstFailure !== null) {
    const failed = results.filter((r) => r.outcome === 'failed').length;
    throw new CliError(
      `${String(failed)} of ${String(results.length)} uploads failed`,
      firstFailure
    );
  }
}
