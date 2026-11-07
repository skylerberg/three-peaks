import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { MM_PER_PT, pixelSize, type LayoutSpec, type TextElement } from '@three-peaks/shared';
import { CardRenderer } from '../../src/layout/render.ts';
import { CardRenderError, type CardLayout, type LoadedImage } from '../../src/layout/svg.ts';
import { boxFont, pixelAt, rasterise, solidPng, solidSvg } from '../layoutFixtures.ts';

const ids = {
  body: '00000000-0000-4000-8000-000000000001',
  bold: '00000000-0000-4000-8000-000000000002',
  coin: '00000000-0000-4000-8000-000000000003',
  frame: '00000000-0000-4000-8000-000000000004',
  art: '00000000-0000-4000-8000-000000000005',
};

const DPI = 100;
const PX_PER_MM = DPI / 25.4;

let files: Map<string, LoadedImage>;
let fetched: string[];

function renderer(): CardRenderer {
  return new CardRenderer(async (id) => {
    fetched.push(id);
    const file = files.get(id);
    if (file === undefined) throw new Error(`no fixture ${id}`);
    return file;
  });
}

function text(overrides: Partial<TextElement> = {}): TextElement {
  return {
    type: 'text',
    box: [5, 50, 53, 30],
    when: null,
    text: '{{rules}}',
    font: 'body',
    bold_font: 'bold',
    size_pt: 9,
    min_size_pt: 6,
    line_height: 1,
    color: '#000000',
    align: 'left',
    valign: 'top',
    ...overrides,
  };
}

function layout(elements?: LayoutSpec['elements']): CardLayout {
  return {
    name: 'Hero',
    width_mm: 63,
    height_mm: 88,
    spec: {
      dpi: DPI,
      fonts: { body: ids.body, bold: ids.bold },
      icons: { coin: ids.coin },
      fields: { rules: { type: 'text' }, art: { type: 'image' } },
      elements: elements ?? [
        {
          type: 'image',
          box: [0, 0, 63, 88],
          when: null,
          source: { from: 'file', file_id: ids.frame },
          fit: 'fill',
        },
        {
          type: 'image',
          box: [10, 10, 20, 20],
          when: 'art',
          source: { from: 'field', field: 'art' },
          fit: 'cover',
        },
        {
          type: 'rect',
          box: [5, 50, 53, 30],
          when: null,
          fill: '#ffffff',
          stroke: null,
          stroke_mm: 0,
          radius_mm: 0,
          opacity: 1,
        },
        text(),
      ],
    },
  };
}

async function raster(card: CardLayout, fields: Record<string, string>) {
  const svg = await renderer().svg(card, fields);
  return { svg, raster: rasterise(svg, pixelSize(card.width_mm, DPI)) };
}

const at = (r: ReturnType<typeof rasterise>, xMm: number, yMm: number) =>
  pixelAt(r, xMm * PX_PER_MM, yMm * PX_PER_MM).color;

beforeAll(async () => {
  files = new Map([
    [ids.body, { bytes: boxFont(500), contentType: 'font/otf' }],
    [ids.bold, { bytes: boxFont(600, 'Box Bold'), contentType: 'font/otf' }],
    [ids.coin, { bytes: solidSvg('#00ff00'), contentType: 'image/svg+xml' }],
    [ids.frame, { bytes: await solidPng('#ff0000'), contentType: 'image/png' }],
    // Twice as wide as tall, so covering a square box has to crop it.
    [ids.art, { bytes: await solidPng('#0000ff', 16, 8), contentType: 'image/png' }],
  ]);
});

