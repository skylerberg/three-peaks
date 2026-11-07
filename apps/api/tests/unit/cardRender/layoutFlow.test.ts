import { describe, expect, it } from 'vitest';
import { MM_PER_PT, parseMarkup } from '@three-peaks/shared';
import { flowText, type Face, type FlowStyle } from '../../../src/services/cardRender/flow.ts';

// Every character half an em wide, a space a quarter, and bold a little wider,
// so each width below is arithmetic rather than a measurement.
function face(perChar: number): Face {
  return {
    ascender: 0.8,
    descender: -0.2,
    advance: (text, size) =>
      [...text].reduce((sum, char) => sum + (char === ' ' ? 0.25 : perChar) * size, 0),
  };
}
const faces = { regular: face(0.5), bold: face(0.6) };

// 10 pt is 3.5278 mm, so a character is 1.7639 mm and a space 0.8819 mm.
const size = 10 * MM_PER_PT;
const style: FlowStyle = {
  size_pt: 10,
  min_size_pt: 10,
  line_height: 1,
  align: 'left',
  valign: 'top',
};

function lines(text: string, width: number, overrides: Partial<FlowStyle> = {}) {
  const result = flowText(
    parseMarkup(text).runs,
    faces,
    { x: 0, y: 0, width, height: 100 },
    {
      ...style,
      ...overrides,
    }
  );
  if (!result.fits) throw new Error(result.reason);
  const byBaseline = new Map<number, string[]>();
  for (const item of result.items) {
    const baseline = item.kind === 'text' ? item.baseline : -1;
    const row = byBaseline.get(baseline) ?? [];
    row.push(item.kind === 'text' ? item.text : `{${item.key}}`);
    byBaseline.set(baseline, row);
  }
  return { result, rows: [...byBaseline.values()].map((row) => row.join(' ')) };
}

describe('flowText', () => {
  it('breaks greedily at spaces', () => {
    // "aaa bbb" is six characters and a space: 10.583 + 0.882 = 11.465 mm. A
    // 12 mm box takes it on one line; an 11 mm box does not.
    expect(lines('aaa bbb ccc', 12).rows).toEqual(['aaa bbb', 'ccc']);
    expect(lines('aaa bbb ccc', 11).rows).toEqual(['aaa', 'bbb', 'ccc']);
  });

  it('collapses runs of spaces and keeps newlines as line breaks', () => {
    expect(lines('aaa    bbb\nccc', 100).rows).toEqual(['aaa bbb', 'ccc']);
  });

  it('keeps an icon with the punctuation that follows it', () => {
    const { result } = lines('Gain {coin}.', 100);
    if (!result.fits) throw new Error();
    const icon = result.items.find((item) => item.kind === 'icon')!;
    const dot = result.items.find((item) => item.kind === 'text' && item.text === '.')!;
    // An icon is one em wide, and the full stop starts where it ends.
    expect(dot.x - icon.x).toBeCloseTo(size, 6);
    expect(icon.size).toBeCloseTo(size, 6);
  });

  it('centres an icon on the middle of the font extent', () => {
    const { result } = lines('{coin}', 100);
    if (!result.fits) throw new Error();
    const icon = result.items[0]!;
    if (icon.kind !== 'icon') throw new Error();
    // Line height 1 puts the baseline at the ascender, 0.8 em down; the extent
    // runs 0.8 above it to 0.2 below, so its middle is the top of the box plus
    // half an em -- and a one-em icon centred there starts at the top.
    expect(icon.y).toBeCloseTo(0, 6);
  });

  it('shrinks in quarter points until the copy fits, and says the size', () => {
    const text = 'aaaa aaaa aaaa aaaa';
    // Four lines of 10 pt need 14.1 mm; a 12 mm box forces it smaller.
    const result = flowText(
      parseMarkup(text).runs,
      faces,
      { x: 0, y: 0, width: 8, height: 12 },
      {
        ...style,
        min_size_pt: 6,
      }
    );
    expect(result.fits).toBe(true);
    if (!result.fits) return;
    expect(result.size_pt).toBeLessThan(10);
    expect(result.size_pt * 4).toBe(Math.round(result.size_pt * 4));
  });

  it('refuses copy that does not fit even at its smallest size, saying why', () => {
    const tall = flowText(
      parseMarkup('a\na\na\na').runs,
      faces,
      { x: 0, y: 0, width: 50, height: 5 },
      style
    );
    expect(tall).toEqual({
      fits: false,
      reason: 'does not fit even at 10 pt: 4 lines need 14.1 mm and the box is 5.0 mm',
    });
    const wide = flowText(
      parseMarkup('abcdefghij').runs,
      faces,
      { x: 0, y: 0, width: 5, height: 50 },
      style
    );
    expect(wide).toEqual({
      fits: false,
      reason: 'does not fit even at 10 pt: a word is wider than the box',
    });
  });

  it('aligns each line within the box', () => {
    const at = (align: FlowStyle['align']) => {
      const { result } = lines('aa', 20, { align });
      if (!result.fits) throw new Error();
      return result.items[0]!.x;
    };
    const width = 2 * 0.5 * size;
    expect(at('left')).toBeCloseTo(0, 6);
    expect(at('center')).toBeCloseTo((20 - width) / 2, 6);
    expect(at('right')).toBeCloseTo(20 - width, 6);
  });

  it('places the block at the bottom of the box when asked', () => {
    const result = flowText(
      parseMarkup('a').runs,
      faces,
      { x: 0, y: 0, width: 20, height: 30 },
      {
        ...style,
        valign: 'bottom',
      }
    );
    if (!result.fits) throw new Error();
    const item = result.items[0]!;
    if (item.kind !== 'text') throw new Error();
    // The descender ends at the bottom of the box.
    expect(item.baseline + 0.2 * size).toBeCloseTo(30, 6);
  });

  it('measures bold copy in the bold face', () => {
    const { result } = lines('**aa** b', 100);
    if (!result.fits) throw new Error();
    const b = result.items.find((item) => item.kind === 'text' && item.text === 'b')!;
    expect(b.x).toBeCloseTo(2 * 0.6 * size + 0.25 * size, 6);
  });

  it('draws nothing for empty copy, and fits it at its full size', () => {
    expect(
      flowText(parseMarkup('   ').runs, faces, { x: 0, y: 0, width: 1, height: 1 }, style)
    ).toEqual({
      fits: true,
      size_pt: 10,
      items: [],
      bounds: { x: 0, y: 0, width: 0, height: 0 },
    });
  });

  it('reports the room the copy took, held to the edges it is aligned to', () => {
    // Two lines: "aa" and "a", each a line height tall, in a 20 by 30 box set
    // against its bottom right corner.
    const result = flowText(
      parseMarkup('aa\na').runs,
      faces,
      { x: 0, y: 0, width: 20, height: 30 },
      { ...style, align: 'right', valign: 'bottom' }
    );
    if (!result.fits) throw new Error();
    const widest = 2 * 0.5 * size;
    expect(result.bounds.x).toBeCloseTo(20 - widest, 6);
    expect(result.bounds.width).toBeCloseTo(widest, 6);
    expect(result.bounds.y).toBeCloseTo(30 - 2 * size, 6);
    expect(result.bounds.height).toBeCloseTo(2 * size, 6);
  });
});
