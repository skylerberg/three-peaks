import { type Kysely, sql } from 'kysely';

// Layouts gain elements placed by one another. A box becomes four named edges,
// so that one edge can be pinned to another element while the rest stay
// numbers, and every element spells out the new settings at their defaults:
// an id, a rotation, and on text and images whether the copy hugs and how the
// image slices. The stored form spells out every setting, so a layout written
// before them is rewritten rather than read with defaults.
//
// Safe beside the previous release because that release never reads a spec:
// it validates one on the way in and hands it back out, and only the CLI draws
// one. The one gap is a layout pushed to an old pod during the rollout, which
// would be stored in the old form; the conversion only touches a box that is
// still a list, so running it again repairs exactly those.
export async function up(db: Kysely<unknown>): Promise<void> {
  await rewrite(db, upgrade);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await rewrite(db, downgrade);
}

type Element = Record<string, unknown>;
type Spec = { elements: Element[] } & Record<string, unknown>;

async function rewrite(db: Kysely<unknown>, convert: (element: Element) => Element) {
  const { rows } = await sql<{ id: string; spec: Spec }>`
    select id, spec from card_layout
  `.execute(db);
  for (const { id, spec } of rows) {
    const next = { ...spec, elements: spec.elements.map(convert) };
    await sql`
      update card_layout set spec = ${JSON.stringify(next)}::jsonb where id = ${id}
    `.execute(db);
  }
}

function upgrade(element: Element): Element {
  if (!Array.isArray(element.box)) return element;
  const [x, y, width, height] = element.box as number[];
  const next: Element = {
    ...element,
    id: null,
    box: { left: x, top: y, right: x! + width!, bottom: y! + height! },
    rotate: 0,
  };
  if (element.type === 'text') next.hug = false;
  if (element.type === 'image') next.slice = null;
  return next;
}

// Only a layout that uses none of the new settings has an old form; one that
// does is left alone, and the previous release refuses it on its next push.
function downgrade(element: Element): Element {
  const box = element.box as Record<string, unknown>;
  if (Array.isArray(box)) return element;
  const { left, top, right, bottom } = box;
  if ([left, top, right, bottom].some((edge) => typeof edge !== 'number')) return element;
  const { id, rotate, hug, slice, ...rest } = element;
  if (id !== null || rotate !== 0 || hug === true || (slice !== undefined && slice !== null)) {
    return element;
  }
  return {
    ...rest,
    box: [left, top, (right as number) - (left as number), (bottom as number) - (top as number)],
  };
}
