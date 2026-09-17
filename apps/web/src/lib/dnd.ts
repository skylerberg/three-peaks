import { SHADOW_PLACEHOLDER_ITEM_ID } from 'svelte-dnd-action';

// The outline svelte-dnd-action draws around a zone while a drag is live. One
// object for every list that can be dragged, so a new one cannot pick up a
// differently-shaped highlight by copying an older call site.
//
// The token rather than a Tailwind class: the library writes these as inline
// styles on the zone, where a class name means nothing.
export const DROP_TARGET_STYLE = {
  outline: '2px solid var(--tph-accent)',
  outlineOffset: '-2px',
  borderRadius: '0.375rem',
};

const FLIP_MS = 150;

/**
 * How long a zone takes to reflow around a dragged item, for the zone itself
 * and for the `animate:flip` on its rows -- the two have to agree or the list
 * settles after the row has landed.
 *
 * A function rather than a constant because the second half is a rule rather
 * than a number: reduced motion collapses it to zero. app.css cannot answer
 * this one. Its `prefers-reduced-motion` block flattens CSS animations and
 * transitions, and both of these are Web Animations, which that rule never
 * reaches.
 */
export function flipDuration(): number {
  // Absent under jsdom, where no drag happens anyway.
  if (typeof window.matchMedia !== 'function') return FLIP_MS;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : FLIP_MS;
}

/**
 * The gap the library leaves where the lifted row came from. It is a full clone
 * of that row with only its id swapped for a sentinel, so it draws as an
 * ordinary one -- and every control on it has to be disabled or absent, because
 * each would address an id no row has.
 */
export function isDragPlaceholder(id: string): boolean {
  return id === SHADOW_PLACEHOLDER_ITEM_ID;
}
