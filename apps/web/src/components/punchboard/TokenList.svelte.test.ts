import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PUNCHBOARD_SETTINGS, type PunchboardModelSettings } from '@three-peaks/shared';
import { fetchMock, jsonResponse } from '../../api/testUtils.ts';
import TokenList from './TokenList.svelte';
import { type ProjectComponent, projectComponents } from '../../lib/components.svelte.ts';

const PROJECT = '2f1c9e5a-8b3d-4f1e-9c2a-7d6b5e4f3a21';
const BOARD = '3a2b1c0d-1111-4222-8333-444455556666';
const SEEKER = '5e5e5e5e-1111-4222-8333-000000000001';
const READER = '5e5e5e5e-1111-4222-8333-000000000002';

function file(id: string, filename: string) {
  return {
    id,
    project_id: PROJECT,
    folder_id: null,
    deck_id: null,
    component_id: BOARD,
    component_role: 'token',
    filename,
    content_type: 'image/png',
    byte_size: 10,
    checksum: `sum-${id}`,
    image_width: 300,
    image_height: 300,
    name_locked: false,
    uploaded_by: 'someone',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
  };
}

function punchboard(tokens: ProjectComponent['tokens']): ProjectComponent {
  return {
    id: BOARD,
    project_id: PROJECT,
    kind: 'punchboard',
    name: 'Tokens',
    position: 0,
    settings: DEFAULT_PUNCHBOARD_SETTINGS,
    created_by: 'someone',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    files: [],
    missing_roles: [],
    tokens,
  } as unknown as ProjectComponent;
}

// A seeker printed the same both sides, three of them, and one reader with
// nothing behind it.
const held = (): ProjectComponent =>
  punchboard([
    {
      file_id: SEEKER,
      back_file_id: SEEKER,
      quantity: 3,
      position: 0,
      file: file(SEEKER, 'seeker.png'),
      back_file: file(SEEKER, 'seeker.png'),
    },
    {
      file_id: READER,
      back_file_id: null,
      quantity: 1,
      position: 1,
      file: file(READER, 'reader.png'),
      back_file: null,
    },
  ] as unknown as ProjectComponent['tokens']);

function stubApi(): void {
  fetchMock.mockImplementation(async (input) => {
    const request = typeof input === 'string' ? null : (input as Request);
    const url = request?.url ?? (input as string);
    if (url.includes('/api/layouts')) return jsonResponse(200, { layouts: [] });
    if (url.includes('/api/card-content')) return jsonResponse(200, { cards: [] });
    if (url.includes(`/api/components/${BOARD}/tokens`)) return jsonResponse(200, held());
    if (url.includes('/download')) return new Response(new Blob(['png']), { status: 200 });
    return jsonResponse(404, { error: `nothing stubbed for ${url}` });
  });
}

async function tokensSent(): Promise<unknown> {
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([input]) => {
        const request = input as Request;
        return request.method === 'PUT' && request.url.includes('/tokens');
      })
    ).toBe(true)
  );
  const call = fetchMock.mock.calls.find(([input]) => (input as Request).method === 'PUT');
  return (await (call![0] as Request).clone().json()).tokens;
}

function show(
  component: ProjectComponent,
  settings: PunchboardModelSettings = DEFAULT_PUNCHBOARD_SETTINGS
) {
  return render(TokenList, { props: { projectId: PROJECT, component, settings, canEdit: true } });
}

describe('a punchboard’s tokens', () => {
  beforeEach(() => {
    projectComponents.reset();
    fetchMock.mockReset();
    stubApi();
    const statics = URL as unknown as Record<string, unknown>;
    statics.createObjectURL = vi.fn(() => 'blob:http://localhost/thumb');
    statics.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    const statics = URL as unknown as Record<string, unknown>;
    delete statics.createObjectURL;
    delete statics.revokeObjectURL;
  });

  it('says how many tokens there are, how many are cut, and what is behind each', () => {
    show(held());
    expect(screen.getByText(/2 tokens · 4 to cut · the sheet holds/)).toBeTruthy();
    // In place of a back's thumbnail, beside the front's.
    expect(screen.getByText('Same both sides', { selector: 'span' })).toBeTruthy();
    expect(screen.getByText('Unprinted', { selector: 'span' })).toBeTruthy();
  });

  it('saves a new count as the whole list, every back kept', async () => {
    show(held());
    const [seekerCopies] = screen.getAllByRole('spinbutton');
    await fireEvent.change(seekerCopies!, { target: { value: '5' } });
    expect(await tokensSent()).toEqual([
      { file_id: SEEKER, back_file_id: SEEKER, quantity: 5 },
      { file_id: READER, back_file_id: null, quantity: 1 },
    ]);
  });

  it('prints a front on both sides when that is chosen as its back', async () => {
    show(held());
    const [, readerBack] = screen.getAllByRole('combobox');
    await fireEvent.change(readerBack!, { target: { value: 'same' } });
    expect(await tokensSent()).toEqual([
      { file_id: SEEKER, back_file_id: SEEKER, quantity: 3 },
      { file_id: READER, back_file_id: READER, quantity: 1 },
    ]);
  });

  it('warns when more copies are asked for than the sheet holds', () => {
    // A sheet with room for a single token inside its margin.
    show(held(), { ...DEFAULT_PUNCHBOARD_SETTINGS, width_mm: 50, height_mm: 50, margin_mm: 10 });
    expect(screen.getByRole('status').textContent?.replace(/\s+/g, ' ')).toMatch(
      /3 copies do not fit on this sheet/
    );
  });
});
