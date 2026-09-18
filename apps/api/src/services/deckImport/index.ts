export { readBinding, ensureImport } from './binding.ts';
export { readTimeline, readRunDetail } from './runs.ts';
export { readDeckAsOfRun } from './history.ts';
export { startRun } from './start.ts';
export { importPage } from './page.ts';
export { abandonRun, finishRun } from './finish.ts';

// Keeping a deck's artwork in step with an export, in three moving parts: an
// import row that remembers which export a deck was last given, a run that
// carries one of them from the first page to the last, and a mapping row per
// card that survives both.
//
// Where the artwork lands is not one of them any more. The deck owns its cards,
// so the deck is the destination, and `binding.ts` exists for the resume check
// rather than to say where anything goes.
//
// The rule the modules beside this one are arranged around: which page becomes
// which card is decided once, at run start, before any bytes exist.
// `planning.ts` takes the whole page manifest, walks it in page-number order
// against the mapping as it stands, and works out a plan row per page;
// `start.ts` writes that down. `page.ts` then looks a plan row up and appends a
// version -- it matches nothing, so there is nothing left for arrival order to
// decide. `finish.ts` applies every planned key in one statement, which is the
// only moment the mapping is rewritten.
//
// Read them in that order. `common.ts` holds what more than one of them needs,
// `runs.ts` reads a run back, and `history.ts` answers what a finished run left
// behind.
