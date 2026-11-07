import type { Font } from 'opentype.js';
import {
  type CardFields,
  type ImageFit,
  type LayoutBox,
  type LayoutSpec,
  type TextElement,
  fillTemplate,
  hasValue,
  parseMarkup,
} from '@three-peaks/shared';
import { flowText, type Face, type Faces } from './flow.ts';

// One card as an SVG document, in millimetres. Every glyph is written out as a
// path, so the rasteriser is never handed text: what it draws cannot depend on
// which fonts a machine has, or on how it would have shaped them.

export interface LoadedImage {
  bytes: Uint8Array;
  contentType: string;
}

export interface CardAssets {
  // By the layout's own keys.
  fonts: ReadonlyMap<string, Font>;
  icons: ReadonlyMap<string, LoadedImage>;
  // By file id: the layout's fixed images and the card's own.
  images: ReadonlyMap<string, LoadedImage>;
}

export interface CardLayout {
  name: string;
  width_mm: number;
  height_mm: number;
  spec: LayoutSpec;
}

// Raised for a card that cannot be drawn as written, with a sentence about the
// card rather than about the renderer.
export class CardRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CardRenderError';
  }
}

// Four decimals of a millimetre is a tenth of a micron: far below any dot a
// printer makes, and fixed, so the document is the same string every time.
function n(value: number): string {
  const rounded = Math.round(value * 1e4) / 1e4;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function dataUri(image: LoadedImage): string {
  return `data:${image.contentType};base64,${Buffer.from(image.bytes).toString('base64')}`;
}

const ASPECT: Record<ImageFit, string> = {
  cover: 'xMidYMid slice',
  contain: 'xMidYMid meet',
  fill: 'none',
};

function boxAttributes([x, y, width, height]: LayoutBox): string {
  return `x="${n(x)}" y="${n(y)}" width="${n(width)}" height="${n(height)}"`;
}

function faceOf(font: Font): Face {
  return {
    ascender: font.ascender / font.unitsPerEm,
    descender: font.descender / font.unitsPerEm,
    advance: (text, size) => font.getAdvanceWidth(text, size),
  };
}

function missingGlyphs(font: Font, text: string): string[] {
  const missing = new Set<string>();
  for (const char of text) if (!/\s/.test(char) && !font.hasChar(char)) missing.add(char);
  return [...missing];
}

function textMarkup(
  element: TextElement,
  where: string,
  fields: CardFields,
  assets: CardAssets,
  clip: (box: LayoutBox) => string
): string {
  const { runs } = parseMarkup(fillTemplate(element.text, fields));
  const regular = assets.fonts.get(element.font)!;
  const bold = element.bold_font === null ? null : assets.fonts.get(element.bold_font)!;

  if (bold === null && runs.some((run) => run.kind === 'text' && run.bold)) {
    throw new CardRenderError(
      `${where} has **bold** copy, and the layout gives it no bold_font to set it in`
    );
  }
  for (const run of runs) {
    if (run.kind !== 'text') continue;
    const font = run.bold ? bold! : regular;
    const missing = missingGlyphs(font, run.text);
    if (missing.length > 0) {
      const key = run.bold ? element.bold_font! : element.font;
      throw new CardRenderError(
        `${where}: font "${key}" has no glyph for ${missing.map((c) => `"${c}"`).join(', ')}`
      );
    }
  }

  const faces: Faces = { regular: faceOf(regular), bold: faceOf(bold ?? regular) };
  const [x, y, width, height] = element.box;
  const result = flowText(runs, faces, { x, y, width, height }, element);
  if (!result.fits) throw new CardRenderError(`${where} ${result.reason}`);

  const paths: string[] = [];
  const icons: string[] = [];
  for (const item of result.items) {
    if (item.kind === 'text') {
      const font = item.bold ? bold! : regular;
      paths.push(font.getPath(item.text, item.x, item.baseline, item.size).toPathData(4));
    } else {
      const icon = assets.icons.get(item.key)!;
      icons.push(
        `<image ${boxAttributes([item.x, item.y, item.size, item.size])} preserveAspectRatio="xMidYMid meet" href="${dataUri(icon)}"/>`
      );
    }
  }
  const parts: string[] = [];
  const d = paths.filter((path) => path !== '').join('');
  if (d !== '') parts.push(`<path d="${d}" fill="${element.color}"/>`);
  parts.push(...icons);
  if (parts.length === 0) return '';
  // Clipped to its box, so nothing that measured as fitting -- a glyph whose
  // outline overhangs its advance -- reaches past where the layout put it.
  return `<g clip-path="${clip(element.box)}">${parts.join('')}</g>`;
}

export function buildCardSvg(layout: CardLayout, fields: CardFields, assets: CardAssets): string {
  const defs: string[] = [];
  const body: string[] = [];
  const clip = (box: LayoutBox) => {
    const id = `c${String(defs.length)}`;
    defs.push(`<clipPath id="${id}"><rect ${boxAttributes(box)}/></clipPath>`);
    return `url(#${id})`;
  };

  layout.spec.elements.forEach((element, index) => {
    if (element.when !== null && !hasValue(fields, element.when)) return;
    const where = `element ${String(index + 1)} (${element.type})`;

    if (element.type === 'image') {
      const id =
        element.source.from === 'file'
          ? element.source.file_id
          : (fields[element.source.field] ?? '');
      // An empty image field draws nothing, which is what `when` is usually
      // there to say; a fixed image is never empty.
      if (id.trim() === '') return;
      const image = assets.images.get(id);
      if (image === undefined) throw new CardRenderError(`${where}: image ${id} was not loaded`);
      body.push(
        `<image ${boxAttributes(element.box)} preserveAspectRatio="${ASPECT[element.fit]}" clip-path="${clip(element.box)}" href="${dataUri(image)}"/>`
      );
    } else if (element.type === 'rect') {
      const attributes = [
        boxAttributes(element.box),
        element.radius_mm > 0 ? `rx="${n(element.radius_mm)}" ry="${n(element.radius_mm)}"` : '',
        `fill="${element.fill ?? 'none'}"`,
        element.stroke !== null && element.stroke_mm > 0
          ? `stroke="${element.stroke}" stroke-width="${n(element.stroke_mm)}"`
          : '',
        element.opacity < 1 ? `opacity="${n(element.opacity)}"` : '',
      ].filter((attribute) => attribute !== '');
      body.push(`<rect ${attributes.join(' ')}/>`);
    } else {
      const markup = textMarkup(element, where, fields, assets, clip);
      if (markup !== '') body.push(markup);
    }
  });

  const { width_mm: width, height_mm: height } = layout;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}mm" height="${n(height)}mm" viewBox="0 0 ${n(width)} ${n(height)}">`,
    defs.length > 0 ? `<defs>${defs.join('')}</defs>` : '',
    ...body,
    '</svg>',
  ].join('');
}
