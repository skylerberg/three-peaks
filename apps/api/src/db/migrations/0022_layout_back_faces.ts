import { type Kysely, sql } from 'kysely';

// A layout can draw the back of a piece as well as its face, for a token
// printed on both sides with a back of its own. The stored form spells out
// every setting, so every layout written before this gains `back: null`, the
// layout that draws one face, rather than being read with a default.
//
// Safe beside the previous release: it hands a stored spec back as it found
// it and draws only `elements`, so a key it does not know is a key it carries.
// A layout saved by one of its pods during the rollout is stored without the
// key, which this release reads as no back, and running this again repairs it.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    update card_layout
       set spec = spec || jsonb_build_object('back', null)
     where not spec ? 'back'
  `.execute(db);
}

// Only a layout that draws one face has an old form; one with a back is left
// alone, and the previous release would draw its face and refuse it on its
// next save.
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    update card_layout
       set spec = spec - 'back'
     where spec -> 'back' = 'null'::jsonb
  `.execute(db);
}
