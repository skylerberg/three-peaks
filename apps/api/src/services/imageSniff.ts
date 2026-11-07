// The client's declared Content-Type is ignored. It is user input, it decides
// how a browser will later render the bytes, and a .png that is actually HTML
// is a stored XSS if anything ever serves it inline.
//
// A kilobyte, because SVG is the one format here with no fixed byte prefix: it
// is XML, and its root tag sits behind however much declaration, comment and
// doctype the exporter felt like emitting. Everything else is decided in the
// first twelve bytes. The head is still buffered a chunk at a time, so this is
// a bound on what is held, not on what is read.
export const SNIFF_BYTES = 1024;

export type SniffedContentType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp'
  | 'image/svg+xml'
  | 'model/gltf-binary'
  | 'font/ttf'
  | 'font/otf'
  | 'font/woff';

function startsWith(buffer: Buffer, bytes: number[], offset = 0): boolean {
  if (buffer.length < offset + bytes.length) return false;
  return bytes.every((byte, index) => buffer[offset + index] === byte);
}

// Consumes whatever may legally precede an XML root element and returns what is
// left. Anything unterminated returns empty: a declaration still open at the end
// of the head is a document whose root tag we have not actually seen.
function skipXmlPreamble(text: string): string {
  let rest = text;

  for (;;) {
    const trimmed = rest.replace(/^\s+/, '');

    if (trimmed.startsWith('<?')) {
      const end = trimmed.indexOf('?>');
      if (end === -1) return '';
      rest = trimmed.slice(end + 2);
      continue;
    }

    if (trimmed.startsWith('<!--')) {
      const end = trimmed.indexOf('-->');
      if (end === -1) return '';
      rest = trimmed.slice(end + 3);
      continue;
    }

    if (/^<!DOCTYPE/i.test(trimmed)) {
      const bracket = trimmed.indexOf('[');
      const close = trimmed.indexOf('>');
      if (close === -1) return '';
      // An internal subset puts unescaped '>' inside the doctype, so the first
      // one is not the end of it.
      const end = bracket !== -1 && bracket < close ? trimmed.indexOf(']>') : close - 1;
      if (end === -1) return '';
      rest = trimmed.slice(end + 2);
      continue;
    }

    return trimmed;
  }
}

function isSvg(head: Buffer): boolean {
  // The head is a byte prefix, so its last character can be half a UTF-8
  // sequence; the non-fatal decoder makes that U+FFFD instead of throwing.
  const text = new TextDecoder('utf-8').decode(head).replace(/^\uFEFF/, '');
  return /^<svg[\s/>]/i.test(skipXmlPreamble(text));
}

// What a card layout's text is drawn in. An sfnt opens with a four-byte version
// and then its table count, and the count is checked too: 00 01 00 00 alone is a
// prefix plenty of binary formats could start with. A collection (`ttcf`) is
// left unrecognised because nothing here can choose a face out of one.
function sniffFont(head: Buffer): 'font/ttf' | 'font/otf' | 'font/woff' | null {
  if (head.length < 12) return null;
  if (startsWith(head, [0x77, 0x4f, 0x46, 0x46])) return 'font/woff';
  const tables = head.readUInt16BE(4);
  if (tables < 1 || tables > 100) return null;
  // 00 01 00 00 is TrueType outlines, and "true" is Apple's older spelling of it.
  if (startsWith(head, [0x00, 0x01, 0x00, 0x00]) || startsWith(head, [0x74, 0x72, 0x75, 0x65])) {
    return 'font/ttf';
  }
  // "OTTO": CFF outlines.
  if (startsWith(head, [0x4f, 0x54, 0x54, 0x4f])) return 'font/otf';
  return null;
}

export function sniffContentType(head: Buffer): SniffedContentType | null {
  // 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  // FF D8 FF
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  // "GIF87a" / "GIF89a"
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  // "RIFF" .... "WEBP"
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }
  // "glTF" then a little-endian version. Only 2 exists in the wild, and this
  // repo writes it -- a bare magic check would also pass the dead v1 layout.
  if (startsWith(head, [0x67, 0x6c, 0x54, 0x46]) && startsWith(head, [0x02, 0x00, 0x00, 0x00], 4)) {
    return 'model/gltf-binary';
  }
  const font = sniffFont(head);
  if (font !== null) return font;
  if (isSvg(head)) return 'image/svg+xml';
  return null;
}
