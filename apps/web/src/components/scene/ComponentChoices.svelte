<script lang="ts">
  import { COMPONENT_KINDS, COMPONENT_KIND_INFO, canBuild } from '@three-peaks/shared';
  import Thumbnail from '../Thumbnail.svelte';
  import Spinner from '../ui/Spinner.svelte';
  import { api, assertOk } from '../../api/client.ts';
  import type { ProjectComponent } from '../../lib/components.svelte.ts';
  import { apiMessage } from '../../lib/session.svelte.ts';
  import { toasts } from '../../lib/toasts.svelte.ts';

  // The project's components, grouped by kind. Not a folder walk: a component
  // is a thing with a name and a section, and picking one by browsing to the
  // file underneath it is exactly what the sections did away with.
  interface Props {
    projectId: string;
    selected: Record<string, boolean>;
    ontoggle: (component: ProjectComponent, on: boolean) => void;
  }

  let { projectId, selected, ontoggle }: Props = $props();

  let all = $state<ProjectComponent[]>([]);
  let loading = $state(true);

  $effect(() => {
    const id = projectId;
    loading = true;
    void api
      .GET('/api/components', { params: { query: { project_id: id } } })
      .then((result) => {
        // Only the ones that can actually be built; a component still waiting
        // for its artwork, or a punchboard with no token to cut, has nothing to
        // put on the table.
        all = assertOk(result).components.filter(canBuild);
      })
      .catch((caught) => toasts.error(apiMessage(caught)))
      .finally(() => {
        loading = false;
      });
  });

  const byKind = $derived(
    COMPONENT_KINDS.map((kind) => ({
      kind,
      section: COMPONENT_KIND_INFO[kind].section,
      rows: all.filter((row) => row.kind === kind),
    })).filter((group) => group.rows.length > 0)
  );

  function artworkOf(component: ProjectComponent) {
    return component.files.find((entry) => entry.role === 'artwork')?.file ?? null;
  }
</script>

{#if loading}
  <Spinner label="Loading components" />
{:else if byKind.length === 0}
  <p class="text-sm text-muted">
    No components are ready yet. One needs its artwork before it can be put in a scene.
  </p>
{:else}
  <div class="flex flex-col gap-4">
    {#each byKind as group (group.kind)}
      <div class="flex flex-col gap-2">
        <h3 class="text-sm font-medium text-muted">{group.section}</h3>
        <ul class="grid gap-2 sm:grid-cols-2">
          {#each group.rows as component (component.id)}
            {@const artwork = artworkOf(component)}
            <li>
              <label class="flex min-h-11 items-center gap-3 rounded-md border border-edge p-2">
                <input
                  type="checkbox"
                  class="focus-ring size-4"
                  checked={selected[component.id] === true}
                  onchange={(event) => ontoggle(component, event.currentTarget.checked)}
                />
                {#if artwork}
                  <Thumbnail fileId={artwork.id} alt="" />
                {/if}
                <span class="min-w-0 flex-1 truncate text-sm">{component.name}</span>
              </label>
            </li>
          {/each}
        </ul>
      </div>
    {/each}
  </div>
{/if}
