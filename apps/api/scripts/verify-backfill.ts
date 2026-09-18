/**
 * Runs the migrations that rewrite existing rows against rows shaped like the
 * ones a project holds, on a scratch database of its own: 0009's homes backfill,
 * 0015's repair of deck cards that lost their place, and 0017 numbering a
 * section that until then had only its names.
 *
 * Not a `check:*` script and not in the gate: a backfill runs once, against
 * data no test fixture has. What this is for is the hour before that run --
 * point it at a restored dump's shape and see the answers it gives.
 *
 *   pnpm --filter @three-peaks/api run verify:backfill
 */
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { env } from '../src/config/env.ts';

const scratch = 'three_peaks_hub_backfill_probe';

function maintenance() {
  return new pg.Client({
    host: env.db.hostname,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.maintenanceDatabase,
  });
}

const setup = maintenance();
await setup.connect();
await setup.query(`drop database if exists "${scratch}"`);
await setup.query(`create database "${scratch}"`);
await setup.end();

// The CLI has no "migrate to": up goes to the latest and down steps back one.
// So this migrates the whole way, steps 0009 back off, plants rows shaped like
// the ones production holds, and runs 0009 forward over them.
function migrate(direction: 'up' | 'down' = 'up') {
  const result = spawnSync(
    'node',
    ['--import', 'tsx', 'src/db/migrate-cli.ts', ...(direction === 'down' ? ['down'] : [])],
    { stdio: 'inherit', env: { ...process.env, DB_DATABASE: scratch } }
  );
  if (result.status !== 0) throw new Error(`migrate ${direction} failed`);
}

// One connection of its own, opened and closed per question: the client below
// is not connected yet while this runs.
async function isApplied(name: string): Promise<boolean> {
  const probe = new pg.Client({
    host: env.db.hostname,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: scratch,
  });
  await probe.connect();
  try {
    const { rows } = await probe.query(`select 1 from kysely_migration where name = $1 limit 1`, [
      name,
    ]);
    return rows.length > 0;
  } finally {
    await probe.end();
  }
}

async function stepBackPast(name: string): Promise<void> {
  for (let step = 0; step < 40; step += 1) {
    if (!(await isApplied(name))) return;
    migrate('down');
  }
  throw new Error(`could not step back past ${name} in 40 migrations`);
}

const client = new pg.Client({
  host: env.db.hostname,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: scratch,
});

const problems: string[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) problems.push(name);
};

