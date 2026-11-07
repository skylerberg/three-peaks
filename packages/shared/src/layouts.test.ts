import { describe, expect, it } from 'vitest';
import {
  cardFieldErrors,
  cardImageIds,
  fillTemplate,
  layoutFileIds,
  layoutReferenceErrors,
  markupErrors,
  parseMarkup,
  templateFields,
  type LayoutSpec,
  type TextElement,
} from './layouts.ts';

const FONT = '00000000-0000-4000-8000-000000000001';
const ICON = '00000000-0000-4000-8000-000000000002';
const FRAME = '00000000-0000-4000-8000-000000000003';

function text(overrides: Partial<TextElement> = {}): TextElement {
  return {
    type: 'text',
    box: [5, 50, 53, 30],
    when: null,
    text: '{{rules}}',
    font: 'body',
    bold_font: null,
    size_pt: 9,
    min_size_pt: 6,
    line_height: 1.2,
    color: '#000000',
    align: 'left',
    valign: 'top',
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
        box: [0, 0, 63, 88],
        when: null,
        source: { from: 'file', file_id: FRAME },
        fit: 'fill',
      },
      {
        type: 'image',
        box: [5, 5, 53, 40],
        when: null,
        source: { from: 'field', field: 'art' },
        fit: 'cover',
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
            box: [0, 0, 1, 1],
            when: null,
            source: { from: 'field', field: 'ghost' },
            fit: 'cover',
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
            box: [0, 0, 1, 1],
            when: null,
            source: { from: 'field', field: 'rules' },
            fit: 'cover',
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
        elements: [text({ text: 'x', box: [0, 0, 0, 5], min_size_pt: 12 })],
      })
    );
    expect(errors).toEqual([
      'icons key "Coin" must be lower-case letters, digits, - or _, starting with a letter',
      'element 1 (text): box width and height must be positive',
      'element 1 (text): min_size_pt is larger than size_pt',
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
