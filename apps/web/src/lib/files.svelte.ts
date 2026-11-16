import type { components } from '@three-peaks/shared/api';
import type { RealtimeEvent } from '@three-peaks/shared/realtime';
import { api, assertOk, authHeader } from '../api/client.ts';
import { newId } from './ids.ts';
import { assertUploadSize, readUploadResponse } from './upload.ts';

type Folder = components['schemas']['Folder'];
type FileRow = components['schemas']['File'];
type DirectoryListing = components['schemas']['DirectoryListing'];

interface PendingUpload {
  key: string;
  filename: string;
}

// Where an upload lands. A folder id (null for the Assets root), a deck, or a
// component -- and `role` says what it becomes there: a deck's back rather
// than one of its cards, or with `back_of` the back of a punchboard's token
// rather than a token of its own.
interface UploadTarget {
  folder_id?: string | null;
  deck_id?: string;
  component_id?: string;
  role?: 'card' | 'back' | 'artwork' | 'token';
  back_of?: string;
}

class FileStore {
  listing = $state<DirectoryListing | null>(null);
  loading = $state(false);
  // Rows drawn before the server has answered, so a large upload is visible the
  // moment it starts rather than when it finishes.
  pending = $state<PendingUpload[]>([]);

  // Two loads are routinely in flight at once: the one a component starts on
  // mount, and the one a refresh starts after an upload. Responses can arrive in
  // either order, and without this the older one overwrites the newer -- which
  // showed up as an explorer listing the file it had just uploaded while the
  // storage meter still read 0 B. Only the newest request may assign.
  #generation = 0;

  async load(projectId: string, folderId: string | null): Promise<void> {
    this.#generation += 1;
    const generation = this.#generation;
    this.loading = true;

    try {
      const data = assertOk(
        await api.GET('/api/files/directory', {
          params: {
            query: { project_id: projectId, ...(folderId ? { folder_id: folderId } : {}) },
          },
        })
      );
      if (generation !== this.#generation) return;
      this.listing = data;
    } finally {
      // Guarded too: a superseded request finishing must not clear the spinner
      // that the request replacing it is still showing.
      if (generation === this.#generation) this.loading = false;
    }
  }

  async refresh(): Promise<void> {
    if (!this.listing) return;
    await this.load(this.listing.project_id, this.listing.folder?.id ?? null);
  }

  // The listing sorts on the server, so a row inserted here has to land where a
  // reload would have put it. Postgres collates by its own rules and this does
  // not, which can differ on names a locale orders unusually -- until the next
  // load, which is the only cost.
  static #insertSorted<T>(rows: T[], row: T, key: (entry: T) => string): T[] {
    const next = [...rows, row];
    next.sort((a, b) => key(a).localeCompare(key(b)));
    return next;
  }

  #placeFolder(here: string | null, row: Folder): void {
    const listing = this.listing;
    if (!listing) return;
    // A rename of the folder being shown, or of one in the trail above it.
    if (listing.folder?.id === row.id) listing.folder = row;
    listing.breadcrumb = listing.breadcrumb.map((entry) => (entry.id === row.id ? row : entry));

    const rest = listing.folders.filter((entry) => entry.id !== row.id);
    listing.folders =
      (row.parent_id ?? null) === here
        ? FileStore.#insertSorted(rest, row, (entry) => entry.name)
        : rest;
  }

