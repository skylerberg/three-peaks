import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BOARD_SETTINGS,
  DEFAULT_BOX_SETTINGS,
  DEFAULT_CARD_SETTINGS,
  DEFAULT_PUNCHBOARD_SETTINGS,
  DEFAULT_WOOD_SETTINGS,
  type GlbAsset,
  type ModelSettings,
  type SceneAsset,
} from '@three-peaks/shared';
import {
  assetKey,
  componentFootprint,
  deckCardSettings,
  planScene,
  type SceneComponentSelection,
  type SceneDeckSelection,
  type SceneSelection,
} from './assets.ts';

const image = (id: string) => ({ file_id: id, content_type: 'image/png' });

// assetKey reads a whole selection; these tests are about the parts of one that
// decide whether two picks are the same file.
const key = (
  settings: ModelSettings,
  front: ReturnType<typeof image> | null,
  back: ReturnType<typeof image> | null,
  extra: Partial<Omit<SceneComponentSelection, 'copies'>> = {}
) => assetKey({ label: 'x', settings, front, back, tokens: null, part: null, ...extra });

const card = (patch: Partial<typeof DEFAULT_CARD_SETTINGS> = {}): ModelSettings => ({
  ...DEFAULT_CARD_SETTINGS,
  ...patch,
});

function deck(name: string, cards: { id: string; copies?: number }[]): SceneDeckSelection {
  return {
    deck_id: `deck-${name}`,
    name,
    card_width_mm: 63,
    card_height_mm: 88,
    back: image('back'),
    cards: cards.map((entry) => ({
      label: entry.id,
      front: image(entry.id),
      copies: entry.copies ?? 1,
      settings: null,
    })),
  };
}

const empty: SceneSelection = { files: [], decks: [], library: [] };

const glbAssets = (assets: SceneAsset[]): GlbAsset[] =>
  assets.filter((asset): asset is GlbAsset => asset.kind === 'glb');

describe('assetKey', () => {
  it('reads two selections of one component as one file', () => {
    expect(key(card(), image('a'), image('back'))).toBe(
      key({ ...DEFAULT_CARD_SETTINGS }, image('a'), image('back'))
    );
  });

  it('does not care what order the settings were written in', () => {
    const reversed = Object.fromEntries(
      Object.entries(DEFAULT_CARD_SETTINGS).reverse()
    ) as ModelSettings;

    expect(key(reversed, image('a'), null)).toBe(key(card(), image('a'), null));
  });

  it('separates two cards cut to one size but printed with different artwork', () => {
    expect(key(card(), image('a'), null)).not.toBe(key(card(), image('b'), null));
  });

  it('separates one image dialled in two ways', () => {
    expect(key(card(), image('a'), null)).not.toBe(
      key(card({ thickness_mm: 2 }), image('a'), null)
    );
  });

  it('separates two cards that differ only in what is on the back', () => {
    expect(key(card(), image('a'), image('one'))).not.toBe(key(card(), image('a'), image('two')));
  });

  // A punchboard is several files out of one component: a sheet built from
  // every token it cuts, and each token on its own.
  it('separates a punchboard’s sheet from one of its tokens', () => {
    const settings = { ...DEFAULT_PUNCHBOARD_SETTINGS } as ModelSettings;
    const tokens = [{ front: image('a'), back: null, quantity: 1 }];
    expect(key(settings, null, null, { tokens, part: 'sheet' })).not.toBe(
      key(settings, image('a'), null, { part: 'token' })
    );
  });

  it('separates two sheets cutting different tokens, or different copies of one', () => {
    const settings = { ...DEFAULT_PUNCHBOARD_SETTINGS } as ModelSettings;
    const sheet = (front: string, quantity: number) =>
      key(settings, null, null, {
        tokens: [{ front: image(front), back: image('back'), quantity }],
        part: 'sheet',
      });
    expect(sheet('a', 1)).not.toBe(sheet('b', 1));
    expect(sheet('a', 1)).not.toBe(sheet('a', 2));
    expect(sheet('a', 2)).toBe(sheet('a', 2));
  });

  it('makes every copy of one token one file', () => {
    const settings = { ...DEFAULT_PUNCHBOARD_SETTINGS } as ModelSettings;
    expect(key(settings, image('a'), image('b'), { part: 'token' })).toBe(
      key(settings, image('a'), image('b'), { part: 'token' })
    );
    expect(key(settings, image('a'), image('b'), { part: 'token' })).not.toBe(
      key(settings, image('a'), null, { part: 'token' })
    );
  });
});

