import {
  backSlotX,
  isLiveCard,
  planPunchboard,
  punchboardDieLine,
  tokenOutlinePath,
  tokenShape,
  type PunchboardModelSettings,
} from '@three-peaks/shared';
import type { components } from '@three-peaks/shared/api';
import { authHeader } from '../api/client.ts';
import { writeZip } from './scene/zip.ts';

type Token = components['schemas']['Component']['tokens'][number];

// The resolution the printed sides are drawn at, which is what a printer asks
// a file for.
export const SHEET_DPI = 300;

async function readImage(fileId: string): Promise<ImageBitmap> {
  const response = await fetch(`/api/files/${fileId}/download`, { headers: authHeader() });
  if (!response.ok) throw new Error(`Could not read a token's image (status ${response.status})`);
  return createImageBitmap(await response.blob());
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) =>
      blob ? resolve(blob) : reject(new Error('The sheet could not be drawn'))
    );
  });
}

/**
 * What a manufacturer cuts the punchboard from, as one archive: its two printed
 * sides at print resolution and its die line, all worked out from the tokens as
 * the 3D studio lays them out, so the files and the model cannot disagree. One
 * archive rather than three downloads, which a browser stops after the first
 * to ask whether the page may.
 *
 * The back is the sheet's reverse as it is printed, every token's back behind
 * its own front -- mirrored across the sheet, drawn upright -- and the board is
 * left unprinted wherever a token has no back. Each face is clipped to the
 * token's outline, which leaves the board round it without ink.
 */
export async function punchboardSheetFiles(
  settings: PunchboardModelSettings,
  tokens: readonly Token[]
): Promise<Blob> {
  const live = tokens.filter(isLiveCard);
  const plan = planPunchboard(
    settings,
    live.map((token) => token.quantity)
  );
  const shape = tokenShape(settings);
  const scale = SHEET_DPI / 25.4;
  const width = Math.round(settings.width_mm * scale);
  const height = Math.round(settings.height_mm * scale);

  // Each image read once, however many copies print it.
  const images = new Map<string, Promise<ImageBitmap>>();
  const image = (fileId: string) => {
    let pending = images.get(fileId);
    if (!pending) {
      pending = readImage(fileId);
      images.set(fileId, pending);
    }
    return pending;
  };

  const side = async (pick: (token: Token) => string | null, mirrored: boolean) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser did not give up a 2D canvas context');
    context.scale(scale, scale);
    for (const slot of plan.slots) {
      const fileId = pick(live[slot.token]!);
      if (fileId === null) continue;
      const x = mirrored ? backSlotX(settings, slot, shape) : slot.x_mm;
      context.save();
      context.clip(new Path2D(tokenOutlinePath(shape, x, slot.y_mm)));
      context.drawImage(await image(fileId), x, slot.y_mm, shape.width_mm, shape.height_mm);
      context.restore();
    }
    return toBlob(canvas);
  };

  try {
    const front = await side((token) => token.file_id, false);
    // A back that is deleted prints nothing, as the 3D studio shows it.
    const back = await side(
      (token) => (token.back_file?.deleted_at === null ? token.back_file.id : null),
      true
    );
    const bytes = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
    return await writeZip([
      { name: 'front.png', bytes: await bytes(front) },
      { name: 'back.png', bytes: await bytes(back) },
      {
        name: 'die line.svg',
        bytes: new TextEncoder().encode(punchboardDieLine(settings, plan)),
        compress: true,
      },
    ]);
  } finally {
    for (const pending of images.values())
      void pending.then(
        (bitmap) => bitmap.close(),
        () => {}
      );
  }
}
