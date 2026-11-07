import { describe, expect, it } from 'vitest';
import {
  cardFieldErrors,
  cardImageIds,
  fieldsInDrawingOrder,
  fillTemplate,
  layoutFileIds,
  layoutReferenceErrors,
  markupErrors,
  parseMarkup,
  templateFields,
  type LayoutBox,
  type LayoutElement,
  type LayoutSpec,
  type RectElement,
  type TextElement,
} from './layouts.ts';

const FONT = '00000000-0000-4000-8000-000000000001';
const ICON = '00000000-0000-4000-8000-000000000002';
const FRAME = '00000000-0000-4000-8000-000000000003';

const box = (x: number, y: number, width: number, height: number): LayoutBox => ({
  left: x,
  top: y,
  right: x + width,
  bottom: y + height,
});

const pin = (element: string, edge: 'left' | 'right' | 'top' | 'bottom', offset_mm = 0) => ({
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
    bold_font: null,
    size_pt: 9,
    min_size_pt: 6,
    line_height: 1.2,
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
    box: box(0, 0, 10, 10),
    when: null,
    rotate: 0,
    fill: '#000000',
    stroke: null,
    stroke_mm: 0,
    radius_mm: 0,
    opacity: 1,
    ...overrides,
  };
}

function spec(overrides: Partial<LayoutSpec> = {}): LayoutSpec {
  return {
    dpi: 300,
    fonts: { body: FONT },
    icons: { coin: ICON },
    fields: { rules: { type: 'text' }, art: { type: 'image' } },
    elements: [
      {
        type: 'image',
        id: null,
        box: box(0, 0, 63, 88),
        when: null,
        rotate: 0,
        source: { from: 'file', file_id: FRAME },
        fit: 'fill',
        slice: null,
      },
      {
        type: 'image',
        id: null,
        box: box(5, 5, 53, 40),
        when: null,
        rotate: 0,
        source: { from: 'field', field: 'art' },
        fit: 'cover',
        slice: null,
      },
      text(),
    ],
    ...overrides,
  };
}

describe('parseMarkup', () => {
  it('splits copy into text, bold, icons and breaks', () => {
    expect(parseMarkup('Gain 2 {coin}.\n**Defend:** discard').runs).toEqual([
      { kind: 'text', text: 'Gain 2 ', bold: false },
      { kind: 'icon', key: 'coin' },
      { kind: 'text', text: '.', bold: false },
      { kind: 'break' },
      { kind: 'text', text: 'Defend:', bold: true },
      { kind: 'text', text: ' discard', bold: false },
    ]);
  });

  it('prints an escaped brace, asterisk or backslash as itself', () => {
    expect(parseMarkup('\\{coin\\} \\*\\* \\\\').runs).toEqual([
      { kind: 'text', text: '{coin} ** \\', bold: false },
    ]);
  });

  it('reports a brace that starts no icon, and bold that never closes', () => {
    const parsed = parseMarkup('Pay {3 coins} and **win');
    expect(parsed.errors).toHaveLength(2);
    expect(parsed.errors[0]).toContain('does not start an icon');
    expect(parsed.errors[1]).toContain('never closed');
  });

  it('ignores carriage returns so a Windows line ending is one break', () => {
    expect(parseMarkup('a\r\nb').runs).toEqual([
      { kind: 'text', text: 'a', bold: false },
      { kind: 'break' },
      { kind: 'text', text: 'b', bold: false },
    ]);
  });
});

describe('markupErrors', () => {
  it('names each unknown icon once', () => {
    expect(markupErrors('{gem} {gem} {coin}', ['coin'])).toEqual([
      "{gem} is not one of this layout's icons",
    ]);
  });
});

describe('templates', () => {
  it('lists and fills placeholders in one pass', () => {
    expect(templateFields('Cost: {{ cost }} / {{name}}')).toEqual(['cost', 'name']);
    expect(fillTemplate('{{a}}-{{b}}', { a: '{{b}}', b: 'x' })).toBe('{{b}}-x');
  });

  it('fills a missing value with nothing', () => {
    expect(fillTemplate('[{{a}}]', {})).toBe('[]');
  });
});

describe('fieldsInDrawingOrder', () => {
  it('lists fields as the elements first use them, then the unused ones alphabetically', () => {
    const fields = {
      zeal: { type: 'text' as const },
      name: { type: 'text' as const },
      rules: { type: 'text' as const },
      art: { type: 'image' as const },
      cost: { type: 'text' as const },
      badge: { type: 'text' as const },
    };
    const ordered = spec({
      fields,
      elements: [
        ...spec().elements,
        rect({ when: 'cost' }),
        text({ text: '**{{name}}** {{rules}} {{name}} {{unknown}}' }),
      ],
    });
    // The art slot, then the rules box, then the rect drawn when there is a
    // cost, then the name the last box adds.
    expect(fieldsInDrawingOrder(ordered)).toEqual([
      'art',
      'rules',
      'cost',
      'name',
      'badge',
      'zeal',
    ]);
  });
});

