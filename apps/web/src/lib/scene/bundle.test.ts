import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CARD_SETTINGS,
  DEFAULT_SURFACE_CHOICE,
  SCENE_FILE_NAME,
  SCENE_TARGET,
  instancesForTarget,
  validateScene,
} from '@three-peaks/shared';
import { readZip } from './testZip.ts';
import { buildSceneBundle, SceneExportError, type SceneBundleRequest } from './bundle.ts';
import type { SceneSelection } from './assets.ts';

const image = (id: string) => ({ file_id: id, content_type: 'image/png' });

const GENERATED_AT = '2026-08-27T12:00:00.000Z';

const selection: SceneSelection = {
  files: [
    {
      label: 'Board',
      front: image('board'),
      back: null,
      tokens: null,
      part: null,
      settings: { ...DEFAULT_CARD_SETTINGS, width_mm: 200, height_mm: 200 },
      copies: 1,
    },
  ],
  decks: [
    {
      deck_id: 'deck-1',
      name: 'Villagers',
      card_width_mm: 63,
      card_height_mm: 88,
      back: image('back'),
      cards: [
        { label: 'Farmer', front: image('farmer'), copies: 4, settings: null },
        { label: 'Miller', front: image('miller'), copies: 1, settings: null },
      ],
    },
  ],
  library: [{ piece: 'meeple', count: 2 }],
};

function request(patch: Partial<SceneBundleRequest> = {}): SceneBundleRequest {
  return {
    project_name: 'Harvest',
    generated_at: GENERATED_AT,
    selection,
    renderAsset: async (build) => new TextEncoder().encode(`glb:${build.asset_id}`),
    ...patch,
  };
}

async function entriesOf(zip: Blob): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await readZip(zip)) {
    out.set(entry.name, new TextDecoder().decode(await entry.bytes()));
  }
  return out;
}

describe('buildSceneBundle', () => {
  it('writes scene.json and one file per asset, and nothing the document does not name', async () => {
    const { zip, document } = await buildSceneBundle(request());

    const entries = await entriesOf(zip);
    const paths = document.assets
      .filter((asset) => asset.kind === 'glb')
      .map((asset) => asset.path);

    expect(entries.size).toBe(paths.length + 1);
    expect([...entries.keys()].sort()).toEqual([SCENE_FILE_NAME, ...paths].sort());
  });

  it('puts the document it hands back inside the archive it hands back', async () => {
    const { zip, document } = await buildSceneBundle(request());

    const entries = await entriesOf(zip);

    expect(JSON.parse(entries.get(SCENE_FILE_NAME)!)).toEqual(document);
    expect(validateScene(document)).toEqual([]);
  });

  it('builds one file for four copies of one card', async () => {
    const renderAsset = vi.fn(async () => new Uint8Array([1, 2, 3]));

    const { document } = await buildSceneBundle(request({ renderAsset }));

    // Four Farmers, one Miller, one board, two meeples: eight instances off
    // three built files, and the meeples cost the bundle nothing at all.
    expect(document.instances).toHaveLength(8);
    expect(renderAsset).toHaveBeenCalledTimes(3);
  });

  it('carries the timestamp it was given rather than reading a clock', async () => {
    const { document } = await buildSceneBundle(request());

    expect(document.generated_at).toBe(GENERATED_AT);
  });

  it('writes the same archive twice for one selection', async () => {
    const first = await buildSceneBundle(request());
    const second = await buildSceneBundle(request());

    expect(new Uint8Array(await second.zip.arrayBuffer())).toEqual(
      new Uint8Array(await first.zip.arrayBuffer())
    );
  });

  it('counts its way through the files it is building', async () => {
    const onProgress = vi.fn();

    await buildSceneBundle(request({ onProgress }));

    expect(onProgress).toHaveBeenCalledWith({ built: 0, total: 3, label: 'Farmer' });
    expect(onProgress).toHaveBeenLastCalledWith({ built: 3, total: 3, label: '' });
  });

  it('takes the shot template it is asked for', async () => {
    const { document } = await buildSceneBundle(request({ template: 'orbit' }));

    expect(document.shots.map((shot) => shot.kind)).toEqual(['orbit']);
  });

  it('refuses a template nobody offers', async () => {
    await expect(buildSceneBundle(request({ template: 'zoom' }))).rejects.toBeInstanceOf(
      SceneExportError
    );
  });

  it('refuses a selection with nothing in it', async () => {
    await expect(
      buildSceneBundle(request({ selection: { files: [], decks: [], library: [] } }))
    ).rejects.toThrow(/Nothing is selected/);
  });

  it('stands the scene on a table nobody had to ask for', async () => {
    const { document } = await buildSceneBundle(request());

    expect(document.surface?.finish).toBe(DEFAULT_SURFACE_CHOICE.finish);
    expect(document.surface?.sweep_height_mm).toBeGreaterThan(0);
  });

  it('leaves the table out of the assets and the instances', async () => {
    const { document } = await buildSceneBundle(request());

    // Scenery, not a piece: a shot aimed at the whole scene reaches every
    // instance, and a turntable that turned the table would take the cards with
    // it.
    expect(document.assets.every((asset) => asset.label !== 'Table')).toBe(true);
    expect(instancesForTarget(document.instances, SCENE_TARGET)).toHaveLength(
      document.instances.length
    );
    expect(document.instances).toHaveLength(8);
  });

  it('exports onto nothing when the table is refused outright', async () => {
    const { document } = await buildSceneBundle(request({ surface: null }));

    expect(document.surface).toBeNull();
  });

  it('flattens the backdrop for a shot that circles the table', async () => {
    // The camera goes round behind a sweep, so an orbit gets a plain table:
    // passing through the backdrop is worse than not having one.
    const orbit = await buildSceneBundle(request({ template: 'orbit' }));
    const still = await buildSceneBundle(request({ template: 'turntable' }));

    expect(orbit.document.surface?.sweep_height_mm).toBe(0);
    expect(still.document.surface?.sweep_height_mm).toBeGreaterThan(0);
  });

  it('cuts the table to what the shots reach, not only to where the pieces stand', async () => {
    // A parade files every instance past the camera along a line several times
    // wider than the table they were standing on.
    const parade = await buildSceneBundle(request({ template: 'parade' }));
    const still = await buildSceneBundle(request({ template: 'turntable' }));

    expect(parade.document.surface!.width_mm).toBeGreaterThan(still.document.surface!.width_mm);
  });

  it('takes the backdrop from the export rather than from the template', async () => {
    const { document } = await buildSceneBundle(
      request({
        template: 'hero-reveal',
        backdrop: { background: 'solid', background_color: '#223344' },
      })
    );

    // The template still picks its own light rig; only what is behind the
    // scene came from the person exporting it.
    expect(document.lighting.background).toBe('solid');
    expect(document.lighting.background_color).toBe('#223344');
    expect(document.lighting.preset).toBe('dramatic');
  });

  it('refuses a document the importer would refuse, before it builds a single file', async () => {
    const renderAsset = vi.fn(async () => new Uint8Array());

    const failed = await buildSceneBundle(
      request({ project_name: 'x'.repeat(500), renderAsset })
    ).catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(SceneExportError);
    expect((failed as SceneExportError).issues[0].path).toBe('project_name');
    expect(renderAsset).not.toHaveBeenCalled();
  });
});
