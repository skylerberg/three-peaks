import opentype from 'opentype.js';
import { Resvg } from '@resvg/resvg-wasm';
import { ensureWasm } from '../../src/services/cardRender/render.ts';

// Fonts and pictures made in the test rather than checked in: a font whose
// every printable ASCII glyph is a box of one advance, so a line's width is
// arithmetic, and solid-colour PNGs whose pixels say exactly what was drawn.

const ASCENDER = 800;
const DESCENDER = -200;

export function boxFont(advance: number, family = 'Box'): Uint8Array {
  const { Font, Glyph, Path } = opentype;
  const glyphs = [new Glyph({ name: '.notdef', advanceWidth: advance, path: new Path() })];
  glyphs.push(
    new Glyph({ name: 'space', unicode: 32, advanceWidth: advance / 2, path: new Path() })
  );
  for (let code = 33; code <= 126; code++) {
    const path = new Path();
    const inset = advance / 10;
    path.moveTo(inset, 0);
    path.lineTo(advance - inset, 0);
    path.lineTo(advance - inset, 700);
    path.lineTo(inset, 700);
    path.close();
    glyphs.push(
      new Glyph({ name: `g${String(code)}`, unicode: code, advanceWidth: advance, path })
    );
  }
  const font = new Font({
    familyName: family,
    styleName: 'Regular',
    unitsPerEm: 1000,
    ascender: ASCENDER,
    descender: DESCENDER,
    glyphs,
  });
  return new Uint8Array(font.toArrayBuffer());
}

export async function solidPng(color: string, width = 8, height = 8): Promise<Uint8Array> {
  await ensureWasm();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}"><rect width="${String(width)}" height="${String(height)}" fill="${color}"/></svg>`;
  return rasterise(svg, width).png;
}

export function solidSvg(color: string): Uint8Array {
  return new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="${color}"/></svg>`
  );
}

export interface Raster {
  png: Uint8Array;
  width: number;
  height: number;
  pixels: Uint8Array;
}

export function rasterise(svg: string, width: number): Raster {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: { loadSystemFonts: false },
  });
  const rendered = resvg.render();
  const result = {
    png: rendered.asPng(),
    width: rendered.width,
    height: rendered.height,
    pixels: new Uint8Array(rendered.pixels),
  };
  rendered.free();
  resvg.free();
  return result;
}

// The colour at a point of a raster, as #rrggbb, with its alpha beside it.
export function pixelAt(raster: Raster, x: number, y: number): { color: string; alpha: number } {
  const offset = (Math.floor(y) * raster.width + Math.floor(x)) * 4;
  const [r, g, b, a] = raster.pixels.slice(offset, offset + 4);
  const hex = [r, g, b].map((channel) => channel!.toString(16).padStart(2, '0')).join('');
  return { color: `#${hex}`, alpha: a! };
}
