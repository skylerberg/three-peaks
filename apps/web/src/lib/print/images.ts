import { pixelsForPrint } from '@three-peaks/shared';
import { authHeader } from '../../api/client.ts';

// Artwork on its way into a PDF. `data` is what jsPDF embeds, and `format` is
// what it is told the bytes are -- the two are the same fact, kept together so
// no caller can pair a PNG with 'JPEG'.
export interface PrintImage {
  data: Uint8Array;
  format: 'PNG' | 'JPEG';
  width: number;
  height: number;
}

// The one format a PDF holds as-is. A JPEG is embedded as a DCTDecode stream
// with nothing decoded on the way in, so the bytes the designer uploaded are
// the bytes that get printed.
//
// PNG is deliberately NOT in here, which looks like an oversight and is not:
// jsPDF decodes every PNG and re-encodes it as a Flate stream regardless, so
// there is no pass-through to lose -- and its decoder is stricter than a
// browser's. A PNG with a bad adler32 or an interlaced one renders everywhere
// else and makes `addImage` throw, taking the whole print run with it. Routing
// them through the canvas that has already decoded them costs nothing and
// cannot fail that way.
const PASSED_THROUGH = 'image/jpeg';

// Guards against a source whose own dimensions are enormous. 6000 px is 508 mm
// at print resolution, and past the point where a browser will reliably give up
// a canvas of it -- so a board longer than that is printed coarser rather than
// not at all.
const MAX_RASTER_PIXELS = 6000;

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser did not give up a 2D canvas context');
  return ctx;
}

// What a raster that has been through the canvas is written back out as.
//
// PNG is the default and is lossless. JPEG is for a board: jsPDF holds a PNG
// decoded while it re-encodes it, which measured at 300 MB for a 6000 px
// square, where a JPEG is handed over as the stream it already is. The loss is
// at a quality nobody can see on a taped-together proof.
export type RasterFormat = PrintImage['format'];

const JPEG_QUALITY = 0.92;

async function encoded(canvas: HTMLCanvasElement, format: RasterFormat): Promise<PrintImage> {
  const blob = await new Promise<Blob | null>((resolve) =>
    format === 'JPEG'
      ? canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY)
      : canvas.toBlob(resolve, 'image/png')
  );
  if (!blob) throw new Error('This browser could not encode the artwork');
  return {
    data: new Uint8Array(await blob.arrayBuffer()),
    format,
    width: canvas.width,
    height: canvas.height,
  };
}

function drawn(
  source: CanvasImageSource,
  width: number,
  height: number,
  format: RasterFormat
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = context(canvas);
  // A JPEG has no alpha, and a canvas encodes what was transparent as black.
  // Paper is what shows through a transparent pixel, and paper is white.
  if (format === 'JPEG') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// An SVG has no resolution of its own, so it is rasterised straight at the size
// it will be printed rather than at whatever the document happens to declare.
async function rasterizeSvg(
  text: string,
  targetPixels: number,
  format: RasterFormat
): Promise<PrintImage> {
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();

    const naturalWidth = image.naturalWidth || targetPixels;
    const naturalHeight = image.naturalHeight || targetPixels;
    const scale = targetPixels / Math.max(naturalWidth, naturalHeight);
    return await encoded(drawn(image, naturalWidth * scale, naturalHeight * scale, format), format);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Reads one file and returns it ready to embed.
 *
 * A JPEG is handed over untouched; everything else is redrawn through a canvas
 * at `targetMm` at print resolution. Rasters are never scaled up on that path --
 * a 200 px source printed at 300 DPI is a low-resolution card, and interpolating
 * it to look like a high-resolution one only hides that from the warning in the
 * editor.
 *
 * The declared type comes off the response rather than from the file row,
 * because the API decides an image's type by its magic bytes and serves that.
 *
 * `version` pins which bytes: the print screen draws the version it was told
 * about and records that same number, so the ledger says what is on the paper
 * rather than what the file reached while the document was building.
 */
export async function loadPrintImage(
  fileId: string,
  targetMm: number,
  version?: number,
  format: RasterFormat = 'PNG'
): Promise<PrintImage> {
  const query = version === undefined ? '' : `?version=${version}`;
  const response = await fetch(`/api/files/${fileId}/download${query}`, { headers: authHeader() });
  if (!response.ok) throw new Error(`Could not read the artwork (status ${response.status})`);

  const contentType = (response.headers.get('Content-Type') ?? '').split(';')[0].trim();
  const targetPixels = Math.min(MAX_RASTER_PIXELS, pixelsForPrint(targetMm));

  if (contentType === 'image/svg+xml') {
    return await rasterizeSvg(await response.text(), targetPixels, format);
  }

  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  try {
    if (contentType === PASSED_THROUGH) {
      return {
        data: new Uint8Array(await blob.arrayBuffer()),
        format: 'JPEG',
        width: bitmap.width,
        height: bitmap.height,
      };
    }

    const scale = Math.min(1, targetPixels / Math.max(bitmap.width, bitmap.height));
    return await encoded(
      drawn(bitmap, bitmap.width * scale, bitmap.height * scale, format),
      format
    );
  } finally {
    bitmap.close();
  }
}
