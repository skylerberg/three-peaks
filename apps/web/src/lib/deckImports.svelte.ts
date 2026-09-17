import type { components } from '@three-peaks/shared/api';
import { ApiError, api, assertOk } from '../api/client.ts';

type DeckImport = components['schemas']['DeckImport'];

// The marker beside a deck, read for the one field the deck screen still draws
// from it: whether a run is open. Importing itself happens in the Canva app, so
// nothing here uploads anything, and the deck screen says nothing about one
// until a run left open needs clearing.
//
// Reading the history is deckHistory's job rather than more of this: that store
// is scoped to a timeline somebody is looking at, and this one to the deck.
class DeckImportStore {
  binding = $state<DeckImport | null>(null);
  // Which deck the row above belongs to. The route block is not keyed, so
  // moving between two decks swaps props on a screen already mounted and
  // nothing unmounts. Cleared before the read rather than only overwritten
  // after it, so nothing downstream is handed the deck just left while the
  // next one is still on the wire.
  bindingDeckId = $state<string | null>(null);

  #projectId: string | null = null;
  #deckId: string | null = null;
  #bindingGeneration = 0;

  // A run opening and closing is the only thing about this row that moves, so
  // it is derived from the run event rather than announced twice.
  applyOpenRun(deckId: string, runId: string | null): void {
    if (this.bindingDeckId !== deckId) return;
    if (!this.binding) {
      // The first import into a deck is the one run there is no row here to
      // patch: `ensureImport` creates it, and this store read the 404 that came
      // before it. Read it back rather than inventing one -- the open run is
      // the whole of what the deck screen draws, so dropping this event leaves
      // a run nobody can discard until the screen is loaded again.
      if (runId !== null) void this.#refreshBinding();
      return;
    }
    this.binding = { ...this.binding, open_run_id: runId };
  }

  async loadBinding(projectId: string, deckId: string): Promise<void> {
    this.#bindingGeneration += 1;
    const generation = this.#bindingGeneration;
    this.#projectId = projectId;
    this.#deckId = deckId;
    this.bindingDeckId = null;
    this.binding = null;

    const binding = await this.#readBinding(deckId);
    if (generation !== this.#bindingGeneration) return;
    this.binding = binding;
    this.bindingDeckId = deckId;
  }

  /**
   * Clears a run the Canva app left open, so the deck can be imported into
   * again.
   *
   * Nothing already imported is undone by it: the pages that landed keep the
   * versions they wrote, and no card is tombstoned. Finishing is the
   * destructive half, and only the app that read the design can do that.
   */
  async abandon(runId: string): Promise<void> {
    assertOk(
      await api.POST('/api/decks/import/runs/{runId}/abandon', { params: { path: { runId } } })
    );
    await this.#refreshBinding();
  }

  reset(): void {
    // Bumped ahead of the fields, so a binding already on the wire lands in a
    // store nobody is reading rather than back in this one.
    this.#bindingGeneration += 1;
    this.binding = null;
    this.bindingDeckId = null;
    this.#projectId = null;
    this.#deckId = null;
  }

  async #readBinding(deckId: string): Promise<DeckImport | null> {
    try {
      return assertOk(
        await api.GET('/api/decks/{deckId}/import', { params: { path: { deckId } } })
      );
    } catch (caught) {
      // A deck with no import answers 404 on this one route, and the deck the
      // screen has already loaded is the proof that this 404 is not that one.
      if (caught instanceof ApiError && caught.status === 404) {
        return null;
      }
      throw caught;
    }
  }

  // The open run on the binding is what the screen offers to discard, so a run
  // that has just closed has to leave it.
  async #refreshBinding(): Promise<void> {
    const projectId = this.#projectId;
    const deckId = this.#deckId;
    if (!projectId || !deckId) return;
    await this.loadBinding(projectId, deckId).catch(() => {});
  }
}

export const deckImports = new DeckImportStore();
