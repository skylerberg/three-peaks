// Turning a selection into the assets and instances scene.json carries, and
// into the list of .glb files the bundle has to contain.
//
// Pure: no three, no fetch, no clock. Every id it hands out is derived from the
// selection's own order, so exporting one selection twice produces one document
// twice over.

import {
  DEFAULT_CARD_SETTINGS,
  DEFAULT_LIBRARY_COLOR,
  DEFAULT_LIBRARY_SIZE_MM,
  LIBRARY_PIECE_LABELS,
  SCENE_TEXT_LIMITS,
  sceneAssetPath,
  type GlbAsset,
  type LibraryAsset,
  type LibraryPiece,
  type ModelSettings,
  type SceneAsset,
  type SceneInstance,
  type Vec3,
} from '@three-peaks/shared';
import {
  blockOrigins,
  blocksExtent,
  clampPosition,
  gridFootprint,
  gridOffsets,
  restRotationDeg,
  stackOffsets,
  type Footprint,
  type Volume,
} from './layout.ts';

export interface SceneImageRef {
  file_id: string;
  content_type: string;
}

// One of a punchboard's tokens, as its sheet is built from them.
interface SceneTokenRef {
  front: SceneImageRef;
  back: SceneImageRef | null;
  quantity: number;
}

export interface SceneComponentSelection {
  label: string;
  // The image it is built from: a component's artwork, or a token's front.
  // Null for a punchboard's sheet, which is built from its tokens.
  front: SceneImageRef | null;
  back: SceneImageRef | null;
  // Every token a punchboard's sheet cuts; null for anything else.
  tokens: readonly SceneTokenRef[] | null;
  settings: ModelSettings;
  copies: number;
  // One piece of a component that has several -- a punchboard's sheet, or one
  // of its tokens. Null is the whole thing, which every other kind is.
  part: string | null;
}

export interface SceneDeckCardSelection {
  label: string;
  front: SceneImageRef;
  copies: number;
  // What the studio already holds for this image, or null for a card nobody
  // has dialled in -- which takes the card defaults at the deck's own size.
  settings: ModelSettings | null;
}

export interface SceneDeckSelection {
  deck_id: string;
  name: string;
  card_width_mm: number;
  card_height_mm: number;
  back: SceneImageRef | null;
  cards: readonly SceneDeckCardSelection[];
}

export interface SceneLibrarySelection {
  piece: LibraryPiece;
  count: number;
  color?: string;
  size_mm?: number;
}

export interface SceneSelection {
  files: readonly SceneComponentSelection[];
  decks: readonly SceneDeckSelection[];
  library: readonly SceneLibrarySelection[];
}

// One .glb to build, and the artwork to build it from.
export interface AssetBuild {
  asset_id: string;
  path: string;
  label: string;
  settings: ModelSettings;
  front: SceneImageRef | null;
  back: SceneImageRef | null;
  tokens: readonly SceneTokenRef[] | null;
  part: string | null;
}

// A shot aims at a group, so a template that wants to deal one onto its own
// patch of table rather than onto the middle of the world needs to know where
// that patch is and how big it is. The kind is what lets a card gesture find
// the decks: fanning a board is a pile, not a fan.
type SceneGroupKind = 'deck' | 'files' | 'library';

export interface SceneGroup {
  name: string;
  kind: SceneGroupKind;
  origin_mm: Vec3;
  footprint: Footprint;
  count: number;
}

export interface ScenePlan {
  assets: SceneAsset[];
  instances: SceneInstance[];
  groups: SceneGroup[];
  builds: AssetBuild[];
  // What the whole arrangement spans on the table, for the camera to be pulled
  // back far enough to hold it.
  extent: Volume;
}

// Room between two pieces standing side by side, and between two blocks.
const PIECE_GAP_MM = 10;

const FILES_GROUP = 'files';

function truncate(value: string, [, max]: readonly [number, number]): string {
  return value.length <= max ? value : value.slice(0, max);
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'deck'
  );
}

