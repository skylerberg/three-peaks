import { type Kysely, sql } from 'kysely';

// A card described rather than drawn: a layout says where the frame, the art
// and each line of copy go, and a card's content is its own values for those
// slots. The image in the deck is rendered from the two, so changing a card's
// rules is a new version of that image rather than a new image from Canva.
//
// Safe beside the previous release because nothing it runs touches either
// table. The one refusing foreign key -- a card's layout -- refuses only a
// layout delete, and that release has no route that deletes one.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('card_layout')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('project_id', 'uuid', (col) =>
      col.notNull().references('project.id').onDelete('cascade')
    )
    .addColumn('name', 'text', (col) => col.notNull())
    // The card the coordinates are drawn on. A layout and the deck it renders
    // into have to agree, and the deck's size is millimetres too.
    .addColumn('width_mm', 'numeric(6, 2)', (col) => col.notNull())
    .addColumn('height_mm', 'numeric(6, 2)', (col) => col.notNull())
    // Fonts, icons, fields and elements, validated on the way in by ArkType
    // and layoutReferenceErrors, the way component_model.settings is.
    .addColumn('spec', 'jsonb', (col) => col.notNull())
    // Set null, not cascade like deck.created_by: cards name a layout with a
    // foreign key that refuses its delete, so a cascade here would leave an
    // account that made a layout in use unable to be deleted at all.
    .addColumn('created_by', 'uuid', (col) => col.references('app_user.id').onDelete('set null'))
    .addColumn('updated_by', 'uuid', (col) => col.references('app_user.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('card_layout_name_not_empty', sql`char_length(name) > 0`)
    .execute();

  await sql`
    create unique index card_layout_unique_name_in_project
      on card_layout (project_id, lower(name))
  `.execute(db);

  await db.schema
    .createTable('card_content')
    // One row per card image, the way component_model is one per source image:
    // the file is the card, so it is the whole address. Cascade, so a purged
    // card takes its copy with it; a soft delete touches neither.
    .addColumn('file_id', 'uuid', (col) =>
      col.primaryKey().references('file.id').onDelete('cascade')
    )
    .addColumn('project_id', 'uuid', (col) =>
      col.notNull().references('project.id').onDelete('cascade')
    )
    // No action rather than restrict: both are refusals, but no action is
    // checked at the end of the statement, so deleting a project -- which
    // cascades into the layouts and the cards together -- is not refused part
    // way through. Deleting one layout that a card still names is.
    .addColumn('layout_id', 'uuid', (col) =>
      col.notNull().references('card_layout.id').onDelete('no action')
    )
    .addColumn('fields', 'jsonb', (col) => col.notNull())
    .addColumn('updated_by', 'uuid', (col) => col.references('app_user.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // The refusal above, and "which decks use this layout", both look up by it.
  await db.schema
    .createIndex('card_content_layout_idx')
    .on('card_content')
    .column('layout_id')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('card_content').execute();
  await db.schema.dropTable('card_layout').execute();
}
