import {
  COMPONENT_KIND_INFO,
  COMPONENT_NAME_LIMITS,
  type ComponentKind,
  DEFAULT_BOARD_SETTINGS,
  MODEL_LIMITS,
} from '@three-peaks/shared';
import type { components } from '@three-peaks/shared/api';
import { api, assertOk, postBytes } from 'src/api';
import type { Design, DesignPage } from 'src/design';

type Component = components['schemas']['Component'];

export class BoardPlanError extends Error {}

// Canva sizes a page in pixels at 96 to the inch whatever unit the design was
// made in, so a page drawn 500 mm wide reads back as 1889.76. Taken from how
// its resize dialog converts rather than measured through the SDK -- which is
// why the plan says every board's millimetres before a byte is uploaded.
const CANVA_PIXELS_PER_INCH = 96;
const MM_PER_INCH = 25.4;

// To a hundredth, which is finer than a blade and coarse enough that 1889.76
// pixels comes back as the 500 somebody typed.
function millimetres(pixels: number): number {
  return Math.round((pixels / CANVA_PIXELS_PER_INCH) * MM_PER_INCH * 100) / 100;
}

function boardName(title: string): string {
  return title
    .normalize('NFC')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, COMPONENT_NAME_LIMITS[1])
    .trim();
}

// The project's own index compares names case-folded, so two names this folds
// together are two the API would refuse to hold side by side.
function nameKey(name: string): string {
  return name.toLowerCase();
}

export interface BoardPlanRow {
  pageNumber: number;
  name: string;
  width_mm: number;
  height_mm: number;
  // The board this page lands on, or null for one it creates.
  board: Component | null;
}

function boardSize(board: Component): { width_mm: number; height_mm: number } | null {
  if (board.settings.kind !== 'board') return null;
  return { width_mm: board.settings.width_mm, height_mm: board.settings.height_mm };
}

// What the board measured before, where the page now says something else.
function resizedFrom(row: BoardPlanRow): { width_mm: number; height_mm: number } | null {
  const held = row.board === null ? null : boardSize(row.board);
  if (held === null) return null;
  return held.width_mm === row.width_mm && held.height_mm === row.height_mm ? null : held;
}

function pageName(design: Design, page: DesignPage): string | null {
  // A design that is one page is the board, and its own name is the one
  // somebody gave it. With several pages that name is none of theirs.
  const title = page.title ?? (design.pages.length === 1 ? design.title : null);
  if (title === null) return null;
  const name = boardName(title);
  return name.length === 0 ? null : name;
}

/**
 * Which board every page of the design becomes.
 *
 * A page is matched to a board by its name and by nothing else. A deck matches
 * on the page's id first, and that tier is deliberately absent here: a page id
 * survives a duplicate of the whole design, and duplicating a design is how a
 * second board is started from the first. Inside one deck that is harmless.
 * Across a project it would land the copy's artwork on the original and rename
 * it, which is the one outcome nobody duplicating a design wants.
 *
 * Nothing is ever removed. A deck is the whole of its design, so a page that
 * has gone is a card to delete; a project's boards are not the whole of any one
 * design, and a board this design does not name is somebody else's.
 *
 * Every problem is found before anything is uploaded and all of them are
 * reported together, because each one is fixed in Canva and a run that stops at
 * the first is an export per mistake.
 */
export function planBoards(design: Design, existing: readonly Component[]): BoardPlanRow[] {
  const [minSide, maxSide] = MODEL_LIMITS.board.width_mm;
  const held = new Map(existing.map((component) => [nameKey(component.name), component]));
  const problems: string[] = [];
  const seen = new Map<string, number>();
  const rows: BoardPlanRow[] = [];

  for (const page of design.pages) {
    const name = pageName(design, page);
    if (name === null) {
      problems.push(
        design.pages.length === 1
          ? 'This design has no name. A board is named after its design or its page, so name one of them in Canva first.'
          : `Page ${page.pageNumber} has no title. Each page becomes a board named after it, so name every page in Canva first.`
      );
      continue;
    }

    const earlier = seen.get(nameKey(name));
    if (earlier !== undefined) {
      problems.push(
        `Pages ${earlier} and ${page.pageNumber} are both named “${name}”, and two boards cannot share a name.`
      );
      continue;
    }
    seen.set(nameKey(name), page.pageNumber);

    if (page.size === null) {
      problems.push(`“${name}” is a page with no fixed size, so there is nothing to cut it to.`);
      continue;
    }

    const width_mm = millimetres(page.size.width);
    const height_mm = millimetres(page.size.height);
    if ([width_mm, height_mm].some((side) => side < minSide || side > maxSide)) {
      problems.push(
        `“${name}” is ${width_mm} × ${height_mm} mm. A board is between ${minSide} and ${maxSide} mm on each side.`
      );
      continue;
    }

    const match = held.get(nameKey(name)) ?? null;
    if (match !== null && match.kind !== 'board') {
      const other = COMPONENT_KIND_INFO[match.kind as ComponentKind].singular;
      problems.push(
        `“${name}” is already the name of a ${other} in this project. Rename the page or the ${other}.`
      );
      continue;
    }

    rows.push({ pageNumber: page.pageNumber, name, width_mm, height_mm, board: match });
  }

  if (problems.length > 0) throw new BoardPlanError(problems.join('\n\n'));
  return rows;
}

