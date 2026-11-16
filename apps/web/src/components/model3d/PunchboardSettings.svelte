<script lang="ts">
  import {
    MODEL_LIMITS,
    PUNCHBOARD_SHEET_STATES,
    planPunchboard,
    type PunchboardModelSettings,
    type PunchboardSheetState,
  } from '@three-peaks/shared';
  import ColorField from './ColorField.svelte';
  import NumberField from './NumberField.svelte';

  interface Props {
    settings: PunchboardModelSettings;
    // How many of each live token the sheet is asked to cut, in order.
    quantities: readonly number[];
    disabled: boolean;
    onchange: (patch: Partial<PunchboardModelSettings>) => void;
  }

  let { settings, quantities, disabled, onchange }: Props = $props();

  // The one place the sheet's arithmetic is said out loud: how many tokens it
  // holds at this size, and how many asked for do not fit.
  const plan = $derived(planPunchboard(settings, quantities));

  const STATE_LABELS: Record<PunchboardSheetState, string> = {
    intact: 'Whole, before anything is punched out',
    punched: 'The frame left after punching',
  };

  const limits = MODEL_LIMITS.punchboard;
  const stateId = $props.id();
</script>

<div class="flex flex-col gap-4">
  <NumberField
    label="Sheet width"
    suffix=" mm"
    value={settings.width_mm}
    min={limits.width_mm[0]}
    max={limits.width_mm[1]}
    step={1}
    {disabled}
    onchange={(width_mm) => onchange({ width_mm })}
  />
  <NumberField
    label="Sheet height"
    suffix=" mm"
    value={settings.height_mm}
    min={limits.height_mm[0]}
    max={limits.height_mm[1]}
    step={1}
    {disabled}
    onchange={(height_mm) => onchange({ height_mm })}
  />
  <NumberField
    label="Thickness"
    suffix=" mm"
    value={settings.thickness_mm}
    min={limits.thickness_mm[0]}
    max={limits.thickness_mm[1]}
    step={0.1}
    {disabled}
    onchange={(thickness_mm) => onchange({ thickness_mm })}
  />
  <NumberField
    label="Token width"
    suffix=" mm"
    value={settings.token_width_mm}
    min={limits.token_width_mm[0]}
    max={limits.token_width_mm[1]}
    step={0.5}
    {disabled}
    onchange={(token_width_mm) => onchange({ token_width_mm })}
  />
  <NumberField
    label="Token height"
    suffix=" mm"
    value={settings.token_height_mm}
    min={limits.token_height_mm[0]}
    max={limits.token_height_mm[1]}
    step={0.5}
    {disabled}
    onchange={(token_height_mm) => onchange({ token_height_mm })}
  />
  <NumberField
    label="Token corner radius"
    suffix=" mm"
    value={settings.token_corner_radius_mm}
    min={limits.token_corner_radius_mm[0]}
    max={limits.token_corner_radius_mm[1]}
    step={0.5}
    {disabled}
    onchange={(token_corner_radius_mm) => onchange({ token_corner_radius_mm })}
  />
  <p class="text-xs text-muted">
    Half the width and height cuts a disc. A layout drawing these tokens has to be drawn at this
    size.
  </p>
  <NumberField
    label="Gap between tokens"
    suffix=" mm"
    value={settings.token_gap_mm}
    min={limits.token_gap_mm[0]}
    max={limits.token_gap_mm[1]}
    step={0.5}
    {disabled}
    onchange={(token_gap_mm) => onchange({ token_gap_mm })}
  />
  <NumberField
    label="Margin"
    suffix=" mm"
    value={settings.margin_mm}
    min={limits.margin_mm[0]}
    max={limits.margin_mm[1]}
    step={0.5}
    {disabled}
    onchange={(margin_mm) => onchange({ margin_mm })}
  />

  <div class="flex flex-col gap-1">
    <label class="text-sm" for={stateId}>Sheet</label>
    <select
      id={stateId}
      class="focus-ring min-h-11 rounded-md border border-edge bg-surface px-2 text-sm"
      value={settings.sheet_state}
      {disabled}
      onchange={(event) =>
        onchange({ sheet_state: event.currentTarget.value as PunchboardSheetState })}
    >
      {#each PUNCHBOARD_SHEET_STATES as state (state)}
        <option value={state}>{STATE_LABELS[state]}</option>
      {/each}
    </select>
    <p class="text-xs text-muted">
      The tokens are exported either way. This only decides whether the sheet beside them still
      holds them.
    </p>
  </div>

  <p class="text-xs text-muted" role="status">
    The sheet cuts {plan.slots.length} of the {plan.capacity}
    {plan.capacity === 1 ? 'token' : 'tokens'} it has room for.
    {#if plan.overflow > 0}
      {plan.overflow} more {plan.overflow === 1 ? 'does' : 'do'} not fit.
    {/if}
  </p>

  <ColorField
    label="Reverse colour"
    value={settings.back_color}
    {disabled}
    onchange={(back_color) => onchange({ back_color })}
  />
  <ColorField
    label="Cut edge colour"
    value={settings.edge_color}
    {disabled}
    onchange={(edge_color) => onchange({ edge_color })}
  />
</div>
