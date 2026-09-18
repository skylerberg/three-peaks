# three-peaks-hub

Board game design tools for Three Peaks Games, at **tools.threepeaksgames.com**.
A pnpm-workspace monorepo: a Hono + Kysely + Postgres API, a Svelte 5 + Vite
SPA, and a small Cloud Run edge that serves per-PR previews.

```
apps/api            Hono + Kysely + Postgres        -> GKE
apps/web            Svelte 5 runes + Vite SPA       -> GCS bucket behind a GCLB
apps/canva          React app inside Canva's editor -> a bundle uploaded to Canva
apps/cli            `threepeaks`, a Commander CLI  -> linked from the main checkout
apps/preview-edge   Cloud Run static edge           -> Cloud Run
packages/shared     generated API + realtime clients, and the constants both
                    sides must agree on
infra/terraform     the load balancer, buckets, certificates, monitoring
infra/k8s           raw manifests, {COMMITHASH} substituted by the deploy
tools/blender       the importer that opens an exported scene bundle
```

# Package manager

pnpm, pinned by `packageManager`. **`pnpm-workspace.yaml` carries every pnpm
setting** — pnpm 11 reads them from nowhere else, `.npmrc` is auth and registry
only, and package.json's `pnpm` field is ignored. **Keys are camelCase**; a
kebab-case key is dropped silently, with no warning and exit 0.

Two behaviours that differ from npm and have already cost time in the reference
repos this is modelled on:

- **`pnpm run x -- <arg>` forwards the `--` into argv**, where npm swallowed it.
  Under vitest that reads as end-of-options and everything after is ignored, so
  `pnpm test -- --shard=1/2` silently runs the whole suite in every shard and
  passes green. Write `pnpm test <path>`.
- **A dependency may not run install scripts unless `allowBuilds` names it**
  (`strictDepBuilds`), and a _denial_ has to be written down rather than left
  out — an omission and a glob both match nothing.

Two more that were learned here rather than inherited, both of which fail an
install or a build outright rather than degrading:

- **A version published in the last few days will not install.**
  `minimumReleaseAgeStrict` is the supply-chain gate that makes a compromised
  release published an hour ago a non-event, and it refuses with
  `ERR_PNPM_NO_MATURE_MATCHING_VERSION`. Write dependency ranges loose enough
  for pnpm to pick the newest version that has aged past it. Pinning an exact
  brand-new one forces an entry in `minimumReleaseAgeExclude`, which is
  precisely the protection being switched off. Watch for the transitive case:
  `vite` needs an `overrides` entry because the svelte and tailwind plugins
  peer-resolve it, and a peer-resolved package ignores the range you wrote.
- **An install that shrinks the dependency set wants to purge `node_modules`,
  and will not do it without a terminal.** Anywhere non-interactive — a
  container build, most obviously — it stops on
  `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`. Pass
  `--config.confirmModulesPurge=false` on that one command rather than turning
  the setting off workspace-wide; interactively the prompt is worth having.

**TypeScript is pinned to 6.0.3, not the 7.x that npm calls `latest`.**
typescript-eslint declares `typescript: >=4.8.4 <6.1.0` and svelte-check
declares `^5 || ^6`; adopting 7 silently costs type-aware linting and every
Svelte type check. Revisit when both peer ranges admit it.

# packages/shared, and the generation cycle

`packages/shared` is **source-only**: `exports` points at `.ts`, there is no
build step and no `dist/`. That is load-bearing. If it compiled, the order would
be build shared → dump the API spec (which imports shared) → rewrite shared's
source → rebuild — a real cycle. With no build, the generation edge is a plain
file write.

Two rules keep it that way, both enforced by eslint rather than by memory:

1. **`apps/api` may never import `@three-peaks/shared/api` or `/realtime`.**
   Those are generated _from_ the API.
2. **Nothing in `packages/shared` may import `node:*`, `hono`, `kysely` or
   `svelte`.** It is loaded by a Node server, a browser bundle and jsdom.

`pnpm run generate` dumps the spec and the realtime document and rewrites both
clients. The generated files are **committed**, so `apps/web` builds on a fresh
clone with no database, and so a breaking change to the API surface shows up as
a red diff in review. CI runs `pnpm run check:generated`, which regenerates and
fails on any diff — exact, because in one repo the spec is always the working
tree.

# API conventions

1. **All mutations run in a transaction.** `transactionMiddleware` wraps
   POST/PUT/PATCH/DELETE; handlers read `c.get('db')` and never import `db`.
   Hono's compose swallows a handler throw onto `c.error`, so the middleware
   rethrows it — without that, Kysely sees a clean return and commits the
   partial write. Side effects go on `c.get('postCommitHooks')`.
2. **Auth is global; opting out is a marker.** `app.use('*', authMiddleware)`,
   with `skipAuth` / `optionalAuth` matched by _handler identity_, and
   `assertPublicRoutes` failing the boot if the marked set drifts from the list
   in `apps/api/src/utils/assert-public-routes.ts`. A route that forgets auth
   cannot exist. Never `use('*', skipAuth)` on a sub-router — it matches every
   sibling sharing that mount prefix. **Session expiry is idle-based**:
   `SESSION_TTL_DAYS` is what a session gets from its last use rather than from
   its creation, and authenticating one past the halfway mark of that window
   slides its expiry forward — unawaited, on the pool, with the due check
   repeated in the UPDATE, exactly as `touchPersonalAccessToken` does and for
   the same reasons. Personal access tokens do not slide.
3. **Two Hono context types.** Handlers on an `AppHono` get a `user`; handlers
   on a `PublicHono` get `AuthenticatedUser | undefined`. Reading the user on a
   public route is a compile error. A router hosting both exports a second
   `PublicHono` for its public half.
4. **404 for a caller with no access; 403 only for a caller who can already read
   the row.** Centralised in `apps/api/src/services/authorization.ts`. Reads
   assert access, mutations assert write; a mutating route that asserts only
   access is a defect.
5. **Client-supplied ids on POST**, duplicate → 409, mapped from Postgres 23505
   via `isUniqueViolation` — a pre-check alone races.
6. **Re-export every schema from `apps/api/src/schemas/index.ts`.** The OpenAPI
   component-name registry reads that barrel; a schema left out appears inline
   and the generated client gets an anonymous duplicate instead of a named type.
   Only the outermost schema of a request or response is named, though — one
   nested inside another is inlined however it is exported, which is why the
   deck listing spells a deck out rather than referencing the named one.
7. Length limits in ArkType, not CHECK constraints. FKs cascade, except
   `project.created_by` and `file_version.created_by`, which are RESTRICT, and
   `file.deleted_by` / `folder.deleted_by`, which are SET NULL — an account
   going away must neither block itself on a tombstone nor take one with it.
8. **Query and path parameters are declared, not just read.** `c.req.query()`
   alone leaves them out of the spec, so the generated client cannot type them.
9. **Take `validator` and `resolver` from `hono-openapi`, never from
   `@hono/standard-validator` directly.** Both packages export a `validator`,
   the import looks equally reasonable either way, and the wrong one type-checks
   and validates requests correctly at runtime — it simply registers nothing in
   the spec. The symptom appears two steps away: a request body missing from
   `openapi.json`, and a generated client whose body is typed `never`. Response
   schemas have the same shape of trap; they have to be wrapped in `resolver()`
   or they are not schema objects at all.
10. Comments are minimal and explain only non-obvious _why_.

## Realtime

`/ws` rides the raw HTTP upgrade on the same server, and is deliberately never
part of the OpenAPI spec — it has no request or response to describe. Its types
are a second document at `GET /api/realtime-events.json`.

Three tables are pinned to each other: `eventCatalog.ts` says which types exist,
`payloads.ts` gives each one an **arktype schema** — the same schema the REST
route already answers with — and `closeCodes.ts` is the set a client must route
on. `publishAfterCommit` is generic over the type, so a payload that disagrees
with its row is a type error at the publish site.

**Every event carries what changed, and no consumer reloads to find out.** The
envelope is `{ type, project_id, data }`: the project id rides outside because
it is what delivery routes on, and a row that happens not to carry one would
reach nobody. Only a delete sends an id alone, because a deleted row is all the
id there is left.

Three rules keep it working, and all three were learned by getting it wrong:

- **A payload is a schema, never a TypeScript type.** An interface is gone by
  the time `realtime-events.json` is dumped, so a payload described by one can
  only be published as a list of field names — and a list of names can only
  describe strings. That is the whole reason this repo shipped a year of empty
  events and six screens that answered them by reloading. `document.ts` builds
  an OpenAPI 3.1 document from the schemas and `generate-clients.mjs` runs the
  same generator over it as over the API spec.