// What one row of the plan will do, said before it does it. A changed size is
// worth its own words: it is the one thing an import decides for a board that
// somebody may have set by hand.
export function describeBoardRow(row: BoardPlanRow): string {
  const size = `${row.width_mm} × ${row.height_mm} mm`;
  if (row.board === null) return `New board, ${size}`;
  const before = resizedFrom(row);
  return before === null
    ? `Updates the board, ${size}`
    : `Updates the board, resized from ${before.width_mm} × ${before.height_mm} to ${size}`;
}

export interface BoardCounts {
  added: number;
  updated: number;
  unchanged: number;
}

export interface Progress {
  done: number;
  total: number;
}

function artworkFilename(name: string): string {
  return `${name.replace(/[/\\]/gu, '-')}.png`;
}

async function uploadArtwork(
  projectId: string,
  componentId: string,
  name: string,
  bytes: Blob
): Promise<void> {
  const query = new URLSearchParams({
    project_id: projectId,
    filename: artworkFilename(name),
    component_id: componentId,
    role: 'artwork',
  });
  await postBytes('/api/files/upload', query, bytes, 'image/png');
}

async function createBoard(projectId: string, row: BoardPlanRow, bytes: Blob): Promise<void> {
  const created = assertOk(
    await api.POST('/api/components', {
      body: {
        project_id: projectId,
        kind: 'board',
        name: row.name,
        settings: {
          ...DEFAULT_BOARD_SETTINGS,
          width_mm: row.width_mm,
          height_mm: row.height_mm,
        },
      },
    })
  );
  await uploadArtwork(projectId, created.id, row.name, bytes);
}

// Whether anything about the board changed, which is what tells an import that
// redrew it from one that found it exactly as it left it.
async function updateBoard(projectId: string, board: Component, row: BoardPlanRow, bytes: Blob) {
  let changed = false;

  if (resizedFrom(row) !== null && board.settings.kind === 'board') {
    assertOk(
      await api.PATCH('/api/components/{componentId}', {
        params: { path: { componentId: board.id } },
        body: { settings: { ...board.settings, width_mm: row.width_mm, height_mm: row.height_mm } },
      })
    );
    changed = true;
  }

  const artwork = board.files.find((entry) => entry.role === 'artwork')?.file ?? null;
  if (artwork === null) {
    await uploadArtwork(projectId, board.id, row.name, bytes);
    return true;
  }

  // A deleted file still holds the component's one artwork slot, so there is
  // no uploading a replacement beside it; and a tombstone refuses a new
  // version. It is put back and given the new bytes as its next version, which
  // keeps the history the board already had.
  if (artwork.deleted_at !== null) {
    assertOk(await api.POST('/api/files/{id}/restore', { params: { path: { id: artwork.id } } }));
    changed = true;
  }

  // A version rather than a second file: the board keeps its settings and its
  // history, and bytes identical to what it already has write nothing at all.
  const response = await postBytes(
    `/api/files/${artwork.id}/versions`,
    new URLSearchParams(),
    bytes,
    'image/png'
  );
  const appended = (await response.json()) as { created: boolean };
  return changed || appended.created;
}

/**
 * Uploads every page onto the board the plan named for it.
 *
 * One at a time, for the reason `uploadPages` gives. There is no run to open or
 * finish: each board is complete as its own upload lands, so a failure part-way
 * leaves the ones before it imported and importing again picks up the rest --
 * an unchanged board costs one request and writes nothing.
 */
export async function importBoards(
  projectId: string,
  rows: readonly BoardPlanRow[],
  urls: readonly string[],
  onProgress: (progress: Progress) => void
): Promise<BoardCounts> {
  const counts: BoardCounts = { added: 0, updated: 0, unchanged: 0 };

  for (const [index, row] of rows.entries()) {
    // By page number, not by position in the plan: the export is one image per
    // page of the design, in the design's order.
    const url = urls[row.pageNumber - 1];
    if (url === undefined) throw new Error(`Page ${row.pageNumber} has no exported image`);

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not download page ${row.pageNumber} from Canva`);
    const bytes = await response.blob();

    if (row.board === null) {
      await createBoard(projectId, row, bytes);
      counts.added += 1;
    } else if (await updateBoard(projectId, row.board, row, bytes)) {
      counts.updated += 1;
    } else {
      counts.unchanged += 1;
    }
    onProgress({ done: index + 1, total: rows.length });
  }

  return counts;
}
