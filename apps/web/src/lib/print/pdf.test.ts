import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRINTER_MARGIN_MM,
  type PrintRun,
  type Rect,
  type SlotBox,
  TILE_BLEED_MM,
  backPlacement,
  cardPreset,
  pageSize,
  planGrid,
  planTileSheets,
  planTiles,
  slotBox,
  tileCutMarks,
} from '@three-peaks/shared';
import type { jsPDF } from 'jspdf';
import type { PrintImage } from './images.ts';
import {
  type ImageArgs,
  type PrintBoard,
  type PrintOptions,
  artworkRect,
  imageArgs,
  pageTurner,
  placement,
  renderBoards,
  renderRuns,
  winAnsi,
} from './pdf.ts';

// A 63 x 88 mm slot, the poker cell.
const box: SlotBox = { row: 0, column: 0, x_mm: 20, y_mm: 30, width_mm: 63, height_mm: 88 };
// A mini cell, which the planner lays on its side: 67 wide, 44 tall.
const turnedBox: SlotBox = {
  row: 0,
  column: 0,
  x_mm: 7.45,
  y_mm: 7.7,
  width_mm: 67,
  height_mm: 44,
};

describe('placement', () => {
  it('fills the slot exactly when the artwork already matches it', () => {
    for (const fit of ['fill', 'fit'] as const) {
      const at = placement({ width: 630, height: 880 }, box, fit);
      expect(at.width_mm).toBeCloseTo(63, 6);
      expect(at.height_mm).toBeCloseTo(88, 6);
      expect(at.x_mm).toBeCloseTo(20, 6);
      expect(at.y_mm).toBeCloseTo(30, 6);
    }
  });

  // Artwork drawn to bleed is wider than the card. Fill covers the slot and
  // lets the clip take the overflow; fit shows all of it and leaves bars.
  it('covers the slot for a wider-than-card image when filling', () => {
    const at = placement({ width: 2000, height: 1000 }, box, 'fill');
    expect(at.height_mm).toBeCloseTo(88, 6);
    expect(at.width_mm).toBeGreaterThan(box.width_mm);
  });

  it('fits a wider-than-card image inside the slot when fitting', () => {
    const at = placement({ width: 2000, height: 1000 }, box, 'fit');
    expect(at.width_mm).toBeCloseTo(63, 6);
    expect(at.height_mm).toBeLessThan(box.height_mm);
  });

  it('covers the slot for a taller-than-card image when filling', () => {
    const at = placement({ width: 1000, height: 3000 }, box, 'fill');
    expect(at.width_mm).toBeCloseTo(63, 6);
    expect(at.height_mm).toBeGreaterThan(box.height_mm);
  });

  it('fits a taller-than-card image inside the slot when fitting', () => {
    const at = placement({ width: 1000, height: 3000 }, box, 'fit');
    expect(at.height_mm).toBeCloseTo(88, 6);
    expect(at.width_mm).toBeLessThan(box.width_mm);
  });

  // Off-centre artwork crops or letterboxes unevenly, which reads as a
  // misregistered print rather than as a mismatched source.
  it.each(['fill', 'fit'] as const)('centres the artwork in the slot when %sing', (fit) => {
    const at = placement({ width: 2000, height: 1000 }, box, fit);
    expect(at.x_mm + at.width_mm / 2).toBeCloseTo(box.x_mm + box.width_mm / 2, 6);
    expect(at.y_mm + at.height_mm / 2).toBeCloseTo(box.y_mm + box.height_mm / 2, 6);
  });

  it('never crops when fitting, and never leaves a gap when filling', () => {
    for (const image of [
      { width: 2000, height: 1000 },
      { width: 1000, height: 3000 },
      { width: 640, height: 480 },
    ]) {
      const fitted = placement(image, box, 'fit');
      expect(fitted.width_mm).toBeLessThanOrEqual(box.width_mm + 1e-6);
      expect(fitted.height_mm).toBeLessThanOrEqual(box.height_mm + 1e-6);

      const filled = placement(image, box, 'fill');
      expect(filled.width_mm).toBeGreaterThanOrEqual(box.width_mm - 1e-6);
      expect(filled.height_mm).toBeGreaterThanOrEqual(box.height_mm - 1e-6);
    }
  });
});

