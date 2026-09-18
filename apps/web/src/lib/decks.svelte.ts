import type { components } from '@three-peaks/shared/api';
import { api, assertOk } from '../api/client.ts';
import { newId } from './ids.ts';

export type Deck = components['schemas']['Deck'];
export type DeckCard = components['schemas']['DeckWithCards']['cards'][number];

interface DeckCardInput {
  file_id: string;
  quantity: number;
}

class DeckStore {
  decks = $state<Deck[]>([]);
  // The deck currently open in the editor, and its cards. One request fills
  // both, so they are never half a deck apart.
  deck = $state<Deck | null>(null);
  cards = $state<DeckCard[]>([]);
  loadingList = $state(false);
  loadingDeck = $state(false);
  saving = $state(false);

  #projectId: string | null = null;
  // Two loads are routinely in flight at once when a screen mounts and a
  // realtime event lands; only the newest may assign. One counter per kind, so
  // reloading the list cannot cancel the open deck.
  #listGeneration = 0;
  #deckGeneration = 0;

  async loadList(projectId: string): Promise<void> {
    this.#listGeneration += 1;
    const generation = this.#listGeneration;
    this.#projectId = projectId;
    this.loadingList = true;

    try {
      const data = assertOk(
        await api.GET('/api/decks', { params: { query: { project_id: projectId } } })
      );
      if (generation !== this.#listGeneration) return;
      this.decks = data.decks;
    } finally {
      if (generation === this.#listGeneration) this.loadingList = false;
    }
  }

  async refreshList(): Promise<void> {
    if (this.#projectId) await this.loadList(this.#projectId);
  }

  async loadDeck(deckId: string): Promise<void> {
    this.#deckGeneration += 1;
    const generation = this.#deckGeneration;
    this.loadingDeck = true;

    try {
      const data = assertOk(await api.GET('/api/decks/{deckId}', { params: { path: { deckId } } }));
      if (generation !== this.#deckGeneration) return;
      // A response can be older than an event already applied -- this GET may
      // have been issued before that edit committed, and applying does not go
      // through the generation counters because it answers no request. The
      // row's own timestamp settles which is newer rather than the order the
      // two happened to arrive in, and the cards route moves that timestamp
      // too, so it stands for the cards as well.
      if (this.#supersededBy(data.deck)) return;
      this.deck = data.deck;
      this.cards = data.cards;
    } finally {
      if (generation === this.#deckGeneration) this.loadingDeck = false;
    }
  }

  async refreshDeck(): Promise<void> {
    if (this.deck) await this.loadDeck(this.deck.id);
  }

  #supersededBy(incoming: Deck): boolean {
    const held = this.deck;
    if (!held || held.id !== incoming.id) return false;
    return Date.parse(held.updated_at) > Date.parse(incoming.updated_at);
  }

  // What a deck_updated event carries, applied instead of read back. Both
  // halves always arrive, so there is nothing to test for here.
  //
  // A deck the list has never seen is a restore: the delete took it out, and
  // restoring publishes an update rather than a create. Inserting it is what
  // stops a tab sitting on the list from having to reload to see it come back.
  applyDeckUpdate(deck: Deck, cards: readonly DeckCard[]): void {
    const listed = this.decks.findIndex((entry) => entry.id === deck.id);
    if (listed !== -1) this.decks[listed] = deck;
    else if (deck.deleted_at === null) this.applyDeckCreated(deck);

    if (this.deck?.id !== deck.id) return;
    this.deck = deck;
    this.cards = [...cards];
  }

  // A card embeds the file row it draws from, and renaming that file or giving
  // it a new version publishes a file event rather than a deck one. Nothing
  // about deck membership moves here -- only the row inside the card.
  applyCardFile(file: DeckCard['file']): void {
    this.cards = this.cards.map((card) => (card.file_id === file.id ? { ...card, file } : card));
  }

  // The listing sorts on the server; a row added here has to land where a
  // reload would have put it.
  applyDeckCreated(deck: Deck): void {
    if (this.decks.some((entry) => entry.id === deck.id)) return;
    this.decks = [...this.decks, deck].sort((a, b) => a.name.localeCompare(b.name));
  }

  applyDeckDeleted(deckId: string): void {
    this.decks = this.decks.filter((entry) => entry.id !== deckId);
  }

  // Reads one deck without touching the open one, which is what the print
  // builder needs: it wants several decks' cards at once and is not editing any
  // of them.
  async readDeck(deckId: string): Promise<{ deck: Deck; cards: DeckCard[] }> {
    return assertOk(await api.GET('/api/decks/{deckId}', { params: { path: { deckId } } }));
  }

  async create(
    projectId: string,
    fields: { name: string; card_width_mm: number; card_height_mm: number }
  ): Promise<Deck> {
    return assertOk(
      await api.POST('/api/decks', { body: { id: newId(), project_id: projectId, ...fields } })
    );
  }

  async update(
    deckId: string,
    patch: Partial<Pick<Deck, 'name' | 'card_width_mm' | 'card_height_mm' | 'back_file_id'>>
  ): Promise<void> {
    this.saving = true;
    try {
      const updated = assertOk(
        await api.PATCH('/api/decks/{deckId}', { params: { path: { deckId } }, body: patch })
      );
      if (this.deck?.id === deckId) this.deck = updated;
    } finally {
      this.saving = false;
    }
  }

  async remove(deckId: string): Promise<void> {
    assertOk(await api.DELETE('/api/decks/{deckId}', { params: { path: { deckId } } }));
    this.decks = this.decks.filter((deck) => deck.id !== deckId);
  }

  // The whole list every time. Reordering, adding and removing are one request,
  // and the response is what the screen then shows -- so a rejected save leaves
  // nothing half-applied to unpick.
  async saveCards(deckId: string, cards: readonly DeckCardInput[]): Promise<void> {
    this.saving = true;
    try {
      const saved = assertOk(
        await api.PUT('/api/decks/{deckId}/cards', {
          params: { path: { deckId } },
          // Snapshotted for the reason model3d.svelte.ts spells out at its own
          // save.
          body: { cards: $state.snapshot(cards) as DeckCardInput[] },
        })
      );
      if (this.deck?.id === deckId) {
        this.deck = saved.deck;
        this.cards = saved.cards;
      }
    } finally {
      this.saving = false;
    }
  }

  reset(): void {
    // Generations first, so a response still in flight when someone signs out
    // cannot assign one account's decks into the next one's store.
    this.#listGeneration += 1;
    this.#deckGeneration += 1;
    this.#projectId = null;
    this.decks = [];
    this.deck = null;
    this.cards = [];
    this.loadingList = false;
    this.loadingDeck = false;
    this.saving = false;
  }
}

export const decks = new DeckStore();
