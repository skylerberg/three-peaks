import { describe, expect, it } from 'vitest';
import {
  mapLayoutFiles,
  readCardsDocument,
  readLayoutDocument,
  writeCardsDocument,
  writeLayoutDocument,
  type CardEntry,
} from '../../src/layout/authoring.ts';

const MINIMAL = `name: Hero
size: poker
fonts: { body: Fonts/Body.ttf }
fields: { rules: text, art: image }
elements:
  - type: image
    box: [0, 0, 63, 88]
    field: art
  - type: rect
    box: [1, 2, 3, 4]
    stroke: "#ABC"
  - type: text
    box: [5, 50, 53, 30]
    text: "{{rules}}"
    font: body
    size_pt: 9
`;

describe('readLayoutDocument', () => {
  it('fills every default the stored form spells out', () => {
    const document = readLayoutDocument(MINIMAL, 'hero.yaml');
    expect(document).toMatchObject({ name: 'Hero', width_mm: 63, height_mm: 88 });
    expect(document.spec.dpi).toBe(300);
    expect(document.spec.fields).toEqual({ rules: { type: 'text' }, art: { type: 'image' } });
    expect(document.spec.elements).toEqual([
      {
        type: 'image',
        id: null,
        box: { left: 0, top: 0, right: 63, bottom: 88 },
        when: null,
        rotate: 0,
        source: { from: 'field', field: 'art' },
        fit: 'cover',
        slice: null,
      },
      {
        type: 'rect',
        id: null,
        box: { left: 1, top: 2, right: 4, bottom: 6 },
        when: null,
        rotate: 0,
        fill: null,
        stroke: '#aabbcc',
        stroke_mm: 0.25,
        radius_mm: 0,
        opacity: 1,
      },
      {
        type: 'text',
        id: null,
        box: { left: 5, top: 50, right: 58, bottom: 80 },
        when: null,
        rotate: 0,
        text: '{{rules}}',
        font: 'body',
        bold_font: null,
        size_pt: 9,
        min_size_pt: 9,
        line_height: 1.2,
        color: '#000000',
        align: 'left',
        valign: 'top',
        hug: false,
      },
    ]);
  });

  it('names every mistake at once, typos in setting names included', () => {
    const text = `name: Hero
size: huge
elements:
  - type: text
    box: [1, 2, 3]
    colour: "#fff"
    font: body
    size_pt: 9
  - type: image
    box: [0, 0, 1, 1]
    file: a.png
    field: art
  - type: circle
`;
    expect(() => readLayoutDocument(text, 'hero.yaml')).toThrow(
      [
        'hero.yaml is not valid:',
        '  size must be one of mini, mini-square, bridge, euro, poker, square, tarot',
        '  elements[0].colour is not a setting here (expected one of type, id, box, when, rotate, text, font, bold_font, size_pt, min_size_pt, line_height, color, align, valign, hug)',
        '  elements[0].box must be [x, y, width, height] in millimetres, or edges like { left: 4, right: 20, top: title.bottom, height: 6 }',
        '  elements[0].text is required',
        "  elements[1] needs exactly one of file (a fixed image) or field (each card's own)",
        '  elements[2].type must be image, rect or text',
      ].join('\n')
    );
  });

  it('reads edges pinned to other elements, and a length from either end', () => {
    const { spec } = readLayoutDocument(
      `name: Plate
size: poker
fonts: { body: Fonts/Body.ttf }
elements:
  - type: rect
    box: { left: name.left - 2, right: 60, top: name.top, height: 6 }
  - type: rect
    box: { right: name.right + .5, width: 4, bottom: 80, top: 70 }
  - type: text
    id: name
    box: [5, 70, 55, 6]
    text: Hi
    font: body
    size_pt: 9
    hug: true
    rotate: 180
`,
      'plate.yaml'
    );
    expect(spec.elements.map((element) => element.box)).toEqual([
      {
        left: { element: 'name', edge: 'left', offset_mm: -2 },
        right: 60,
        top: { element: 'name', edge: 'top', offset_mm: 0 },
        bottom: { element: 'name', edge: 'top', offset_mm: 6 },
      },
      {
        left: { element: 'name', edge: 'right', offset_mm: -3.5 },
        right: { element: 'name', edge: 'right', offset_mm: 0.5 },
        top: 70,
        bottom: 80,
      },
      { left: 5, top: 70, right: 60, bottom: 76 },
    ]);
    expect(spec.elements[2]).toMatchObject({ id: 'name', hug: true, rotate: 180 });
  });

  it('reads a nine-slice in one, two or four insets, and stretches the image', () => {
    const slices = ['8', '[8, 2]', '[8, 2, 4, 1]'].map((slice) => {
      const image = readLayoutDocument(
        `name: Banner\nsize: poker\nelements:\n  - type: image\n    box: [0, 0, 10, 40]\n    file: Art/banner.png\n    slice: ${slice}\n`,
        'banner.yaml'
      ).spec.elements[0]!;
      if (image.type !== 'image') throw new Error();
      expect(image.fit).toBe('fill');
      return image.slice;
    });
    expect(slices).toEqual([
      [8, 8, 8, 8],
      [8, 2, 8, 2],
      [8, 2, 4, 1],
    ]);
  });

  it('refuses a box with too many sides, an edge it cannot read, a turn and a slice it cannot use', () => {
    const text = `name: Hero
size: poker
elements:
  - type: rect
    box: { left: 1, right: 5, width: 4, top: name.middle, height: 2 }
  - type: rect
    box: [0, 0, 1, 1]
    rotate: 45
  - type: image
    box: [0, 0, 1, 1]
    file: a.png
    slice: [1, 2, 3]
`;
    expect(() => readLayoutDocument(text, 'hero.yaml')).toThrow(
      [
        'hero.yaml is not valid:',
        '  elements[0].box needs two of left, right and width',
        '  elements[0].box.top must be millimetres or an edge like title.bottom + 2',
        '  elements[1].rotate must be one of 0, 90, 180, 270',
        '  elements[2].slice must be one, two or four insets',
      ].join('\n')
    );
  });

  it('refuses a file that is not YAML, saying which', () => {
    expect(() => readLayoutDocument('name: [', 'hero.yaml')).toThrow(/^hero\.yaml is not YAML/);
  });
});