- **A payload carries what the screen draws, not only the row.** A file event
  carries `storage_used_bytes` because a row cannot move the explorer's meter; a
  component event carries the files it holds because the section draws a
  thumbnail per row. A payload that leaves one of those out sends the client
  back for it, which is the reload again wearing a smaller hat.
- **A screen that cannot place an event says so.** `files.apply` returns false
  and its caller reloads. The deleted listing is the standing example: an entry
  there carries a `path` and a `blocked_by` computed from the tombstoned tree
  above it, and one delete changes `blocked_by` for rows its event never names.
  `file_uploaded` is the other limit — no payload can carry the bytes.

The bus is in-process until `REDIS_URL` is set. **Subscribing is not
authorization**: a socket may name any project id, and delivery re-checks access
for every event — which is what makes membership removal take effect without a
reconnect. The same query re-checks the credential the socket authenticated
with, and closes it 4401 once that session or token is gone: revocation reaches
every replica at the next event with no message passed between them. A client
may also send `{ type: 'ping' }` and get a `pong`, because the server's own
heartbeat is a protocol ping that a WebSocket answers without telling its code;
a ping is checked against the credential too, so a quiet socket is not a way to
outlive one. The wire frame is `{ type, ...payload }`, flattened at the socket
boundary from the bus's `{ type, payload }`; an e2e test holds the two together.

## Migrations

Migrations are numbered files in `apps/api/src/db/migrations/`. Deploys are
rolling and the migrate Job runs **before** the rollout, so old and new pods
serve side by side. **Every migration must be backward-compatible with the
previous release** — drop or rename a column in a follow-up release.

**A migration's number has to be free on `main` when it merges, not when it was
written.** Kysely orders them by filename and refuses one that sorts before a
migration the database has already run, so two branches that both reach for the
same number ship a deploy that dies on `corrupted migrations`. Nothing upstream
of that catches it: the filenames differ, so the merge is clean, and every
database CI builds is empty, where all of them are pending and sorting decides
the order with nothing to contradict. The first database that has run the later
one is production, at deploy time. Rebasing is when to look, and
`tests/unit/pendingMigrations.test.ts` is what fails if you did not --
it reads the numbers off the tree and needs no database at all.

**A green CI run does not say the number is still free**, either: it was green
against whatever `main` was when it ran, and the merge ref GitHub computes goes
stale the moment `main` moves. The collision is semantic rather than textual, so
`mergeStateStatus` reads CLEAN through it. Re-read the folder on `origin/main`
immediately before merging -- this happened twice in a row on one branch, and
the second time the number that had been free an hour earlier was not.

`pnpm --filter @three-peaks/api run kysely-codegen` migrates a scratch database,
introspects that and drops it. It never reads the database you develop against;
introspecting that is how a column left behind by an abandoned branch gets
committed looking exactly like a real one.

## File versions

A file is the newest of a stack. `file_version` holds the stack and the current
version is **`max(version_number)`** — there is no pointer column, because a
pointer is a second answer to "which one is current" that can disagree with the
list itself.

`file` keeps `storage_key`, `content_type`, `byte_size`, `checksum` and the
image dimensions as a mirror of that newest version, for two reasons: a rolling
deploy leaves pods on the previous release reading those columns, and the
directory listing stays a single query. `appendFileVersion` writes every
`file_version` row and every later change to the mirror, inside the caller's
transaction; the only other writer is `/upload`, which inserts the `file` row
with its first set of values before handing over.

**History only grows.** A restore copies the old object to a new key and appends
that as a further version; nothing rewinds a number and no version row is ever
mutated. Bytes identical to the current version append nothing at all and say so,
which is what stops a re-import of an unchanged deck from writing a version per
card.

Two consequences that are easy to get wrong. The quota sums `file_version`, and
every path that deletes a file, a folder or a project has to collect **every**
version's key — the mirror names one object out of N and the rest would be
orphaned in the bucket with nothing pointing at them. And a row written before
this table existed has bytes and no version: the read paths present the mirror as
version 1, and the first append adopts it before adding anything, or that append
would overwrite the only reference to those bytes. Its bytes count nothing
towards the quota until that append, because the sum has no row to reach — the
one residual a pod on the previous release can still leave after the migration.

The 3D studio deliberately follows the current version. `component_model` is one
row per file, so a card that gains new artwork keeps the dial-in someone already
gave it.

## Where a file lives

**Every file has exactly one home**, and it is one of three: a deck, which owns
its cards and its back; a `component`, which owns its own source images; or the
folder tree, which is what belongs to neither. `file.deck_id`,
`file.component_id` and `file.folder_id` are the three columns, and two CHECKs
hold the rule: at most one owner, and no folder on a row that has one. Assets is
the owner-less case and is defined by it —
`unowned` in `apps/api/src/services/fileHome.ts` is the whole filter, and it is
why a three-hundred-card deck is no longer three hundred rows of the explorer.

`fileHome.ts` owns the dispatch, because every rule that used to be about a
folder is now about a home: what a name has to be unique within, what a tombstone
above it hides, which listing shows it. `resolveHome` is the one place a request
names a destination, and it answers 404 for one the caller cannot see.

It took two migrations to get here, and the split is the rolling-deploy rule
rather than a change of mind. 0009 gave every file an owner and deliberately
left `file.folder_id` populated, `deck_import.folder_id` in place and the copied
`component_model` rows alone, because the release it deployed beside read all
three. 0010 cleared them once that release was gone.
`pnpm --filter @three-peaks/api run verify:backfill` rehearses both against rows
shaped like the ones a project held before either, on a scratch database.

**A component is an owner; `component_model` is a property.** The `component`
table is the thing a person creates and names — a wooden piece, a box, a board, a
punchboard — and its settings live on it, because a punchboard's describe two
files and so cannot be keyed on one. `component_model` keeps one job and only
that job: the 3D dial-in for one image, which after this means a deck card.
`file.component_role` says which slot a file fills (`artwork` or `cut`), with a
partial unique index so a component holds at most one of each.

**A section is an order, and `component.position` is it** — per kind, because a
section is one kind and dragging a wooden piece must not move the box. It is not
unique: a tombstone keeps the number it had so a restore lands where it was, and
the name settles a collision on the way out. `PUT /api/components/order` takes
the whole section at once the way a deck's cards are replaced, and refuses
anything that is not exactly its live rows — a reorder arranges what is there
and is not a way to take something out of it. It writes `position` and nothing
else, so it publishes `component_order_changed` rather than a row update, and
that event carries the section whole because a list of ids would send every
screen holding it back for the names and artwork it already has.

**A deck's cards are exactly its own live images**, bar a back that is not itself
a card. `assertCardFiles` refuses both halves: a file the deck does not own would
be a card Assets still lists, and a live one left out would be artwork in the deck
with no place in it — a third state this arrangement has none of. That is also
why an upload into a deck writes its `deck_card` row, why an imported page joins
the deck as its bytes land rather than at finish, and why a restore gives a card
back a place through `ensureDeckCard` when the one it had is gone.

**A tombstoned card is one the deck may name and need not.** Deleting the image
keeps its `deck_card` row so a restore is exact, and the editor sends back the
list it was answered with — so refusing a tombstone there left a deck holding one
deleted card unable to change any card's copy count at all. An import removal is
the other direction: it takes the row as it tombstones the artwork, so a list
that cannot name that row has to be allowed to leave it out. Both jam the same
editor, from opposite sides, and 0015 is the repair for the decks that were
already stranded.

Moving is `POST /api/files/:id/move`, and it is the only way a home changes. The
name is re-deduplicated against wherever it arrives with `freeFilename`, because
a move must not fail on a clash nobody looking at either screen can see.

## Soft delete

`DELETE` is soft: it stamps `deleted_at` and keeps every stored object.
`?purge=true` is a separate, explicit act and the only path that reclaims bytes —
which is why it is the only branch reaching `deleteStoredObjectsAfterCommit`.

The four partial unique name indexes carry `deleted_at is null`, so a deleted
card's name is free again the moment it is deleted. Without that, re-importing a
card that came back in Canva would hit a 409 nothing could resolve.

Access checks deliberately ignore `deleted_at` — a tombstone's bytes and its
history are exactly what someone deciding whether to restore it reads first.
Listings filter it, and what a tombstone refuses is a write to its _contents_:
its name, its folder, or a new version. Purge and restore are writes of their
own, and so is `PUT /api/models/:fileId`, which stays allowed on one — a
component's settings are not the file.

