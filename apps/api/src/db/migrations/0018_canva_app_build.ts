import { type Kysely, sql } from 'kysely';

// Which bundle the Canva Developer Portal is serving.
//
// The bundle is uploaded by hand into a field in the portal, and no Canva API
// reads it back -- so until now the only way to tell whether a release had
// landed was to compare a built file's timestamp against the log and guess.
// The bundle carries its own build and reports it when the app opens, which
// makes this a record of what ran rather than of what somebody meant to upload.
//
// One row per build, keyed on the commit it was built from. The portal serves
// one bundle at a time, so the row with the newest last_seen_at is the one that
// is live and the rest are the history of what has been.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('canva_app_build')
    .addColumn('commit', 'text', (col) => col.primaryKey())
    .addColumn('branch', 'text', (col) => col.notNull())
    // Reported, so a row cannot claim a commit whose tree the build never had.
    .addColumn('dirty', 'boolean', (col) => col.notNull())
    .addColumn('built_at', 'timestamptz', (col) => col.notNull())
    .addColumn('first_seen_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('last_seen_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex('canva_app_build_last_seen_idx')
    .on('canva_app_build')
    .column('last_seen_at')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('canva_app_build').execute();
}