// Key order is whatever the object literal happened to use, and a settings row
// read back from the API is free to differ from one the studio just built.
function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : 1
    );
    return `{${entries.map(([key, item]) => `${key}:${stableKey(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * What the exported .glb is a function of, and so what decides whether two
 * selections name one file rather than two.
 *
 * The geometry-determining half of the settings is only half of it. An instance
 * names one path, so two cards cut to one size but printed with different
 * artwork cannot be handed the same file however identical their meshes are.
 * What this does collapse is every repeat of one component -- a copy count, one
 * image used twice in a deck, the same token in two selections -- which is
 * where a deck's bytes actually go.
 */
export function assetKey(component: PlannedAsset): string {
  return stableKey([
    component.settings,
    component.front?.file_id ?? null,
    component.back?.file_id ?? null,
    component.tokens?.map((token) => [
      token.front.file_id,
      token.back?.file_id ?? null,
      token.quantity,
    ]) ?? null,
    component.part,
  ]);
}

/**
 * How much table a component takes and how tall it stands, in the document's
 * axes rather than three's: laid flat, a piece's build width and height are its
 * footprint and its extrusion is its height. A punchboard's token is the size
 * its sheet cuts it.
 */
export function componentFootprint(
  settings: ModelSettings,
  part: string | null = null
): Footprint & { height_mm: number } {
  if (settings.kind === 'punchboard' && part === 'token') {
    return {
      width_mm: settings.token_width_mm,
      depth_mm: settings.token_height_mm,
      height_mm: settings.thickness_mm,
    };
  }
  switch (settings.kind) {
    case 'card':
      return {
        width_mm: settings.width_mm,
        depth_mm: settings.height_mm,
        height_mm: settings.thickness_mm,
      };
    case 'wood':
      return {
        width_mm: settings.longest_side_mm,
        depth_mm: settings.longest_side_mm,
        height_mm: settings.thickness_mm,
      };
    case 'box':
      // It stands, so its own height is how tall it is and its depth is how
      // much table it takes.
      return {
        width_mm: settings.width_mm,
        depth_mm: settings.depth_mm,
        height_mm: settings.height_mm,
      };
    case 'board':
      return {
        width_mm: settings.width_mm,
        depth_mm: settings.height_mm,
        height_mm: settings.thickness_mm,
      };
    case 'punchboard':
      return {
        width_mm: settings.width_mm,
        depth_mm: settings.height_mm,
        height_mm: settings.thickness_mm,
      };
  }
}

// A card nobody has opened in the studio still has a size: the deck's. One that
// somebody has dialled in keeps what they dialled, because those settings are
// the component's own and the thickness and corner radius are part of them.
export function deckCardSettings(
  deck: SceneDeckSelection,
  settings: ModelSettings | null
): ModelSettings {
  if (settings) return settings;
  return {
    ...DEFAULT_CARD_SETTINGS,
    width_mm: deck.card_width_mm,
    height_mm: deck.card_height_mm,
  };
}

interface PlannedInstance {
  asset_id: string;
  label: string;
  offset: Vec3;
}

interface PlannedBlock {
  group: string;
  kind: SceneGroupKind;
  footprint: Footprint;
  // How far the tallest thing in the block stands off the table.
  height_mm: number;
  instances: PlannedInstance[];
}

// What one .glb is built from. A copy count is not part of it: the copies are
// instances of the file, which is the whole reason the registry deduplicates.
type PlannedAsset = Omit<SceneComponentSelection, 'copies'>;

class AssetRegistry {
  readonly assets: SceneAsset[] = [];
  readonly builds: AssetBuild[] = [];
  #ids = new Map<string, string>();
  #counts = new Map<string, number>();

  #nextId(prefix: string): string {
    const next = (this.#counts.get(prefix) ?? 0) + 1;
    this.#counts.set(prefix, next);
    return `${prefix}-${next}`;
  }

  glb(component: PlannedAsset): string {
    const key = assetKey(component);
    const existing = this.#ids.get(key);
    if (existing) return existing;

    const id = this.#nextId(component.settings.kind);
    const asset: GlbAsset = {
      kind: 'glb',
      id,
      path: sceneAssetPath(`${id}.glb`),
      component: component.settings.kind,
      label: truncate(component.label, SCENE_TEXT_LIMITS.label),
    };
    this.#ids.set(key, id);
    this.assets.push(asset);
    this.builds.push({
      asset_id: id,
      path: asset.path,
      label: asset.label,
      settings: component.settings,
      front: component.front,
      back: component.back,
      tokens: component.tokens,
      part: component.part,
    });
    return id;
  }

  library(piece: LibraryPiece, color: string, size_mm: number): string {
    const key = stableKey(['library', piece, color, size_mm]);
    const existing = this.#ids.get(key);
    if (existing) return existing;

    const id = this.#nextId(piece);
    const asset: LibraryAsset = {
      kind: 'library',
      id,
      piece,
      color,
      size_mm,
      label: LIBRARY_PIECE_LABELS[piece],
    };
    this.#ids.set(key, id);
    this.assets.push(asset);
    return id;
  }
}

function uniqueGroup(name: string, taken: Set<string>): string {
  const base = truncate(name, SCENE_TEXT_LIMITS.group);
  let candidate = base;
  let suffix = 1;
  while (taken.has(candidate)) {
    suffix += 1;
    candidate = `${truncate(base, [1, SCENE_TEXT_LIMITS.group[1] - 4])}-${suffix}`;
  }
  taken.add(candidate);
  return candidate;
}

function copies(count: number): number {
  return Math.max(0, Math.floor(count));
}

function labelledCopies(label: string, count: number): string[] {
  if (count === 1) return [label];
  return Array.from({ length: count }, (_, index) => `${label} (${index + 1})`);
}

function deckBlock(
  deck: SceneDeckSelection,
  registry: AssetRegistry,
  taken: Set<string>
): PlannedBlock {
  const group = uniqueGroup(`deck:${slug(deck.name)}`, taken);
  const flattened: { asset_id: string; label: string; height_mm: number }[] = [];
  let footprint: Footprint = { width_mm: 0, depth_mm: 0 };

  for (const card of deck.cards) {
    const settings = deckCardSettings(deck, card.settings);
    const size = componentFootprint(settings);
    footprint = {
      width_mm: Math.max(footprint.width_mm, size.width_mm),
      depth_mm: Math.max(footprint.depth_mm, size.depth_mm),
    };
    const assetId = registry.glb({
      label: card.label,
      front: card.front,
      back: deck.back,
      tokens: null,
      part: null,
      settings,
    });
    for (const label of labelledCopies(card.label, copies(card.copies))) {
      flattened.push({ asset_id: assetId, label, height_mm: size.height_mm });
    }
  }

  // One thickness for the whole stack: cards of two thicknesses in one deck is
  // not a case worth interleaving, and the tallest keeps them from intersecting.
  const step = flattened.reduce((tallest, card) => Math.max(tallest, card.height_mm), 0);
  const offsets = stackOffsets(flattened.length, step);

  return {
    group,
    kind: 'deck',
    footprint,
    height_mm: flattened.length * step,
    instances: flattened.map((card, index) => ({
      asset_id: card.asset_id,
      label: card.label,
      offset: offsets[index],
    })),
  };
}

function filesBlock(
  files: readonly SceneComponentSelection[],
  registry: AssetRegistry,
  taken: Set<string>
): PlannedBlock {
  const group = uniqueGroup(FILES_GROUP, taken);
  const placed: { asset_id: string; label: string; height_mm: number }[] = [];
  let spacing: Footprint = { width_mm: 0, depth_mm: 0 };

  for (const file of files) {
    const size = componentFootprint(file.settings, file.part);
    spacing = {
      width_mm: Math.max(spacing.width_mm, size.width_mm + PIECE_GAP_MM),
      depth_mm: Math.max(spacing.depth_mm, size.depth_mm + PIECE_GAP_MM),
    };
    const assetId = registry.glb(file);
    for (const label of labelledCopies(file.label, copies(file.copies))) {
      placed.push({ asset_id: assetId, label, height_mm: size.height_mm });
    }
  }

  const offsets = gridOffsets(placed.length, spacing);

  return {
    group,
    kind: 'files',
    footprint: gridFootprint(placed.length, spacing),
    height_mm: placed.reduce((tallest, entry) => Math.max(tallest, entry.height_mm), 0),
    instances: placed.map((entry, index) => ({
      asset_id: entry.asset_id,
      label: entry.label,
      // A component's origin is the middle of the slab, so resting it on the
      // table is half its own thickness up.
      offset: [offsets[index][0], offsets[index][1], entry.height_mm / 2] as Vec3,
    })),
  };
}

function libraryBlock(
  selection: SceneLibrarySelection,
  registry: AssetRegistry,
  taken: Set<string>
): PlannedBlock {
  const size_mm = selection.size_mm ?? DEFAULT_LIBRARY_SIZE_MM[selection.piece];
  const color = selection.color ?? DEFAULT_LIBRARY_COLOR;
  const assetId = registry.library(selection.piece, color, size_mm);
  const group = uniqueGroup(`pieces:${selection.piece}`, taken);
  const count = Math.max(0, Math.floor(selection.count));
  const spacing = { width_mm: size_mm + PIECE_GAP_MM, depth_mm: size_mm + PIECE_GAP_MM };
  // No lift: the importer builds a library piece standing on its own origin, so
  // the table is where that origin goes. Half a size would be wrong for a disc
  // anyway -- its thickness is a fraction of the size, and only the end that
  // builds the geometry knows which fraction.
  const offsets = gridOffsets(count, spacing, 0);

  return {
    group,
    kind: 'library',
    footprint: gridFootprint(count, spacing),
    // A piece is built inside a cube of its own longest side, whatever fraction
    // of it the shape actually uses.
    height_mm: size_mm,
    instances: offsets.map((offset, index) => ({
      asset_id: assetId,
      label: `${LIBRARY_PIECE_LABELS[selection.piece]} ${index + 1}`,
      offset,
    })),
  };
}

/**
 * Every selected thing, deduplicated into assets and laid out as instances.
 *
 * A deck is one group and one instance per copy in deck order, so a fan can
 * target the whole thing by name; loose files and library pieces get a group
 * each for the same reason.
 */
export function planScene(selection: SceneSelection): ScenePlan {
  const registry = new AssetRegistry();
  const taken = new Set<string>();
  const blocks: PlannedBlock[] = [];

  // Nothing with no copies gets as far as a block. A group with no instances is
  // a shot target that resolves to nothing, and a card whose .glb is built for
  // an instance list it never appears in is geometry and bytes the bundle
  // carries for no piece on the table.
  for (const deck of selection.decks) {
    const cards = deck.cards.filter((card) => copies(card.copies) > 0);
    if (cards.length > 0) blocks.push(deckBlock({ ...deck, cards }, registry, taken));
  }
  const files = selection.files.filter((file) => copies(file.copies) > 0);
  if (files.length > 0) blocks.push(filesBlock(files, registry, taken));
  for (const pieces of selection.library) {
    if (pieces.count > 0) blocks.push(libraryBlock(pieces, registry, taken));
  }

  const volumes = blocks.map((block) => ({ ...block.footprint, height_mm: block.height_mm }));
  const origins = blockOrigins(volumes, PIECE_GAP_MM * 4);
  // A library piece has no component kind; a .glb's decides whether the quarter
  // turn that lays a slab on the table applies to it.
  const components = new Map(
    registry.assets.map((asset) => [asset.id, asset.kind === 'glb' ? asset.component : null])
  );
  const instances: SceneInstance[] = [];
  const perAsset = new Map<string, number>();

  blocks.forEach((block, index) => {
    const origin = origins[index];
    for (const planned of block.instances) {
      const next = (perAsset.get(planned.asset_id) ?? 0) + 1;
      perAsset.set(planned.asset_id, next);
      instances.push({
        id: `${planned.asset_id}-i${next}`,
        asset_id: planned.asset_id,
        label: truncate(planned.label, SCENE_TEXT_LIMITS.label),
        group: block.group,
        position_mm: clampPosition([
          origin[0] + planned.offset[0],
          origin[1] + planned.offset[1],
          planned.offset[2],
        ]),
        rotation_deg: restRotationDeg(components.get(planned.asset_id) ?? null),
      });
    }
  });

  return {
    assets: registry.assets,
    instances,
    groups: blocks.map((block, index) => ({
      name: block.group,
      kind: block.kind,
      origin_mm: origins[index],
      footprint: block.footprint,
      count: block.instances.length,
    })),
    builds: registry.builds,
    extent: blocksExtent(origins, volumes),
  };
}
