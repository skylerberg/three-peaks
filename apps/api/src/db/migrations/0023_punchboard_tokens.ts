import { type Kysely, sql } from 'kysely';

// A punchboard holds tokens now, each one a front and a back, rather than one
// uploaded sheet and a die line saying where the tokens were on it. The sheet
// and its die line are laid out from the tokens wherever they are needed, so
// neither is stored; a token's faces are files the punchboard owns, with the
// role `token`, and `component_token` is the list that says which file is
// which face of which token, how many of each, and in what order -- the way
// `deck_card` is a deck's.
//
// Rollout notes, since old and new pods serve side by side:
//
//  * `component_token` is new, so the previous release neither reads nor
//    writes it, and both its foreign keys point at rows that release deletes
//    -- one cascading and one nulling, so none of its deletes starts failing.
//  * The role CHECK only admits more: `token` joins `artwork` and `cut`, so
//    nothing the previous release writes is refused. `cut` goes in a later
//    release, once no pod can write one.
//  * The one-file-per-role index is narrowed to the roles that are slots,
//    which only ever admits more rows.
//  * The sheets and die lines punchboards already had are moved to the Assets
//    root rather than left on a component that no longer shows them: nothing
//    is lost, and their bytes stay where a person can find them. A pod on the
//    previous release then shows those punchboards waiting for their artwork,
//    which is the truth about them from here on.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('component_token')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('component_id', 'uuid', (col) =>
      col.notNull().references('component.id').onDelete('cascade')
    )
    // The front, and so the token: purging it takes the token out of the
    // list, the way purging a card's image takes it out of its deck.
    .addColumn('file_id', 'uuid', (col) => col.notNull().references('file.id').onDelete('cascade'))
    // The image printed behind it. Null leaves the board unprinted there, and
    // the front's own id prints the same image on both sides; anything else is
    // a file the punchboard owns that is no token's front. Set null, so purging
    // a back leaves the token standing with a blank reverse.
    .addColumn('back_file_id', 'uuid', (col) => col.references('file.id').onDelete('set null'))
    .addColumn('quantity', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('position', 'integer', (col) => col.notNull())
    .addUniqueConstraint('component_token_unique_file', ['component_id', 'file_id'])
    .addCheckConstraint('component_token_quantity_in_range', sql`quantity between 0 and 999`)
    .addCheckConstraint('component_token_position_non_negative', sql`position >= 0`)
    .execute();

  // Not unique, for the reason deck_card's is not: the list is rewritten
  // wholesale on every edit.
  await db.schema
    .createIndex('component_token_component_position_idx')
    .on('component_token')
    .columns(['component_id', 'position'])
    .execute();
  // Which token a back belongs to, asked whenever a file is checked for being
  // drawn from a layout.
  await db.schema
    .createIndex('component_token_back_idx')
    .on('component_token')
    .column('back_file_id')
    .execute();

  await sql`
    alter table file
      drop constraint file_component_role_known,
      add constraint file_component_role_known
        check (component_role is null or component_role in ('artwork', 'cut', 'token'))
  `.execute(db);

  await sql`drop index file_unique_component_role`.execute(db);
  await sql`
    create unique index file_unique_component_role
      on file (component_id, component_role)
      where component_id is not null and component_role in ('artwork', 'cut')
  `.execute(db);

  await retireUploadedSheets(db);
}

// What punchboards held before this: their sheets and die lines go to the
// Assets root, and their settings gain the token shape at its defaults.
// Exported so a test can run it over rows shaped like the old ones; run twice,
// it finds nothing left to move and no settings without the shape.
export async function retireUploadedSheets(db: Kysely<unknown>): Promise<void> {
  // Named after the punchboard and the slot they filled, with the start of
  // their id: two punchboards' sheets would otherwise both arrive as the same
  // filename at the root, and the root's name index refuses that.
  await sql`
    update file
       set folder_id = null,
           component_id = null,
           component_role = null,
           filename = left(regexp_replace(file.filename, '\\.[^.]+$', ''), 100)
             || ' (' || left(component.name, 80) || ', ' || file.component_role
             || ', ' || left(file.id::text, 8) || ')'
             || coalesce(substring(file.filename from '\\.[^.]+$'), '')
      from component
     where component.id = file.component_id
       and component.kind = 'punchboard'
       and file.component_role in ('artwork', 'cut')
  `.execute(db);

  await sql`
    update component
       set settings = settings || jsonb_build_object(
             'token_width_mm', 25,
             'token_height_mm', 25,
             'token_corner_radius_mm', 12.5,
             'token_gap_mm', 3,
             'margin_mm', 10
           )
     where kind = 'punchboard'
       and not settings ? 'token_width_mm'
  `.execute(db);
}

// A development affordance rather than a rollout mechanism, like 0013's: the
// faces of every token go to the Assets root, named the way `up` names a sheet,
// since the role they held is one the schema before this refuses.
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    update file
       set component_id = null,
           component_role = null,
           filename = left(regexp_replace(file.filename, '\\.[^.]+$', ''), 100)
             || ' (' || left(file.id::text, 8) || ')'
             || coalesce(substring(file.filename from '\\.[^.]+$'), '')
     where component_role = 'token'
  `.execute(db);

  await db.schema.dropTable('component_token').execute();

  await sql`drop index file_unique_component_role`.execute(db);
  await sql`
    create unique index file_unique_component_role
      on file (component_id, component_role)
      where component_id is not null
  `.execute(db);

  await sql`
    alter table file
      drop constraint file_component_role_known,
      add constraint file_component_role_known
        check (component_role is null or component_role in ('artwork', 'cut'))
  `.execute(db);

  await sql`
    update component
       set settings = settings - 'token_width_mm' - 'token_height_mm'
             - 'token_corner_radius_mm' - 'token_gap_mm' - 'margin_mm'
     where kind = 'punchboard'
  `.execute(db);
}