describe('artworkRect', () => {
  const miniArt = { width: 264, height: 402 };

  it('is the plain placement when the card is upright or upside down', () => {
    for (const turns of [0, 2] as const) {
      expect(artworkRect({ width: 630, height: 880 }, box, 'fill', turns)).toEqual(
        placement({ width: 630, height: 880 }, box, 'fill')
      );
    }
  });

  // The screenshot bug: a portrait card in a landscape cell, drawn upright at
  // the cell's width, is 67 x 102 mm clipped to a 44 mm band of its middle.
  // Turned, it is the cell.
  it.each([1, 3] as const)(
    'lays portrait artwork over a landscape cell exactly when turned %i quarter',
    (turns) => {
      for (const fit of ['fill', 'fit'] as const) {
        const rect = artworkRect(miniArt, turnedBox, fit, turns);
        expect(rect.x_mm).toBeCloseTo(turnedBox.x_mm, 6);
        expect(rect.y_mm).toBeCloseTo(turnedBox.y_mm, 6);
        expect(rect.width_mm).toBeCloseTo(67, 6);
        expect(rect.height_mm).toBeCloseTo(44, 6);
      }
    }
  );

  // Fit and fill are decided in the card's frame, so an image wider than the
  // card overflows along the card's width -- which on the page is the cell's
  // height once the card is on its side.
  it('measures the overflow along the turned axis', () => {
    const rect = artworkRect({ width: 2000, height: 1000 }, turnedBox, 'fill', 1);
    expect(rect.width_mm).toBeCloseTo(67, 6);
    expect(rect.height_mm).toBeGreaterThan(44);
    expect(rect.x_mm + rect.width_mm / 2).toBeCloseTo(turnedBox.x_mm + 67 / 2, 6);
    expect(rect.y_mm + rect.height_mm / 2).toBeCloseTo(turnedBox.y_mm + 44 / 2, 6);
  });
});

/**
 * jsPDF's own placement, as `writeImageToPDF` writes it: translate to the
 * bottom-left corner of the box it was given, rotate anticlockwise, scale the
 * unit square by the width and height. Modelled in the millimetres and the
 * top-left origin the arguments are given in, so the answer is the rectangle a
 * reader of the page would measure. `check:print` holds this model to the
 * library by reading a real file back.
 */
function covered(args: ImageArgs): Rect & { up: 'N' | 'E' | 'S' | 'W' } {
  const { x_mm: x, y_mm: y, width_mm: w, height_mm: h, rotation } = args;
  const rad = (rotation * Math.PI) / 180;
  const corner = (u: number, v: number) => {
    const px = u * w;
    const py = v * h;
    // PDF's y runs up the page, so an anticlockwise turn there is anticlockwise
    // to the eye, and the pivot's PDF-space offsets come off the page's y.
    const rx = px * Math.cos(rad) - py * Math.sin(rad);
    const ry = px * Math.sin(rad) + py * Math.cos(rad);
    return { x: x + rx, y: y + h - ry };
  };

  const corners = [corner(0, 0), corner(1, 0), corner(0, 1), corner(1, 1)];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const upX = corner(0, 1).x - corner(0, 0).x;
  const upY = corner(0, 1).y - corner(0, 0).y;

  return {
    x_mm: Math.min(...xs),
    y_mm: Math.min(...ys),
    width_mm: Math.max(...xs) - Math.min(...xs),
    height_mm: Math.max(...ys) - Math.min(...ys),
    up: Math.abs(upX) > Math.abs(upY) ? (upX > 0 ? 'E' : 'W') : upY < 0 ? 'N' : 'S',
  };
}

describe('imageArgs', () => {
  const rect: Rect = { x_mm: 30, y_mm: 50, width_mm: 67, height_mm: 44 };

  it.each([
    [0, 'N'],
    [1, 'E'],
    [2, 'S'],
    [3, 'W'],
  ] as const)(
    'covers the rectangle after %i clockwise quarter turns, top pointing %s',
    (turns, up) => {
      const drawn = covered(imageArgs(rect, turns));
      expect(drawn.x_mm).toBeCloseTo(rect.x_mm, 6);
      expect(drawn.y_mm).toBeCloseTo(rect.y_mm, 6);
      expect(drawn.width_mm).toBeCloseTo(rect.width_mm, 6);
      expect(drawn.height_mm).toBeCloseTo(rect.height_mm, 6);
      expect(drawn.up).toBe(up);
    }
  );

  // The library takes the artwork's own sides, so a sideways card is handed its
  // portrait width and height and left to turn them.
  it('hands over the artwork’s sides rather than the rectangle’s when sideways', () => {
    for (const turns of [1, 3] as const) {
      const at = imageArgs(rect, turns);
      expect(at.width_mm).toBe(rect.height_mm);
      expect(at.height_mm).toBe(rect.width_mm);
    }
  });

  it('asks for no rotation at all on an upright card', () => {
    expect(imageArgs(rect, 0)).toEqual({ ...rect, rotation: 0 });
  });
});

