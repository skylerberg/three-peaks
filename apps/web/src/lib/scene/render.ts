// The half of the export that needs a GPU-shaped browser: it builds each
// component the studio would build and asks the same exporter for the same
// bytes. Everything that reaches three is behind this one module, so a plan or
// a document can be assembled -- and tested -- without loading any of it.

import {
  PUNCHBOARD_PARTS,
  buildModel,
  disposeModel,
  exportGlb,
  loadSource,
  type SourceImage,
} from '../model3d/index.ts';
import type { AssetBuild, SceneImageRef } from './assets.ts';

export type SceneAssetRenderer = (build: AssetBuild) => Promise<Uint8Array>;

/**
 * One renderer per export, holding the images it has already read.
 *
 * A deck puts the same back on every card in it, and a punchboard's sheet and
 * its tokens are built from the same faces, so an uncached renderer would fetch
 * and decode one image fifty times to build fifty files that each embed it once.
 */
export function componentRenderer(): SceneAssetRenderer {
  const sources = new Map<string, Promise<SourceImage>>();

  const read = (ref: SceneImageRef): Promise<SourceImage> => {
    const held = sources.get(ref.file_id);
    if (held) return held;
    const started = loadSource(ref.file_id, ref.content_type);
    sources.set(ref.file_id, started);
    return started;
  };

  return async (build) => {
    const artwork = build.front ? await read(build.front) : null;
    const back = build.back ? await read(build.back) : null;
    // A token on its own is built from its own two faces; a sheet, from every
    // token it cuts.
    const tokens =
      build.part === PUNCHBOARD_PARTS.token && artwork
        ? [{ front: artwork, back, quantity: 1 }]
        : await Promise.all(
            (build.tokens ?? []).map(async (token) => ({
              front: await read(token.front),
              back: token.back ? await read(token.back) : null,
              quantity: token.quantity,
            }))
          );
    const model = buildModel(build.settings, { artwork, back, tokens }, build.part);
    try {
      return new Uint8Array(await exportGlb(model.group));
    } finally {
      // Geometry and textures hold GPU memory until they are told to let go,
      // and an export builds a thousand of them one after another.
      disposeModel(model);
    }
  };
}
