<script lang="ts">
  import {
    COMPONENT_KIND_INFO,
    MODEL_SOURCE_TYPES,
    type ComponentFileRole,
    type ComponentKind,
    type ModelSettings,
  } from '@three-peaks/shared';
  import type { components as ApiComponents } from '@three-peaks/shared/api';
  import Studio from '../components/model3d/Studio.svelte';
  import Thumbnail from '../components/Thumbnail.svelte';
  import Button from '../components/ui/Button.svelte';
  import Spinner from '../components/ui/Spinner.svelte';
  import { ApiError, api, assertOk, authHeader } from '../api/client.ts';
  import { type ComponentSettings, projectComponents } from '../lib/components.svelte.ts';
  import { files } from '../lib/files.svelte.ts';
  import type { ModelSources, SourceImage } from '../lib/model3d/index.ts';
  import { realtime } from '../lib/realtime.svelte.ts';
  import { link } from '../lib/router.svelte.ts';
  import { apiMessage } from '../lib/session.svelte.ts';
  import { toasts } from '../lib/toasts.svelte.ts';
  import { assertUploadSize, readUploadResponse } from '../lib/upload.ts';

  // One component, and the studio for whatever kind it is. Its artwork lives
  // here and nowhere else, which is what the upload slots below are: a
  // component is named first and given its images afterwards.
  interface Props {
    projectId: string;
    componentId: string;
  }
  let { projectId, componentId }: Props = $props();

  let project = $state<ApiComponents['schemas']['Project'] | null>(null);
  let error = $state<string | null>(null);
  let artwork = $state<SourceImage | null>(null);
  let cut = $state<SourceImage | null>(null);
  let tokens = $state<number | null>(null);
  let uploading = $state<ComponentFileRole | null>(null);
  let renaming = $state(false);

  const component = $derived(projectComponents.component);
  const canEdit = $derived(project?.role === 'editor');
  const info = $derived(component ? COMPONENT_KIND_INFO[component.kind as ComponentKind] : null);
  const settings = $derived(component?.settings ?? null);

  function fileFor(role: ComponentFileRole) {
    return component?.files.find((entry) => entry.role === role)?.file ?? null;
  }
  const artworkFile = $derived(fileFor('artwork'));
  const cutFile = $derived(fileFor('cut'));

  // Null until every image the kind needs has been read, which is what stops
  // the viewer building a punchboard with no die line.
  const sources = $derived<ModelSources | null>(
    artwork && (!info?.roles.includes('cut') || cut) ? { artwork, cut } : null
  );

  $effect(() => {
    const id = componentId;
    error = null;
    artwork = null;
    cut = null;
    tokens = null;

    void projectComponents.loadOne(id).catch((caught: unknown) => {
      error =
        caught instanceof ApiError && caught.status === 404
          ? 'That component does not exist, or you do not have access to it.'
          : apiMessage(caught);
    });
  });

  $effect(() => {
    const id = projectId;
    api
      .GET('/api/projects/{id}', { params: { path: { id } } })
      .then((result) => {
        project = assertOk(result);
      })
      .catch(() => {
        // The component load above owns the error message.
        project = null;
      });
  });

  // The bytes, not the row: decoding a megapixel image on every slider move
  // would make the whole panel feel broken.
  function readInto(
    row: ApiComponents['schemas']['File'] | null,
    assign: (image: SourceImage | null) => void
  ) {
    if (!row) {
      assign(null);
      return undefined;
    }

    let stale = false;
    void (async () => {
      try {
        const { loadSource } = await import('../lib/model3d/index.ts');
        const loaded = await loadSource(row.id, row.content_type);
        if (!stale) assign(loaded);
      } catch (caught) {
        if (!stale) error = caught instanceof Error ? caught.message : 'Could not read the image.';
      }
    })();

    return () => {
      stale = true;
    };
  }

  $effect(() => readInto(artworkFile, (image) => (artwork = image)));
  $effect(() => readInto(cutFile, (image) => (cut = image)));

  // How many tokens the die line found, which is the one number saying whether
  // the cut sheet was understood. Read here rather than in the panel, because
  // the panel is shared with every kind that has no die line at all.
  $effect(() => {
    const svg = cut?.svgText ?? null;
    const current = settings;
    if (!svg || current?.kind !== 'punchboard') {
      tokens = null;
      return;
    }

    let stale = false;
    void (async () => {
      try {
        const { punchboardLayout } = await import('../lib/model3d/index.ts');
        const layout = punchboardLayout(current, svg);
        // The sheet is one of the pieces; the tokens are the rest.
        if (!stale) tokens = layout.pieces.length - 1;
      } catch {
        if (!stale) tokens = 0;
      }
    })();

    return () => {
      stale = true;
    };
  });

  $effect(() => {
    const id = projectId;
    realtime.subscribe(id);
    const off = realtime.on((event) => {
      if (event.project_id !== id) return;
      if (event.type === 'component_updated' && event.data.id === componentId) {
        projectComponents.apply(event.data);
      }
    });
    return () => {
      off();
      realtime.unsubscribe(id);
    };
  });

  function change(patch: Partial<ModelSettings>): void {
    if (!canEdit) return;
    // The studio's panels are typed against the whole union; a component's
    // settings are the narrower one the API validates, and the panel on screen
    // is the one for this component's kind.
    projectComponents.update(patch as Partial<ComponentSettings>);
    projectComponents.scheduleSave();
  }

  async function upload(role: ComponentFileRole, list: FileList | null) {
    const chosen = list?.[0];
    if (!chosen) return;
    uploading = role;
    try {
      await files.upload(projectId, { component_id: componentId, role }, chosen);
      await projectComponents.refreshOne();
    } catch (caught) {
      toasts.error(`${chosen.name}: ${apiMessage(caught)}`);
    } finally {
      uploading = null;
    }
  }

  async function replace(role: ComponentFileRole, list: FileList | null) {
    const existing = fileFor(role);
    if (existing) {
      try {
        await files.deleteFile(existing.id);
      } catch (caught) {
        toasts.error(apiMessage(caught));
        return;
      }
    }
    await upload(role, list);
  }

  async function rename() {
    const current = component;
    if (!current) return;
    const next = prompt('New name', current.name);
    if (!next || next === current.name) return;
    renaming = true;
    try {
      await projectComponents.rename(current.id, next);
    } catch (caught) {
      toasts.error(apiMessage(caught));
    } finally {
      renaming = false;
    }
  }

  // Into Assets, not into the component: the mesh is a build artefact rather
  // than one of the images this component is made from, and a component holds
  // one artwork and one cut sheet and nothing else.
  async function saveToProject(bytes: ArrayBuffer, filename: string): Promise<void> {
    const query = new URLSearchParams({ project_id: projectId, filename });

    assertUploadSize(bytes.byteLength);
    const response = await fetch(`/api/files/upload?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'model/gltf-binary', ...authHeader() },
      body: bytes,
    });

    await readUploadResponse(response, 'The model could not be saved.');
    toasts.success(`Saved ${filename} to Assets.`);
  }

  const ROLE_LABELS: Record<ComponentFileRole, string> = {
    artwork: 'Artwork',
    cut: 'Cut sheet (SVG)',
  };
</script>

<div class="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8" use:link>
  {#if error}
    <p role="alert" class="rounded-md border border-danger p-4 text-sm text-danger">{error}</p>
    <a class="focus-ring rounded underline" href="/projects/{projectId}">Back to the project</a>
  {:else if projectComponents.loadingOne || !component || !info || !settings}
    <Spinner label="Loading component" />
  {:else}
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <div>
        <h1 class="text-2xl font-semibold">{component.name}</h1>
        <p class="text-sm text-muted">
          {#if component.deleted_at}
            Deleted. Restore it from the project’s Deleted view to edit it.
          {:else if projectComponents.saving}
            Saving settings…
          {:else if canEdit}
            Settings are saved to this project as you change them.
          {:else}
            You have read-only access to this project.
          {/if}
        </p>
      </div>
      <div class="flex items-center gap-1">
        {#if canEdit}
          <Button variant="secondary" onclick={rename} disabled={renaming}>Rename</Button>
        {/if}
        {#if component.kind === 'board' && artworkFile?.deleted_at === null}
          <a
            class="focus-ring rounded px-3 py-2 text-sm underline"
            href="/projects/{projectId}/print?board={component.id}"
          >
            Print
          </a>
        {/if}
        <a
          class="focus-ring rounded px-3 py-2 text-sm underline"
          href="/projects/{projectId}/components/{component.kind}"
        >
          Back to {info.section.toLowerCase()}
        </a>
      </div>
    </div>

    <div class="flex flex-wrap gap-3">
      {#each info.roles as role (role)}
        {@const row = fileFor(role)}
        <div class="flex items-center gap-3 rounded-lg border border-edge bg-surface p-3">
          <div class="flex size-16 items-center justify-center overflow-hidden rounded bg-canvas">
            {#if row}
              <Thumbnail fileId={row.id} alt={ROLE_LABELS[role]} class="size-16" />
            {:else}
              <span class="text-xs text-muted">None</span>
            {/if}
          </div>
          <div class="flex flex-col gap-1">
            <span class="text-sm font-medium">{ROLE_LABELS[role]}</span>
            <span class="max-w-40 truncate text-xs text-muted">
              {row ? row.filename : 'Not uploaded yet'}
            </span>
            {#if canEdit}
              <label class="focus-within:focus-ring cursor-pointer text-xs underline">
                <!-- Which slot, in the label's own text: two file inputs both
                     named "Upload" are two controls a screen reader cannot tell
                     apart, and this is the only thing that separates them. -->
                <span class="sr-only">{ROLE_LABELS[role]}: </span>
                {uploading === role ? 'Uploading…' : row ? 'Replace' : 'Upload'}
                <input
                  class="sr-only"
                  type="file"
                  accept={role === 'cut' ? 'image/svg+xml' : MODEL_SOURCE_TYPES.join(',')}
                  disabled={uploading !== null}
                  onchange={(event) => {
                    const input = event.currentTarget;
                    void replace(role, input.files).finally(() => (input.value = ''));
                  }}
                />
              </label>
            {/if}
          </div>
        </div>
      {/each}
    </div>

    {#if component.missing_roles.length > 0}
      <p class="rounded-md border border-edge p-4 text-sm text-muted">
        This {info.singular} still needs its {component.missing_roles
          .map((role) => ROLE_LABELS[role].toLowerCase())
          .join(' and ')}.
      </p>
    {:else}
      <Studio
        {settings}
        {sources}
        canEdit={canEdit && component.deleted_at === null}
        {tokens}
        vector={artworkFile?.content_type === 'image/svg+xml'}
        onchange={change}
        exportName={component.name}
        onsave={saveToProject}
      />
    {/if}
  {/if}
</div>