describe('CardRenderer', () => {
  it('renders at the layout resolution', async () => {
    fetched = [];
    const png = await renderer().render(layout(), { rules: 'Hi', art: ids.art });
    // The PNG header carries the width at bytes 16..19.
    const width = Buffer.from(png).readUInt32BE(16);
    expect(width).toBe(pixelSize(63, DPI));
  });

  it('draws the frame, and the art cropped to its own box', async () => {
    fetched = [];
    const { raster: r } = await raster(layout(), { rules: '', art: ids.art });
    expect(at(r, 2, 2)).toBe('#ff0000');
    expect(at(r, 20, 20)).toBe('#0000ff');
    // The art is wider than its box; covering it must not paint past the edge.
    expect(at(r, 33, 20)).toBe('#ff0000');
    expect(at(r, 20, 60)).toBe('#ffffff');
  });

  it('leaves out an element whose `when` field is empty', async () => {
    fetched = [];
    // A badge drawn only for cards with rules: its own box is otherwise frame.
    const badge = {
      type: 'rect' as const,
      box: [40, 30, 5, 5] as [number, number, number, number],
      when: 'rules',
      fill: '#00ffff',
      stroke: null,
      stroke_mm: 0,
      radius_mm: 0,
      opacity: 1,
    };
    const card = layout([...layout().spec.elements, badge]);
    expect(at((await raster(card, { rules: 'Hi', art: '' })).raster, 42, 32)).toBe('#00ffff');
    expect(at((await raster(card, { rules: ' ', art: '' })).raster, 42, 32)).toBe('#ff0000');
  });

  it('draws nothing for an empty image field, and never fetches one', async () => {
    fetched = [];
    const { svg, raster: r } = await raster(layout(), { rules: '', art: '' });
    expect(at(r, 20, 20)).toBe('#ff0000');
    expect(fetched).not.toContain(ids.art);
    expect(svg.match(/<image/g)).toHaveLength(1);
  });

  it('writes copy as paths and never as text', async () => {
    fetched = [];
    const { svg, raster: r } = await raster(layout(), { rules: 'HHHH', art: '' });
    expect(svg).not.toContain('<text');
    // The first glyph box: inset a tenth of its advance, 0.7 em tall.
    const size = 9 * MM_PER_PT;
    expect(at(r, 5 + size * 0.25, 50 + size * 0.5)).toBe('#000000');
  });

  it('draws an icon inline, one em square, from an SVG', async () => {
    fetched = [];
    const { raster: r } = await raster(layout(), { rules: '{coin}', art: '' });
    const size = 9 * MM_PER_PT;
    expect(at(r, 5 + size / 2, 50 + size / 2)).toBe('#00ff00');
  });

  it('fetches each file once however many cards draw it', async () => {
    fetched = [];
    const shared = renderer();
    await shared.render(layout(), { rules: 'a', art: ids.art });
    await shared.render(layout(), { rules: 'b', art: ids.art });
    expect(fetched.sort()).toEqual(Object.values(ids).sort());
  });

  // The property every comparison of checksums rests on.
  it('renders the same card to the same bytes, and to these bytes', async () => {
    fetched = [];
    const fields = { rules: '**Defend:** gain 2 {coin}.\nDraw a card.', art: ids.art };
    const first = await renderer().render(layout(), fields);
    const second = await renderer().render(layout(), fields);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    // Pinned. A change here means every card already rendered would come out
    // as a new version on its next render -- after upgrading opentype.js or
    // resvg, say. That may be fine, but it is a decision, not a side effect.
    expect(createHash('sha256').update(first).digest('hex')).toBe(
      '6d62054812ec5cf52f018f455bf81b0a1f1b843275be9951c2be498d9d72e3bd'
    );
  });

  it('refuses bold copy when the element has no bold face', async () => {
    fetched = [];
    const card = layout([text({ bold_font: null })]);
    await expect(renderer().svg(card, { rules: '**Defend**' })).rejects.toThrow(
      new CardRenderError(
        'element 1 (text) has **bold** copy, and the layout gives it no bold_font to set it in'
      )
    );
  });

  it('refuses a character the font has no glyph for', async () => {
    fetched = [];
    await expect(renderer().svg(layout([text()]), { rules: 'café' })).rejects.toThrow(
      'element 1 (text): font "body" has no glyph for "é"'
    );
  });

  it('refuses copy that overflows its box at the smallest size', async () => {
    fetched = [];
    const long = Array.from({ length: 400 }, () => 'word').join(' ');
    await expect(renderer().svg(layout([text()]), { rules: long })).rejects.toThrow(
      /^element 1 \(text\) does not fit even at 6 pt: \d+ lines need/
    );
  });
});
