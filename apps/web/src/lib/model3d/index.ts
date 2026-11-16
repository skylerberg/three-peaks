// The one entry point the studio screen imports, and it imports it with a
// dynamic import: three is the largest dependency in the app by a wide margin,
// and nothing outside this screen needs a byte of it.
export {
  buildModel,
  disposeModel,
  EmptyOutlineError,
  MissingArtworkError,
  PUNCHBOARD_PARTS,
  type BuiltModel,
  type ModelSources,
  type PunchboardTokenSource,
} from './build.ts';
export { EmptyPunchboardError } from './geometry/punchboard.ts';
export { exportGlb } from './exportGlb.ts';
export { loadSource, type SourceImage } from './sources.ts';
export { ModelViewer } from './viewer.svelte.ts';
// Millimetres to metres, and the only conversion in the pipeline. Exported so a
// caller reading a piece's built size can say it in the units a document does.
export { MM } from './units.ts';
