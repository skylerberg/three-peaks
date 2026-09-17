import { type Kysely, sql } from 'kysely';

// The order somebody put a section's components in, which until now was their
// names. A section is a kind, so the order is per kind rather than per project:
// dragging a wooden piece cannot move the box.
//
// Backward compatible in the direction that matters. The previous release
// neither selects nor writes this column, so the migrate Job can run ahead of
// the rollout and both releases go on serving; what it does have is an insert
// with no position in it, which takes the default and lands at the head of its
// section rather than the tail. That is one rollout's worth of a component
// appearing first instead of last, against a NOT NULL with no default that the
// same insert would fail outright.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table component add column position integer not null default 0
  `.execute(db);

  // Their current order made explicit, so nothing moves the first time a
  // section is drawn from the new column. Tombstoned rows are numbered too: a
  // restore has to come back somewhere, and leaving them out would have put
  // every one of them at the head.
  await sql`
    update component
       set position = ordered.rank
      from (
        select id,
               row_number() over (partition by project_id, kind order by lower(name), id) - 1
                 as rank
          from component
      ) as ordered
     where component.id = ordered.id
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`alter table component drop column position`.execute(db);
}
