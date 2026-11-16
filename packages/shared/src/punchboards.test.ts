import { describe, expect, it } from 'vitest';
import { DEFAULT_PUNCHBOARD_SETTINGS } from './models3d.ts';
import {
  backSlotX,
  planPunchboard,
  punchboardDieLine,
  tokenOutlinePath,
  tokenShape,
} from './punchboards.ts';

// A sheet small enough to count by hand: 100 × 60 mm inside a 10 mm margin
// holds 80 × 40 mm of tokens, which is three 20 mm discs with 5 mm between
// them across and one down -- 20 + 5 + 20 + 5 + 20 = 70, and a fourth would
// need 95.
const sheet = {
  ...DEFAULT_PUNCHBOARD_SETTINGS,
  width_mm: 100,
  height_mm: 60,
  margin_mm: 10,
  token_width_mm: 20,
  token_height_mm: 20,
  token_corner_radius_mm: 10,
  token_gap_mm: 5,
};

describe('planPunchboard', () => {
  it('packs every copy in rows, in the order of the list', () => {
    const plan = planPunchboard({ ...sheet, height_mm: 100 }, [2, 0, 3]);
    expect(plan.columns).toBe(3);
    expect(plan.rows).toBe(3);
    expect(plan.capacity).toBe(9);
    expect(plan.overflow).toBe(0);
    expect(plan.slots.map((slot) => [slot.token, slot.copy])).toEqual([
      [0, 0],
      [0, 1],
      [2, 0],
      [2, 1],
      [2, 2],
    ]);
    // The fourth copy starts the second row.
    expect(plan.slots[3]).toMatchObject({
      x_mm: plan.slots[0]!.x_mm,
      y_mm: plan.slots[0]!.y_mm + 25,
    });
  });

  it('centres the block inside the margin, so the frame is even', () => {
    const plan = planPunchboard(sheet, [3]);
    // 70 mm of tokens across 100 mm leaves 15 each side; 20 down 60 leaves 20.
    expect(plan.slots.map((slot) => [slot.x_mm, slot.y_mm])).toEqual([
      [15, 20],
      [40, 20],
      [65, 20],
    ]);
  });

  it('counts the copies left over once the sheet is full', () => {
    const plan = planPunchboard(sheet, [2, 4]);
    expect(plan.capacity).toBe(3);
    expect(plan.slots).toHaveLength(3);
    expect(plan.overflow).toBe(3);
  });

  it('holds nothing when a token is wider than the room inside the margin', () => {
    const plan = planPunchboard({ ...sheet, token_width_mm: 90 }, [1]);
    expect(plan.capacity).toBe(0);
    expect(plan.overflow).toBe(1);
  });
});

describe('tokenShape', () => {
  it('rounds no further than half the shorter side', () => {
    expect(tokenShape({ ...sheet, token_corner_radius_mm: 40 }).corner_radius_mm).toBe(10);
    expect(tokenShape({ ...sheet, token_corner_radius_mm: 2 }).corner_radius_mm).toBe(2);
  });
});

describe('backSlotX', () => {
  it('puts a back behind its front once the sheet is turned over left to right', () => {
    const [first, , last] = planPunchboard(sheet, [3]).slots;
    const shape = tokenShape(sheet);
    expect(backSlotX(sheet, first!, shape)).toBe(last!.x_mm);
    expect(backSlotX(sheet, last!, shape)).toBe(first!.x_mm);
  });
});

describe('the die line', () => {
  it('draws a disc as four quarter arcs, and a square as four sides', () => {
    expect(tokenOutlinePath(tokenShape(sheet), 0, 0)).toBe(
      'M10 0h0a10 10 0 0 1 10 10v0a10 10 0 0 1 -10 10h0a10 10 0 0 1 -10 -10v0a10 10 0 0 1 10 -10Z'
    );
    expect(tokenOutlinePath(tokenShape({ ...sheet, token_corner_radius_mm: 0 }), 5, 5)).toBe(
      'M5 5h20v20h-20Z'
    );
  });

  it('is the sheet in millimetres with a closed path per token cut', () => {
    const svg = punchboardDieLine(sheet, planPunchboard(sheet, [2]));
    expect(svg).toContain('width="100mm" height="60mm" viewBox="0 0 100 60"');
    expect(svg.match(/<path /g)).toHaveLength(2);
  });
});
