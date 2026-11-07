import { MM_PER_PT, type MarkupRun, type TextAlign, type TextValign } from '@three-peaks/shared';

// Setting one text element's copy into its box: greedy line breaking at
// spaces, icons as unbreakable one-em squares, and the size stepped down until
// the whole thing fits. Pure -- a face is a measure function and two metrics --
// so every break is a number a test can state exactly.

export interface Face {
  // Fractions of the em: ascender above the baseline, descender below it
  // (negative), as the font itself declares them.
  ascender: number;
  descender: number;
  // Width in millimetres of `text` set at `sizeMm`.
  advance(text: string, sizeMm: number): number;
}

export interface Faces {
  regular: Face;
  bold: Face;
}

export interface FlowBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FlowStyle {
  size_pt: number;
  min_size_pt: number;
  line_height: number;
  align: TextAlign;
  valign: TextValign;
}

type Placed =
  | { kind: 'text'; text: string; bold: boolean; x: number; baseline: number; size: number }
  | { kind: 'icon'; key: string; x: number; y: number; size: number };

export type FlowResult =
  { fits: true; size_pt: number; items: Placed[] } | { fits: false; reason: string };

// A quarter of a point at a time: fine enough that a box is filled, coarse
// enough that the loop is short, and the same steps on every machine.
const STEP_PT = 0.25;
// Floating-point slack, far below anything a printer resolves.
const EPSILON_MM = 1e-6;

type Piece = { kind: 'text'; text: string; bold: boolean } | { kind: 'icon'; key: string };

// A line is words with one space between each; a word is pieces with no space
// inside it, so "{coin}." stays together across the change of piece.
interface Word {
  pieces: Piece[];
  // The space before this word takes the weight of the text it follows.
  spaceBold: boolean;
}

type Paragraph = Word[];

function paragraphs(runs: readonly MarkupRun[]): Paragraph[] {
  const result: Paragraph[] = [[]];
  let word: Piece[] = [];
  let pendingSpace: boolean | null = null;

  const endWord = () => {
    if (word.length === 0) return;
    result.at(-1)!.push({ pieces: word, spaceBold: pendingSpace ?? false });
    word = [];
    pendingSpace = null;
  };

  for (const run of runs) {
    if (run.kind === 'break') {
      endWord();
      pendingSpace = null;
      result.push([]);
    } else if (run.kind === 'icon') {
      word.push({ kind: 'icon', key: run.key });
    } else {
      // Any run of whitespace is one space, the way type is set; a space at
      // the start or end of a line is dropped where the line breaks.
      const parts = run.text.split(/[ \t\u00a0]+/);
      parts.forEach((part, index) => {
        if (index > 0) {
          endWord();
          if (result.at(-1)!.length > 0) pendingSpace = run.bold;
        }
        if (part !== '') word.push({ kind: 'text', text: part, bold: run.bold });
      });
    }
  }
  endWord();
  return result;
}

function face(faces: Faces, bold: boolean): Face {
  return bold ? faces.bold : faces.regular;
}

function pieceWidth(faces: Faces, piece: Piece, size: number): number {
  return piece.kind === 'icon' ? size : face(faces, piece.bold).advance(piece.text, size);
}

function wordWidth(faces: Faces, word: Word, size: number): number {
  return word.pieces.reduce((sum, piece) => sum + pieceWidth(faces, piece, size), 0);
}

interface Line {
  words: Word[];
  width: number;
}

function breakLines(faces: Faces, paras: readonly Paragraph[], size: number, max: number): Line[] {
  const lines: Line[] = [];
  for (const para of paras) {
    let line: Line = { words: [], width: 0 };
    for (const word of para) {
      const width = wordWidth(faces, word, size);
      const space = face(faces, word.spaceBold).advance(' ', size);
      if (line.words.length > 0 && line.width + space + width > max + EPSILON_MM) {
        lines.push(line);
        line = { words: [], width: 0 };
      }
      line.width += (line.words.length > 0 ? space : 0) + width;
      line.words.push(word);
    }
    lines.push(line);
  }
  return lines;
}

function place(
  faces: Faces,
  lines: readonly Line[],
  box: FlowBox,
  style: FlowStyle,
  size: number
): Placed[] {
  const { ascender, descender } = faces.regular;
  const lineHeight = style.line_height * size;
  // Half the leading above the font's own extent and half below, as CSS does,
  // so a line height of 1 sets the ascender at the top of the box.
  const halfLeading = (lineHeight - (ascender - descender) * size) / 2;
  const blockHeight = lines.length * lineHeight;
  const top =
    style.valign === 'top'
      ? box.y
      : style.valign === 'middle'
        ? box.y + (box.height - blockHeight) / 2
        : box.y + box.height - blockHeight;

  const items: Placed[] = [];
  lines.forEach((line, index) => {
    const baseline = top + index * lineHeight + halfLeading + ascender * size;
    let x =
      style.align === 'left'
        ? box.x
        : style.align === 'center'
          ? box.x + (box.width - line.width) / 2
          : box.x + box.width - line.width;
    line.words.forEach((word, wordIndex) => {
      if (wordIndex > 0) x += face(faces, word.spaceBold).advance(' ', size);
      for (const piece of word.pieces) {
        if (piece.kind === 'icon') {
          // Centred on the middle of the font's extent, so an icon sits where
          // a capital and its descender together would.
          const middle = baseline - ((ascender + descender) / 2) * size;
          items.push({ kind: 'icon', key: piece.key, x, y: middle - size / 2, size });
        } else {
          items.push({ kind: 'text', text: piece.text, bold: piece.bold, x, baseline, size });
        }
        x += pieceWidth(faces, piece, size);
      }
    });
  });
  return items;
}

export function flowText(
  runs: readonly MarkupRun[],
  faces: Faces,
  box: FlowBox,
  style: FlowStyle
): FlowResult {
  const paras = paragraphs(runs);
  const empty = paras.every((para) => para.length === 0);
  if (empty) return { fits: true, size_pt: style.size_pt, items: [] };

  let last = '';
  for (let pt = style.size_pt; pt >= style.min_size_pt - 1e-9; pt -= STEP_PT) {
    // Rounded to the step, so repeated subtraction cannot drift a size into
    // something like 8.749999 that a second machine might not reproduce.
    const sizePt = Math.round(pt / STEP_PT) * STEP_PT;
    const size = sizePt * MM_PER_PT;
    const lines = breakLines(faces, paras, size, box.width);
    const tooWide = lines.find((line) => line.width > box.width + EPSILON_MM);
    const height = lines.length * style.line_height * size;
    if (tooWide === undefined && height <= box.height + EPSILON_MM) {
      return { fits: true, size_pt: sizePt, items: place(faces, lines, box, style, size) };
    }
    last =
      tooWide !== undefined
        ? 'a word is wider than the box'
        : `${String(lines.length)} lines need ${height.toFixed(1)} mm and the box is ${box.height.toFixed(1)} mm`;
  }
  return {
    fits: false,
    reason: `does not fit even at ${String(style.min_size_pt)} pt: ${last}`,
  };
}