**An owner's tombstone is never copied onto what it holds** — a folder's, a
deck's or a component's. Visibility is derived instead: a row is reachable only
while its own `deleted_at` is null _and_ nothing above it is deleted. That is
what makes restoring one exactly symmetric with deleting it, rather than
resurrecting rows somebody deleted one by one beforehand. A folder is a chain and
is walked; a deck and a component are one row each, because neither nests.

Two things follow from the walk, and both are load-bearing: a write target is
validated by walking that chain rather than by testing one column, because a live
folder inside a deleted one is ordinary and a row planted there would be visible
in no listing and recoverable by no route; and a walk that hits the depth bound
denies, because an unverified chain is not a clean one.

**That bound puts a cliff at 64 levels of nesting.** Past it every read of the
chain denies: `GET /directory` answers 404 where the release before this one
answered 200 with a partial breadcrumb, and creating a folder under a parent that
deep answers "Parent folder not found" for a parent that plainly exists. It is
the deliberate trade rather than something to fix by raising
`MAX_BREADCRUMB_DEPTH`, which would only move it — the alternative is trusting a
chain nothing has checked, and that is what leaves a deleted subtree browsable.

Tombstoned bytes still count against the quota. They are still stored, and only a
purge gets them back.

# Web conventions

Svelte 5 **runes only** (`runes: true` in `svelte.config.js`, so `export let`,
`$:` and svelte/store are compile errors). No SvelteKit, no state library, no
router library.

- Shared state is a class instance exported from a `*.svelte.ts` module.
- `src/lib/router.svelte.ts` is a hand-rolled History router with a
  discriminated-union `Route`. `beforeNavigate` **does not run on the initial
  page load** — `App.svelte` guards that once by hand, and renders nothing at
  all until that guard has run. Gating the first render on `session.status`
  instead is not the same thing and was a bug: the store leaves `unknown` a
  microtask before the guard redirects, and the screen that mounted in the gap
  fetched with a token that had just been cleared.
- Session status is four-valued. `offline` is a signed-in session whose token
  could not be _checked_; collapsing it into `anon` is what makes launching
  without a network land on the login screen with every store reset.
- The API client is same-origin (`baseUrl: ''`). There is no base URL to
  configure anywhere.
- Optimistic updates: apply, send, and on failure toast and refetch — never
  snapshot-rollback.
- **A download is a `<button>` calling `downloadFile`, never an `<a href>`.** The
  API takes its credential from the `Authorization` header only, and a
  browser-initiated GET sends none, so a plain link 401s silently. An anchor
  without a `download` attribute is also swallowed by the router's `use:link`.
- Styling uses the tokens in `src/app.css` (`bg-canvas`, `bg-surface`,
  `border-edge`, `text-ink`, `text-muted`, `bg-accent`). Never hardcode
  `gray-*`. Tap targets ≥ 44px (`min-h-11`).
- **A test that needs runes must be named `*.svelte.test.ts`.** Without the
  infix the runes are never compiled and the failure is silent: a `$derived`
  keeps handing back its first value.
- **A list somebody arranges is dragged by a handle**, and there are no up and
  down buttons left anywhere. `svelte-dnd-action` is the one dependency here
  that is neither Svelte nor Vite, and what it buys is the keyboard half: space
  or enter on the grip lifts a row, the arrows move it, escape puts it down.
- Three Svelte 5 traps: `$state` returns a _proxy_, so a value captured for later
  must be read back off the `$state` variable after assignment; **writing**
  `$state` during teardown silently does not survive, so bookkeeping that must
  outlive an unmount belongs in a plain binding; and **a prop read inside an
  `$effect` subscribes to whatever the parent's getter reads**, which inside a
  keyed each is the row rather than the value it yields. A list replaced with
  equal-valued rows — every save that shows its own response — then re-runs that
  effect for every item, key or no key. An effect doing real work off a prop
  reads it through a `$derived`, which compares by value and stops there;
  `Thumbnail.svelte` is the one that has to.
- **The card viewer is a hand-rolled modal, and holds its card by id.**
  `components/CardViewer.svelte` is the overlay three screens open when somebody
  clicks a card -- the deck editor and the two import-history screens. Not a
  native `<dialog>`: jsdom implements no `showModal`, which would leave the one
  component in the app with a focus trap and a key map covered by nothing. It
  keeps the focus, gives it back to whatever opened it, and answers keys on the
  window rather than on the panel, because clicking the artwork leaves the focus
  on nothing and a panel-level listener then stops answering. The open card is
  named by id: a save or a realtime event replaces the whole list, and a
  position would go on pointing at whatever moved into that slot -- so a card
  that leaves the list closes the viewer instead of quietly becoming its
  neighbour. Each screen hands over its rows in the order it drew them, with the
  version it drew them at, so the arrow keys walk the screen and a card opened
  from a run in February is February's artwork.

## Dragging a list into order

`apps/web/src/components/ui/DragHandle.svelte` is the grip, and
`apps/web/src/lib/dnd.ts` holds what every zone shares: the outline drawn around
one while a drag is live, and the flip duration. That duration is a rule rather
than a number — reduced motion takes it to zero, and `app.css` cannot say so on
its behalf, because its own block reaches CSS animations and these are Web
Animations.

A deck's cards and a components section are the two, and they are written alike
because the three awkward parts are the same on each:

- **What is drawn is a local copy of the store's list**, held from the moment a
  drag starts until the save that follows it answers. The store goes on applying
  realtime events under a live drag, and a screen that reads it back in between
  redraws the arrangement the drop replaced: the row jumps home, and forward
  again when the response lands.
- **The flag that holds that copy is a plain `let`.** Declared as `$state` it
  becomes a dependency of the effect doing the copying, so the drag ending
  re-runs it — the same jump, reached from the other side.
- **A keyboard drag ends on a `consider` carrying `DRAG_STOPPED`.** Its arrows
  finalize on every press, so a save hung off the finalize is a request and a
  broadcast per keystroke. A row dropped back where it came from is not a move
  and writes nothing at all.

`check:reorder` owns the gesture. jsdom has no pointer, no layout and no
animation, so a unit test can only hand a screen the events the library would
have dispatched; between a press on the grip and those events is covered there
and nowhere else.

# The 3D studio

Two screens, one studio. `/projects/:projectId/components/:componentId` dials in
a component someone has created and named; `/projects/:projectId/files/:fileId/3d`
dials in one card of one deck. `components/model3d/Studio.svelte` is the half
they share — the viewer, the export buttons, and the panel for the kind.

**The kind is not a choice.** A card is a member of a deck; a wooden piece, a
box, a board and a punchboard are components, each with a section of its own and
a kind fixed when it was created. The studio used to offer a picker that could
turn a card into a box, which is why it had to remember a settings object per
kind; nothing remembers anything now.

**All of it runs in the browser.** `apps/api` has no image or geometry
dependency; it recognises two more content types and stores a settings blob.
`apps/web/src/lib/model3d/` is reached only by `await import()`, so `three` —
larger than everything else in the bundle put together — stays in a chunk that
only this screen pays for.

- **Millimetres in the settings, metres in the file.** glTF's unit is the metre
  and every importer assumes it, so `MM` in `apps/web/src/lib/model3d/units.ts`
  is applied when geometry is built and never afterwards by scaling a node.
- **A bevel in `ExtrudeGeometry` grows the piece**: the outline it is handed
  becomes the flat face, and the bevel then pushes out past it in x and y and
  past the depth in z. `geometry/extrude.ts` offsets it inwards by its own size
  and takes it out of the depth, so a 63.5 mm card measures 63.5 mm. It exported
  63.66 mm before.
- **`ExtrudeGeometry` puts both lids in one group**, so a card's two faces cannot
  carry different artwork. `geometry/faceGroups.ts` repartitions the triangles
  into front, back and rim, and rewrites the cap UVs — which are world
  coordinates in metres otherwise, sampling one corner of the texture. Textures
  are exported with `flipY` off, as glTF requires, so the UVs are written to
  match; the two have to agree.
- **A vector source is already an outline.** An SVG's paths are parsed and
  extruded; only a raster is contour-traced. Rasterising an SVG to trace the
  raster back would throw away the exact edge.
- Textures are generated from seeded noise, never `Math.random()`: the same
  settings have to produce the same file twice.
