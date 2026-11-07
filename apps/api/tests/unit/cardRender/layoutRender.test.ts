import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  MM_PER_PT,
  pixelSize,
  type EdgeRef,
  type ImageElement,
  type LayoutBox,
  type LayoutSpec,
  type RectElement,
  type TextElement,
} from '@three-peaks/shared';
import { CardRenderer } from '../../../src/services/cardRender/render.ts';
import {
  CardRenderError,
  type CardLayout,
  type LoadedImage,
} from '../../../src/services/cardRender/svg.ts';
import { boxFont, pixelAt, rasterise, solidPng, solidSvg } from '../../setup/layoutFixtures.ts';

const ids = {
  body: '00000000-0000-4000-8000-000000000001',
  bold: '00000000-0000-4000-8000-000000000002',
  coin: '00000000-0000-4000-8000-000000000003',
  frame: '00000000-0000-4000-8000-000000000004',
  art: '00000000-0000-4000-8000-000000000005',
  banner: '00000000-0000-4000-8000-000000000006',
  capped: '00000000-0000-4000-8000-000000000007',
  ribbon: '00000000-0000-4000-8000-000000000008',
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

const box = (x: number, y: number, width: number, height: number): LayoutBox => ({
  left: x,
  top: y,
  right: x + width,
  bottom: y + height,
});

const pin = (element: string, edge: EdgeRef['edge'], offset_mm = 0): EdgeRef => ({
  element,
  edge,
  offset_mm,
});

function text(overrides: Partial<TextElement> = {}): TextElement {
  return {
    type: 'text',
    id: null,
    box: box(5, 50, 53, 30),
    when: null,
    rotate: 0,
    text: '{{rules}}',
    font: 'body',
    bold_font: 'bold',
    size_pt: 9,
    min_size_pt: 6,
    line_height: 1,
    color: '#000000',
    align: 'left',
    valign: 'top',
    hug: false,
    ...overrides,
  };
}

function rect(overrides: Partial<RectElement> = {}): RectElement {
  return {
    type: 'rect',
    id: null,
    box: box(5, 50, 53, 30),
    when: null,
    rotate: 0,
    fill: '#ffffff',
    stroke: null,
    stroke_mm: 0,
    radius_mm: 0,
    opacity: 1,
    ...overrides,
  };
}

function image(overrides: Partial<ImageElement> = {}): ImageElement {
  return {
    type: 'image',
    id: null,
    box: box(0, 0, 63, 88),
    when: null,
    rotate: 0,
    source: { from: 'file', file_id: ids.frame },
    fit: 'fill',
    slice: null,
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
        image(),
        image({
          box: box(10, 10, 20, 20),
          when: 'art',
          source: { from: 'field', field: 'art' },
          fit: 'cover',
        }),
        rect(),
        text(),
      ],
    },
  };
}

async function raster(card: CardLayout, fields: Record<string, string>) {
  const svg = await renderer().svg(card, fields);
  return { svg, raster: rasterise(svg, pixelSize(card.width_mm, DPI)) };
}