describe('writeLayoutDocument', () => {
  it('reads back as the layout it was written from', async () => {
    const document = readLayoutDocument(MINIMAL, 'hero.yaml');
    const again = readLayoutDocument(writeLayoutDocument(document), 'again.yaml');
    expect(again).toEqual(document);
  });

  it('writes pinned edges as they are read, and the new settings only when set', () => {
    const document = readLayoutDocument(
      `name: Plate
size: poker
fonts: { body: Fonts/Body.ttf }
elements:
  - type: image
    box: { left: name.left - 2.5, right: 60, top: 70, bottom: name.bottom + 1 }
    file: Art/plate.png
    slice: [0, 4, 0, 4]
  - type: text
    id: name
    box: [5, 70, 55, 6]
    text: Hi
    font: body
    size_pt: 9
    hug: true
    rotate: 90
`,
      'plate.yaml'
    );
    const written = writeLayoutDocument(document);
    expect(written).toContain(
      'box:\n      left: name.left - 2.5\n      right: 60\n      top: 70\n      bottom: name.bottom + 1\n'
    );
    expect(written).not.toContain('fit:');
    expect(readLayoutDocument(written, 'again.yaml')).toEqual(document);
  });

  it('writes a size no preset matches as millimetres', () => {
    const document = { ...readLayoutDocument(MINIMAL, 'hero.yaml'), width_mm: 60, height_mm: 90 };
    expect(writeLayoutDocument(document)).toMatch(/^name: Hero\nwidth_mm: 60\nheight_mm: 90\n/);
  });

  it('maps every file reference, and nothing else', async () => {
    const document = readLayoutDocument(
      `${MINIMAL}  - type: image\n    box: [0, 0, 1, 1]\n    file: Frames/a.png\n`,
      'hero.yaml'
    );
    const seen: string[] = [];
    const mapped = await mapLayoutFiles(document.spec, async (ref, what) => {
      seen.push(`${what}: ${ref}`);
      return `id(${ref})`;
    });
    expect(seen.sort()).toEqual(['element 4 (image): Frames/a.png', 'font "body": Fonts/Body.ttf']);
    expect(mapped.fonts.body).toBe('id(Fonts/Body.ttf)');
    expect(mapped.elements[0]).toEqual(document.spec.elements[0]);
  });
});

describe('cards documents', () => {
  it('gives each card the shared layout unless it names its own, and reads numbers as text', () => {
    const cards = readCardsDocument(
      `layout: Hero
cards:
  - name: knight
    copies: 3
    fields: { cost: 3, rules: "Gain {coin}", art: ~ }
  - name: villain
    layout: Villain
`,
      'cards.yaml'
    );
    expect(cards).toEqual([
      {
        name: 'knight',
        layout: 'Hero',
        copies: 3,
        fields: { cost: '3', rules: 'Gain {coin}', art: '' },
      },
      { name: 'villain', layout: 'Villain', copies: null, fields: {} },
    ]);
  });

  it('refuses a card named twice, a card with no layout and a fractional copy count', () => {
    expect(() =>
      readCardsDocument(
        `cards:
  - { name: knight, layout: Hero, copies: 1.5 }
  - { name: Knight, layout: Hero }
  - { name: mage }
`,
        'cards.yaml'
      )
    ).toThrow(
      [
        'cards.yaml is not valid:',
        '  cards[0].copies must be a whole number',
        '  cards[1].name: Knight is listed twice',
        '  cards[2] names no layout, and the file gives none for every card',
      ].join('\n')
    );
  });

  it('writes the layout once when every card shares it, and reads back the same', () => {
    const cards: CardEntry[] = [
      { name: 'knight', layout: 'Hero', copies: 3, fields: { rules: 'a' } },
      { name: 'squire', layout: 'Hero', copies: null, fields: {} },
    ];
    const text = writeCardsDocument(cards);
    expect(text).toMatch(/^layout: Hero\ncards:\n/);
    expect(readCardsDocument(text, 'cards.yaml')).toEqual(cards);
  });
});
