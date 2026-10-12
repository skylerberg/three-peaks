import { beforeEach, describe, expect, it, vi } from 'vitest';

// Canva's SDK only exists inside the editor iframe, so it is stubbed whole. The
// shapes here are the ones the real APIs returned when this was measured
// against a 47-page deck: a PageRef carries `type` and `locked` and no id, and
// the id lives on the AbsolutePage its own helper dereferences one into.
const getDesignMetadata = vi.fn();
const openDesign = vi.fn();
const requestExport = vi.fn();

vi.mock('@canva/design', () => ({
  getDesignMetadata: () => getDesignMetadata(),
  openDesign: (options: unknown, callback: unknown) => openDesign(options, callback),
  requestExport: (request: unknown) => requestExport(request),
}));

const { DesignError, exportPages, readDesign } = await import('./design.ts');

interface StubPage {
  id: string;
  title?: string;
  dimensions?: { width: number; height: number };
}

function stubDesign(pages: StubPage[], designTitle = 'Colori Cards'): void {
  getDesignMetadata.mockResolvedValue({
    title: designTitle,
    // Deliberately reversed. The documentation says this order is not
    // guaranteed, so a reader that trusts it would pass here and shuffle a real
    // deck the day Canva changes its mind.
    pageMetadata: [...pages].reverse().map((page) => ({
      type: 'absolute',
      id: page.id,
      title: page.title ?? '',
      dimensions: page.dimensions,
    })),
  });

  openDesign.mockImplementation(
    async (_options: unknown, callback: (session: unknown) => Promise<void>) => {
      await callback({
        pageRefs: { toArray: () => pages.map(() => ({ type: 'absolute', locked: false })) },
        helpers: {
          openPage: async (
            _ref: unknown,
            visit: (result: { page: { type: string; id: string } }) => Promise<void>
          ) => {
            const next = pages[openPageCalls];
            openPageCalls += 1;
            if (next) await visit({ page: { type: 'absolute', id: next.id } });
          },
        },
      });
    }
  );
}

let openPageCalls = 0;

const WHY = 'An import is the whole deck.';

beforeEach(() => {
  openPageCalls = 0;
  vi.clearAllMocks();
});

describe('reading the design', () => {
  it('numbers pages by their order and joins their titles by id', async () => {
    stubDesign([
      { id: 'PBX5gb6VMv0YSZfR' },
      { id: 'PBMBBSMWY0qb2McD', title: 'Template' },
      { id: 'PB8Svy3dV0HR4mdB', title: 'Back' },
    ]);

    const design = await readDesign();

    expect(design.title).toBe('Colori Cards');
    expect(design.pages).toEqual([
      { pageNumber: 1, pageId: 'PBX5gb6VMv0YSZfR', title: null, size: null },
      { pageNumber: 2, pageId: 'PBMBBSMWY0qb2McD', title: 'Template', size: null },
      { pageNumber: 3, pageId: 'PB8Svy3dV0HR4mdB', title: 'Back', size: null },
    ]);
  });

  // Joined by id like the titles, and for the same reason: the metadata's order
  // is the one thing the documentation will not promise.
  it('reads each page’s own size, joined by id', async () => {
    stubDesign([
      { id: 'PBmain', title: 'Main board', dimensions: { width: 1890, height: 1890 } },
      { id: 'PBmat', title: 'Player mat', dimensions: { width: 1134, height: 756 } },
      { id: 'PBboard', title: 'Whiteboard' },
    ]);

    const design = await readDesign();
    expect(design.pages.map((page) => page.size)).toEqual([
      { width: 1890, height: 1890 },
      { width: 1134, height: 756 },
      null,
    ]);
  });

  it('treats a page nobody named as untitled rather than titled empty', async () => {
    // Canva answers with an empty string for a page with no name, and an empty
    // title is not a title -- the importer keys those by page number, and one
    // sent as '' would be refused outright by the manifest.
    stubDesign([
      { id: 'PBone', title: '' },
      { id: 'PBtwo', title: '   ' },
    ]);

    const design = await readDesign();
    expect(design.pages.map((page) => page.title)).toEqual([null, null]);
  });

  it('refuses a design with no pages', async () => {
    stubDesign([]);
    await expect(readDesign()).rejects.toThrow(DesignError);
  });
});

describe('exporting the pages', () => {
  it('asks for one file per page rather than an archive', async () => {
    requestExport.mockResolvedValue({
      status: 'completed',
      exportBlobs: [{ url: 'a' }, { url: 'b' }],
    });

    await exportPages(2, WHY);

    // `zipped` belongs on the file type. Passed on the request it is silently
    // ignored, and a multi-page design comes back as one ZIP under the default.
    expect(requestExport).toHaveBeenCalledWith({
      acceptedFileTypes: [{ type: 'png', zipped: 'never' }],
    });
  });

  it('refuses an export holding fewer pages than the design', async () => {
    requestExport.mockResolvedValue({
      status: 'completed',
      exportBlobs: [{ url: 'a' }, { url: 'b' }],
    });

    // The export dialog lets a person pick a subset, and an ExportBlob is a
    // bare `{ url }` with nothing saying which page it holds. Lining two blobs
    // up against 47 pages by position would put the wrong artwork on the first
    // two cards and tombstone the other 45, and it would look entirely normal.
    await expect(exportPages(47, WHY)).rejects.toThrow(DesignError);
    // The message says why, not just what. Canva offers no way to ask for
    // specific pages and no way to learn which ones came back, so "export
    // everything" is a constraint the person has to understand rather than a
    // rule they have tripped over.
    await expect(exportPages(47, WHY)).rejects.toThrow(/2 of this design's 47 pages/u);
    await expect(exportPages(47, WHY)).rejects.toThrow(/does not say which ones/u);
    await expect(exportPages(47, WHY)).rejects.toThrow(WHY);
  });

  it('answers null when the dialog is closed, which is not a failure', async () => {
    requestExport.mockResolvedValue({ status: 'aborted' });
    expect(await exportPages(3, WHY)).toBeNull();
  });
});