interface Placed {
  page: number;
  alias: string;
  rect: Rect & { up: 'N' | 'E' | 'S' | 'W' };
  // The clip in force when the image was drawn, which is the part of it that
  // reaches the paper.
  clip: Rect | null;
}

interface Recording {
  doc: jsPDF;
  placed: Placed[];
  lines: { page: number; x1: number; y1: number; x2: number; y2: number }[];
  text: { page: number; text: string; x: number; y: number }[];
  pages: () => number;
}

// Records where every image lands and which way it points, through the same
// model of the library as above.
function recordingDoc(): Recording {
  const placed: Placed[] = [];
  const lines: Recording['lines'] = [];
  const text: Recording['text'] = [];
  let page = 1;
  let path: Rect | null = null;
  let clip: Rect | null = null;
  const doc = {
    addPage: () => {
      page += 1;
    },
    saveGraphicsState: () => undefined,
    restoreGraphicsState: () => {
      clip = null;
    },
    // As the library does it: a rectangle with no style is painted there and
    // then, which leaves no path for a clip to take, and only `null` builds one.
    rect: (x_mm: number, y_mm: number, width_mm: number, height_mm: number, style?: null) => {
      path = style === null ? { x_mm, y_mm, width_mm, height_mm } : null;
    },
    clip: () => {
      clip = path;
    },
    discardPath: () => {
      path = null;
    },
    setDrawColor: () => undefined,
    setLineWidth: () => undefined,
    setFont: () => undefined,
    setFontSize: () => undefined,
    setTextColor: () => undefined,
    line: (x1: number, y1: number, x2: number, y2: number) => {
      lines.push({ page, x1, y1, x2, y2 });
    },
    text: (value: string, x: number, y: number) => {
      text.push({ page, text: value, x, y });
    },
    addImage: (
      _data: unknown,
      _format: unknown,
      x_mm: number,
      y_mm: number,
      width_mm: number,
      height_mm: number,
      alias: string,
      _compression: unknown,
      rotation: number
    ) => {
      placed.push({
        page,
        alias,
        rect: covered({ x_mm, y_mm, width_mm, height_mm, rotation }),
        clip,
      });
    },
  };
  return { doc: doc as unknown as jsPDF, placed, lines, text, pages: () => page };
}

const letter = pageSize('letter')!;

function options(overrides: Partial<PrintOptions> = {}): PrintOptions {
  return {
    page: letter,
    printer_margin_mm: DEFAULT_PRINTER_MARGIN_MM,
    include_backs: true,
    flip: 'long',
    cut_marks: false,
    fit: 'fill',
    ...overrides,
  };
}

// Artwork at each piece's own aspect, so every placement is exactly its cell.
function sized(size: { width_mm: number; height_mm: number }): Promise<PrintImage> {
  return Promise.resolve({
    data: new Uint8Array(),
    format: 'PNG',
    width: size.width_mm * 6,
    height: size.height_mm * 6,
  });
}

const images = {
  artwork: (_fileId: string, card: { width_mm: number; height_mm: number }) => sized(card),
  board: (_fileId: string, size: { width_mm: number; height_mm: number }) => sized(size),
};

function run(preset: string, items: PrintRun['items']): PrintRun {
  return { card: cardPreset(preset)!, items };
}

function expectRect(actual: Rect, expected: Rect): void {
  expect(actual.x_mm).toBeCloseTo(expected.x_mm, 6);
  expect(actual.y_mm).toBeCloseTo(expected.y_mm, 6);
  expect(actual.width_mm).toBeCloseTo(expected.width_mm, 6);
  expect(actual.height_mm).toBeCloseTo(expected.height_mm, 6);
}