- **A box is wrapped in one flat net**, not six per-face uploads: the row's own
  source image is unfolded by `boxNetRegions`, which the geometry's UVs and the
  guide the studio draws both read, so the diagram cannot disagree with what is
  sampled. Its six faces are six materials over that one texture, differing only
  in name — identical materials collapse into one glTF slot, and a face nobody
  can select is a face nobody can retouch in Blender. The net is the printer's
  cross, and nothing measures the image handed to it: a wrap drawn to other
  proportions exports without complaint, with every face sampling the rectangle
  next to the one it wanted.
- **A board's panels are separate meshes**, named in reading order and placed by
  their node translation, so the crease between two neighbours is the midpoint
  of their two positions — which is the hinge somebody folds it about by hand.
  The fold gap is cut out of the board rather than added to it.
- **A punchboard is two files: a printed sheet and an SVG cut sheet**, and the
  cut sheet _is_ the token layout — every closed path in it is one token, read
  by the `svgOutlines` the wooden pieces already use. Nothing is traced, because
  a die line is an outline already. The document's viewBox is stretched over the
  sheet's own millimetres, and that one mapping decides both a token's size and
  the rectangle of artwork it samples, so the two cannot disagree — the property
  `boxNetRegions` has for a wrap. `sheet_state` decides whether the sheet beside
  the tokens still holds them or is the frame left after punching; the tokens are
  exported either way.
- **`punchboardLayout` builds no geometry**, and `buildPunchboardPiece` builds
  one piece. The scene exports the sheet and each token as a file of its own, and
  extruding all of them once per file would be quadratic in the tokens on a
  sheet.
- The box is closed. An open one needs a wall thickness to line, which is a
  setting it has not got, so there is no interior colour to offer either.

Settings live in `component_model`, one row per source image, and the bounds the
API enforces are named once in `packages/shared/src/models3d.ts` so no input can
offer a value the server will reject.

# Decks, and printable sheets

A **deck** is an ordered list of card images with a copy count each, one card
size, and one image on the back. The order is `deck_card.position`, dragged into
place on the deck screen and replaced wholesale by every save. `/projects/:projectId/print` turns any selection
of decks into a US Letter PDF: cards packed as tightly as the paper allows, with
a backing page behind every sheet.

**Card sizes are Panda Game Manufacturing's**, in
`packages/shared/src/cards.ts`, and both features that size a card read that one
list — the 3D studio and the sheets. They are 63 × 88 rather than 63.5 × 88.9 on
purpose: a proof cut at home is then the same trim as the production order. The
guidebook's bleed, margin and corner radius live there too; the Letter proof
prints at trim and uses none of them.

A deck stores its size as **millimetres and nothing else**. The named size is
derived on read by matching those two numbers, for the same reason `file_version`
has no pointer column.

**A copy count may be zero**, and that is a third state beside taking the card
out of the list and deleting its image: the row keeps its place and its artwork,
and nothing physical is made of it. Every consumer that counts pieces rather than
rows honours it — no slot on a sheet and nothing on the Blender table, which
means no `.glb` in the bundle either. The bound is `DECK_QUANTITY_LIMITS` in
`packages/shared/src/decks.ts`, and the deck's own "N cards · M to print" is
where the two numbers come apart on screen. The print screen is where it is a
default rather than an instruction — see below.

**A card whose image is deleted is hidden, not dropped.** It prints nothing, so
the deck's totals leave it out — the editor's own and `card_count` /
`total_copies` on the row — the print screen does not list it, and the editor
draws it only once its overflow menu is asked to. The row is still held, and
`withHiddenCards` puts it back into every save at the slot it had: a save that
left it out would take its place and its copy count, and the restore would
bring it back at the end with one. Deleting or restoring a card publishes
`deck_updated` for the same reason — the totals moved even where the
arrangement did not, and the decks listing hears of a deck no other way.

**Deleting a deck is soft**, because a deck owns its artwork and so owns bytes.
It is tombstoned like a folder, `?purge=true` is the only path that reclaims, and
its cards are never marked — restoring the deck brings back exactly what was
there, and a card somebody deleted beforehand stays deleted. A card whose image
is merely deleted keeps its row and its place in the deck; only a purge takes it
out, through the foreign key.

## Sheets

`packages/shared/src/print.ts` is the whole layout, and it is pure: no DOM, no
bytes, no library. It knows nothing about decks, so a future token or tile
printer reuses it unchanged.

Two things there are worth knowing before changing anything:

- **`planGrid` tries the card turned as well as upright**, and a quarter turn is
  worth six cards a sheet on minis. Only two trials are needed, because turning
  the page instead of the card yields the same pair of products — so every page
  this emits is portrait.
- **`backPlacement` is where duplex is won or lost.** The printer's flip is what
  mirrors the page, so the back page is drawn as if read from the front with the
  slots transposed. Whether a back is also inverted depends on the card's own
  turn: a flip reverses one axis of the page, and the back turns over when that
  axis is the one its front's top lies along -- short edge for an upright card,
  long edge for one the grid has laid on its side.
- **The renderer draws every card through the grid's turn**, in the content
  stream rather than in the pixels. jsPDF rotates about the bottom-left corner
  of the box it is handed, and `imageArgs` in `apps/web/src/lib/print/pdf.ts`
  is that corner solved for each quarter turn; `check:print` reads the turned
  placements back out of a real file, because the first sheet of minis drew
  eighteen upright cards clipped to landscape cells and nothing measured it.

A sheet may hold cards from several decks, so the back is resolved per slot
rather than per sheet. That is what `check:print` exists to hold: it builds two
decks with different backs, generates the real PDF in a real browser, and reads
the placements back out of the content streams. Position alone would not catch
the bug — on a three-column grid an unmirrored backing page occupies exactly the
right set of boxes.

Sheets are planned inside a **printer margin**, 6.35 mm by default, because a
consumer printer will not lay ink nearer the edge than that and the outer row
would come out clipped. It is a setting rather than a constant: borderless
printing is worth half a sheet again on square cards.

## Building the file

All of it runs in the browser, like the 3D studio, and `apps/web/src/lib/print/`
is reached only by `await import()` — so jsPDF sits in a chunk only this screen
pays for and `apps/api` gains no PDF dependency.

- **jsPDF takes millimetres and a page size directly**, which is why the numbers
  the planner computes are the numbers it is handed. There is no unit layer.
- **Every image is embedded once and referenced by alias.** With copy counts the
  same artwork repeats constantly, and re-embedding it per slot is the difference
  between a four-megabyte file and a hundred-and-sixty-megabyte one.
- **Only JPEG is passed through untouched.** jsPDF decodes and re-encodes every
  PNG anyway, and its decoder refuses files a browser renders happily, so PNGs go
  through the canvas that already decoded them.
- jsPDF reaches for `html2canvas`, `canvg` and `dompurify` from methods this app
  never calls. They are refused by `ignoredOptionalDependencies` and aliased in
  `apps/web/vite.config.ts` to a stub that explains itself — a dynamic import is
  still a specifier Vite must resolve, so without the alias the build fails on a
  branch that cannot run.

## Printing only what has changed

`print_run` and `print_run_card` record what is already on paper: one row per
card per run, naming the version of the artwork that went through the printer
and the back it was given. A date on the deck would answer a different question
-- it could not tell a card somebody left out of the last run from one that came
off it.

`readOutstanding` in `apps/api/src/services/printRuns.ts` is the whole of the
comparison, and what the screen shows is one subtraction: the copies the deck
asks for, less the copies already on paper at the artwork this card carries now,
behind the back this deck gives it now. Four situations fall out of that rather
than being tested for -- a card nothing has printed, one whose artwork has been
re-imported, one whose deck has a new back, one whose copy count went up -- and
`reason` says which, because a badge reading "new artwork" is a different
instruction from one reading "2 more".

Three consequences are worth knowing before changing any of it:

- **Part runs add up.** Printing the shortfall on its own has to leave nothing
  owing, or a deck would ask for the same three cards every time.
- **A run with the backing pages switched off recorded no reverse**, and a
  reverse that was never printed cannot go out of date. Otherwise somebody
  printing fronts onto pre-backed stock is told the whole deck is owed, for ever.
- **The version is the client's to name.** `apps/web/src/routes/Print.svelte`
  draws each card at the number `GET /api/print/outstanding` handed it and
  records that same number, so the ledger describes the paper rather than
  whatever the file reached while jsPDF was working.

