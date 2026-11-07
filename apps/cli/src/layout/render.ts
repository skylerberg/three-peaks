import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import opentype, { type Font } from 'opentype.js';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import {
  type CardFields,
  cardImageIds,
  isFontType,
  isLayoutImageType,
  pixelSize,
} from '@three-peaks/shared';
import { CardRenderError, buildCardSvg, type CardLayout, type LoadedImage } from './svg.ts';

// The WebAssembly build of resvg rather than the native one: the same code on
// every platform is what lets two machines render a card to the same bytes,
// and identical bytes are how an unchanged card is told from a changed one.
let wasmReady: Promise<void> | null = null;

export function ensureWasm(): Promise<void> {
  wasmReady ??= (async () => {
    const require = createRequire(import.meta.url);
    await initWasm(await readFile(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
  })();
  return wasmReady;
}

function fixedImageIds(spec: CardLayout['spec']): string[] {
  return spec.elements.flatMap((element) =>
    element.type === 'image' && element.source.from === 'file' ? [element.source.file_id] : []
  );
}

// Where a renderer gets a file's bytes: the API in the CLI, a map in a test.
export type AssetSource = (fileId: string) => Promise<LoadedImage>;

// One per run. Every font and image a run touches is fetched once however many
// cards draw it, which for a deck sharing one frame is most of the transfer.
export class CardRenderer {
  private readonly bytes = new Map<string, Promise<LoadedImage>>();
  private readonly fonts = new Map<string, Promise<Font>>();

  constructor(private readonly source: AssetSource) {}

  private load(fileId: string): Promise<LoadedImage> {
    let pending = this.bytes.get(fileId);
    if (pending === undefined) {
      pending = this.source(fileId);
      this.bytes.set(fileId, pending);
    }
    return pending;
  }

  private async image(fileId: string, what: string): Promise<LoadedImage> {
    const loaded = await this.load(fileId);
    if (!isLayoutImageType(loaded.contentType)) {
      throw new CardRenderError(`${what} is ${loaded.contentType}, not a PNG, JPEG or SVG image`);
    }
    return loaded;
  }

  private font(fileId: string, key: string): Promise<Font> {
    let pending = this.fonts.get(fileId);
    if (pending === undefined) {
      pending = this.load(fileId).then((loaded) => {
        if (!isFontType(loaded.contentType)) {
          throw new CardRenderError(`font "${key}" is ${loaded.contentType}, not a font`);
        }
        const { buffer, byteOffset, byteLength } = loaded.bytes;
        try {
          return opentype.parse(buffer.slice(byteOffset, byteOffset + byteLength) as ArrayBuffer);
        } catch (err) {
          throw new CardRenderError(`font "${key}" could not be read: ${(err as Error).message}`);
        }
      });
      this.fonts.set(fileId, pending);
    }
    return pending;
  }

  // The card as an SVG document, every asset it draws already fetched.
  async svg(layout: CardLayout, fields: CardFields): Promise<string> {
    const { spec } = layout;
    const fonts = new Map<string, Font>();
    const icons = new Map<string, LoadedImage>();
    const images = new Map<string, LoadedImage>();
    await Promise.all([
      ...Object.entries(spec.fonts).map(async ([key, id]) => {
        fonts.set(key, await this.font(id, key));
      }),
      ...Object.entries(spec.icons).map(async ([key, id]) => {
        icons.set(key, await this.image(id, `icon "${key}"`));
      }),
      ...[...fixedImageIds(spec), ...cardImageIds(spec, fields)].map(async (id) => {
        images.set(id, await this.image(id, `image ${id}`));
      }),
    ]);
    return buildCardSvg(layout, fields, { fonts, icons, images });
  }

  // The card as PNG bytes at the layout's resolution.
  async render(layout: CardLayout, fields: CardFields): Promise<Uint8Array> {
    const [svg] = await Promise.all([this.svg(layout, fields), ensureWasm()]);
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: pixelSize(layout.width_mm, layout.spec.dpi) },
      // The document carries no text, only paths; system fonts would be one
      // more thing a second machine could have differently.
      font: { loadSystemFonts: false },
    });
    // Both halves hold WebAssembly memory the JavaScript collector cannot see,
    // and a deck of three hundred cards would otherwise keep every one.
    try {
      const rendered = resvg.render();
      try {
        return rendered.asPng();
      } finally {
        rendered.free();
      }
    } finally {
      resvg.free();
    }
  }
}