describe('renderRuns', () => {
  const mini = planGrid(letter, cardPreset('mini')!, DEFAULT_PRINTER_MARGIN_MM);
  const poker = planGrid(letter, cardPreset('poker')!, DEFAULT_PRINTER_MARGIN_MM);
  const items = [
    { front_file_id: 'a', back_file_id: 'z' },
    { front_file_id: 'b', back_file_id: 'z' },
  ];

  it('draws an upright card and its back both pointing up the page', async () => {
    const { doc, placed } = recordingDoc();
    await renderRuns(doc, [run('poker', items)], options(), images);

    expect(placed.map((p) => p.page)).toEqual([1, 1, 2, 2]);
    for (const [index, front] of placed.filter((p) => p.page === 1).entries()) {
      expectRect(front.rect, slotBox(poker, index));
      expect(front.rect.up).toBe('N');
    }
    for (const back of placed.filter((p) => p.page === 2)) expect(back.rect.up).toBe('N');
  });

  it('turns every card of a turned grid onto its side', async () => {
    const { doc, placed } = recordingDoc();
    await renderRuns(doc, [run('mini', items)], options({ include_backs: false }), images);

    expect(mini.rotated).toBe(true);
    expect(placed).toHaveLength(2);
    for (const [index, front] of placed.entries()) {
      expectRect(front.rect, slotBox(mini, index));
      expect(front.rect.up).toBe('E');
    }
  });

  // The back's top has to land on the physical edge the front's top is on, and
  // a long-edge flip reverses left and right -- the axis a sideways card's top
  // now lies along.
  it('turns a long-edge back the opposite way to its sideways front', async () => {
    const { doc, placed } = recordingDoc();
    await renderRuns(doc, [run('mini', items)], options({ flip: 'long' }), images);

    const backs = placed.filter((p) => p.page === 2);
    expect(backs).toHaveLength(2);
    for (const [index, back] of backs.entries()) {
      expectRect(back.rect, slotBox(mini, backPlacement(index, mini, 'long').index));
      expect(back.rect.up).toBe('W');
    }
  });

  it('turns a short-edge back the same way as its sideways front', async () => {
    const { doc, placed } = recordingDoc();
    await renderRuns(doc, [run('mini', items)], options({ flip: 'short' }), images);

    const backs = placed.filter((p) => p.page === 2);
    for (const [index, back] of backs.entries()) {
      expectRect(back.rect, slotBox(mini, backPlacement(index, mini, 'short').index));
      expect(back.rect.up).toBe('E');
    }
  });

  it('draws a short-edge back of an upright card upside down', async () => {
    const { doc, placed } = recordingDoc();
    await renderRuns(doc, [run('poker', items)], options({ flip: 'short' }), images);

    for (const back of placed.filter((p) => p.page === 2)) expect(back.rect.up).toBe('S');
  });

  // Artwork drawn to bleed is wider than its card, and its neighbour is drawn
  // edge to edge with it: unclipped, the overflow is a strip of one card
  // printed down the side of the next.
  it('cuts artwork wider than its card off at the card', async () => {
    const { doc, placed } = recordingDoc();
    const bleeding = {
      ...images,
      artwork: () => sized({ width_mm: 69, height_mm: 88 }),
    };
    await renderRuns(
      doc,
      [run('poker', items)],
      options({ include_backs: false }),
      bleeding,
      undefined
    );

    for (const [index, front] of placed.entries()) {
      expect(front.rect.width_mm).toBeCloseTo(69, 6);
      expectRect(front.clip!, slotBox(poker, index));
    }
  });

  it('leaves artwork that already matches its card unclipped', async () => {
    const { doc, placed } = recordingDoc();
    await renderRuns(doc, [run('poker', items)], options({ include_backs: false }), images);
    for (const front of placed) expect(front.clip).toBeNull();
  });

  // One embedding per artwork, whichever way and on whichever side it is drawn.
  it('names the same artwork by one alias on every side and at every turn', async () => {
    const { doc, placed } = recordingDoc();
    await renderRuns(
      doc,
      [run('mini', [{ front_file_id: 'a', back_file_id: 'a' }])],
      options(),
      images
    );
    expect(new Set(placed.map((p) => p.alias)).size).toBe(1);
  });
});