**A deck's copy count is what a run starts at, not what it prints.** Every card
on the print screen carries a field, `defaultCopies` in
`apps/web/src/lib/printRuns.ts` fills it -- from the deck under "everything
selected", from what is outstanding under "only what has changed" -- and what is
in it is what the sheets are packed from and what the ledger records. Three
things follow. A number somebody typed outranks the mode, so switching between
the two moves the fields still following their default and leaves the rest where
they were put; the deck row offers to put its own back, which is the only way a
typed number is forgotten short of leaving the screen. A card the deck holds
none of starts at none and can still be asked for, which is how the deck's back
is proofed as a card. And nothing here writes to the deck: the counts on the
deck screen are the persistent truth and this is one print job's opinion of
them, which is why a run that printed five of a card the deck asks two of leaves
it owing nothing rather than owing less than nothing.

Generating the document records the run, because building it is the act of
printing and a second button is a step to forget. `DELETE /api/print/runs/:runId`
is the jammed sheet: it removes the run rather than marking it, and the cards it
claimed go back to owing what they owed before. None of this publishes a realtime
event -- no other screen draws any of it, so there would be nothing to place.

## Importing a design

There is no import screen. The Canva app pushes the design it is open on, and
all the web app keeps is a way to clear a run left open — the deck screen names
Canva only while there is one, because a deck with no open run has nothing for
anybody to do here. Everything below is the API's half, which both ends of that
arrangement rest on.

It is a directory rather than a file, and the modules are the steps of a run in
order: `planning.ts` works out which page becomes which card, `start.ts` writes
that plan down, `page.ts` lands one image onto the card the plan named, `card.ts`
is the card row underneath it, and `finish.ts` is the two ways a run ends.
`binding.ts` is the `deck_import` row, `runs.ts` reads a run back, `history.ts`
answers what a finished one left, and `common.ts` is what more than one of them
needs. `index.ts` is the only thing the routes import.

- **A page is matched on three tiers, strongest first**: the page's own id, then
  its title, then its number. `planPages` runs them as three passes rather than
  one interleaved walk, because a weaker claim walked earlier would take the card
  a later page names outright. The plan says per row which tier caught it.
- **Every page of a manifest carries an id**, and a manifest without one is
  refused. The app reads the design and always has one, so the only thing an
  absent id could mean is a caller that has quietly dropped to matching on
  titles — which is worth a 422 rather than an import that lands weaker than it
  looks.
- **The page id is a column, not a fourth prefix on `identity_key`.** The two
  answer different questions and a card wants both. Folded into one column,
  taking the id would throw the title away — and the title is what places a page
  whose id this deck has never seen, which is what a design rebuilt somewhere
  else arrives as. `deck_import_card.source_page_id` is written by finishing,
  onto whatever card the page matched by whichever tier, so a deck placed by
  title once is placed by id from then on.
- **What a Canva page id survives was measured, not assumed**: a rename, a
  reorder, and being carried into a duplicate of the whole design, which keeps
  every id it copied. Duplicating a _page_ is what mints a new one, and the copy
  keeps the title — two pages named alike that only the id can tell apart.
- **Only `identity_key` is parked before it is rewritten.** A title moves between
  cards, so `applyPlannedIdentities` needs its two statements; a page id cannot,
  because the tier matching on it runs first and takes whatever card already
  holds it, leaving no other row wanting that id.
- **A manifest's pages are numbered 1..n, each exactly once**, and anything else
  is refused: the run's page count is the length of that list, and finishing
  checks the count rather than enumerating what landed. The app numbers them off
  the design's own page order, so a page deleted in Canva leaves no gap to
  reassign around.
- **A page titled "Back" is the deck's back rather than a card of it.**
  `isDeckBackTitle` in `packages/shared/src/imports.ts` folds the title the way
  an identity key is folded, so such a page is still matched, renamed and
  versioned like any other -- only the arrangement it lands in differs. It keeps
  a `deck_card` row, held at zero copies, rather than having none: the deck
  screen's back picker offers exactly the images the card list names, so a back
  with no row is one nobody could choose again. `is_back` rides on the plan,
  because taking a card's copies to zero is a change to the arrangement and the
  plan the app shows before uploading is where it has to be visible.
- **The deck comes out in the design's order.** Finishing a run numbers the
  `deck_card` rows off the pages of the export, so moving a page in Canva moves
  the card and an order somebody set by hand is undone by the next import. A
  copy count is not the design's to say and survives one. Whatever the export
  does not account for -- a card added by hand, one already deleted that the
  design has stopped naming -- trails the pages in the order it already had.
  Which order is the import's to decide and `renumberDeckCards` is what writes
  one, because what a dense zero-based arrangement is belongs to the deck: it
  renumbers every row rather than the pages alone, or two of them share a number
  and the listing's tie-break chooses between them. Every position written
  earlier in a run is provisional for the same reason.
- **Nothing turns a back back into a card.** A page that stops being titled Back
  keeps its card and the deck goes on pointing at it. This end cannot tell a
  back the import set from one somebody chose on the deck screen, and undoing
  the first would be the same statement about the second.
- **The plan names the cards it is about to remove**: `removed` is
  `{ file_id, name }[]` rather than a count, and each page carries the name of
  the card it matched. Tombstoning artwork is the destructive half of a
  re-import, and the confirmation step is the only place it can be seen coming.
  Do not work that list out in the client by diffing the deck against the plan:
  the server's matching includes a tie-break nothing there can see.
- **There is nothing to bind.** The deck owns its cards, so the deck is where an
  import lands and no folder is chosen first. `deck_import` survives to say what
  a deck was last imported from and whether a run is open, and `ensureImport`
  writes it on the first run rather than a person setting it up. A card that
  leaves the deck detaches its mapping row, which is what `detachMovedCards`
  now asks: not whether the file left a folder, but whether it left the deck.
- **`source_kind` is written and never read.** One source is left, so a value
  nothing branches on says nothing; the column is NOT NULL, which is why it is
  still written at all. Dropping it is a follow-up release's job, like any other
  column a live release still writes.
- **The deck screen scopes the import row it draws.** `bindingDeckId` says which
  deck the row belongs to, because the route block is not keyed: walking from one
  deck to another swaps props on the screen already mounted, and the open run on
  the row read for the deck just left would otherwise be offered for discarding
  under this deck's name.
- **Discarding an open run is the web app's, and finishing it is not.** A run
  outlives the Canva tab that opened it and the deck refuses every later import
  behind it, so the deck screen offers to abandon one. Nothing already imported
  is undone by that: the pages that landed keep the versions they wrote. That
  offer is the whole of the deck screen's import surface, which is why the row
  is still read for a deck nobody is importing into — the answer is what says
  whether to draw anything at all.
- **`GET /api/decks/:deckId/import` answers 404 for a deck nothing has been
  imported into.** It means "no history yet" rather than "set something up
  first", and the timeline beside it answers 200 with an empty list for the same
  deck — there is nowhere else the artwork could go, so having none is not a
  state anybody has to fix.
- **Pages go up one at a time.** Each request asserts the storage quota, so a
  parallel burst can have every one of them pass a check the set of them fails.
- Nothing is uploaded until someone has read the plan and pressed Import.
  Re-importing tombstones the cards the design has stopped having, which is too
  destructive to happen on a click.

### Reading the history back

`/projects/:projectId/decks/:deckId/history` lists the runs, opening one lists
what it did, and `GET /api/decks/:deckId/import/runs/:runId/deck` answers what
the imports had put in a deck as of one run: the newest ledger row per card at
or before it, minus what it removed. Only a **finished** run has an answer — an
open one has not removed anything yet, an abandoned one handed the deck nothing,
and both are 409, which is why the timeline offers that link on neither. Two
things it deliberately cannot say: a purged card is gone from the ledger
entirely, so the response carries a flag and never a count; and deck arrangement
— order, copies, the back — is rewritten wholesale on every edit and was never
versioned, so the screen is a gallery rather than an arrangement.

**Both reads of a run are scoped to the deck**, not to the project: the detail
sits at `GET /api/decks/:deckId/import/runs/:runId`, beside the as-of read, and
a run this deck does not own is 404 on either. One project holds several decks
with separate histories, and the screen puts this deck's name over whatever
comes back — cross-checking that in the browser would only be a second answer
free to disagree with the server's. The project-scoped path it replaced is still
registered, doing exactly what it always did, because the SPA ships as a cached
bundle and a tab on the previous release keeps calling it until it reloads. Drop
it a release later, the way a renamed column is dropped in a follow-up.

**Neither claim about the past is made from the present tense.** An abandoned
run is not a no-op — the pages that landed kept the versions they wrote — so the
timeline calls one a no-op only where `counts.pages` is zero. For the same
reason a card's tombstone travels as `image_deleted_at` and not a boolean: the
badge is a comparison against the run being read, and a file tombstoned before
that run was not deleted since it.

