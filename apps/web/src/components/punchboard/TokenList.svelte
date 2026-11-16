<script lang="ts">
  import { flip } from 'svelte/animate';
  import { SOURCES, TRIGGERS, type DndEvent, dragHandleZone } from 'svelte-dnd-action';
  import {
    DECK_QUANTITY_LIMITS,
    isLiveCard,
    planPunchboard,
    withHiddenCards,
    type PunchboardModelSettings,
  } from '@three-peaks/shared';
  import CardEditor from '../decks/CardEditor.svelte';
  import Thumbnail from '../Thumbnail.svelte';
  import Button from '../ui/Button.svelte';
  import DragHandle from '../ui/DragHandle.svelte';
  import { cardContent } from '../../lib/cardContent.svelte.ts';
  import {
    type ComponentToken,
    type ProjectComponent,
    projectComponents,
    tokenInput,
  } from '../../lib/components.svelte.ts';
  import { DROP_TARGET_STYLE, flipDuration, isDragPlaceholder } from '../../lib/dnd.ts';
  import { files } from '../../lib/files.svelte.ts';
  import { apiMessage } from '../../lib/session.svelte.ts';
  import { toasts } from '../../lib/toasts.svelte.ts';
  import { versions } from '../../lib/versions.svelte.ts';

  // A punchboard's tokens: each one a front and a back, how many are cut, and
  // where it comes in the order the sheet is packed in. Written the way the
  // deck screen's cards are, for the same reasons -- the list is dragged by a
  // handle, saved whole, and drawn from a local copy while a drag is live.
  interface Props {
    projectId: string;
    component: ProjectComponent;
    settings: PunchboardModelSettings;
    canEdit: boolean;
  }
  let { projectId, component, settings, canEdit }: Props = $props();

  type DraggableToken = ComponentToken & { id: string };
  type BackChoice = 'none' | 'same' | 'own';

  let uploading = $state(false);
  let editing = $state<{ kind: 'token'; fileId: string } | { kind: 'new' } | null>(null);
  let localTokens = $state<DraggableToken[]>([]);
  // Plain, not `$state`, for the reason the deck screen gives about its own.
  let dragging = false;

  const [minQuantity, maxQuantity] = DECK_QUANTITY_LIMITS;
  const tokens = $derived(component.tokens);
  const liveTokens = $derived(tokens.filter(isLiveCard));
  const plan = $derived(
    planPunchboard(
      settings,
      liveTokens.map((token) => token.quantity)
    )
  );
  const wanted = $derived(liveTokens.reduce((sum, token) => sum + token.quantity, 0));

  $effect(() => {
    const id = component.id;
    editing = null;
    void cardContent.load(projectId, { component_id: id }).catch(() => {});
    return () => cardContent.close();
  });

  $effect(() => {
    const next = liveTokens;
    if (dragging) return;
    localTokens = next.map((token) => ({ ...token, id: token.file_id }));
  });

  const editingToken = $derived.by(() => {
    const open = editing;
    if (open?.kind !== 'token') return null;
    const row = tokens.find((entry) => entry.file_id === open.fileId);
    const content = cardContent.contentOf(open.fileId);
    return row && content ? { fileId: row.file_id, filename: row.file.filename, content } : null;
  });

  function backChoice(token: ComponentToken): BackChoice {
    if (token.back_file_id === null) return 'none';
    return token.back_file_id === token.file_id ? 'same' : 'own';
  }

  // Whether the token's layout draws its back, which is then not anybody's to
  // choose.
  function drawsBack(token: ComponentToken): boolean {
    const content = cardContent.contentOf(token.file_id);
    const layout = content ? cardContent.layoutOf(content.layout_id) : undefined;
    return layout !== undefined && layout.spec.back !== null;
  }

  async function save(next: readonly ComponentToken[]): Promise<void> {
    try {
      await projectComponents.saveTokens(
        component.id,
        withHiddenCards(tokens, next).map(tokenInput)
      );
    } catch (caught) {
      toasts.error(apiMessage(caught));
      await projectComponents.refreshOne().catch(() => {});
    }
  }

  async function uploadTokens(list: FileList | null): Promise<void> {
    if (!list || list.length === 0) return;
    uploading = true;
    try {
      // One at a time, because the quota is checked per request.
      for (const file of Array.from(list)) {
        try {
          await files.upload(projectId, { component_id: component.id }, file);
        } catch (caught) {
          toasts.error(`${file.name}: ${apiMessage(caught)}`);
        }
      }
      await projectComponents.refreshOne().catch(() => {});
    } finally {
      uploading = false;
    }
  }

  // A back of the token's own that no other token prints, which another choice
  // would leave in the punchboard naming nothing: it goes to Deleted first.
  function ownBack(token: ComponentToken) {
    const back = token.back_file;
    if (back === null || back.id === token.file_id || back.deleted_at !== null) return null;
    const shared = tokens.some(
      (other) => other.file_id !== token.file_id && other.back_file_id === back.id
    );
    return shared ? null : back;
  }

  async function chooseBack(token: ComponentToken, choice: 'none' | 'same'): Promise<void> {
    const own = ownBack(token);
    if (own && !confirm(`Delete ${own.filename}, the back it has now? Deleted can put it back.`)) {
      return;
    }
    try {
      if (own) await files.deleteFile(own.id);
      const back = choice === 'same' ? token.file_id : null;
      await save(
        localTokens.map((row) =>
          row.file_id === token.file_id ? { ...row, back_file_id: back } : row
        )
      );
    } catch (caught) {
      toasts.error(apiMessage(caught));
      await projectComponents.refreshOne().catch(() => {});
    }
  }

  // A back it has of its own gains a version, so the old picture stays one
  // revert away; anything else takes the image as a back of its own.
  async function uploadBack(token: ComponentToken, list: FileList | null): Promise<void> {
    const chosen = list?.[0];
    if (!chosen) return;
    try {
      const own = ownBack(token);
      if (own) {
        await versions.upload(own.id, chosen);
      } else {
        if (token.back_file !== null && token.back_file_id !== token.file_id) {
          // A deleted back still holds the place; it is let go, and stays in
          // Deleted.
          await save(
            localTokens.map((row) =>
              row.file_id === token.file_id ? { ...row, back_file_id: null } : row
            )
          );
        }
        await files.upload(
          projectId,
          { component_id: component.id, role: 'back', back_of: token.file_id },
          chosen
        );
      }
      await projectComponents.refreshOne().catch(() => {});
    } catch (caught) {
      toasts.error(`${chosen.name}: ${apiMessage(caught)}`);
    }
  }

  async function removeToken(token: ComponentToken): Promise<void> {
    if (
      !confirm(`Delete ${token.file.filename}? Its history is kept, and Deleted can put it back.`)
    )
      return;
    try {
      await files.deleteFile(token.file_id);
      await projectComponents.refreshOne();
    } catch (caught) {
      toasts.error(apiMessage(caught));
    }
  }

  function setQuantity(fileId: string, quantity: number): void {
    const clamped = Math.max(minQuantity, Math.min(maxQuantity, Math.round(quantity)));
    void save(
      localTokens.map((token) =>
        token.file_id === fileId ? { ...token, quantity: clamped } : token
      )
    );
  }

  function selectAll(event: FocusEvent & { currentTarget: HTMLInputElement }): void {
    event.currentTarget.select();
  }

  function handleConsider(event: CustomEvent<DndEvent<DraggableToken>>): void {
    localTokens = event.detail.items.filter((token) => !isDragPlaceholder(token.id));
    if (event.detail.info.trigger === TRIGGERS.DRAG_STOPPED) {
      dragging = false;
      void commitOrder();
      return;
    }
    dragging = true;
  }

  function handleFinalize(event: CustomEvent<DndEvent<DraggableToken>>): void {
    localTokens = event.detail.items.filter((token) => !isDragPlaceholder(token.id));
    if (event.detail.info.source === SOURCES.KEYBOARD) return;
    dragging = false;
    void commitOrder();
  }

  async function commitOrder(): Promise<void> {
    const held = liveTokens;
    const unchanged =
      localTokens.length === held.length &&
      localTokens.every((token, index) => token.file_id === held[index]?.file_id);
    if (unchanged) {
      localTokens = held.map((token) => ({ ...token, id: token.file_id }));
      return;
    }
    await save(localTokens);
  }
