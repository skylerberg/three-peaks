import type { ComponentKind } from '@three-peaks/shared';
import type { components as ApiComponents } from '@three-peaks/shared/api';
import { api, assertOk } from '../api/client.ts';
import { SAVE_DELAY_MS } from './autosave.ts';

export type ProjectComponent = ApiComponents['schemas']['Component'];
export type ComponentSettings = ProjectComponent['settings'];

// The order the server lists a section in, so a row inserted here lands where a
// reload would have put it. The name breaks a tie, because a tombstone keeps
// the position it had and a restore can collide with whatever took it.
function byPlace(a: ProjectComponent, b: ProjectComponent): number {
  return a.position - b.position || a.name.localeCompare(b.name);
}

class ComponentStore {
  // The section currently on screen, and the one component open in the studio.
  list = $state<ProjectComponent[]>([]);
  component = $state<ProjectComponent | null>(null);
  loadingList = $state(false);
  loadingOne = $state(false);
  saving = $state(false);

  #projectId: string | null = null;
  #kind: ComponentKind | null = null;
  // One counter per kind of load, so reloading a section cannot cancel the
  // component open in the studio.
  #listGeneration = 0;
  #oneGeneration = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;

  async loadList(projectId: string, kind: ComponentKind): Promise<void> {
    this.#listGeneration += 1;
    const generation = this.#listGeneration;
    this.#projectId = projectId;
    this.#kind = kind;
    this.loadingList = true;

    try {
      const data = assertOk(
        await api.GET('/api/components', { params: { query: { project_id: projectId, kind } } })
      );
      if (generation !== this.#listGeneration) return;
      this.list = data.components;
    } finally {
      if (generation === this.#listGeneration) this.loadingList = false;
    }
  }

  async refreshList(): Promise<void> {
    if (this.#projectId && this.#kind) await this.loadList(this.#projectId, this.#kind);
  }

  async loadOne(componentId: string): Promise<void> {
    this.#oneGeneration += 1;
    const generation = this.#oneGeneration;
    this.loadingOne = true;

    try {
      const data = assertOk(
        await api.GET('/api/components/{componentId}', { params: { path: { componentId } } })
      );
      if (generation !== this.#oneGeneration) return;
      if (this.#supersededBy(data)) return;
      this.component = data;
    } finally {
      if (generation === this.#oneGeneration) this.loadingOne = false;
    }
  }

  async refreshOne(): Promise<void> {
    if (this.component) await this.loadOne(this.component.id);
  }

  // A response can be older than an event already applied: this GET may have
  // been issued before that edit committed, and applying answers no request so
  // it goes through no generation counter. The row's own timestamp settles
  // which is newer rather than the order the two happened to arrive in.
  #supersededBy(incoming: ProjectComponent): boolean {
    const held = this.component;
    if (!held || held.id !== incoming.id) return false;
    return Date.parse(held.updated_at) > Date.parse(incoming.updated_at);
  }

  // What a realtime event carries, applied rather than read back.
  apply(row: ProjectComponent, gone = false): boolean {
    if (this.component?.id === row.id) {
      this.component = gone ? this.component : row;
    }

    const index = this.list.findIndex((one) => one.id === row.id);
    const hidden = gone || row.deleted_at !== null;
    if (index === -1) {
      // A component of another kind belongs to another section, and this one
      // knows only its own: it cannot tell that from a row it has not loaded.
      if (hidden) return true;
      if (this.#kind !== null && row.kind !== this.#kind) return true;
      this.list = [...this.list, row].sort(byPlace);
      return true;
    }

    this.list = hidden
      ? this.list.filter((one) => one.id !== row.id)
      : this.list.map((one) => (one.id === row.id ? row : one)).sort(byPlace);
    return true;
  }

  // The whole section in its new order, applied rather than read back. A
  // reorder moves rows this client already holds, so a list of ids would only
  // send it back for them; what it cannot know is which section moved, which is
  // why the kind rides alongside.
  applyOrder(kind: string, components: readonly ProjectComponent[]): void {
    if (this.#kind !== null && kind !== this.#kind) return;
    this.list = [...components];
  }

  async reorder(
    projectId: string,
    kind: ComponentKind,
    componentIds: readonly string[]
  ): Promise<void> {
    const saved = assertOk(
      await api.PUT('/api/components/order', {
        body: { project_id: projectId, kind, component_ids: [...componentIds] },
      })
    );
    if (this.#projectId === projectId && this.#kind === kind) this.list = saved.components;
  }

  update(patch: Partial<ComponentSettings>): void {
    const held = this.component;
    if (!held) return;
    this.component = { ...held, settings: { ...held.settings, ...patch } as ComponentSettings };
  }

  // See ModelStore.scheduleSave, which does this for a deck card's dial-in.
  scheduleSave(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.saveSettings().catch(() => {});
    }, SAVE_DELAY_MS);
  }

  async saveSettings(): Promise<void> {
    const held = this.component;
    if (!held) return;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }

    this.saving = true;
    try {
      // Snapshotted because a $state proxy cannot cross fetch.
      const body = { settings: $state.snapshot(held.settings) as ComponentSettings };
      const saved = assertOk(
        await api.PATCH('/api/components/{componentId}', {
          params: { path: { componentId: held.id } },
          body,
        })
      );
      this.apply(saved);
    } finally {
      this.saving = false;
    }
  }

  async create(projectId: string, kind: ComponentKind, name: string): Promise<ProjectComponent> {
    const made = assertOk(
      await api.POST('/api/components', { body: { project_id: projectId, kind, name } })
    );
    this.apply(made);
    return made;
  }

  async rename(componentId: string, name: string): Promise<void> {
    this.apply(
      assertOk(
        await api.PATCH('/api/components/{componentId}', {
          params: { path: { componentId } },
          body: { name },
        })
      )
    );
  }

  async remove(componentId: string, purge = false): Promise<void> {
    assertOk(
      await api.DELETE('/api/components/{componentId}', {
        params: { path: { componentId }, query: purge ? { purge: 'true' } : {} },
      })
    );
    this.list = this.list.filter((one) => one.id !== componentId);
  }

  reset(): void {
    // Generation first, so a load already in flight cannot assign afterwards.
    this.#listGeneration += 1;
    this.#oneGeneration += 1;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.list = [];
    this.component = null;
    this.#projectId = null;
    this.#kind = null;
    this.loadingList = false;
    this.loadingOne = false;
    this.saving = false;
  }
}

export const projectComponents = new ComponentStore();