**Every thumbnail on a history screen is drawn at a version.** `Thumbnail` takes
one and appends `?version=` to the download it already fetches with the
credential. Without it a row from last month renders with today's artwork, which
is the single thing this whole feature exists not to do.

No browser probe reads a whole import round trip, because there is no screen to
drive one from — it happens inside Canva's editor. `apps/api`'s own e2e suite is
what imports one design twice and holds the second pass to leaving every card on
the version it already had, and `check:a11y` drives the same routes to give the
history screens a finished run to draw.

# The Canva app

`apps/canva` runs inside Canva's own editor and pushes the open design into a
deck, which is the only way anything is imported: nothing is downloaded and
nothing is uploaded by hand. It is React and
Canva's toolchain — the only package here that is neither Svelte nor Vite — and
it ships by **uploading a bundle to the Developer Portal**, touching no image,
no manifest and no Terraform. `pnpm canva:release` is the whole of a release:
it builds through `build:prod`, refuses the result if it names localhost, pushes
`canva-app.json`, and then prints the steps for the App source field, which is
the one part Canva exposes no API for. The plain `build` bakes in whatever
`CANVA_BACKEND_HOST` says, which locally is a localhost API.

It needs `CANVA_APP_ID` in `apps/canva/.env` and reads it nowhere else, because
that is the only place the Canva CLI looks — an id in the environment it is
spawned with does not reach it. The example carries the id, so `pnpm setup:env`
writes it and a fresh worktree can release without being told what it is. One
`.env` is only ever written from that example once, though, so a file that
predates the id still lacks it and `pnpm canva:release` says so with the line to
add.

**A bundle says which one it is, and the API records what it saw.** Canva
exposes no API for the App source field, so until this nothing on our side could
name what the portal was serving -- the answer was a built file's timestamp read
against the log, which is a guess. `canva-app.config.ts` defines `APP_BUILD` the
way the toolchain already defines `BACKEND_HOST`, the session exchange every app
load makes carries it, and `canva_app_build` keeps a row per build with when it
was first and last seen. The newest by `last_seen_at` is what is up there, and
older rows are the history. `pnpm canva:release` reads
`GET /api/canva-app/build` before it builds and says what is being served and
how far behind `main` it is; that route is public for the reason `/health` names
its own commit, since it identifies a release and says nothing about anybody.

The limit is worth knowing: **the record moves when a bundle runs, not when one
is uploaded.** An upload nobody has opened yet is invisible to it, which is why
the release ends by telling you to open the app and run the command again — and
why a 401 from that route means the release adding it has not gone out, rather
than anything about a credential.

**It authenticates by exchanging Canva's word for ours.** The app can prove
which Canva user is running it and nothing else, so somebody signed in here
spends a pairing code once and `canva_app_link` remembers. What comes back is an
ordinary session — the same credential login issues — which is why the app
drives the whole existing API and has no route surface of its own. `aud` pinned
to the app id is the only thing separating our tokens from any other Canva
app's, since every app's are signed by the same JWKS.

**The origin is derived from the app id**, not configured beside it:
`CANVA_APP_ID` decides both the audience checked and the `app-<id>.canva-apps.com`
origin CORS admits. Read off a running app rather than documented, so
`CORS_ORIGINS` can still name one the pattern fails to predict.

**Reading a design takes two APIs and neither answers alone.** `openDesign`
gives the order but a `PageRef` carries no id — that is on the `AbsolutePage`
its own helper dereferences one into — and `getDesignMetadata` gives ids with
titles in an order the documentation refuses to guarantee. They are joined by
id, never by position.

**An export missing pages is refused before a run opens.** The dialog lets a
person pick a subset and an `ExportBlob` is a bare `{ url }` naming no page, so
two blobs would line up against the first two of forty-seven by position: the
wrong artwork on those, the rest tombstoned, every step looking normal.

Two SDK traps, both written beside the call that hits them: `zipped` belongs on
the file type and is silently ignored on the request, and it is declared
optional but `{ type: 'png' }` alone is refused at runtime.

**The bytes never touch `apps/api`.** Canva's documentation says to download
export blobs from a backend; measured against the real thing the iframe can
fetch them, which is what keeps the API free of any outbound request and of the
allowlist one would otherwise need.

# The CLI

`apps/cli` is `threepeaks`, the terminal client, modelled on critical-path's
`cpath`. `apps/cli/README.md` is the reference for using it; this is for
changing it. It is a client of the HTTP API and of nothing else, and eslint
refuses an import of `apps/api` from its source.

**It has no generated client of its own.** It imports the committed one from
`@three-peaks/shared/api` and the realtime union from `/realtime`, and every
bound it checks before sending — upload size, copy counts, token names, card
sizes, settings defaults — comes from `packages/shared` rather than being typed
again. A number the server enforces therefore cannot drift here the way it can
in a client from another repository.

**Its tests are collected by `apps/api`'s vitest**, through a `../cli/tests`
include in `apps/api/vitest.config.ts`. The e2e half drives this app
in-process through the harness in `apps/cli/tests/e2e/helpers.ts`, so it needs
the test database like any API test, and a suite of its own would contend for
the same advisory lock. Run one file as
`pnpm --filter @three-peaks/api test cli/tests/e2e/deck`. `watch.test.ts` is
the one that serves a real port, because a socket cannot ride an in-process
fetch.

How a command is put together:

- `leaf()` gives a runnable command the global flags, `inProject()` adds
  `--project`, and `withCtx()` builds the context — config, credential store,
  API client, output — before the handler runs. Everything a command prints
  goes through `ctx.out`, which is what `--json` switches.
- `src/resolve.ts` is the only way a name becomes a row: one four-tier matcher
  (id, exact name, id prefix, unique substring) that stops at an ambiguous tier
  rather than falling through, and the Assets path walk, which matches whole
  segments only.
- `src/transfer.ts` owns every request whose body is a file — openapi-fetch
  would serialise one — and the batch rule the upload commands share.
- An argument's placeholder is what shell completion keys on: `<deck>`,
  `<card>`, `<file>` (a remote reference), `<path>` (a local one). Reuse the
  placeholder and completion comes for free.

`apps/cli/skill` is the Claude Code skill that drives it, linked into
`~/.claude/skills` by `pnpm --filter @three-peaks/cli run install:global`
together with the command itself. `tests/unit/skillCommands.test.ts` fails when
`skill/commands.md` and the program disagree about which commands exist.

Personal access tokens (`tph_…`) are minted, listed and revoked under
`/api/auth/tokens` for it, and authenticate exactly like a session. They have no
expiry: revoking one is how it ends.

# The Blender scene

`/projects/:projectId/scene` exports a ZIP — `assets/*.glb` and one `scene.json`
— that `tools/blender/import_scene.py` turns into a lit, keyframed Blender file.
What comes out is where the trailer shot starts, not where it finishes; the
whole feature exists so the manual half is arranging, not rebuilding.

The screen is a picker and stops there: tick decks and components, add library
pieces, choose a shot template, what it all stands on and a renderer, export. Components are picked by
name out of their sections rather than by browsing to the file underneath one,
and a component still waiting for its artwork is not offered — a tick that
cannot be built is only a failure deferred to Export. Every arrangement control
it could grow — a layout canvas, a timeline — is one Blender already has and
does better, and a tool built to hand work over should not spend its surface
area competing with what it hands to.

**Nothing here added a dependency.** The archive is written by
`apps/web/src/lib/scene/zip.ts`, and read back — in its tests only — by the
separate parser in `apps/web/src/lib/scene/testZip.ts`, which shares none of the
writer's arithmetic and so can actually disagree with it. Everything else this
screen needs is the studio's own
geometry, reached the way the studio reaches it — `apps/web/src/lib/scene/render.ts`
is the only module here that touches `three`, and only `await import()` reaches
that, so ticking a component costs nothing until Export is pressed.

**Nothing about a scene is stored.** No database table, no route, no migration,
and nothing in `apps/api` that knows the word: the exported bundle is the
record, and it is a pure function of what was ticked, the settings each of those
already has, one shot template and one setting to stand it in. Two exports of one selection
differ in `generated_at` and in nothing else, which is what lets a test compare
two archives byte for byte.

Three languages hold three separate jobs, and keeping them separate is the
design:

- **`packages/shared/src/scenes.ts` owns the document's shape and its bounds**,
  the way `models3d.ts` owns the studio's, so the exporter cannot write a shot
  the importer would refuse. It owns no shot maths whatsoever.
