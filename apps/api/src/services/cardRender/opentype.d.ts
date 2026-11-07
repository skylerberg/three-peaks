// opentype.js 2.0 ships no declarations, and @types/opentype.js describes 1.3.
// This is the part of the API the renderer calls, checked against the real
// package rather than recalled -- anything more would be a claim nothing here
// exercises.
declare module 'opentype.js' {
  export interface PathCommand {
    type: string;
  }

  export class Path {
    commands: PathCommand[];
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    close(): void;
    toPathData(decimalPlaces?: number): string;
  }

  export class Glyph {
    constructor(options: { name: string; unicode?: number; advanceWidth: number; path: Path });
  }

  export class Font {
    constructor(options: {
      familyName: string;
      styleName: string;
      unitsPerEm: number;
      ascender: number;
      descender: number;
      glyphs: Glyph[];
    });
    unitsPerEm: number;
    ascender: number;
    descender: number;
    hasChar(char: string): boolean;
    getAdvanceWidth(text: string, fontSize: number): number;
    getPath(text: string, x: number, y: number, fontSize: number): Path;
    toArrayBuffer(): ArrayBuffer;
  }

  export function parse(buffer: ArrayBuffer): Font;

  const opentype: {
    Font: typeof Font;
    Glyph: typeof Glyph;
    Path: typeof Path;
    parse: typeof parse;
  };
  export default opentype;
}
