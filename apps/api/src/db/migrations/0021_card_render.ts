import { type Kysely, sql } from 'kysely';

// The API draws laid-out cards itself now, and a card can fall behind its
// picture without anyone touching it: its layout changes, or a font, an icon or
// a picture it draws gets a new version. A card in that state carries the time
// it was asked for, and the API pods work through those in the background. The
// row is the card, so a card that stops being drawn from a layout takes its
// request with it.
//
// Safe beside the previous release: every column is nullable or defaulted, and
// that release neither reads nor writes any of them. A layout it saves during
// the rollout asks for no render, which `threepeaks deck render` repairs.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('card_content')
    // Null while the image is the picture of the content. Set again by a later
    // request, so a render that started before it knows to go round once more.
    .addColumn('render_requested_at', 'timestamptz')
    // Whoever's change made the request, and so who the new version is by.
    .addColumn('render_requested_by', 'uuid', (col) =>
      col.references('app_user.id').onDelete('set null')
    )
    // A pod working on the card holds it until this time; one that dies
    // mid-render lets it go when the time passes.
    .addColumn('render_claimed_until', 'timestamptz')
    .addColumn('render_attempts', 'integer', (col) => col.notNull().defaultTo(0))
    // Why the card cannot be drawn as it stands -- copy that no longer fits a
    // changed layout, say. Not retried until something about the card changes.
    .addColumn('render_error', 'text')
    .execute();

  await sql`
    create index card_content_render_pending_idx
      on card_content (render_requested_at)
      where render_requested_at is not null and render_error is null
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('card_content')
    .dropColumn('render_requested_at')
    .dropColumn('render_requested_by')
    .dropColumn('render_claimed_until')
    .dropColumn('render_attempts')
    .dropColumn('render_error')
    .execute();
}