try {
  migrate();
  // Down until 0009 itself is gone, rather than a fixed number of steps: the
  // pair being rehearsed is no longer the last two, and counting was what made
  // this script silently rehearse the wrong thing the moment another migration
  // landed between them.
  await stepBackPast('0009_component_homes');
  await client.connect();

  // A project as it stands before this change: two folders, a deck whose cards
  // and back live in one of them, a wooden component dialled in on a loose
  // image, and two files that share a name in different folders.
  await client.query(`
    insert into app_user (id, email, name, password_hash, email_verified)
      values ('11111111-1111-4111-8111-111111111111', 'probe@example.com', 'Probe', 'x', true);
    insert into project (id, name, created_by)
      values ('22222222-2222-4222-8222-222222222222', 'Legacy', '11111111-1111-4111-8111-111111111111');
    insert into folder (id, project_id, parent_id, name, created_by) values
      ('33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222', null, 'Cards', '11111111-1111-4111-8111-111111111111'),
      ('44444444-4444-4444-8444-444444444444', '22222222-2222-4222-8222-222222222222', null, 'More', '11111111-1111-4111-8111-111111111111');
  `);

  const file = async (id: string, folder: string | null, filename: string) => {
    await client.query(
      `insert into file (id, project_id, folder_id, filename, storage_key, content_type, byte_size, uploaded_by)
       values ($1, '22222222-2222-4222-8222-222222222222', $2, $3, gen_random_uuid(), 'image/png', 10, '11111111-1111-4111-8111-111111111111')`,
      [id, folder, filename]
    );
    await client.query(
      `insert into file_version (id, file_id, version_number, storage_key, content_type, byte_size, created_by)
       values (gen_random_uuid(), $1, 1, gen_random_uuid(), 'image/png', 10, '11111111-1111-4111-8111-111111111111')`,
      [id]
    );
  };

  const CARDS = '33333333-3333-4333-8333-333333333333';
  const MORE = '44444444-4444-4444-8444-444444444444';
  await file('a0000000-0000-4000-8000-000000000001', CARDS, 'alpha.png');
  // Same name, different folder, and both end up cards of one deck: the pair
  // the per-deck name index would refuse without the rename in the backfill.
  await file('a0000000-0000-4000-8000-000000000002', MORE, 'alpha.png');
  await file('a0000000-0000-4000-8000-000000000003', CARDS, 'back.png');
  await file('a0000000-0000-4000-8000-000000000004', null, 'meeple.png');
  await file('a0000000-0000-4000-8000-000000000005', MORE, 'reference.png');
  // A wooden dial-in on a file that is also a card: the deck has to win.
  await file('a0000000-0000-4000-8000-000000000006', CARDS, 'both.png');

  await client.query(`
    insert into deck (id, project_id, name, card_width_mm, card_height_mm, back_file_id, created_by)
      values ('55555555-5555-4555-8555-555555555555', '22222222-2222-4222-8222-222222222222',
              'Base', 63, 88, 'a0000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111');
    insert into deck_card (id, deck_id, file_id, quantity, position) values
      (gen_random_uuid(), '55555555-5555-4555-8555-555555555555', 'a0000000-0000-4000-8000-000000000001', 1, 0),
      (gen_random_uuid(), '55555555-5555-4555-8555-555555555555', 'a0000000-0000-4000-8000-000000000002', 1, 1),
      (gen_random_uuid(), '55555555-5555-4555-8555-555555555555', 'a0000000-0000-4000-8000-000000000006', 1, 2);
    insert into component_model (id, project_id, source_file_id, settings, updated_by) values
      (gen_random_uuid(), '22222222-2222-4222-8222-222222222222', 'a0000000-0000-4000-8000-000000000004',
       '{"kind":"wood","longest_side_mm":30}', '11111111-1111-4111-8111-111111111111'),
      (gen_random_uuid(), '22222222-2222-4222-8222-222222222222', 'a0000000-0000-4000-8000-000000000006',
       '{"kind":"wood","longest_side_mm":40}', '11111111-1111-4111-8111-111111111111');
  `);
  await client.end();

  migrate();

  const after = new pg.Client({
    host: env.db.hostname,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: scratch,
  });
  await after.connect();

  const rows = (
    await after.query(
      `select id, filename, folder_id, deck_id, component_id, component_role from file order by filename`
    )
  ).rows;
  const byId = new Map(rows.map((row) => [row.id as string, row]));

  const card = byId.get('a0000000-0000-4000-8000-000000000001');
  check(
    'a deck card is owned by its deck',
    card.deck_id === '55555555-5555-4555-8555-555555555555'
  );
  check('its folder is cleared, so it is in one place and not two', card.folder_id === null);

  const back = byId.get('a0000000-0000-4000-8000-000000000003');
  check(
    'the deck back is owned by its deck',
    back.deck_id === '55555555-5555-4555-8555-555555555555'
  );

  const clash = byId.get('a0000000-0000-4000-8000-000000000002');
  check(
    'two cards that shared a name are renamed apart',
    clash.filename === 'alpha (2).png',
    String(clash.filename)
  );

  const component = (await after.query(`select id, kind, name from component`)).rows;
  check(
    'one component is made, for the dial-in that is not a card',
    component.length === 1,
    JSON.stringify(component)
  );
  check('it takes its kind from the settings', component[0]?.kind === 'wood');
  check('it is named after its file', component[0]?.name === 'meeple', String(component[0]?.name));

  const meeple = byId.get('a0000000-0000-4000-8000-000000000004');
  check('the component owns its artwork', meeple.component_id === component[0]?.id);
  check('in the artwork role', meeple.component_role === 'artwork');

  // The deck wins: a file in a deck's card list is a card, whatever settings
  // somebody once saved against it.
  const both = byId.get('a0000000-0000-4000-8000-000000000006');
  check(
    'a card with a wooden dial-in stays a card',
    both.deck_id !== null && both.component_id === null
  );

  const loose = byId.get('a0000000-0000-4000-8000-000000000005');
  check('an unowned file stays an asset', loose.deck_id === null && loose.component_id === null);
  check('and keeps the folder it was in', loose.folder_id === MORE);

  // 0010 deletes the dial-ins 0009 copied onto a component, and only those: the
  // one on a file that turned out to be a card was never copied, so the card
  // still has the settings somebody gave it.
  const dialIns = (await after.query(`select source_file_id from component_model`)).rows;
  check(
    'the superseded dial-in is gone and the card’s own survives',
    dialIns.length === 1 && dialIns[0].source_file_id === 'a0000000-0000-4000-8000-000000000006',
    JSON.stringify(dialIns)
  );

  const twoHomes = await after
    .query(`update file set folder_id = $1 where id = 'a0000000-0000-4000-8000-000000000001'`, [
      CARDS,
    ])
    .then(() => null)
    .catch((error: Error) => error);
  check(
    'a row claiming two homes is refused',
    twoHomes !== null,
    'the CHECK let a deck card keep a folder'
  );

  const dropped = (
    await after.query(
      `select column_name from information_schema.columns
      where table_name = 'deck_import' and column_name = 'folder_id'`
    )
  ).rows;
  check('the import row has no folder column left', dropped.length === 0);

  await after.end();

  // 0015, rehearsed on its own: a deck holding artwork with no place in its
  // list, which is what an import removal followed by a hand restore used to
  // leave behind. Planted after the whole set has run, then stepped back over
  // and run forward again -- the state it repairs cannot exist in the schema
  // 0009's fixture is written in.
  const planted = new pg.Client({
    host: env.db.hostname,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: scratch,
  });
  await planted.connect();

  const DECK = '55555555-5555-4555-8555-555555555555';
  const owned = async (id: string, filename: string, deletedAt: string | null) => {
    await planted.query(
      `insert into file (id, project_id, deck_id, filename, storage_key, content_type, byte_size, uploaded_by, deleted_at)
       values ($1, '22222222-2222-4222-8222-222222222222', $2, $3, gen_random_uuid(), 'image/png', 10,
               '11111111-1111-4111-8111-111111111111', $4)`,
      [id, DECK, filename, deletedAt]
    );
  };
  await owned('b0000000-0000-4000-8000-000000000001', 'stranded.png', null);
  await owned(
    'b0000000-0000-4000-8000-000000000002',
    'removed-by-import.png',
    new Date().toISOString()
  );
  await planted.end();

  await stepBackPast('0015_deck_card_places');
  migrate();

  const repaired = new pg.Client({
    host: env.db.hostname,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: scratch,
  });
  await repaired.connect();

  const cards = (
    await repaired.query(
      `select file_id, position, quantity from deck_card where deck_id = $1 order by position`,
      [DECK]
    )
  ).rows;
  const strandedCard = cards.find((row) => row.file_id === 'b0000000-0000-4000-8000-000000000001');
  check('live artwork with no place is given one', strandedCard !== undefined);
  check(
    'at the end of the list, one copy',
    strandedCard?.position === 3 && strandedCard?.quantity === 1,
    JSON.stringify(strandedCard)
  );
  check(
    'a tombstoned card the import removed is left out of the deck',
    !cards.some((row) => row.file_id === 'b0000000-0000-4000-8000-000000000002')
  );
  check(
    'the back is still not a card',
    !cards.some((row) => row.file_id === 'a0000000-0000-4000-8000-000000000003')
  );
  check('and nothing else was added', cards.length === 4, JSON.stringify(cards));

  await repaired.end();

  // 0017, rehearsed the same way: components as the release before it held
  // them, which is to say with no position at all. What the backfill has to be
  // is invisible -- every section comes back in the order its names already
  // gave it, and only a drag moves anything afterwards.
  const named = new pg.Client({
    host: env.db.hostname,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: scratch,
  });
  await named.connect();

  const PROJECT = '22222222-2222-4222-8222-222222222222';
  const plantComponent = async (name: string, kind: string, deletedAt: string | null) => {
    await named.query(
      `insert into component (id, project_id, kind, name, settings, created_by, deleted_at)
       values (gen_random_uuid(), $1, $2, $3, $4::jsonb, '11111111-1111-4111-8111-111111111111', $5)`,
      [PROJECT, kind, name, JSON.stringify({ kind }), deletedAt]
    );
  };
  // Inserted in an order that is neither the alphabet nor its reverse, and
  // cased against it: the index this replaces folded case, so a backfill that
  // sorts on the raw name puts every capital ahead of every lower-case one.
  await plantComponent('Zebra piece', 'wood', null);
  await plantComponent('acorn piece', 'wood', null);
  await plantComponent('Mallet', 'wood', null);
  // A tombstone is numbered too. Left out, it would come back at the head of
  // the section on the day somebody restored it.
  await plantComponent('deleted piece', 'wood', new Date().toISOString());
  await plantComponent('Big box', 'box', null);
  await plantComponent('Another box', 'box', null);
  // `meeple` is in this section too -- it is the component 0009 made out of a
  // loose dial-in, further up.
  await named.end();

  await stepBackPast('0017_component_order');
  migrate();

  const numbered = new pg.Client({
    host: env.db.hostname,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: scratch,
  });
  await numbered.connect();

  const sectionOf = async (kind: string) =>
    (
      await numbered.query(
        `select name, position from component where project_id = $1 and kind = $2 order by position`,
        [PROJECT, kind]
      )
    ).rows as { name: string; position: number }[];

  const wood = await sectionOf('wood');
  check(
    'a section is numbered in the order its names already read in',
    wood.map((row) => row.name).join(', ') ===
      'acorn piece, deleted piece, Mallet, meeple, Zebra piece',
    JSON.stringify(wood)
  );
  check(
    'from zero, one apart',
    wood.every((row, index) => row.position === index),
    JSON.stringify(wood)
  );

  const boxes = await sectionOf('box');
  check(
    'every section is numbered from its own start',
    boxes.map((row) => `${row.name}:${row.position}`).join(', ') === 'Another box:0, Big box:1',
    JSON.stringify(boxes)
  );

  await numbered.end();
} finally {
  const teardown = maintenance();
  await teardown.connect();
  await teardown.query(`drop database if exists "${scratch}"`);
  await teardown.end();
}

if (problems.length > 0) {
  console.error(`\n${problems.length} backfill assertion(s) failed`);
  process.exit(1);
}
console.log('\nbackfill probe passed');