describe('renderBoards', () => {
  const margin = DEFAULT_PRINTER_MARGIN_MM;

  function board(name: string, width_mm: number, height_mm: number): PrintBoard {
    return { name, file_id: name, width_mm, height_mm };
  }

  async function draw(
    boards: PrintBoard[],
    overrides: Partial<PrintOptions> = {},
    blankBacks = false
  ): Promise<Recording> {
    const recording = recordingDoc();
    await renderBoards(
      recording.doc,
      boards,
      options({ cut_marks: true, ...overrides }),
      images,
      pageTurner(recording.doc),
      blankBacks
    );
    return recording;
  }

  it('draws a board that fits the paper on one page, at its own size', async () => {
    const mat = board('mat', 150, 200);
    const { placed, pages } = await draw([mat]);

    expect(pages()).toBe(1);
    expect(placed).toHaveLength(1);
    expectRect(placed[0].rect, {
      x_mm: (letter.width_mm - 150) / 2,
      y_mm: (letter.height_mm - 200) / 2,
      width_mm: 150,
      height_mm: 200,
    });
    expect(placed[0].rect.up).toBe('N');
  });

  // The whole board is handed over on every sheet and the clip is what makes
  // each one a different piece of it. Drawn unclipped, every sheet is the same
  // corner of the artwork running off the paper.
  it('puts a different part of the board on each sheet it is spread over', async () => {
    const main = board('main', 500, 400);
    const grid = planTiles(letter, main, margin);
    const tiles = planTileSheets(grid, letter);
    const { placed, pages } = await draw([main]);

    expect(pages()).toBe(6);
    expect(placed.map((p) => p.page)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const [index, tile] of tiles.entries()) {
      expectRect(placed[index].rect, tile.whole);
      expectRect(placed[index].clip!, tile.inked);
    }
    expect(new Set(placed.map((p) => p.alias)).size).toBe(1);
  });

  it('draws a board the planner has turned through the turn', async () => {
    const wide = board('wide', 420, 190);
    const grid = planTiles(letter, wide, margin);
    const { placed } = await draw([wide]);

    expect(grid.rotated).toBe(true);
    expect(placed).toHaveLength(2);
    for (const [index, tile] of planTileSheets(grid, letter).entries()) {
      expectRect(placed[index].rect, tile.whole);
      expect(placed[index].rect.up).toBe('E');
    }
  });

  it('marks the four cuts of every tile and says which piece it is', async () => {
    const main = board('main', 500, 400);
    const grid = planTiles(letter, main, margin);
    const tiles = planTileSheets(grid, letter);
    const { lines, text } = await draw([main]);

    for (const [index, tile] of tiles.entries()) {
      const drawn = lines.filter((line) => line.page === index + 1);
      expect(drawn.map(({ x1, y1, x2, y2 }) => [x1, y1, x2, y2])).toEqual(
        tileCutMarks(tile, letter).map((mark) => [mark.x1_mm, mark.y1_mm, mark.x2_mm, mark.y2_mm])
      );
    }
    expect(text.map((entry) => entry.text)).toEqual([
      'main · row 1 of 2, column 1 of 3 · 166.7 × 200 mm',
      'main · row 1 of 2, column 2 of 3 · 166.7 × 200 mm',
      'main · row 1 of 2, column 3 of 3 · 166.7 × 200 mm',
      'main · row 2 of 2, column 1 of 3 · 166.7 × 200 mm',
      'main · row 2 of 2, column 2 of 3 · 166.7 × 200 mm',
      'main · row 2 of 2, column 3 of 3 · 166.7 × 200 mm',
    ]);
    // Above the tile and clear of its bleed, so it is never under the ink.
    for (const [index, entry] of text.entries()) {
      expect(entry.y).toBeLessThan(tiles[index].cut.y_mm - TILE_BLEED_MM);
    }
  });

  // Without marks the edge of the ink is the only thing saying where to cut.
  it('stops the ink at the cut when the marks are switched off', async () => {
    const main = board('main', 500, 400);
    const tiles = planTileSheets(planTiles(letter, main, margin), letter, 0);
    const { placed, lines, text } = await draw([main], { cut_marks: false });

    expect(lines).toEqual([]);
    expect(text).toEqual([]);
    for (const [index, tile] of tiles.entries()) expectRect(placed[index].clip!, tile.cut);
  });

  // The printer turns every sheet over for the cards ahead of the boards, so
  // without a blank the second tile lands on the back of the first.
  it('leaves a blank page behind every tile when the document has backs', async () => {
    const main = board('main', 380, 250);
    const { placed, pages } = await draw([main], {}, true);

    expect(placed.map((p) => p.page)).toEqual([1, 3]);
    expect(pages()).toBe(4);
  });

  it('follows the card sheets already in the document', async () => {
    const recording = recordingDoc();
    const turn = pageTurner(recording.doc);
    const front = [{ front_file_id: 'a', back_file_id: 'z' }];
    await renderRuns(recording.doc, [run('poker', front)], options(), images, undefined, turn);
    await renderBoards(recording.doc, [board('mat', 150, 200)], options(), images, turn, true);

    expect(recording.placed.map((p) => [p.alias, p.page])).toEqual([
      ['art:a', 1],
      ['art:z', 2],
      ['art:mat', 3],
    ]);
    expect(recording.pages()).toBe(4);
  });

  it('draws nothing of a board the paper has no room for', async () => {
    const { placed } = await draw([board('main', 500, 400)], { printer_margin_mm: 200 });
    expect(placed).toEqual([]);
  });
});

describe('winAnsi', () => {
  it('keeps what the standard fonts can draw', () => {
    expect(winAnsi('Café board · 166.7 × 250 mm')).toBe('Café board · 166.7 × 250 mm');
  });

  it('replaces what they cannot', () => {
    expect(winAnsi('盤 — board')).toBe('? ? board');
  });
});
