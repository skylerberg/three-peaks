<script lang="ts">
  import { fieldsInDrawingOrder } from '@three-peaks/shared';
  import type { components } from '@three-peaks/shared/api';
  import FilePicker from './FilePicker.svelte';
  import Thumbnail from '../Thumbnail.svelte';
  import Button from '../ui/Button.svelte';
  import Input from '../ui/Input.svelte';
  import { type CardContent, type CardLayout, cardContent } from '../../lib/cardContent.svelte.ts';
  import { apiMessage } from '../../lib/session.svelte.ts';

  type File = components['schemas']['File'];

  // A card drawn from a layout, edited field by field beside a preview the API
  // draws as the fields change. Editing an existing card keeps its layout; a
  // new card chooses one and a name.
  interface Props {
    projectId: string;
    deckId: string;
    layouts: readonly CardLayout[];
    // The card being edited, or null for a new one.
    card: { fileId: string; filename: string; content: CardContent } | null;
    // After a new card is made, which the deck has to read back to list.
    oncreated: () => void;
    onclose: () => void;
  }
  let { projectId, deckId, layouts, card, oncreated, onclose }: Props = $props();

  // How long the fields have to stand still before the preview is drawn again:
  // a request per keystroke would be a render per keystroke.
  const PREVIEW_DELAY_MS = 400;

  const uid = $props.id();

  // Seeded once from the card. Drafts, not bindings: a realtime reload of the
  // deck must not rewrite what somebody is halfway through typing.
  // svelte-ignore state_referenced_locally
  let layoutId = $state(card?.content.layout_id ?? layouts[0]?.id ?? '');
  // svelte-ignore state_referenced_locally
  let fields = $state<Record<string, string>>({ ...(card?.content.fields ?? {}) });
  let filename = $state('');
  let saving = $state(false);
  let saveError = $state<string | null>(null);
  let previewUrl = $state<string | null>(null);
  let previewError = $state<string | null>(null);
  let drawing = $state(false);
  let picking = $state<string | null>(null);
  // The copy box the icon buttons write into, and where its caret last was.
  let focusedField = $state<string | null>(null);
  const textareas: Record<string, HTMLTextAreaElement> = {};

  const layout = $derived(layouts.find((entry) => entry.id === layoutId) ?? null);
  const fieldEntries = $derived(
    layout
      ? fieldsInDrawingOrder(layout.spec).map((key) => [key, layout.spec.fields[key]!] as const)
      : []
  );
  // Alphabetical, so a layout's icons are always found in the same place.
  const iconKeys = $derived(layout ? Object.keys(layout.spec.icons).sort() : []);
  // Only the layout's own fields are sent: a key left over from another layout
  // is one the API would refuse.
  const sentFields = $derived(
    Object.fromEntries(fieldEntries.map(([key]) => [key, fields[key] ?? '']))
  );
  const nameValid = $derived(card !== null || filename.trim() !== '');

  // Drawn after the fields settle, and only the newest answer is shown: an
  // older request finishing late would otherwise put back a card already typed
  // past.
  let generation = 0;
  $effect(() => {
    const current = layout;
    const values = sentFields;
    if (!current) return;
    const mine = ++generation;
    const timer = setTimeout(() => {
      drawing = true;
      cardContent
        .preview(projectId, current, values)
        .then((blob) => {
          if (mine !== generation) return;
          if (previewUrl) URL.revokeObjectURL(previewUrl);
          previewUrl = URL.createObjectURL(blob);
          previewError = null;
        })
        .catch((caught: unknown) => {
          if (mine === generation) previewError = apiMessage(caught);
        })
        .finally(() => {
          if (mine === generation) drawing = false;
        });
    }, PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  });

  // At the caret of the copy box last used, or at the end of the first one.
  function insertIcon(key: string): void {
    const target = focusedField ?? fieldEntries.find(([, field]) => field.type === 'text')?.[0];
    if (target === undefined) return;
    const area = textareas[target];
    const text = fields[target] ?? '';
    const start = area?.selectionStart ?? text.length;
    const end = area?.selectionEnd ?? text.length;
    const token = `{${key}}`;
    fields[target] = text.slice(0, start) + token + text.slice(end);
    // After the value has been written back into the box.
    queueMicrotask(() => {
      if (!area) return;
      area.focus();
      area.setSelectionRange(start + token.length, start + token.length);
    });
  }

  function pickImage(key: string, chosen: File[]): void {
    picking = null;
    const file = chosen[0];
    if (file) fields[key] = file.id;
  }

  async function save(): Promise<void> {
    if (!layout || !nameValid) return;
    saving = true;
    saveError = null;
    try {
      if (card) await cardContent.save(card.fileId, layout.id, sentFields);
      else {
        const name = filename.trim();
        await cardContent.create(
          deckId,
          /\.png$/i.test(name) ? name : `${name}.png`,
          layout.id,
          sentFields
        );
        oncreated();
      }
      onclose();
    } catch (caught) {
      saveError = apiMessage(caught);
    } finally {
      saving = false;
    }
  }
</script>

<section
  class="flex flex-col gap-4 rounded-md border border-accent bg-surface p-4"
  aria-labelledby="{uid}-title"
>
  <h2 id="{uid}-title" class="text-lg font-semibold">
    {card ? `Edit ${card.filename}` : 'New card from a layout'}
  </h2>

  <div class="flex flex-col gap-4 md:flex-row">
    <div class="flex min-w-0 flex-1 flex-col gap-4">
      {#if !card}
        <Input label="Name" bind:value={filename} maxlength={255} placeholder="knight" />
        <div class="flex flex-col gap-1">
          <label class="text-sm font-medium" for="{uid}-layout">Layout</label>
          <select
            id="{uid}-layout"
            class="focus-ring min-h-11 rounded-md border border-edge bg-surface px-2 text-sm"
            bind:value={layoutId}
          >
            {#each layouts as entry (entry.id)}
              <option value={entry.id}>{entry.name}</option>
            {/each}
          </select>
        </div>
      {:else if layout}
        <p class="text-sm text-muted">Drawn from {layout.name}.</p>
      {/if}

      {#if iconKeys.length > 0}
        <div class="flex flex-col gap-1">
          <span class="text-sm font-medium" id="{uid}-icons">Insert an icon</span>
          <div class="flex flex-wrap gap-1" role="group" aria-labelledby="{uid}-icons">
            {#each iconKeys as key (key)}
              <button
                type="button"
                class="focus-ring min-h-11 rounded-md border border-edge px-2 font-mono text-sm
                       hover:bg-accent-soft"
                onmousedown={(event) => event.preventDefault()}
                onclick={() => insertIcon(key)}
              >
                {`{${key}}`}
              </button>
            {/each}
          </div>
        </div>
      {/if}

      {#each fieldEntries as [key, field] (key)}
        {#if field.type === 'text'}
          <div class="flex flex-col gap-1">
            <label class="text-sm font-medium" for="{uid}-{key}">{key}</label>
            <textarea
              id="{uid}-{key}"
              bind:this={textareas[key]}
              class="focus-ring min-h-20 rounded-md border border-edge bg-surface px-3 py-2
                     font-mono text-sm"
              value={fields[key] ?? ''}
              oninput={(event) => (fields[key] = event.currentTarget.value)}
              onfocus={() => (focusedField = key)}></textarea>
          </div>
        {:else}
          <div class="flex flex-col gap-2">
            <span class="text-sm font-medium">{key}</span>
            <div class="flex flex-wrap items-center gap-2">
              {#if fields[key]}
                <Thumbnail fileId={fields[key]} alt="" />
              {:else}
                <span class="text-sm text-muted">No image</span>
              {/if}
              <Button variant="secondary" onclick={() => (picking = picking === key ? null : key)}>
                Choose image
              </Button>
              {#if fields[key]}
                <Button variant="ghost" onclick={() => (fields[key] = '')}>Clear</Button>
              {/if}
            </div>
            {#if picking === key}
              <FilePicker
                {projectId}
                onpick={(chosen) => pickImage(key, chosen)}
                oncancel={() => (picking = null)}
              />
            {/if}
          </div>
        {/if}
      {/each}
    </div>

    <div class="flex w-full flex-col items-center gap-2 md:w-72">
      <span class="self-start text-sm font-medium">Preview</span>
      {#if previewUrl}
        <img
          src={previewUrl}
          alt="The card as these fields draw it"
          class="w-full rounded-md border border-edge {drawing || previewError ? 'opacity-50' : ''}"
        />
      {:else if !previewError}
        <p class="text-sm text-muted">Drawing…</p>
      {/if}
      {#if previewError}
        <p role="status" class="text-sm text-danger">{previewError}</p>
      {/if}
    </div>
  </div>

  {#if saveError}
    <p role="alert" class="text-sm text-danger">{saveError}</p>
  {/if}
  <div class="flex flex-wrap gap-2">
    <Button disabled={saving || !layout || !nameValid} onclick={() => void save()}>
      {saving ? 'Saving…' : card ? 'Save' : 'Create card'}
    </Button>
    <Button variant="secondary" disabled={saving} onclick={onclose}>Cancel</Button>
  </div>
</section>