</script>

<section class="flex flex-col gap-3">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <div>
      <h2 class="text-lg font-semibold">Tokens</h2>
      <p class="text-sm text-muted">
        {liveTokens.length}
        {liveTokens.length === 1 ? 'token' : 'tokens'} · {wanted} to cut · the sheet holds {plan.capacity}
      </p>
    </div>
    {#if canEdit}
      <div class="flex flex-wrap items-center gap-2">
        <label
          class="focus-within:focus-ring inline-flex min-h-11 cursor-pointer items-center
                 rounded-md bg-accent px-4 text-sm font-medium text-on-accent hover:bg-accent-strong"
        >
          {uploading ? 'Uploading…' : 'Upload tokens'}
          <input
            class="sr-only"
            type="file"
            multiple
            accept="image/*"
            disabled={uploading}
            onchange={(event) => {
              const input = event.currentTarget;
              void uploadTokens(input.files).finally(() => (input.value = ''));
            }}
          />
        </label>
        {#if cardContent.layouts.length > 0}
          <Button variant="secondary" onclick={() => (editing = { kind: 'new' })}>
            New token from a layout
          </Button>
        {/if}
      </div>
    {/if}
  </div>

  {#if plan.overflow > 0}
    <p role="status" class="rounded-md border border-warning p-3 text-sm">
      {plan.overflow}
      {plan.overflow === 1 ? 'copy does' : 'copies do'} not fit on this sheet. Make the sheet larger,
      or the tokens, the gap or the margin smaller -- or cut fewer copies.
    </p>
  {/if}

  {#if editing?.kind === 'new' || editingToken}
    {#key editing}
      <CardEditor
        {projectId}
        home={{ component_id: component.id }}
        layouts={cardContent.layouts}
        card={editingToken}
        oncreated={() => void projectComponents.refreshOne().catch(() => {})}
        onclose={() => (editing = null)}
      />
    {/key}
  {/if}

  {#if liveTokens.length === 0}
    <p class="text-sm text-muted">
      No tokens yet. {canEdit
        ? 'Upload an image for each one, or draw them from a layout, and set what is printed behind each.'
        : ''}
    </p>
  {:else}
    <ul
      class="flex flex-col gap-2"
      aria-label="Tokens, in the order the sheet is packed"
      use:dragHandleZone={{
        items: localTokens,
        type: 'punchboard-tokens',
        flipDurationMs: flipDuration(),
        dropTargetStyle: DROP_TARGET_STYLE,
        dropFromOthersDisabled: true,
        dragDisabled: !canEdit,
      }}
      onconsider={handleConsider}
      onfinalize={handleFinalize}
    >
      {#each localTokens as token (token.id)}
        {@const inert = isDragPlaceholder(token.id)}
        {@const content = cardContent.contentOf(token.file_id)}
        {@const drawState = content?.render_status ?? 'current'}
        {@const drawn = drawsBack(token)}
        {@const choice = backChoice(token)}
        <li
          animate:flip={{ duration: flipDuration() }}
          aria-label={token.file.filename}
          class="flex flex-wrap items-center gap-3 rounded-md border border-edge bg-surface p-2"
        >
          {#if canEdit && !inert}
            <DragHandle label="Reorder {token.file.filename}" />
          {/if}
          <div class="flex items-center gap-2">
            {#key token.file.checksum}
              <Thumbnail fileId={token.file_id} alt="Front" fit="contain" />
            {/key}
            {#if token.back_file && choice === 'own'}
              {#key token.back_file.checksum}
                <Thumbnail fileId={token.back_file.id} alt="Back" fit="contain" />
              {/key}
            {:else}
              <span
                class="flex size-12 items-center justify-center rounded bg-canvas text-center text-[10px] leading-tight text-muted"
              >
                {choice === 'same' ? 'Same both sides' : 'Unprinted'}
              </span>
            {/if}
          </div>
          <span class="min-w-0 flex-1 truncate text-sm">{token.file.filename}</span>

          <label class="flex items-center gap-2 text-sm">
            <span class="text-muted">Copies</span>
            <input
              type="number"
              class="focus-ring min-h-11 w-20 rounded-md border border-edge bg-surface px-2 text-sm"
              value={token.quantity}
              min={minQuantity}
              max={maxQuantity}
              step="1"
              disabled={!canEdit || inert}
              onfocus={selectAll}
              onchange={(event) => setQuantity(token.file_id, Number(event.currentTarget.value))}
            />
          </label>

          {#if canEdit && !inert}
            <div class="flex flex-wrap items-center gap-1">
              {#if drawn}
                <span class="px-2 text-xs text-muted">Back drawn by its layout</span>
              {:else}
                <label class="flex items-center gap-2 text-sm">
                  <span class="text-muted">Back</span>
                  <select
                    class="focus-ring min-h-11 rounded-md border border-edge bg-surface px-2 text-sm"
                    value={choice}
                    onchange={(event) => {
                      const next = event.currentTarget.value as BackChoice;
                      if (next !== 'own') void chooseBack(token, next);
                    }}
                  >
                    <option value="none">Unprinted</option>
                    <option value="same">Same as the front</option>
                    {#if choice === 'own'}
                      <option value="own">{token.back_file?.filename}</option>
                    {/if}
                  </select>
                </label>
                <label
                  class="focus-within:focus-ring inline-flex min-h-11 cursor-pointer items-center rounded-md px-3 text-sm underline"
                >
                  <span class="sr-only">{token.file.filename}: </span>
                  {choice === 'own' ? 'Replace back' : 'Upload a back'}
                  <input
                    class="sr-only"
                    type="file"
                    accept="image/*"
                    onchange={(event) => {
                      const input = event.currentTarget;
                      void uploadBack(token, input.files).finally(() => (input.value = ''));
                    }}
                  />
                </label>
              {/if}
              {#if content}
                <Button
                  variant="ghost"
                  onclick={() => (editing = { kind: 'token', fileId: token.file_id })}
                >
                  Edit
                </Button>
              {/if}
              <Button variant="ghost" onclick={() => void removeToken(token)}>Delete</Button>
            </div>
          {/if}

          {#if drawState !== 'current'}
            <div class="basis-full">
              {#if drawState === 'pending'}
                <p class="text-xs text-muted">Being drawn again from its layout…</p>
              {:else}
                <p class="text-xs text-danger">
                  Can’t be drawn from its layout: {content?.render_error}
                </p>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