describe('layoutReferenceErrors', () => {
  it('accepts a layout whose references all resolve', () => {
    expect(layoutReferenceErrors(spec())).toEqual([]);
  });

  it('refuses a placeholder, when, font or source that names nothing', () => {
    const errors = layoutReferenceErrors(
      spec({
        elements: [
          text({ text: '{{nope}}', when: 'missing', font: 'title', bold_font: 'heavy' }),
          {
            type: 'image',
            id: null,
            box: box(0, 0, 1, 1),
            when: null,
            rotate: 0,
            source: { from: 'field', field: 'ghost' },
            fit: 'cover',
            slice: null,
          },
        ],
      })
    );
    expect(errors).toEqual([
      'element 1 (text): when names "missing", which is not a field',
      'element 1 (text): {{nope}} is not a field',
      'element 1 (text): font "title" is not one of this layout\'s fonts',
      'element 1 (text): bold_font "heavy" is not one of this layout\'s fonts',
      'element 2 (image): source names "ghost", which is not a field',
    ]);
  });

  it('refuses a field used as the wrong kind', () => {
    const errors = layoutReferenceErrors(
      spec({
        elements: [
          text({ text: '{{art}}' }),
          {
            type: 'image',
            id: null,
            box: box(0, 0, 1, 1),
            when: null,
            rotate: 0,
            source: { from: 'field', field: 'rules' },
            fit: 'cover',
            slice: null,
          },
        ],
      })
    );
    expect(errors).toEqual([
      'element 1 (text): {{art}} is an image field and cannot be printed as text',
      'element 2 (image): source field "rules" is a text field, not an image',
    ]);
  });

  it("checks the template's literal copy against the icons, not the values", () => {
    expect(layoutReferenceErrors(spec({ elements: [text({ text: '{gem} {{rules}}' })] }))).toEqual([
      "element 1 (text): {gem} is not one of this layout's icons",
    ]);
  });

  it('refuses a key that could be mistaken for markup, an empty box and a min above the size', () => {
    const errors = layoutReferenceErrors(
      spec({
        icons: { Coin: ICON },
        elements: [text({ text: 'x', box: box(0, 0, 0, 5), min_size_pt: 12 })],
      })
    );
    expect(errors).toEqual([
      'icons key "Coin" must be lower-case letters, digits, - or _, starting with a letter',
      'element 1 (text): box width and height must be positive',
      'element 1 (text): min_size_pt is larger than size_pt',
    ]);
  });
});

describe('pinned edges', () => {
  const errors = (...elements: LayoutElement[]) => layoutReferenceErrors(spec({ elements }));

  it('accepts a backing pinned to the copy it sits behind, listed before it', () => {
    expect(
      errors(
        rect({ box: { ...box(0, 0, 63, 10), left: pin('name', 'left', -2) } }),
        text({ id: 'name', hug: true })
      )
    ).toEqual([]);
  });

  it('refuses an id that is not a key, and one two elements share', () => {
    expect(errors(rect({ id: 'Plate' }), rect({ id: 'name' }), text({ id: 'name' }))).toEqual([
      'element 1 (rect): id "Plate" must be lower-case letters, digits, - or _, starting with a letter',
      'element 3 (text): id "name" is also element 2\'s',
    ]);
  });

  it('refuses a pin to nothing, to itself, and across the other axis', () => {
    expect(
      errors(
        rect({ box: { ...box(0, 0, 1, 1), top: pin('ghost', 'top') } }),
        rect({ id: 'self', box: { ...box(0, 0, 1, 1), right: pin('self', 'left', 5) } }),
        rect({ box: { ...box(0, 0, 1, 1), left: pin('self', 'bottom') } })
      )
    ).toEqual([
      'element 1 (rect): box.top names "ghost", which is no element\'s id',
      'element 2 (rect): box.right is pinned to its own left',
      'element 3 (rect): box.left is pinned to self.bottom, which runs the other way',
    ]);
  });

  it('checks a numbered box for room only along an axis with no pin', () => {
    // Bottom above top, but pinned: only the card can say how it comes out.
    expect(
      errors(text({ id: 'name' }), rect({ box: { ...box(0, 10, 5, -5), top: pin('name', 'top') } }))
    ).toEqual([]);
  });

  it('names the elements going round a circle of pins', () => {
    expect(
      errors(
        rect({ id: 'a', box: { ...box(0, 0, 1, 1), left: pin('b', 'left') } }),
        rect({ id: 'b', box: { ...box(0, 0, 1, 1), top: pin('c', 'top') } }),
        rect({ id: 'c', box: { ...box(0, 0, 1, 1), right: pin('a', 'right') } })
      )
    ).toEqual(['elements are pinned to each other in a circle: a → b → c → a']);
  });

  it('refuses a nine-slice on an image that is not stretched to fill', () => {
    const [frame] = spec().elements;
    expect(errors({ ...frame!, slice: [4, 0, 4, 0], fit: 'contain' } as LayoutElement)).toEqual([
      'element 1 (image): slice stretches the image, so its fit must be fill',
    ]);
  });
});

describe('layoutFileIds', () => {
  it('collects fonts, icons and fixed images once each', () => {
    expect(layoutFileIds(spec({ icons: { coin: ICON, gem: ICON } })).sort()).toEqual(
      [FONT, ICON, FRAME].sort()
    );
  });
});

describe('cardFieldErrors', () => {
  it('refuses an unknown key and copy naming an unknown icon', () => {
    expect(cardFieldErrors(spec(), { rules: 'Gain {gem}', cost: '3' })).toEqual([
      "rules: {gem} is not one of this layout's icons",
      '"cost" is not a field of this layout',
    ]);
  });

  it('does not read an image field as markup', () => {
    expect(cardFieldErrors(spec(), { art: FRAME })).toEqual([]);
  });

  it('is not fooled by a key inherited from Object', () => {
    expect(cardFieldErrors(spec(), { toString: 'x' })).toEqual([
      '"toString" is not a field of this layout',
    ]);
  });
});

describe('cardImageIds', () => {
  it('is the non-empty image values', () => {
    expect(cardImageIds(spec(), { art: FRAME, rules: 'text' })).toEqual([FRAME]);
    expect(cardImageIds(spec(), { art: '  ' })).toEqual([]);
  });
});
