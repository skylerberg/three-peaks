import {
  type CardSize,
  planRuns,
  planTiles,
  summarizeRuns,
  tilesWantBlankBacks,
} from '@three-peaks/shared';
import { type PrintImage, loadPrintImage } from './images.ts';
import {
  type ImageSource,
  type PrintBoard,
  type PrintOptions,
  pageTurner,
  renderBoards,
  renderRuns,
} from './pdf.ts';

export type { ArtworkFit, PrintBoard, PrintOptions } from './pdf.ts';

export interface PrintJobDeck {
  name: string;
  card: CardSize;
  back_file_id: string | null;
  cards: readonly { file_id: string; copies: number }[];
}

export interface PrintJob {
  decks: readonly PrintJobDeck[];
  // Drawn after every card sheet, each split over as many pages as it needs.
  boards?: readonly PrintBoard[];
  options: PrintOptions;
  // Which version of each file to draw, by file id. A file left out is drawn at
  // whatever it is now, which is what a screen that has no version to offer
  // wants; the print screen has one for every card and pins them all.
  versions?: Readonly<Record<string, number>>;
}

export interface PrintProgress {
  drawn: number;
  total: number;
}

// One fetch and one decode per distinct piece of artwork, however many cards
// name it and whichever side of them it is on. Every turn a card takes is drawn
// in the file rather than in the pixels, so there is one copy of each to hold.
function cachedImages(versions: Readonly<Record<string, number>>): ImageSource {
  const cache = new Map<string, Promise<PrintImage>>();

  const once = (fileId: string, load: () => Promise<PrintImage>) => {
    const existing = cache.get(fileId);
    if (existing) return existing;
    const started = load();
    cache.set(fileId, started);
    return started;
  };

  return {
    artwork: (fileId, card) =>
      once(fileId, () =>
        loadPrintImage(fileId, Math.max(card.width_mm, card.height_mm), versions[fileId])
      ),
    board: (fileId, size) =>
      once(fileId, () =>
        loadPrintImage(fileId, Math.max(size.width_mm, size.height_mm), versions[fileId], 'JPEG')
      ),
  };
}

/**
 * Builds the whole document and hands back the bytes.
 *
 * `jspdf` is imported here and nowhere above, so it lands in the chunk this
 * module already is -- reached only through `await import()` from the print
 * screen, the way the 3D studio keeps `three` out of everyone else's bundle.
 */
export async function generatePrintPdf(
  job: PrintJob,
  onProgress?: (progress: PrintProgress) => void
): Promise<Blob> {
  const runs = planRuns(job.decks);
  const boards = job.boards ?? [];
  if (runs.length === 0 && boards.length === 0) {
    throw new Error('There is nothing selected to print.');
  }

  const { page, printer_margin_mm: margin, include_backs: backs } = job.options;
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({
    unit: 'mm',
    format: [page.width_mm, page.height_mm],
    orientation: 'portrait',
    compress: true,
  });

  const images = cachedImages(job.versions ?? {});
  const turn = pageTurner(doc);
  const tiles = boards.reduce((sum, board) => sum + planTiles(page, board, margin).pages, 0);
  let cards = 0;

  await renderRuns(
    doc,
    runs,
    job.options,
    images,
    (progress) => {
      cards = progress.total;
      onProgress?.({ drawn: progress.drawn, total: progress.total + tiles });
    },
    turn
  );

  await renderBoards(
    doc,
    boards,
    job.options,
    images,
    turn,
    tilesWantBlankBacks(backs, summarizeRuns(runs, page, margin, backs).sheets),
    (drawn) => onProgress?.({ drawn: cards + drawn, total: cards + tiles })
  );

  return doc.output('blob');
}