- **`tools/blender/shots.py` owns the maths**, and imports no `bpy`, so a shot
  is iterated with one file and one `python3` command. `scene.py`, `lighting.py`
  and `materials.py` are the only modules that touch Blender, and between them
  they work nothing out.
- **`apps/web/src/lib/scene/` owns the selection**: which `.glb` files there
  are, what stands where, which template ran. It computes no keyframes either.

`scripts/check-scene-contract.mjs` is what pins the first two together. Both
ends carry their own copy of every bound, because a browser bundle and Blender's
Python cannot share a file, and it reads both and fails on a disagreement — the
alternative being a bundle the exporter believed in and Blender refuses, which
surfaces two programs away from the edit that caused it.

**Sparse keys, and Blender interpolates.** Two or three keyframes a move, each
one a handle somebody can take hold of in the dope sheet. Bake a channel per
frame and it is no longer editable by a person at all, which would cost this
feature the half of the work it exists to make possible. `shots.py` has the
rule, and names the one place it is allowed to sample instead.

**One `.glb` per distinct component, instanced for every repeat.** A copy count,
an image used twice in a deck, a token picked in two places — all of them name
one file, and in Blender one mesh datablock. Two cards cut to one size with
different artwork cannot share a file, because an instance names a path and
nothing narrower. A punchboard is the one component that is several files: its
sheet and one per token, told apart by `part` on the selection, which is why
`assetKey` reads that as well as the images.

**A token's size comes from the die line, and the planner may not read one.**
Parsing an SVG needs three, and `assets.ts` is deliberately the half of this that
does not touch it — so the screen reads the layout behind its own `await import()`
and hands each part its `footprint` as data. `componentFootprint` sizes everything
else from its settings alone.

**A library piece has no file at all.** A die, a meeple, a cube, a disc and a
cylinder are built by `pieces.py` from a name, a size and a colour, so they cost
the bundle no bytes and stay editable as geometry rather than arriving as a
mesh.

**The table is scenery, and is the one thing in the document that is neither an
asset nor an instance.** `surface` names a finish, a colour and its millimetres,
and `tools/blender/stage.py` extrudes the profile — so it costs the bundle no
bytes either. It is kept out of the instances for two reasons that both bite:
a shot aimed at `scene` reaches every one of them, so a turntable would swing
the table under the cards; and `lighting.py` sizes the entire rig on what it is
handed, and a table is several times wider than anything standing on it, which
would push every lamp out of the room. Its top face is z = 0 — the plane every
piece already rests on — so a scene that gains one moves nothing that was in it.

**The backdrop is the table, curved.** `sweep_height_mm` rises off the far edge
through a fillet, one continuous surface, which is why nothing shows the corner
behind a component. `surfaceFor` in `apps/web/src/lib/scene/layout.ts` sizes it,
because that is the only end knowing both what was picked and where the template
left the camera: a backdrop has to fill the frame at its own distance, which is
further off than the subject and therefore wider than the subject's own span.
Two consequences are worth knowing before touching it. An orbit is given a flat
table, because the camera it circles on would otherwise pass behind the wall.
And a rim lamp would stand behind that wall, so `lighting.py` brings one forward
to it and lifts it by as much as holds its distance — which is where a back
light belongs on a sweep, and leaves the exposure it was given alone.

**Four finishes, because what tells a table from a coloured plane is how it
takes a light.** They live in `materials.py` beside the profiles the imported
components get, and only wood is given a grain: at the size of a tabletop the
other three are flat to the eye, and noise on them reads as dirt.

**A template frames its own camera**, through `frameCamera` in
`apps/web/src/lib/scene/layout.ts`, because only the template knows whether its
shots are about to move it: an orbit has to circle at the distance the still was
framed from, and a parade sweeps a line several times wider than the table it
came from. Two things that function settles are worth knowing before touching
it. It solves the distance against **both** halves of the frame — Blender fits
its sensor to the longer side, and a component lying on a table is deepest along
the axis a 16:9 render has least of, so fitting the horizontal alone crops every
card. And it chooses the f-number: framing pins the distance over the focal
length, which leaves the aperture as the only term in the depth of field, and
the stop a portrait wants leaves two millimetres of a 63 mm card sharp.

**Fanning, dealing and dropping are aimed at the decks.** All three collapse
what they are aimed at onto one small arc or grid — a hand of cards for a deck,
and a heap for a box and a board standing next to each other. `planScene` gives
every group its kind alongside its own patch of table, so a template can pick
the decks and size the arc to what it found.

**The document counts in millimetres and degrees; Blender counts in metres and
radians.** `scenedoc.MM` is the entire conversion, and like the studio's it is
applied as each value is written and never afterwards as a scale on a parent — a
factor sitting above an object is a second answer to how big that object is,
free to disagree with the numbers in the file it came from.

Two conventions the two ends have to agree on, and both are one constant each:

- **`position_mm` is where the asset's own origin goes**, and that origin is not
  the same point on both kinds. A `.glb` is built about its middle, so resting
  one on the table is half its own height up; a library piece is built standing
  on its origin and needs no lift. Only the end that builds the geometry knows
  which, which is why the arithmetic is on that side.
- **A `.glb` arrives standing up.** Every component is built in three's XY plane
  and extruded along +Z, and Blender's glTF importer bakes the Y-up to Z-up
  conversion into the vertex data — so a card lands on edge facing the camera,
  and `FLAT_ROTATION_DEG` in `layout.ts` is the quarter turn that lays it down
  with its top edge away. A box does not take it, and `restRotationDeg` is where
  that is decided: the axis it is extruded along is the one the printer's cross
  is folded about, so it exports standing on its base with its lid to the front.

**A mesh's name crosses the boundary as data.** A folded board exports one mesh
per panel, numbered in reading order and zero-padded to three digits by
`apps/web/src/lib/model3d/geometry/board.ts`, and the importer carries those
names onto the objects it builds: once the board is in Blender the numbering is
the only thing left that says which two panels a crease runs between. Nothing
downstream folds it — a person does, and this is what they take hold of.

**The bpy API is discovered by running Blender, never recalled.** The importer
targets 5.2 LTS, and three of the things a 4.x tutorial will confidently tell
you raise instead of degrading: keys live in a slotted action now, so
`Action.fcurves` is gone and a curve is reached through a layer's strip and the
channelbag of the slot the object is bound to; `BLENDER_EEVEE_NEXT` has stopped
being an engine name; and the Principled BSDF's Clearcoat, Specular, Subsurface
and Transmission sockets were all renamed. Introspecting is not the answer
either — the engine enum lists a single value on a build where `CYCLES` assigns
perfectly well — so a question here is settled with `--background --python-expr`
against the real binary, and the answer is written down beside the line that
depends on it.

`check:scene` is the only thing that reads a bundle whole. It exports one
through the real screen, follows the archive's own central directory to unpack
it, and opens every `.glb` inside — each unit test of that path hands the
exporter a stub renderer, because jsdom has neither a canvas nor a WebGL
context. Two claims are settled there and nowhere else: that a card asked for
six times is one file in the archive, and that each file spans the millimetres
its own settings asked for.

`tools/blender/smoke.sh` is the only thing that runs both halves. It builds a
fixture through Blender, renders a frame, and decodes the PNG rather than
trusting that one exists — a render of an unlit scene is a file on disk and an
exit code of zero. Its fixture is written in the conventions above deliberately:
a fixture that lays its own cards out some other way would keep passing after
the ones the exporter writes had drifted.

It needs Blender, so it is in no `check:*` script and no workflow — `check:all`
has to pass on a checkout with nothing else installed. `pnpm run blender:smoke`
is the name it answers to; run it by hand after anything under `tools/blender/`.
The half that is in the gate is `check:scene-shots`, which needs only `python3`.

# Running things

```sh
pnpm install && pnpm setup:env   # once per checkout or worktree
pnpm dev                         # api on :17310, web on :17300
```

**A second branch starts with `scripts/new-worktree.sh <branch> [base-ref]`**,
not with `git worktree add` by hand. It fetches before it branches, so the base
is not one commit behind whatever the lockfile policy now requires, and it
copies `apps/api/.env` and `.env.test` across — untracked, and every check fails
without them for reasons that have nothing to do with the branch.

Native Postgres 18 and Redis (`brew`), no Docker for development. `API_PROXY_TARGET`
moves the Vite proxy, which matters as soon as a second branch is in flight and
the main checkout already holds 17310.

