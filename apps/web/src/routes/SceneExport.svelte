<script lang="ts">
  import {
    DEFAULT_LIBRARY_COLOR,
    DEFAULT_LIBRARY_SIZE_MM,
    DEFAULT_SCENE_LIGHTING,
    DEFAULT_SCENE_RENDER,
    DEFAULT_SURFACE_CHOICE,
    SCENE_LIMITS,
    SCENE_TEXT_LIMITS,
    type LibraryPiece,
    type ModelSettings,
    type PunchboardModelSettings,
    type RenderEngine,
    type SceneBackground,
    type SurfaceChoice,
    isLiveCard,
  } from '@three-peaks/shared';
  import type { components } from '@three-peaks/shared/api';
  import ComponentChoices from '../components/scene/ComponentChoices.svelte';
  import LibraryPieces from '../components/scene/LibraryPieces.svelte';
  import RenderSettings from '../components/scene/RenderSettings.svelte';
  import ShotTemplate from '../components/scene/ShotTemplate.svelte';
  import StageSettings from '../components/scene/StageSettings.svelte';
  import Button from '../components/ui/Button.svelte';
  import Spinner from '../components/ui/Spinner.svelte';
  import { ApiError, api, assertOk } from '../api/client.ts';
  import type { ProjectComponent } from '../lib/components.svelte.ts';
  import { type Deck, type DeckCard, decks } from '../lib/decks.svelte.ts';
  import { saveBlob } from '../lib/download.ts';
  import { newId } from '../lib/ids.ts';
  import { link } from '../lib/router.svelte.ts';
  import type {
    Footprint,
    SceneBundleProgress,
    SceneComponentSelection,
    SceneImageRef,
    SceneSelection,
  } from '../lib/scene/index.ts';
  import { apiMessage } from '../lib/session.svelte.ts';
  import { toasts } from '../lib/toasts.svelte.ts';

  interface Props {
    projectId: string;
  }
  let { projectId }: Props = $props();

  type FileRow = components['schemas']['File'];

  interface PieceRow {
    key: string;
    piece: LibraryPiece;
    color: string;
    size_mm: number;
    count: number;
  }

  // One request per image, and a deck is hundreds of them. A single
  // Promise.all over a whole project opens every socket the browser has.
  const BATCH = 8;

  let project = $state<components['schemas']['Project'] | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let loaded = $state<{ deck: Deck; cards: DeckCard[] }[]>([]);
  let selectedDecks = $state<Record<string, boolean>>({});
  // The whole row rather than a tick: the picker's listing is long gone by the
  // time Export is pressed, and a component carries the files it is built from.
  let selectedComponents = $state<Record<string, ProjectComponent | undefined>>({});
  let pieces = $state<PieceRow[]>([]);
  let templates = $state<{ id: string; name: string; description: string }[]>([]);
  let templateId = $state('');
  let engine = $state<RenderEngine>(DEFAULT_SCENE_RENDER.engine);
  let fps = $state(DEFAULT_SCENE_RENDER.fps);
  let samples = $state(DEFAULT_SCENE_RENDER.samples);
  let surface = $state<SurfaceChoice | null>({ ...DEFAULT_SURFACE_CHOICE });
  let background = $state<SceneBackground>(DEFAULT_SCENE_LIGHTING.background);
  let backgroundColor = $state(DEFAULT_SCENE_LIGHTING.background_color);
  let exporting = $state(false);
  let progress = $state<SceneBundleProgress | null>(null);

  function clamp(text: string, [, max]: readonly [number, number]): string {
    return text.slice(0, max);
  }

  function label(filename: string): string {
    return clamp(filename.replace(/\.[^.]+$/, ''), SCENE_TEXT_LIMITS.label);
  }

  $effect(() => {
    const id = projectId;
    loading = true;
    error = null;

    void (async () => {
      try {
        const [row] = await Promise.all([
          api.GET('/api/projects/{id}', { params: { path: { id } } }),
          decks.loadList(id),
        ]);
        project = assertOk(row);
        loaded = await Promise.all(decks.decks.map((deck) => decks.readDeck(deck.id)));
      } catch (caught) {
        error =
          caught instanceof ApiError && caught.status === 404
            ? 'That project does not exist, or you do not have access to it.'
            : apiMessage(caught);
      } finally {
        loading = false;
      }
    })();
  });

  // The templates live behind the same dynamic import as the exporter, so the
  // dropdown is filled once that chunk arrives rather than named here twice.
  $effect(() => {
    void (async () => {
      try {
        const scene = await import('../lib/scene/index.ts');
        templates = scene.SCENE_TEMPLATES.map((template) => ({
          id: template.id,
          name: template.name,
          description: template.description,
        }));
        templateId = scene.DEFAULT_SCENE_TEMPLATE_ID;
      } catch {
        toasts.error('The shot templates could not be loaded.');
      }
    })();
  });

  // A card whose artwork is in the bin has no bytes to build from, so it leaves
  // here rather than failing halfway through an export. So does one the deck
  // holds no copies of: it puts nothing on the table, and the count beside the
  // deck's name is a count of what is about to be laid out on one.
  function usableCards(cards: readonly DeckCard[]): DeckCard[] {
    return cards.filter((card) => isLiveCard(card) && card.quantity > 0);
  }

  const chosenDecks = $derived(
    loaded
      .filter((entry) => selectedDecks[entry.deck.id])
      .map((entry) => ({ deck: entry.deck, cards: usableCards(entry.cards) }))
      .filter((entry) => entry.cards.length > 0)
  );

  const chosenComponents = $derived(
    Object.values(selectedComponents).filter((row): row is ProjectComponent => row !== undefined)
  );

  const pieceCount = $derived(pieces.reduce((total, row) => total + row.count, 0));
  const cardCount = $derived(
    chosenDecks.reduce(
      (total, entry) => total + entry.cards.reduce((sum, card) => sum + card.quantity, 0),
      0
    )
  );
  // A punchboard puts its sheet and every token on the table, and how many
  // tokens that is only the die line knows. One apiece here is the floor, and
  // the real count is checked against the bound when the plan is built.
  const instanceCount = $derived(cardCount + chosenComponents.length + pieceCount);
  const tooBig = $derived(instanceCount > SCENE_LIMITS.instances[1]);

  function toggleComponent(component: ProjectComponent, on: boolean): void {
    if (on) selectedComponents[component.id] = component;
    else delete selectedComponents[component.id];
  }

  function roleFile(component: ProjectComponent, role: 'artwork' | 'cut'): FileRow | null {
    return component.files.find((entry) => entry.role === role)?.file ?? null;
  }

  // A punchboard is a sheet and a token each, and the die line is what says how
  // many. Read here rather than in the planner: parsing an SVG needs three, and
  // the planner is deliberately the half of this that does not touch it.
  async function punchboardParts(
    component: ProjectComponent,
    cut: FileRow
  ): Promise<{ part: string; label: string; footprint: Footprint }[]> {
    const { MM, loadSource, punchboardLayout } = await import('../lib/model3d/index.ts');
    const source = await loadSource(cut.id, cut.content_type);
    if (source.svgText === null) throw new Error(`${cut.filename} is not an SVG cut sheet.`);

    const settings = component.settings as PunchboardModelSettings;
    const layout = punchboardLayout(settings, source.svgText);
    return layout.pieces.map((piece, index) => ({
      part: piece.name,
      label: index === 0 ? component.name : `${component.name} ${piece.name}`,
      footprint: { width_mm: piece.size.width / MM, depth_mm: piece.size.height / MM },
    }));
  }

  function addPiece(piece: LibraryPiece): void {
    pieces = [
      ...pieces,
      {
        key: newId(),
        piece,
        color: DEFAULT_LIBRARY_COLOR,
        size_mm: DEFAULT_LIBRARY_SIZE_MM[piece],
        count: 1,
      },
    ];
  }

  function changePiece(key: string, patch: Partial<Omit<PieceRow, 'key' | 'piece'>>): void {
    pieces = pieces.map((row) =>
      row.key === key ? { ...row, ...patch, color: (patch.color ?? row.color).toLowerCase() } : row
    );
  }

  async function inBatches<T, R>(items: readonly T[], run: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = [];
    for (let at = 0; at < items.length; at += BATCH) {
      out.push(...(await Promise.all(items.slice(at, at + BATCH).map(run))));
    }
    return out;
  }

  async function readSettings(fileId: string): Promise<ModelSettings | null> {
    try {
      const saved = assertOk(
        await api.GET('/api/models/{fileId}', { params: { path: { fileId } } })
      );
      return saved.settings as ModelSettings;
    } catch (caught) {
      // A 404 is an image nobody has opened in the studio. Null is what the
      // planner reads as "take the defaults", so it is an answer, not a failure.
      if (caught instanceof ApiError && caught.status === 404) return null;
      throw caught;
    }
  }

  // What each component is built from. A component carries its own files and
  // its own dial-in, so the only thing still to read is a deck card's -- and,
  // for a punchboard, the die line that says how many tokens there are.
  async function resolveSelection(): Promise<SceneSelection> {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- filled and read inside this one call; nothing renders from it
    const rows = new Map<string, FileRow>();
    for (const entry of chosenDecks)
      for (const card of entry.cards) rows.set(card.file.id, card.file);

    const dialled = new Map<string, ModelSettings | null>(
      await inBatches([...rows.keys()], async (id) => [id, await readSettings(id)] as const)
    );

    const backs: string[] = [];
    for (const entry of chosenDecks) {
      const fileId = entry.deck.back_file_id;
      if (fileId && !rows.has(fileId) && !backs.includes(fileId)) backs.push(fileId);
    }
    for (const row of await inBatches(backs, (id) =>
      api.GET('/api/files/{id}', { params: { path: { id } } }).then(assertOk)
    )) {
      rows.set(row.id, row);
    }

    const ref = (fileId: string | null): SceneImageRef | null => {
      const row = fileId === null ? undefined : rows.get(fileId);
      return row ? { file_id: row.id, content_type: row.content_type } : null;
    };

    const components: SceneComponentSelection[] = [];
    for (const component of chosenComponents) {
      const artwork = roleFile(component, 'artwork');
      if (!artwork) continue;
      const front = { file_id: artwork.id, content_type: artwork.content_type };
      const settings = component.settings as ModelSettings;
      const cutRow = roleFile(component, 'cut');
      const cut = cutRow ? { file_id: cutRow.id, content_type: cutRow.content_type } : null;

      if (settings.kind !== 'punchboard' || !cutRow) {
        components.push({
          label: label(component.name),
          front,
          back: null,
          cut,
          settings,
          copies: 1,
          part: null,
        });
        continue;
      }

      for (const piece of await punchboardParts(component, cutRow)) {
        components.push({
          label: label(piece.label),
          front,
          back: null,
          cut,
          settings,
          copies: 1,
          part: piece.part,
          footprint: { ...piece.footprint, height_mm: settings.thickness_mm },
        });
      }
    }

    return {
      files: components,
      decks: chosenDecks.map((entry) => ({
        deck_id: entry.deck.id,
        name: entry.deck.name,
        card_width_mm: entry.deck.card_width_mm,
        card_height_mm: entry.deck.card_height_mm,
        back: ref(entry.deck.back_file_id),
        cards: entry.cards.map((card) => ({
          label: label(card.file.filename),
          front: { file_id: card.file.id, content_type: card.file.content_type },
          copies: card.quantity,
          settings: dialled.get(card.file.id) ?? null,
        })),
      })),
      library: pieces.map((row) => ({
        piece: row.piece,
        count: row.count,
        color: row.color,
        size_mm: row.size_mm,
      })),
    };
  }

  function bundleName(): string {
    const stem = (project?.name ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return `${stem || 'scene'}-scene.zip`;
  }

  async function exportBundle(): Promise<void> {
    exporting = true;
    progress = null;
    try {
      const selection = await resolveSelection();
      // Imported here and nowhere else: building the bundle reaches three, and
      // no other screen should pay a byte for it.
      const { buildSceneBundle } = await import('../lib/scene/index.ts');
      const bundle = await buildSceneBundle({
        project_name: clamp(project?.name ?? '', SCENE_TEXT_LIMITS.project_name),
        generated_at: new Date().toISOString(),
        selection,
        template: templateId,
        render: { ...DEFAULT_SCENE_RENDER, engine, fps, samples },
        // Read off the $state proxy rather than held from before the export
        // started, so a colour changed while the picker was open is the one
        // that lands in the document.
        surface: surface === null ? null : { ...surface },
        backdrop: { background, background_color: backgroundColor },
        onProgress: (update) => {
          progress = update;
        },
      });

      const name = bundleName();
      saveBlob(bundle.zip, name);
      // A download gives no sign it happened, and the counts are the one thing
      // the screen could not work out before the bundle existed.
      toasts.success(
        `${name}: ${bundle.document.instances.length} pieces over ` +
          `${bundle.document.assets.length} components.`
      );
    } catch (caught) {
      toasts.error(caught instanceof Error ? caught.message : 'The scene could not be exported.');
    } finally {
      exporting = false;
      progress = null;
    }
  }
</script>

<div class="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8" use:link>
  {#if error}
    <p role="alert" class="rounded-md border border-danger p-4 text-sm text-danger">{error}</p>
    <a class="focus-ring rounded underline" href="/projects/{projectId}">Back to the project</a>
  {:else}
    <div>
      <a class="focus-ring rounded text-sm underline" href="/projects/{projectId}">
        {project?.name ?? 'Project'}
      </a>
      <h1 class="text-2xl font-semibold">Blender scene</h1>
      <p class="max-w-2xl text-sm text-muted">
        A ZIP holding one <code>.glb</code> per component and a <code>scene.json</code> saying where
        they sit and how they move. Unzip it and run
        <code class="rounded bg-accent-soft px-1"
          >blender --background --python tools/blender/import_scene.py -- scene.json</code
        >
        for a lit, keyframed file to finish by hand.
      </p>
    </div>

    {#if loading}
      <Spinner label="Loading project" />
    {:else}
      <section class="flex flex-col gap-3 rounded-md border border-edge bg-surface p-4">
        <h2 class="text-lg font-semibold">Decks</h2>
        {#if loaded.length === 0}
          <p class="text-sm text-muted">This project has no decks.</p>
        {:else}
          <ul class="flex flex-col gap-1">
            {#each loaded as entry (entry.deck.id)}
              {@const usable = usableCards(entry.cards)}
              <li>
                <label class="flex min-h-11 items-center gap-3 rounded px-2 hover:bg-accent-soft">
                  <input
                    type="checkbox"
                    class="focus-ring size-4"
                    bind:checked={selectedDecks[entry.deck.id]}
                  />
                  <span class="min-w-0 flex-1 truncate font-medium">{entry.deck.name}</span>
                  <span class="text-sm text-muted">
                    {usable.length}
                    {usable.length === 1 ? 'card' : 'cards'}
                  </span>
                </label>
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <section class="flex flex-col gap-3 rounded-md border border-edge bg-surface p-4">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h2 class="text-lg font-semibold">Components</h2>
          {#if chosenComponents.length > 0}
            <div class="flex items-center gap-2">
              <span class="text-sm text-muted">{chosenComponents.length} picked</span>
              <Button variant="ghost" onclick={() => (selectedComponents = {})}>Clear</Button>
            </div>
          {/if}
        </div>
        <ComponentChoices
          {projectId}
          selected={Object.fromEntries(chosenComponents.map((row) => [row.id, true]))}
          ontoggle={toggleComponent}
        />
      </section>

      <section class="flex flex-col gap-3 rounded-md border border-edge bg-surface p-4">
        <h2 class="text-lg font-semibold">Library pieces</h2>
        <LibraryPieces
          rows={pieces}
          onadd={addPiece}
          onremove={(key) => (pieces = pieces.filter((row) => row.key !== key))}
          onchange={changePiece}
        />
      </section>

      <section class="flex flex-col gap-3 rounded-md border border-edge bg-surface p-4">
        <h2 class="text-lg font-semibold">Movement</h2>
        <ShotTemplate {templates} {templateId} onpick={(id) => (templateId = id)} />
      </section>

      <section class="flex flex-col gap-4 rounded-md border border-edge bg-surface p-4">
        <h2 class="text-lg font-semibold">Setting</h2>
        <StageSettings
          {surface}
          {background}
          {backgroundColor}
          onsurface={(next) => (surface = next)}
          onbackdrop={(patch) => {
            background = patch.background ?? background;
            backgroundColor = patch.backgroundColor ?? backgroundColor;
          }}
        />
      </section>

      <section class="flex flex-col gap-4 rounded-md border border-edge bg-surface p-4">
        <h2 class="text-lg font-semibold">Render</h2>
        <RenderSettings
          {engine}
          {fps}
          {samples}
          onchange={(patch) => {
            engine = patch.engine ?? engine;
            fps = patch.fps ?? fps;
            samples = patch.samples ?? samples;
          }}
        />
      </section>

      <section class="flex flex-col gap-3 rounded-md border border-edge bg-surface p-4">
        <p class="text-sm" role="status">
          {instanceCount}
          {instanceCount === 1 ? 'piece' : 'pieces'} on the table.
        </p>

        {#if tooBig}
          <p class="text-sm text-danger" role="alert">
            That is more than one scene can hold. Take out a deck, or ask for fewer pieces.
          </p>
        {/if}

        {#if exporting}
          <p class="text-sm text-muted" role="status">
            {progress
              ? `Building ${Math.min(progress.built + 1, progress.total)} of ${progress.total}${
                  progress.label ? ` — ${progress.label}` : ''
                }…`
              : 'Reading what each piece is made of…'}
          </p>
        {/if}

        <div>
          <Button
            disabled={exporting ||
              tooBig ||
              templateId === '' ||
              instanceCount < SCENE_LIMITS.instances[0]}
            onclick={exportBundle}
          >
            {exporting ? 'Building…' : 'Export bundle'}
          </Button>
        </div>
      </section>
    {/if}
  {/if}
</div>
