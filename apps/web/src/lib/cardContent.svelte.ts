import type { components } from '@three-peaks/shared/api';
import { ApiError, api, assertOk } from '../api/client.ts';
import { newId } from './ids.ts';

export type CardLayout = components['schemas']['CardLayout'];
export type CardContent = components['schemas']['CardContentList']['cards'][number];
type CardFields = CardContent['fields'];

// The layouts of the open deck's project and the content of its laid-out
// cards: what the deck screen needs to say which cards are drawn from a layout,
// whether each is up to date, and to edit one.
class CardContentStore {
  layouts = $state<CardLayout[]>([]);
  contents = $state<CardContent[]>([]);

  #deckId: string | null = null;
  #generation = 0;

  async load(projectId: string, deckId: string): Promise<void> {
    this.#generation += 1;
    const generation = this.#generation;
    this.#deckId = deckId;
    const [layouts, contents] = await Promise.all([
      api.GET('/api/layouts', { params: { query: { project_id: projectId } } }),
      api.GET('/api/card-content', { params: { query: { deck_id: deckId } } }),
    ]);
    if (generation !== this.#generation) return;
    this.contents = assertOk(contents).cards;
    // Cast, not converted: openapi-fetch's response mapping widens a slice's
    // tuple to number[], and the named schema it came from says four numbers.
    this.layouts = assertOk(layouts).layouts as CardLayout[];
  }

  // Leaving the deck forgets what it held, so the next deck never draws the
  // last one's status for a moment.
  close(): void {
    this.#generation += 1;
    this.#deckId = null;
    this.layouts = [];
    this.contents = [];
  }

  // A card's content as an event carries it: saved, asked to be drawn again,
  // drawn, or found impossible to draw. Kept whichever of the project's decks
  // it is in: a card made elsewhere can announce its content before the deck
  // event that lists it, and nothing here is read but by a card's own id.
  applyContents(updated: readonly CardContent[]): void {
    if (this.#deckId === null) return;
    const replaced = new Set(updated.map((content) => content.file_id));
    this.contents = [
      ...this.contents.filter((content) => !replaced.has(content.file_id)),
      ...updated,
    ];
  }

  applyRemoved(fileId: string): void {
    this.contents = this.contents.filter((content) => content.file_id !== fileId);
  }

  contentOf(fileId: string): CardContent | undefined {
    return this.contents.find((content) => content.file_id === fileId);
  }

  layoutOf(layoutId: string): CardLayout | undefined {
    return this.layouts.find((layout) => layout.id === layoutId);
  }

  // Saving draws the card: the image changes with the answer, and the deck
  // hears of it as a new version of the file.
  async save(fileId: string, layoutId: string, fields: CardFields): Promise<void> {
    const saved = assertOk(
      await api.PUT('/api/card-content/{fileId}', {
        params: { path: { fileId } },
        body: { layout_id: layoutId, fields },
      })
    );
    this.contents = [
      ...this.contents.filter((content) => content.file_id !== fileId),
      saved.content,
    ];
  }

  async create(
    deckId: string,
    filename: string,
    layoutId: string,
    fields: CardFields
  ): Promise<string> {
    const created = assertOk(
      await api.POST('/api/card-content', {
        body: { id: newId(), deck_id: deckId, filename, layout_id: layoutId, fields },
      })
    );
    this.contents = [...this.contents, created.content];
    return created.file.id;
  }

  // The card as `fields` would draw it, saving nothing. A card that cannot be
  // drawn is an ApiError saying why, which is what an editor shows in its place.
  async preview(projectId: string, layout: CardLayout, fields: CardFields): Promise<Blob> {
    const result = await api.POST('/api/layouts/preview', {
      body: {
        project_id: projectId,
        width_mm: layout.width_mm,
        height_mm: layout.height_mm,
        spec: layout.spec,
        fields,
      },
      parseAs: 'blob',
    });
    if (!result.response.ok) {
      const body = result.error as { error?: string } | undefined;
      throw new ApiError(
        result.response.status,
        body?.error ?? 'The card could not be drawn',
        body
      );
    }
    return result.data as unknown as Blob;
  }
}

export const cardContent = new CardContentStore();