`pnpm setup:env` writes `DB_USER` as your login name on macOS. Homebrew's initdb
names the superuser after you and creates no `postgres` role, which is what the
checked-in example says because that is what everything else gives you.

**Development ports are one block: web 17300, api 17310, preview 17320, the
browser probes 17330-17332, and the bundle probe 17333.** Not 3001 and 5173,
which every other project on the same laptop also defaults to — a sibling project's API answered here on 3001
for a while, and because its `/health` looks exactly like this one's, the browser
probes ran against it and failed fifteen seconds later inside a screen. The gaps
are deliberate: `pnpm dev` lets Vite walk upward from 17300 when a second
worktree is already running, and it has ten ports to walk before it reaches the
API. Deployment is unaffected — the container is pinned to 3001 by its Dockerfile
and its Deployment, and nothing in a container has to dodge anything.

**Run only the tests your change touches; let CI run the rest.**
`pnpm --filter @three-peaks/api test <path>` takes seconds. Reach for the whole
suite when a change is broad enough that you cannot name the files it affects,
and once before opening the PR.

The test database name is **derived, never configured**: `vitest.config.ts`
appends this checkout's directory name and a hash of its path, and both the
config and every forked worker assert it. That is what lets parallel worktrees
run the suite at once. `globalSetup` also takes a Postgres advisory lock, so a
second run in the _same_ checkout refuses to start rather than truncating out
from under the first.

# Checks

`pnpm run check:all` is the whole gate. Three parts of it are worth knowing:

- **`check:test-guards`** is mutation testing. Every entry under
  `scripts/test-guards/` names a bug and the edit that puts it back, and the
  named tests must **fail** with it in place. Nothing is written to the source
  tree — the edit rides in `GUARD_MUTATION` and is applied by a Vite transform.
  Each `find` must match **exactly once**: a pattern matching nothing leaves the
  source correct and the tests green, which is indistinguishable from a guard
  that works. Guards sharing a database run serially, because the advisory run
  lock refuses two suites against one database — correctly.
  **The entries are split one file per area, and that is about merging rather
  than tidiness**: a single list is one line every branch appends to, so any two
  branches that each add a guard conflict there and nowhere else. A new guard
  goes in the file its subject belongs to; `scripts/test-guards.mjs` is the
  loader, owns the rules for writing one, and refuses a name two files both
  hold — which a copy into the wrong area is what produces.
- **`check:bundle`** builds `apps/api/dist/index.mjs` and boots it. Everything
  else here reads the source tree or runs it through tsx, so the artefact the
  image actually starts was covered by nothing, and a bug that exists only once
  bundled took the deploy down for eight releases while the previous one went on
  serving. `apps/api/scripts/check-bundle.mjs` has the mechanism; the rule it
  leaves behind is that a CLI belongs in its own file, never at the top of a
  module the server imports.
- **`check:comments`** reads the prose and fails on the same sentence in two
  files, and on a repository path named in prose that no longer resolves. When
  it fires, give the rule one owner — the module that implements it — and cut
  the other copy down to what is local.
- **`check:a11y`** runs axe-core over the real screens in **both colour
  schemes**; half the tokens exist only under `prefers-color-scheme: dark`, so a
  light-only run reads none of them.
- **`check:k8s`** renders the manifests with a full-length SHA, the way the
  deploy does, and checks the name and label lengths that a client-side
  `kubectl --dry-run` silently accepts. It caught a migrate Job whose name was
  64 bytes; only the API server had been rejecting it, at deploy time.
- **`check:dockerfiles`** asserts that every path a Dockerfile COPYs survives
  `.dockerignore`. That mismatch is invisible to every other check — the API
  image copies the other packages' manifests, because pnpm reads the whole
  workspace to validate the lockfile even for a filtered install, and excluding
  those directories fails a line that reads perfectly well.

**All of these take `--selftest`**, which re-runs them against something
deliberately put back on the bug and fails if it still _passes_. They share a
failure mode a unit test mostly does not: measuring nothing and reporting green.
CI runs them without the flag; the flag is how you earn the right to believe
them.

**`check:scripts`** fails if any `check:*` script is run by neither `check:all`
nor a workflow. CI is a hand-copy of `check:all` — it fans out for a postgres
service, test sharding and image builds — so the two lists are exactly the thing
that drifts, and three probes sat in neither for a year with their `--selftest`
arms and their "fails under CI" contracts never once executing.

`check:upload` drives the real file picker in a real browser against a real API,
and `check:model3d` drives the studio and reads the `.glb` that comes out —
GLTFExporter needs a real canvas to serialise a texture, so nothing else covers
the step between "the vertices are right" and "a file Blender can open came
out". `check:reorder` presses a drag handle and walks the pointer far enough to
change places, which is the half of a reorder jsdom cannot hold an opinion
about. `check:a11y` reaches its one screen behind the session the same way.

They all need an API (`pnpm dev:api`), and they all interrogate it before a
browser starts rather than trusting the port. Nothing there skips locally and
fails under CI; something there that serves a different set of routes fails
everywhere, with the reason. `check:a11y` skips only the screens behind the
session, because it is in `check:all` and that has to keep passing on a checkout
with nothing else running.

**The branch is part of what is interrogated.** Two worktrees serve the same
name and the same routes on two ports, and whichever bound first is what answers
— so `inspectApi` compares `/health`'s branch against this checkout's and
refuses a mismatch outright, the way it refuses an older set of routes. That is
the case a green run is worst for: the probes pass, against somebody else's
code. A detached HEAD names nothing and is not compared, which is every CI
checkout.

**A skip is only ever a local kindness, and `REQUIRE_PROBES=1` withdraws it.**
Set it for a run whose result is going to be believed — before a PR, most
obviously — and an absent API fails the probe instead of being warned about,
exactly as it does under CI. The warning itself carries the word `SKIPPED`, so a
gate log that scrolled past it still answers `grep SKIPPED`; `probeRefusal` in
`apps/web/scripts/lib/session.mjs` is the one copy of all of this.

Those two guards are the same problem from opposite ends, and both are worth
having: `inspectApi` lets a probe refuse a server that cannot serve it, and the
branch and commit on `/health` let a person recognise one.

**Never run `prettier --write` or `eslint --fix` by hand.** `.githooks/post-commit`
runs both over the files each commit touched and amends the result in. The
consequence: `format:check` is only meaningful on a _committed_ tree — failing
it on uncommitted edits means nothing has fixed them yet. It stays in the gate
as the assertion that the hook actually ran.

`scripts/tmp-*` and `apps/*/scripts/tmp-*` are the sanctioned throwaway-probe
prefixes, ignored by git, eslint, vitest discovery and `check:comments`.

# Health, and which build is running

`GET /health` and `GET /` answer the same thing: `status`, plus `name`,
`environment`, `branch` and a short `commit`.

The status half reaches the database. Answering `ok` without it puts a pod that
cannot serve one request back into the load balancer's rotation — and liveness
is a TCP check rather than this one, so a database outage takes replicas out of
rotation without restart-looping every one of them at once.

The build half is `apps/api/src/config/buildInfo.ts`. In the cluster the deploy
substitutes `{BRANCH}` and `{COMMITHASH}` into `infra/k8s/deployment.yaml` as
`BUILD_BRANCH` and `BUILD_COMMIT`; there is no `.git` in the image, so nothing
else could tell the process what it is. Locally both are absent and it reads the
checkout instead, which is the case that earns its keep: two worktrees on two
ports are indistinguishable until one of them says which branch it is, and
`API_PROXY_TARGET` defaults to whichever already holds 17310.

`apps/api/src/utils/serverStartup.ts` is the other half of that. A bind failure
exits non-zero with a message naming the port — left to the default, `pnpm dev`
stays alive under `--watch` with nothing bound and the port answers from
whatever already owns it.

# Deployment

The SPA is a static bundle in a public GCS bucket behind a Terraform-managed
GCLB. The API runs in GKE, exposed through a **standalone NEG** created from the
Service annotation — there is no Ingress object anywhere. The URL map sends
`/api/`, `/ws` and `/health` to the API and everything else to the bucket, with
a catch-all rule rewriting 404 to `/index.html`; `/assets/` sits above it with
no error policy, because those names are content-hashed and a miss must stay a
404 rather than becoming HTML a `<script>` fails to parse.

`infra/terraform/README.md` has the bootstrap ordering. The one thing to know
before a first apply: **the NEG is created by GKE, so the first deploy has to
run before the `data` source resolves** — it is a two-pass apply.

Secrets are created once by hand. Workload Identity means the pod needs no key
file for GCS at all.