// Black with a green body below its first 92 units: a ribbon's notched end,
// kept as drawn, over the part that stretches.
function ribbonFixture(): void {
  files.set(ids.ribbon, {
    bytes: new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 100" width="160" height="100"><rect width="160" height="100" fill="#000000"/><rect y="92" width="160" height="8" fill="#00ff00"/></svg>'
    ),
    contentType: 'image/svg+xml',
  });
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
    [ids.banner, { bytes: await solidPng('#00ff00', 8, 8), contentType: 'image/png' }],
    // Green with a blue band across the top quarter: the end a slice keeps.
    [
      ids.capped,
      {
        bytes: new TextEncoder().encode(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#00ff00"/><rect width="8" height="2" fill="#0000ff"/></svg>'
        ),
        contentType: 'image/svg+xml',
      },
    ],
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
    const badge = rect({ box: box(40, 30, 5, 5), when: 'rules', fill: '#00ffff' });
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
    const drawn = [ids.body, ids.bold, ids.coin, ids.frame, ids.art];
    expect(fetched.sort()).toEqual(drawn.sort());
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

  describe('pinned edges', () => {
    const size = 9 * MM_PER_PT;
    // A name set against the right of a strip, and a backing listed before it
    // whose left edge is pinned 2 mm short of where the name begins.
    const named = () =>
      layout([
        image(),
        rect({ box: { ...box(0, 40, 58, 6), left: pin('name', 'left', -2) }, fill: '#00ffff' }),
        text({ id: 'name', box: box(5, 40, 53, 6), align: 'right', valign: 'middle', hug: true }),
      ]);

    it('pins a backing to the copy it sits behind, however long the copy', async () => {
      // Read below the glyphs, which stand in the middle of the strip.
      const short = (await raster(named(), { rules: 'HH' })).raster;
      // Two characters of half an em end at 58; the backing starts 2 mm before them.
      const start = 58 - 2 * 0.5 * size;
      expect(at(short, start - 1, 45)).toBe('#00ffff');
      expect(at(short, start - 3, 45)).toBe('#ff0000');
      const long = (await raster(named(), { rules: 'HHHHHHHH' })).raster;
      expect(at(long, start - 3, 45)).toBe('#00ffff');
    });

    it('leaves out an element pinned to one that drew nothing', async () => {
      const { svg, raster: r } = await raster(named(), { rules: '' });
      expect(at(r, 57, 43)).toBe('#ff0000');
      expect(svg).not.toContain('#00ffff');
    });

    it('refuses a box its pinned edges leave no room in', async () => {
      const card = layout([
        rect({ box: { ...box(0, 40, 58, 6), left: pin('name', 'left', 60) } }),
        text({ id: 'name', box: box(5, 40, 53, 6), align: 'right', hug: true }),
      ]);
      await expect(renderer().svg(card, { rules: 'HH' })).rejects.toThrow(
        /^element 1 \(rect\): its pinned edges leave its box -[\d.]+ by 6 mm$/
      );
    });

    it('turns an element half about, content and all', async () => {
      const card = layout([image(), rect(), text({ rotate: 180 })]);
      const r = (await raster(card, { rules: 'HHHH' })).raster;
      // The first glyph, written from the top left of the box, lands upside
      // down at its bottom right: the box is 5..58 by 50..80.
      const x = 5 + size * 0.25;
      const y = 50 + size * 0.5;
      expect(at(r, 63 - x, 130 - y)).toBe('#000000');
      expect(at(r, x, y)).toBe('#ffffff');
    });

    it('lays a quarter-turned element along its long side, and pins to where it came out', async () => {
      // A strip 6 wide and 60 tall from y = 10. Turned a quarter, its copy runs
      // down from the top; the backing's bottom follows the copy's end.
      const card = layout([
        image(),
        rect({ box: { ...box(40, 5, 6, 1), bottom: pin('name', 'bottom', 1) }, fill: '#00ffff' }),
        text({ id: 'name', box: box(40, 10, 6, 60), rotate: 90, valign: 'middle', hug: true }),
      ]);
      const r = (await raster(card, { rules: 'HH' })).raster;
      const end = 10 + 2 * 0.5 * size + 1;
      expect(at(r, 43, end - 0.5)).toBe('#00ffff');
      expect(at(r, 43, end + 0.5)).toBe('#ff0000');
    });
  });

  describe('nine-slice images', () => {
    it('keeps the ends of the image as drawn and stretches the middle', async () => {
      // An 8 by 8 picture drawn 8 mm wide and 40 tall: a millimetre a pixel,
      // so the 2 pixel band kept at the top is 2 mm, not stretched to 10.
      const card = layout([
        image(),
        image({
          box: box(10, 10, 8, 40),
          source: { from: 'file', file_id: ids.capped },
          slice: [2, 0, 0, 0],
        }),
      ]);
      const r = (await raster(card, {})).raster;
      expect(at(r, 14, 11)).toBe('#0000ff');
      expect(at(r, 14, 13)).toBe('#00ff00');
      expect(at(r, 14, 45)).toBe('#00ff00');
    });

    it('joins its pieces with no seam', async () => {
      // Drawn 40 by 20 from an 8 by 8 picture: a scale of 2.5, so the pieces
      // meet 5 mm in from each edge, partway across a pixel.
      const card = layout([
        image(),
        image({
          box: box(10, 10, 40, 20),
          source: { from: 'file', file_id: ids.banner },
          slice: [2, 2, 2, 2],
        }),
      ]);
      const r = (await raster(card, {})).raster;
      for (const [x, y] of [
        [15, 20],
        [45, 20],
        [30, 15],
        [30, 25],
        [15, 15],
      ] as const) {
        expect(at(r, x, y)).toBe('#00ff00');
      }
    });

    // A tarot card's ribbon, hung from the bottom edge and stretched to nearly
    // three times its height: the stretched piece reaches the edge of the
    // card. Clipped by its own piece and again by a group around the pieces,
    // that drawing panics resvg's WebAssembly build.
    it('draws a sliced image stretched to the edge of the card', async () => {
      ribbonFixture();
      const card = {
        ...layout([
          image({
            box: { left: 6.16, top: 91.48, right: 17.36, bottom: 120 },
            source: { from: 'file', file_id: ids.ribbon },
            slice: [92, 0, 0, 0],
          }),
        ]),
        width_mm: 70,
        height_mm: 120,
      };
      const r = (await raster(card, {})).raster;
      expect(at(r, 7, 92)).toBe('#000000');
      expect(at(r, 11.5, 119.5)).toBe('#00ff00');
    });

    it('refuses insets that leave nothing in the middle to stretch', async () => {
      const card = layout([
        image({ source: { from: 'file', file_id: ids.banner }, slice: [4, 0, 4, 0] }),
      ]);
      await expect(renderer().svg(card, {})).rejects.toThrow(
        'element 1 (image): slice 4, 0, 4, 0 leaves nothing of a 8 by 8 image to stretch'
      );
    });
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