describe('componentFootprint', () => {
  it('reads each kind in the axes the document is written in', () => {
    expect(componentFootprint(card())).toEqual({
      width_mm: 63,
      depth_mm: 88,
      height_mm: DEFAULT_CARD_SETTINGS.thickness_mm,
    });
    expect(componentFootprint(DEFAULT_WOOD_SETTINGS)).toEqual({
      width_mm: 30,
      depth_mm: 30,
      height_mm: 8,
    });
    // A box stands on its base, so its depth is the table it takes and its
    // height is how far it reaches up.
    expect(componentFootprint(DEFAULT_BOX_SETTINGS)).toEqual({
      width_mm: 295,
      depth_mm: 70,
      height_mm: 295,
    });
    expect(componentFootprint(DEFAULT_BOARD_SETTINGS)).toEqual({
      width_mm: 500,
      depth_mm: 500,
      height_mm: 2,
    });
    // The sheet, and a token the size the sheet cuts it.
    expect(componentFootprint(DEFAULT_PUNCHBOARD_SETTINGS)).toEqual({
      width_mm: 280,
      depth_mm: 210,
      height_mm: 2,
    });
    expect(componentFootprint(DEFAULT_PUNCHBOARD_SETTINGS, 'token')).toEqual({
      width_mm: 25,
      depth_mm: 25,
      height_mm: 2,
    });
  });
});

describe('deckCardSettings', () => {
  it('sizes an undialled card to the deck it is in', () => {
    const settings = deckCardSettings(deck('villagers', []), null);

    expect(settings).toMatchObject({ kind: 'card', width_mm: 63, height_mm: 88 });
  });

  it('leaves a card somebody has already dialled in exactly as it is', () => {
    const dialled = card({ width_mm: 41, height_mm: 63, thickness_mm: 0.5 });

    expect(deckCardSettings(deck('minis', []), dialled)).toBe(dialled);
  });
});

