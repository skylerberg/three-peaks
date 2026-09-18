import { extname } from 'node:path';
import { CliError, EXIT, assertOk } from './errors.ts';
import {
  fetchDeck,
  fetchDirectory,
  folderPathOf,
  splitPath,
  type FileRow,
  type Folder,
} from './resolve.ts';
import type { RuntimeContext } from './context.ts';

export function assetsPath(folderPath: string): string {
  return folderPath === '' ? 'Assets' : `Assets/${folderPath}`;
}

// Where a file lives, said the way the screen that lists it says it.
export async function describeHome(ctx: RuntimeContext, file: FileRow): Promise<string> {
  if (file.deck_id !== null) {
    const { deck } = await fetchDeck(ctx, file.deck_id);
    return deck.back_file_id === file.id ? `deck "${deck.name}" (its back)` : `deck "${deck.name}"`;
  }
  if (file.component_id !== null) {
    const component = assertOk(
      await ctx.api.GET('/api/components/{componentId}', {
        params: { path: { componentId: file.component_id } },
      })
    );
    const role = file.component_role === null ? '' : ` (${file.component_role})`;
    return `component "${component.name}"${role}`;
  }
  if (file.folder_id === null) return 'Assets';
  return assetsPath(folderPathOf(await fetchDirectory(ctx, file.project_id, file.folder_id)));
}

export function parsePositiveInt(value: string, what: string): number {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1) {
    throw new CliError(`${what} must be a positive whole number, not "${value}"`, EXIT.usage);
  }
  return number;
}

// A stored filename is whatever the uploader called it, so it is never trusted
// as a path: a separator or a dot-name would write somewhere other than the
// directory the download was aimed at.
export function localName(filename: string, fallback: string): string {
  const flattened = filename.replace(/[/\\]/g, '_').replace(/\p{Cc}/gu, '');
  return flattened === '' || flattened === '.' || flattened === '..' ? fallback : flattened;
}

// An old version keeps its extension last, so it still opens in whatever opens
// the current one.
export function versionedName(filename: string, version: number): string {
  const extension = extname(filename);
  const stem = extension === '' ? filename : filename.slice(0, -extension.length);
  return `${stem}.v${String(version)}${extension}`;
}

export interface EnsuredFolder {
  folder: Folder | null;
  path: string;
  created: Folder[];
}

// Walks a folder path from the root, creating what is missing when `parents`
// allows and refusing at the first missing segment otherwise. The last segment
// is always created unless it exists, in which case only `parents` makes that
// an answer rather than a conflict -- the way `mkdir -p` treats it.
export async function ensureFolderPath(
  ctx: RuntimeContext,
  projectId: string,
  path: string,
  parents: boolean
): Promise<EnsuredFolder> {
  const segments = splitPath(path);
  if (segments.length === 0) {
    throw new CliError('Name a folder to create, not the Assets root', EXIT.usage);
  }
  let parent: Folder | null = null;
  const created: Folder[] = [];
  const walked: string[] = [];
  for (const [index, segment] of segments.entries()) {
    walked.push(segment);
    const last = index === segments.length - 1;
    const listing = await fetchDirectory(ctx, projectId, parent?.id ?? null);
    const existing = listing.folders.find((f) => f.name.toLowerCase() === segment.toLowerCase());
    if (existing !== undefined) {
      if (last && !parents) {
        throw new CliError(
          `${assetsPath(walked.join('/'))} already exists; pass --parents to accept that`,
          EXIT.conflict
        );
      }
      parent = existing;
      continue;
    }
    if (!last && !parents) {
      throw new CliError(
        `No folder ${assetsPath(walked.join('/'))}; pass --parents to create it`,
        EXIT.notFound
      );
    }
    const folder: Folder = assertOk(
      await ctx.api.POST('/api/files/folders', {
        body: {
          id: crypto.randomUUID(),
          project_id: projectId,
          parent_id: parent?.id ?? null,
          name: segment,
        },
      })
    );
    created.push(folder);
    parent = folder;
  }
  return { folder: parent, path: segments.join('/'), created };
}
