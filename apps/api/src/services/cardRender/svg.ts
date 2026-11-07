import type { Font } from 'opentype.js';
import {
  type CardFields,
  type Edge,
  type ImageElement,
  type ImageFit,
  type LayoutElement,
  type LayoutSpec,
  type Rotation,
  type TextElement,
  fillTemplate,
  hasValue,
  parseMarkup,
} from '@three-peaks/shared';
import { flowText, type Face, type Faces, type FlowBox, type FlowResult } from './flow.ts';
import { imageSize } from './imageSize.ts';

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

function boxAttributes({ x, y, width, height }: FlowBox): string {
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

// ---------------------------------------------------------------------------
// Where each element comes out

interface SetText {
  flow: Extract<FlowResult, { fits: true }>;
  regular: Font;
  bold: Font | null;
}

// An element as it comes out on this card. `frame` is its box on the card;
// `local` is the box its content is laid out in, which a quarter turn swaps
// the sides of; `used` is what other elements' edges are pinned to.
interface Placement {
  frame: FlowBox;
  local: FlowBox;
  used: FlowBox;
  text: SetText | null;
}

function edgeOf(box: FlowBox, edge: Edge): number {
  switch (edge) {
    case 'left':
      return box.x;
    case 'right':
      return box.x + box.width;
    case 'top':
      return box.y;
    case 'bottom':
      return box.y + box.height;
  }
}

function centreOf(box: FlowBox): [number, number] {
  return [box.x + box.width / 2, box.y + box.height / 2];
}

// The box a rotation about `frame`'s centre carries the content's box onto.
// Exact for quarter turns: the sine and cosine are whole numbers.
function turned(box: FlowBox, frame: FlowBox, rotate: Rotation): FlowBox {
  if (rotate === 0) return box;
  const [cx, cy] = centreOf(frame);
  const cos = [1, 0, -1, 0][rotate / 90]!;
  const sin = [0, 1, 0, -1][rotate / 90]!;
  const corners = [
    [box.x, box.y],
    [box.x + box.width, box.y + box.height],
  ].map(([x, y]) => [
    cx + (x! - cx) * cos - (y! - cy) * sin,
    cy + (x! - cx) * sin + (y! - cy) * cos,
  ]);
  const xs = corners.map(([x]) => x!);
  const ys = corners.map(([, y]) => y!);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function setText(
  element: TextElement,
  where: string,
  fields: CardFields,
  assets: CardAssets,
  box: FlowBox
): SetText | null {
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
  const flow = flowText(runs, faces, box, element);
  if (!flow.fits) throw new CardRenderError(`${where} ${flow.reason}`);
  return flow.items.length === 0 ? null : { flow, regular, bold };
}

const nameOf = (element: LayoutElement, index: number) =>
  `element ${String(index + 1)} (${element.type})`;

// Every element's placement, worked out in the order their edges need rather
// than the order they are painted, so a backing listed before its copy can be
// as long as the copy. Null for an element that draws nothing on this card --
// left out by `when`, an empty image field, copy that came out empty -- and
// for any element pinned to one of those: there is nothing to pin it to.
function placements(
  layout: CardLayout,
  fields: CardFields,
  assets: CardAssets
): (Placement | null)[] {
  const { elements } = layout.spec;
  const byId = new Map<string, number>();
  elements.forEach((element, index) => {
    if (element.id !== null && !byId.has(element.id)) byId.set(element.id, index);
  });
  const done = new Map<number, Placement | null>();
  const pending = new Set<number>();

  const place = (index: number): Placement | null => {
    if (done.has(index)) return done.get(index)!;
    const element = elements[index]!;
    const where = nameOf(element, index);
    if (pending.has(index)) throw new CardRenderError(`${where} is pinned to itself in a circle`);
    pending.add(index);
    const result = placeOne(element, where);
    pending.delete(index);
    done.set(index, result);
    return result;
  };

  const placeOne = (element: LayoutElement, where: string): Placement | null => {
    if (element.when !== null && !hasValue(fields, element.when)) return null;
    if (
      element.type === 'image' &&
      element.source.from === 'field' &&
      (fields[element.source.field] ?? '').trim() === ''
    ) {
      return null;
    }

    const edges = {} as Record<Edge, number>;
    for (const side of ['left', 'top', 'right', 'bottom'] as const) {
      const value = element.box[side];
      if (typeof value === 'number') {
        edges[side] = value;
        continue;
      }
      const target = byId.get(value.element);
      if (target === undefined) {
        throw new CardRenderError(
          `${where}: box.${side} names "${value.element}", which is no element's id`
        );
      }
      const pinned = place(target);
      if (pinned === null) return null;
      edges[side] = edgeOf(pinned.used, value.edge) + value.offset_mm;
    }
    const frame = {
      x: edges.left,
      y: edges.top,
      width: edges.right - edges.left,
      height: edges.bottom - edges.top,
    };
    if (frame.width <= 0 || frame.height <= 0) {
      throw new CardRenderError(
        `${where}: its pinned edges leave its box ${n(frame.width)} by ${n(frame.height)} mm`
      );
    }
    const [cx, cy] = centreOf(frame);
    const local =
      element.rotate % 180 === 0
        ? frame
        : {
            x: cx - frame.height / 2,
            y: cy - frame.width / 2,
            width: frame.height,
            height: frame.width,
          };

    if (element.type !== 'text') return { frame, local, used: frame, text: null };
    const text = setText(element, where, fields, assets, local);
    if (text === null) return null;
    const used = element.hug ? turned(text.flow.bounds, frame, element.rotate) : frame;
    return { frame, local, used, text };
  };

  return elements.map((_, index) => place(index));
}

// ---------------------------------------------------------------------------
// Drawing

interface Canvas {
  defs: string[];
  clip(box: FlowBox): string;
  // One device pixel at the layout's resolution, in millimetres.
  pixel: number;
}

function textMarkup(
  element: TextElement,
  set: SetText,
  box: FlowBox,
  assets: CardAssets,
  canvas: Canvas
): string {
  const paths: string[] = [];
  const icons: string[] = [];
  for (const item of set.flow.items) {
    if (item.kind === 'text') {
      const font = item.bold ? set.bold! : set.regular;
      paths.push(font.getPath(item.text, item.x, item.baseline, item.size).toPathData(4));
    } else {
      const icon = assets.icons.get(item.key)!;
      icons.push(
        `<image ${boxAttributes({ x: item.x, y: item.y, width: item.size, height: item.size })} preserveAspectRatio="xMidYMid meet" href="${dataUri(icon)}"/>`
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
  return `<g clip-path="${canvas.clip(box)}">${parts.join('')}</g>`;
}

// Nine pieces of one picture: the corners at the image's own proportions, the
// sides stretched one way and the middle both. The scale is the one that fits
// the image's tighter dimension into the box, so the borders always fit.
function slicedMarkup(
  element: ImageElement,
  where: string,
  image: LoadedImage,
  box: FlowBox,
  canvas: Canvas
): string {
  const [top, right, bottom, left] = element.slice!;
  const size = imageSize(image);
  if (size === null) {
    throw new CardRenderError(`${where}: slice needs the image's size, and it gives none`);
  }
  if (left + right >= size.width || top + bottom >= size.height) {
    throw new CardRenderError(
      `${where}: slice ${String(top)}, ${String(right)}, ${String(bottom)}, ${String(left)} leaves nothing of a ${String(size.width)} by ${String(size.height)} image to stretch`
    );
  }
  const scale = Math.min(box.width / size.width, box.height / size.height);
  const bands = (start: number, length: number, from: number, to: number, whole: number) => [
    { src: 0, srcLength: from, dest: start, destLength: from * scale },
    {
      src: from,
      srcLength: whole - from - to,
      dest: start + from * scale,
      destLength: length - (from + to) * scale,
    },
    { src: whole - to, srcLength: to, dest: start + length - to * scale, destLength: to * scale },
  ];
  const columns = bands(box.x, box.width, left, right, size.width);
  const rows = bands(box.y, box.height, top, bottom, size.height);

  const id = `i${String(canvas.defs.length)}`;
  canvas.defs.push(
    `<image id="${id}" width="${String(size.width)}" height="${String(size.height)}" preserveAspectRatio="none" href="${dataUri(image)}"/>`
  );
  // Each piece's clip reaches a pixel into its neighbours, so two pieces meet
  // with no seam of half-covered pixels between them, and stops at the box.
  // The box is not a second clip around the pieces: one clip inside another
  // around a stretched piece that reaches the card's edge is a drawing resvg's
  // WebAssembly build panics on.
  const reach = canvas.pixel;
  const boxRight = box.x + box.width;
  const boxBottom = box.y + box.height;
  const pieces: string[] = [];
  columns.forEach((column, i) => {
    rows.forEach((row, j) => {
      if (column.srcLength <= 0 || row.srcLength <= 0) return;
      if (column.destLength <= 0 || row.destLength <= 0) return;
      const sx = column.destLength / column.srcLength;
      const sy = row.destLength / row.srcLength;
      const x0 = Math.max(box.x, column.dest - (i > 0 ? reach : 0));
      const x1 = Math.min(boxRight, column.dest + column.destLength + (i < 2 ? reach : 0));
      const y0 = Math.max(box.y, row.dest - (j > 0 ? reach : 0));
      const y1 = Math.min(boxBottom, row.dest + row.destLength + (j < 2 ? reach : 0));
      const clipped = canvas.clip({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
      const matrix = [sx, 0, 0, sy, column.dest - sx * column.src, row.dest - sy * row.src];
      pieces.push(
        `<g clip-path="${clipped}"><use href="#${id}" transform="matrix(${matrix.map(n).join(' ')})"/></g>`
      );
    });
  });
  return pieces.join('');
}

// One element in its own box, before any turn.
function elementMarkup(
  element: LayoutElement,
  placement: Placement,
  where: string,
  fields: CardFields,
  assets: CardAssets,
  canvas: Canvas
): string {
  const box = placement.local;
  if (element.type === 'image') {
    const id =
      element.source.from === 'file'
        ? element.source.file_id
        : (fields[element.source.field] ?? '');
    const image = assets.images.get(id);
    if (image === undefined) throw new CardRenderError(`${where}: image ${id} was not loaded`);
    return element.slice === null
      ? `<image ${boxAttributes(box)} preserveAspectRatio="${ASPECT[element.fit]}" clip-path="${canvas.clip(box)}" href="${dataUri(image)}"/>`
      : slicedMarkup(element, where, image, box, canvas);
  }
  if (element.type === 'rect') {
    const attributes = [
      boxAttributes(box),
      element.radius_mm > 0 ? `rx="${n(element.radius_mm)}" ry="${n(element.radius_mm)}"` : '',
      `fill="${element.fill ?? 'none'}"`,
      element.stroke !== null && element.stroke_mm > 0
        ? `stroke="${element.stroke}" stroke-width="${n(element.stroke_mm)}"`
        : '',
      element.opacity < 1 ? `opacity="${n(element.opacity)}"` : '',
    ].filter((attribute) => attribute !== '');
    return `<rect ${attributes.join(' ')}/>`;
  }
  return textMarkup(element, placement.text!, box, assets, canvas);
}

export function buildCardSvg(layout: CardLayout, fields: CardFields, assets: CardAssets): string {
  const placed = placements(layout, fields, assets);
  const defs: string[] = [];
  const canvas: Canvas = {
    defs,
    clip: (box) => {
      const id = `c${String(defs.length)}`;
      defs.push(`<clipPath id="${id}"><rect ${boxAttributes(box)}/></clipPath>`);
      return `url(#${id})`;
    },
    pixel: 25.4 / layout.spec.dpi,
  };
  const body: string[] = [];

  layout.spec.elements.forEach((element, index) => {
    const placement = placed[index];
    if (placement === null || placement === undefined) return;
    const markup = elementMarkup(
      element,
      placement,
      nameOf(element, index),
      fields,
      assets,
      canvas
    );
    if (markup === '') return;
    if (element.rotate === 0) {
      body.push(markup);
      return;
    }
    const [cx, cy] = centreOf(placement.frame);
    body.push(`<g transform="rotate(${String(element.rotate)} ${n(cx)} ${n(cy)})">${markup}</g>`);
  });

  const { width_mm: width, height_mm: height } = layout;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}mm" height="${n(height)}mm" viewBox="0 0 ${n(width)} ${n(height)}">`,
    defs.length > 0 ? `<defs>${defs.join('')}</defs>` : '',
    ...body,
    '</svg>',
  ].join('');
}