describe('planScene', () => {
  it('collapses a deck onto one asset per distinct card and one instance per copy', () => {
    const plan = planScene({
      ...empty,
      decks: [deck('villagers', [{ id: 'a', copies: 3 }, { id: 'b' }, { id: 'a' }])],
    });

    expect(plan.assets).toHaveLength(2);
    expect(plan.builds).toHaveLength(2);
    expect(plan.instances).toHaveLength(5);
    expect(new Set(plan.instances.map((instance) => instance.asset_id)).size).toBe(2);
  });

  it('leaves a card the deck holds no copies of off the table entirely', () => {
    const plan = planScene({
      ...empty,
      decks: [deck('villagers', [{ id: 'a', copies: 0 }, { id: 'b' }])],
    });

    // Not one instance fewer with the file still in the archive: a .glb nothing
    // stands on the table is geometry built and bytes shipped for no piece.
    expect(plan.instances).toHaveLength(1);
    expect(plan.assets).toHaveLength(1);
    expect(plan.builds.map((build) => build.front?.file_id)).toEqual(['b']);
  });

  it('gives a deck holding no copies of anything no group to aim a shot at', () => {
    const plan = planScene({
      ...empty,
      decks: [deck('villagers', [{ id: 'a', copies: 0 }]), deck('nobles', [{ id: 'b' }])],
    });

    expect(plan.groups.map((group) => group.name)).toEqual(['deck:nobles']);
  });

  it('gives every instance in a deck one group to be targeted by', () => {
    const plan = planScene({ ...empty, decks: [deck('Villagers of the Vale', [{ id: 'a' }])] });

    expect(plan.groups.map((group) => group.name)).toEqual(['deck:villagers-of-the-vale']);
    expect(plan.groups[0].kind).toBe('deck');
    expect(plan.instances[0].group).toBe('deck:villagers-of-the-vale');
  });

  it('keeps two decks of one name apart', () => {
    const plan = planScene({
      ...empty,
      decks: [deck('Cards', [{ id: 'a' }]), deck('cards!', [{ id: 'b' }])],
    });

    expect(plan.groups.map((group) => group.name)).toEqual(['deck:cards', 'deck:cards-2']);
  });

  it('stacks a deck with its first card on top, resting on the table', () => {
    const plan = planScene({ ...empty, decks: [deck('villagers', [{ id: 'a' }, { id: 'b' }])] });

    const heights = plan.instances.map((instance) => instance.position_mm[2]);
    expect(heights[0]).toBeGreaterThan(heights[1]);
    expect(heights[1]).toBeCloseTo(DEFAULT_CARD_SETTINGS.thickness_mm / 2, 6);
  });

  it('names one path per asset, under the bundle assets directory', () => {
    const plan = planScene({ ...empty, decks: [deck('villagers', [{ id: 'a' }, { id: 'b' }])] });

    expect(glbAssets(plan.assets).map((asset) => asset.path)).toEqual([
      'assets/card-1.glb',
      'assets/card-2.glb',
    ]);
    expect(plan.builds.map((build) => build.path)).toEqual([
      'assets/card-1.glb',
      'assets/card-2.glb',
    ]);
  });

  it('shares one file between two decks that put the same card on the same back', () => {
    const plan = planScene({
      ...empty,
      decks: [deck('one', [{ id: 'a' }]), deck('two', [{ id: 'a' }])],
    });

    expect(plan.builds).toHaveLength(1);
    expect(plan.instances.map((instance) => instance.group)).toEqual(['deck:one', 'deck:two']);
  });

  it('costs the bundle nothing for a library piece', () => {
    const plan = planScene({ ...empty, library: [{ piece: 'd6', count: 4 }] });

    expect(plan.builds).toEqual([]);
    expect(plan.assets).toEqual([
      { kind: 'library', id: 'd6-1', piece: 'd6', color: '#c0392b', size_mm: 16, label: 'D6 die' },
    ]);
    expect(plan.instances).toHaveLength(4);
    expect(plan.instances[0].group).toBe('pieces:d6');
  });

  it('rests a library piece on the table and leaves it in the axes it is built in', () => {
    const plan = planScene({ ...empty, library: [{ piece: 'cube', count: 1, size_mm: 10 }] });

    // Zero, not half the size: the importer builds the piece standing on its
    // own origin, so lifting it here would float it by half its height.
    expect(plan.instances[0].position_mm[2]).toBe(0);
    expect(plan.instances[0].rotation_deg).toEqual([0, 0, 0]);
  });

  it('lays an imported component flat, because the glTF conversion stands it up', () => {
    const plan = planScene({ ...empty, decks: [deck('villagers', [{ id: 'a' }])] });

    expect(plan.instances[0].rotation_deg).toEqual([-90, 0, 0]);
  });

  it('leaves a box standing, and takes its own height for how tall it is', () => {
    const plan = planScene({
      ...empty,
      files: [
        {
          label: 'Box',
          front: image('wrap'),
          back: null,
          tokens: null,
          part: null,
          settings: { ...DEFAULT_BOX_SETTINGS, width_mm: 120, height_mm: 90, depth_mm: 60 },
          copies: 1,
        },
      ],
    });

    // Its net is a printer's cross, and that folds round a box on its base: on
    // its back, the lid is up and four panels read sideways or upside down.
    expect(plan.instances[0].rotation_deg).toEqual([0, 0, 0]);
    expect(plan.instances[0].position_mm[2]).toBe(45);
    expect(plan.extent.height_mm).toBe(90);
  });

  it('groups loose files together and repeats one that was asked for twice', () => {
    const plan = planScene({
      ...empty,
      files: [
        {
          label: 'Board',
          front: image('board'),
          back: null,
          tokens: null,
          part: null,
          settings: DEFAULT_BOARD_SETTINGS,
          copies: 1,
        },
        {
          label: 'Token',
          front: image('token'),
          back: null,
          tokens: null,
          part: null,
          settings: DEFAULT_WOOD_SETTINGS,
          copies: 3,
        },
      ],
    });

    expect(plan.groups.map((group) => group.name)).toEqual(['files']);
    expect(plan.builds).toHaveLength(2);
    expect(plan.instances).toHaveLength(4);
    expect(plan.instances.map((instance) => instance.label)).toEqual([
      'Board',
      'Token (1)',
      'Token (2)',
      'Token (3)',
    ]);
  });

  it('answers the same plan for the same selection, twice over', () => {
    const selection: SceneSelection = {
      files: [
        {
          label: 'Board',
          front: image('board'),
          back: null,
          tokens: null,
          part: null,
          settings: DEFAULT_BOARD_SETTINGS,
          copies: 1,
        },
      ],
      decks: [deck('villagers', [{ id: 'a', copies: 2 }])],
      library: [{ piece: 'meeple', count: 2 }],
    };

    expect(planScene(selection)).toEqual(planScene(selection));
  });

  it('has nothing to place for an empty selection', () => {
    expect(planScene(empty)).toMatchObject({ assets: [], instances: [], builds: [], groups: [] });
  });
});
