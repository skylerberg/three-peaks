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
        box: [0, 0, 63, 88],
        when: null,
        source: { from: 'field', field: 'art' },
        fit: 'cover',
      },
      {
        type: 'rect',
        box: [1, 2, 3, 4],
        when: null,
        fill: null,
        stroke: '#aabbcc',
        stroke_mm: 0.25,
        radius_mm: 0,
        opacity: 1,
      },
      {
        type: 'text',
        box: [5, 50, 53, 30],
        when: null,
        text: '{{rules}}',
        font: 'body',
        bold_font: null,
        size_pt: 9,
        min_size_pt: 9,
        line_height: 1.2,
        color: '#000000',
        align: 'left',
        valign: 'top',
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
        '  elements[0].colour is not a setting here (expected one of type, box, when, text, font, bold_font, size_pt, min_size_pt, line_height, color, align, valign)',
        '  elements[0].box must be [x, y, width, height] in millimetres',
        '  elements[0].text is required',
        "  elements[1] needs exactly one of file (a fixed image) or field (each card's own)",
        '  elements[2].type must be image, rect or text',
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
