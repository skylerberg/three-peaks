import '../api/testUtils.ts';
import { fetchMock, jsonResponse } from '../api/testUtils.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES, formatBytes } from '@three-peaks/shared';
import { apiMessage } from '../api/client.ts';
import { files } from './files.svelte.ts';

const PROJECT = '2f1c9e5a-8b3d-4f1e-9c2a-7d6b5e4f3a21';

function listing(fileCount: number, usedBytes: number) {
  return {
    project_id: PROJECT,
    folder: null,
    breadcrumb: [],
    folders: [],
    files: Array.from({ length: fileCount }, (_, index) => ({
      id: `file-${index}`,
      project_id: PROJECT,
      folder_id: null,
      filename: `f${index}.txt`,
      content_type: 'text/plain',
      byte_size: usedBytes,
      image_width: null,
      image_height: null,
      uploaded_by: 'someone',
      deleted_at: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    })),
    storage_used_bytes: usedBytes,
    storage_quota_bytes: 1024,
  };
}

describe('FileStore.load', () => {
  beforeEach(() => {
    files.reset();
    fetchMock.mockReset();
  });

  // Two loads are routinely in flight: the one a component starts on mount and
  // the one a refresh starts after an upload. Before the generation guard, the
  // slower earlier response won -- which showed as an explorer listing the file
  // it had just uploaded while the storage meter still read 0 B.
  it('discards a response that a newer request has already superseded', async () => {
    let releaseFirst: (() => void) | null = null;
    const firstArrived = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    fetchMock
      .mockImplementationOnce(async () => {
        await firstArrived;
        return jsonResponse(200, listing(0, 0));
      })
      .mockImplementationOnce(async () => jsonResponse(200, listing(1, 58)));

    const stale = files.load(PROJECT, null);
    const fresh = files.load(PROJECT, null);

    await fresh;
    expect(files.listing?.storage_used_bytes).toBe(58);

    // Now let the older request finish. It must not assign.
    releaseFirst!();
    await stale;

    expect(files.listing?.storage_used_bytes).toBe(58);
    expect(files.listing?.files).toHaveLength(1);
  });

  it('leaves the spinner to whichever request is still current', async () => {
    let releaseFirst: (() => void) | null = null;
    const firstArrived = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    fetchMock
      .mockImplementationOnce(async () => {
        await firstArrived;
        return jsonResponse(200, listing(0, 0));
      })
      .mockImplementationOnce(async () => jsonResponse(200, listing(1, 58)));

    const stale = files.load(PROJECT, null);
    const fresh = files.load(PROJECT, null);
    await fresh;
    expect(files.loading).toBe(false);

    releaseFirst!();
    await stale;
    expect(files.loading).toBe(false);
  });

  // Signing out empties the store; a response already on the wire must not
  // refill it with the departing account's data.
  it('does not assign into a store that was reset mid-flight', async () => {
    let release: (() => void) | null = null;
    const arrived = new Promise<void>((resolve) => {
      release = resolve;
    });

    fetchMock.mockImplementationOnce(async () => {
      await arrived;
      return jsonResponse(200, listing(3, 99));
    });

    const inFlight = files.load(PROJECT, null);
    files.reset();
    release!();
    await inFlight;

    expect(files.listing).toBeNull();
  });
});

// A File of the size claimed, without allocating it: only `size` is read before
// the request, and half a gigabyte of zeroes in jsdom is not worth the seconds.
function fileOf(name: string, size: number): File {
  const file = new File(['x'], name, { type: 'application/zip' });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

describe('FileStore.upload', () => {
  beforeEach(() => {
    files.reset();
    fetchMock.mockReset();
  });

  it('refuses a file over the limit without sending it', async () => {
    const oversized = fileOf('export.zip', MAX_UPLOAD_BYTES * 2);
    const caught = await files
      .upload(PROJECT, { folder_id: null }, oversized)
      .catch((error: unknown) => error);

    expect(apiMessage(caught)).toBe(
      `That file is ${formatBytes(MAX_UPLOAD_BYTES * 2)}, over the ` +
        `${formatBytes(MAX_UPLOAD_BYTES)} limit for one upload.`
    );
    expect(fetchMock).not.toHaveBeenCalled();
    // The row the explorer draws while a transfer is in flight: nothing was
    // ever in flight.
    expect(files.pending).toHaveLength(0);
  });

  // apiMessage shows an ApiError and nothing else, so a plain Error thrown here
  // reached the toast as "could not reach the server" -- for a refusal the
  // server had taken the trouble to explain.
  it('carries the refusal the API wrote out to the caller', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(413, { error: 'Project storage quota exceeded' }));

    const caught = await files
      .upload(PROJECT, { folder_id: null }, fileOf('card.png', 8))
      .catch((error: unknown) => error);

    expect(apiMessage(caught)).toBe('Project storage quota exceeded');
    expect(files.pending).toHaveLength(0);
  });
});

