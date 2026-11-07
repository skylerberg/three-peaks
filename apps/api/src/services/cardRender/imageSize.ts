import type { LoadedImage } from './svg.ts';

// An image's own size, in pixels for a PNG or JPEG and in user units for an
// SVG: what a nine-slice inset is counted in. Read from the header, so a
// picture is never decoded just to be measured. Null when the file states none
// -- an SVG with neither a viewBox nor a width and height.
export function imageSize(image: LoadedImage): { width: number; height: number } | null {
  const bytes = Buffer.from(image.bytes);
  switch (image.contentType) {
    case 'image/png':
      // The IHDR chunk is always first: width and height follow its name.
      return bytes.length >= 24
        ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
        : null;
    case 'image/jpeg':
      return jpegSize(bytes);
    case 'image/svg+xml':
      return svgSize(bytes.toString('utf8'));
    default:
      return null;
  }
}

// The frame header (any SOF marker but the three that share its range: DHT,
// JPG and DAC) carries height then width; every segment before it says its
// own length.
function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  let at = 2;
  while (at + 9 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
    }
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  return null;
}

function svgSize(source: string): { width: number; height: number } | null {
  const root = /<svg\b[^>]*>/i.exec(source)?.[0];
  if (root === undefined) return null;
  const attribute = (name: string) =>
    new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(root)?.[1];
  const viewBox = attribute('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (viewBox?.length === 4 && viewBox[2]! > 0 && viewBox[3]! > 0) {
    return { width: viewBox[2]!, height: viewBox[3]! };
  }
  const length = (value: string | undefined) => {
    const match = /^\s*([\d.]+)\s*(px)?\s*$/.exec(value ?? '');
    return match === null ? NaN : Number(match[1]);
  };
  const width = length(attribute('width'));
  const height = length(attribute('height'));
  return width > 0 && height > 0 ? { width, height } : null;
}