  #placeFile(here: string | null, row: FileRow): void {
    const listing = this.listing;
    if (!listing) return;
    const rest = listing.files.filter((entry) => entry.id !== row.id);
    // A tombstone leaves the live listing; it turns up on the deleted screen,
    // which reads its own. So does a file a deck or a component now owns: this
    // listing is Assets, and Assets is what belongs to neither.
    const belongsHere =
      (row.folder_id ?? null) === here && row.deck_id === null && row.component_id === null;
    listing.files =
      belongsHere && row.deleted_at === null
        ? FileStore.#insertSorted(rest, row, (entry) => entry.filename)
        : rest;
  }

  // Applies what an event carried to the listing on screen. False means this
  // store cannot place it and the caller should reload -- which is the honest
  // answer for an event whose consequences are wider than the row it names.
  apply(event: RealtimeEvent): boolean {
    const listing = this.listing;
    if (!listing || listing.project_id !== event.project_id) return true;
    const here = listing.folder?.id ?? null;

    switch (event.type) {
      case 'folder_created':
      case 'folder_updated':
        this.#placeFolder(here, event.data);
        return true;

      case 'folder_deleted': {
        // The folder being shown, or one above it, going away is not something
        // a listing can absorb: what is on screen has stopped existing.
        const gone = event.data.id;
        if (listing.folder?.id === gone || listing.breadcrumb.some((entry) => entry.id === gone)) {
          return false;
        }
        listing.folders = listing.folders.filter((entry) => entry.id !== gone);
        return true;
      }

      case 'file_uploaded':
      case 'file_deleted':
        this.#placeFile(here, event.data);
        listing.storage_used_bytes = event.data.storage_used_bytes;
        return true;

      // A move carries the row with its new home, and #placeFile drops it from
      // the listing when that home is not this one. Nothing about the bytes
      // changed on either, so the meter stays where it is.
      case 'file_updated':
      case 'file_moved':
        this.#placeFile(here, event.data);
        return true;

      case 'file_version_created':
        this.#placeFile(here, event.data.file);
        listing.storage_used_bytes = event.data.storage_used_bytes;
        return true;

      // A project going away, or its membership changing, is the screen's to
      // answer rather than this listing's.
      default:
        return true;
    }
  }

  // One folder, read without disturbing the listing the explorer is showing:
  // the import screen resolves the folder its deck is bound to while the
  // explorer may be sitting somewhere else entirely.
  async readDirectory(projectId: string, folderId: string | null): Promise<DirectoryListing> {
    return assertOk(
      await api.GET('/api/files/directory', {
        params: {
          query: { project_id: projectId, ...(folderId ? { folder_id: folderId } : {}) },
        },
      })
    );
  }

  async upload(projectId: string, target: UploadTarget, file: File): Promise<void> {
    assertUploadSize(file.size);
    const key = `${file.name}-${crypto.randomUUID()}`;
    this.pending = [...this.pending, { key, filename: file.name }];

    try {
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- built to make one URL and discarded
      const query = new URLSearchParams({ project_id: projectId, filename: file.name });
      for (const [name, value] of Object.entries(target)) {
        if (typeof value === 'string' && value.length > 0) query.set(name, value);
      }

      // The file IS the body. Serializing it into JSON would read the whole
      // thing into memory on both ends, which is exactly what the streaming
      // upload path on the server exists to avoid.
      const response = await fetch(`/api/files/upload?${query}`, {
        method: 'POST',
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          ...authHeader(),
        },
        body: file,
      });

      await readUploadResponse(response, `Upload failed with status ${response.status}`);
    } finally {
      this.pending = this.pending.filter((entry) => entry.key !== key);
    }
  }

  async createFolder(projectId: string, parentId: string | null, name: string): Promise<Folder> {
    return assertOk(
      await api.POST('/api/files/folders', {
        body: { id: newId(), project_id: projectId, parent_id: parentId, name },
      })
    );
  }

  async renameFolder(id: string, name: string): Promise<void> {
    assertOk(
      await api.PATCH('/api/files/folders/{id}', { params: { path: { id } }, body: { name } })
    );
  }

  async deleteFolder(id: string): Promise<void> {
    assertOk(await api.DELETE('/api/files/folders/{id}', { params: { path: { id } } }));
  }

  async renameFile(id: string, filename: string): Promise<void> {
    assertOk(await api.PATCH('/api/files/{id}', { params: { path: { id } }, body: { filename } }));
  }

  // Every home change goes through this, folder to folder included: the server
  // re-deduplicates the name against wherever it is arriving, which a plain
  // rename could not do.
  async moveFile(id: string, to: UploadTarget): Promise<void> {
    assertOk(
      await api.POST('/api/files/{id}/move', {
        params: { path: { id } },
        body: {
          folder_id: to.folder_id ?? null,
          ...(to.deck_id ? { deck_id: to.deck_id } : {}),
          ...(to.component_id ? { component_id: to.component_id } : {}),
          ...(to.role ? { role: to.role } : {}),
        },
      })
    );
  }

  async deleteFile(id: string): Promise<void> {
    assertOk(await api.DELETE('/api/files/{id}', { params: { path: { id } } }));
  }

  reset(): void {
    // Moves the generation on, so a response still in flight when someone signs
    // out cannot assign one account's listing into the next one's store.
    this.#generation += 1;
    this.listing = null;
    this.pending = [];
    this.loading = false;
  }
}

export const files = new FileStore();