describe('FileStore.apply', () => {
  const FOLDER = 'folder-1';

  function fileRow(id: string, filename: string, folderId: string | null = null) {
    return {
      id,
      project_id: PROJECT,
      folder_id: folderId,
      deck_id: null,
      component_id: null,
      component_role: null,
      filename,
      content_type: 'text/plain',
      byte_size: 10,
      checksum: null,
      image_width: null,
      image_height: null,
      name_locked: false,
      uploaded_by: 'someone',
      deleted_at: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
  }

  function folderRow(id: string, name: string, parentId: string | null = null) {
    return {
      id,
      project_id: PROJECT,
      parent_id: parentId,
      name,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
  }

  function envelope(type: string, data: Record<string, unknown>) {
    return { type, project_id: PROJECT, data: { ...data, actor_user_id: 'someone' } } as never;
  }

  beforeEach(() => {
    files.reset();
    fetchMock.mockReset();
    files.listing = { ...listing(0, 0), files: [fileRow('a', 'a.txt'), fileRow('c', 'c.txt')] };
  });

  // The listing is ordered by the server, so a row put in here has to land
  // where a reload would have put it or the explorer jumps on the next load.
  it('inserts an uploaded file in the order the listing is sorted in', () => {
    expect(
      files.apply(envelope('file_uploaded', { ...fileRow('b', 'b.txt'), storage_used_bytes: 99 }))
    ).toBe(true);

    expect(files.listing!.files.map((row) => row.filename)).toEqual(['a.txt', 'b.txt', 'c.txt']);
    // A row cannot move the project total on its own, so the event carries it.
    expect(files.listing!.storage_used_bytes).toBe(99);
  });

  it('takes a file out of the listing when it is moved elsewhere', () => {
    files.apply(envelope('file_updated', fileRow('a', 'a.txt', FOLDER)));
    expect(files.listing!.files.map((row) => row.id)).toEqual(['c']);
  });

  it('replaces the row and moves the meter when a version lands', () => {
    files.apply(
      envelope('file_version_created', {
        version: { file_id: 'a', version_number: 2, is_current: true },
        file: { ...fileRow('a', 'a.txt'), byte_size: 4096 },
        storage_used_bytes: 4096,
      })
    );

    expect(files.listing!.files[0].byte_size).toBe(4096);
    expect(files.listing!.storage_used_bytes).toBe(4096);
  });

  it('drops a tombstoned file from the live listing', () => {
    files.apply(
      envelope('file_deleted', {
        ...fileRow('a', 'a.txt'),
        deleted_at: '2026-02-01T00:00:00.000Z',
        storage_used_bytes: 10,
        purged: false,
      })
    );

    expect(files.listing!.files.map((row) => row.id)).toEqual(['c']);
  });

  it('follows a rename of the folder it is showing', () => {
    files.listing = {
      ...files.listing!,
      folder: folderRow(FOLDER, 'Old'),
      breadcrumb: [folderRow(FOLDER, 'Old')],
    };

    files.apply(envelope('folder_updated', folderRow(FOLDER, 'New')));

    expect(files.listing!.folder!.name).toBe('New');
    expect(files.listing!.breadcrumb[0].name).toBe('New');
  });

  // The one it cannot absorb: what is on screen has stopped existing, and only
  // a reload can decide what to show instead.
  it('asks for a reload when the folder being shown is deleted', () => {
    files.listing = { ...files.listing!, folder: folderRow(FOLDER, 'Here'), breadcrumb: [] };

    expect(
      files.apply(envelope('folder_deleted', { ...folderRow(FOLDER, 'Here'), purged: false }))
    ).toBe(false);
  });

  it('ignores an event for another project', () => {
    expect(files.apply({ type: 'file_deleted', project_id: 'other', data: {} } as never)).toBe(
      true
    );
    expect(files.listing!.files).toHaveLength(2);
  });
});
