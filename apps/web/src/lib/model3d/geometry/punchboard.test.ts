import { describe, expect, it } from 'vitest';
import { DEFAULT_PUNCHBOARD_SETTINGS } from '@three-peaks/shared';
import { MM } from '../units.ts';
import { buildSheetGeometry, buildTokenGeometry, punchboardLayout } from './punchboard.ts';

const PLACES = 6;

// A 100 × 60 mm sheet holding three 20 mm discs in a row, centred: the plan
// puts their boxes at x = 15, 40 and 65 mm and y = 20 mm from the top left.
const settings = {
  ...DEFAULT_PUNCHBOARD_SETTINGS,
  width_mm: 100,
  height_mm: 60,
  margin_mm: 10,
  token_width_mm: 20,
  token_height_mm: 20,
  token_corner_radius_mm: 10,
  token_gap_mm: 5,
};

function size(geometry: ReturnType<typeof buildTokenGeometry>) {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  return { x: box.max.x - box.min.x, y: box.max.y - box.min.y, z: box.max.z - box.min.z };
}

describe('punchboardLayout', () => {
  it('puts each copy where the plan does, in metres with y pointing up', () => {
    const layout = punchboardLayout(settings, [2, 1]);
    expect(layout.pieces.map((piece) => piece.name)).toEqual([
      'Token.001',
      'Token.002',
      'Token.003',
    ]);
    expect(layout.pieces.map((piece) => piece.token)).toEqual([0, 0, 1]);
    // The first box's centre is 25 mm from the left and 30 mm down a sheet
    // centred on the origin: 25 left of the middle, and level with it.
    const [first] = layout.pieces;
    expect(first!.center[0]).toBeCloseTo(-25 * MM, PLACES);
    expect(first!.center[1]).toBeCloseTo(0, PLACES);
  });
});

describe('the meshes', () => {
  it('cuts a token to its box and the sheet’s thickness', () => {
    const token = size(buildTokenGeometry(punchboardLayout(settings, [1]), settings));
    expect(token.x).toBeCloseTo(20 * MM, PLACES);
    expect(token.y).toBeCloseTo(20 * MM, PLACES);
    expect(token.z).toBeCloseTo(settings.thickness_mm * MM, PLACES);
  });

  it('cuts a hole in the sheet for every token, and keeps the sheet’s own size', () => {
    const solid = buildSheetGeometry(punchboardLayout(settings, []), settings);
    const holed = buildSheetGeometry(punchboardLayout(settings, [3]), settings);
    expect(size(holed).x).toBeCloseTo(100 * MM, PLACES);
    expect(size(holed).y).toBeCloseTo(60 * MM, PLACES);
    // Each hole adds a rim of walls round its outline.
    expect(holed.getAttribute('position').count).toBeGreaterThan(
      solid.getAttribute('position').count
    );
  });
});
