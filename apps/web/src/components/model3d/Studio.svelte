<script lang="ts">
  import type { ModelSettings } from '@three-peaks/shared';
  import type { components } from '@three-peaks/shared/api';
  import BoardSettings from './BoardSettings.svelte';
  import BoxSettings from './BoxSettings.svelte';
  import CardSettings from './CardSettings.svelte';
  import ModelViewer from './ModelViewer.svelte';
  import PunchboardSettings from './PunchboardSettings.svelte';
  import WoodSettings from './WoodSettings.svelte';
  import Button from '../ui/Button.svelte';
  import { saveBlob } from '../../lib/download.ts';
  import type { BuiltModel, ModelSources } from '../../lib/model3d/index.ts';
  import { apiMessage } from '../../lib/session.svelte.ts';
  import { toasts } from '../../lib/toasts.svelte.ts';

  // The viewer, the export buttons and the panel for whatever kind this is.
  // Shared because a deck card and a component are dialled in exactly the same
  // way; what differs is where the settings are read from and saved to, which
  // is the screen's job and not this one's.
  interface Props {
    settings: ModelSettings;
    sources: ModelSources | null;
    canEdit: boolean;
    onchange: (patch: Partial<ModelSettings>) => void;
    // Card only: the other images this card could put on its reverse.
    backChoices?: components['schemas']['File'][];
    // Wood only: whether the source is an SVG, whose paths are the outline.
    vector?: boolean;
    // Punchboard only: how many of each live token the sheet is asked to cut.
    quantities?: readonly number[];
    // What a downloaded .glb is called, without the extension.
    exportName: string;
    // Absent on a screen with nowhere in the project to put the file.
    onsave?: (bytes: ArrayBuffer, filename: string) => Promise<void>;
  }

  let {
    settings,
    sources,
    canEdit,
    onchange,
    backChoices = [],
    vector = false,
    quantities = [],
    exportName,
    onsave,
  }: Props = $props();

  let exporting = $state(false);
  let built: BuiltModel | null = null;

  async function withGlb(action: (bytes: ArrayBuffer, filename: string) => Promise<void> | void) {
    if (!built) {
      toasts.error('There is no model to export yet.');
      return;
    }

    exporting = true;
    try {
      const { exportGlb } = await import('../../lib/model3d/index.ts');
      await action(await exportGlb(built.group), `${exportName}.glb`);
    } catch (caught) {
      toasts.error(apiMessage(caught, 'The model could not be exported.'));
    } finally {
      exporting = false;
    }
  }

  function download() {
    void withGlb((bytes, filename) => {
      saveBlob(new Blob([bytes], { type: 'model/gltf-binary' }), filename);
    });
  }
</script>

<div class="grid gap-6 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
  <div class="flex flex-col gap-3">
    <ModelViewer {settings} {sources} onbuild={(model) => (built = model)} />
    <div class="flex flex-wrap gap-2">
      <Button variant="secondary" onclick={download} disabled={exporting}>Download .glb</Button>
      {#if onsave && canEdit}
        <Button onclick={() => void withGlb(onsave)} disabled={exporting}>Save to project</Button>
      {/if}
    </div>
  </div>

  <div class="flex flex-col gap-4 rounded-lg border border-edge bg-surface p-4">
    {#if settings.kind === 'card'}
      <CardSettings {settings} {backChoices} disabled={!canEdit} {onchange} />
    {:else if settings.kind === 'wood'}
      <WoodSettings {settings} {vector} disabled={!canEdit} {onchange} />
    {:else if settings.kind === 'box'}
      <BoxSettings {settings} disabled={!canEdit} {onchange} />
    {:else if settings.kind === 'board'}
      <BoardSettings {settings} disabled={!canEdit} {onchange} />
    {:else}
      <PunchboardSettings {settings} {quantities} disabled={!canEdit} {onchange} />
    {/if}
  </div>
</div>
