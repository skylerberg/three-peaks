// AUTO-GENERATED FROM apps/api's OpenAPI spec. DO NOT EDIT.
// Regenerate with: pnpm run generate
//
// Committed on purpose: apps/web must type-check, build and run on a fresh
// clone with no database and no API process, and the diff is what makes a
// breaking change to the API surface visible in review.
export interface paths {
  '/api/auth/signup': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Create an account
     * @description Creates an account and returns a session token.
     */
    post: operations['postApiAuthSignup'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/auth/login': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Sign in
     * @description Exchanges an email and password for a session token.
     */
    post: operations['postApiAuthLogin'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/auth/forgot-password': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Request a password reset
     * @description Sends a reset link to an address that has an account. Answers 404 for one that does not.
     */
    post: operations['postApiAuthForgotPassword'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/auth/reset-password': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Set a new password from a reset link
     * @description Consumes a reset token. Rotating alternative_id is what makes the link single-use; sessions are deliberately left signed in.
     */
    post: operations['postApiAuthResetPassword'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/auth/me': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * The signed-in account
     * @description Returns the account the presented token belongs to.
     */
    get: operations['getApiAuthMe'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/auth/logout': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Sign out
     * @description Revokes the session the request was authenticated with.
     */
    post: operations['postApiAuthLogout'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/auth/sessions': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List active sessions
     * @description Every unexpired session for this account, newest first.
     */
    get: operations['getApiAuthSessions'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/auth/sessions/{id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    /**
     * Revoke a session
     * @description Signs out one session. Revoking the current one is allowed.
     */
    delete: operations['deleteApiAuthSessionsById'];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/auth/change-password': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Change password
     * @description Requires the current password. Leaves every session signed in, including this one, so no replacement token is issued.
     */
    post: operations['postApiAuthChangePassword'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/projects': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List projects
     * @description Every project the caller created or is a member of, with their role on each.
     */
    get: operations['getApiProjects'];
    put?: never;
    /**
     * Create a project
     * @description The creator is an implicit editor and is never stored as a member row.
     */
    post: operations['postApiProjects'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/projects/{id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get a project
     * @description Answers 404 rather than 403 for a project the caller cannot see.
     */
    get: operations['getApiProjectsById'];
    put?: never;
    post?: never;
    /**
     * Delete a project
     * @description Owner only. Cascades to members, folders and file rows.
     */
    delete: operations['deleteApiProjectsById'];
    options?: never;
    head?: never;
    /**
     * Update a project
     * @description Editors only. A viewer who can read the project gets 403.
     */
    patch: operations['patchApiProjectsById'];
    trace?: never;
  };
  '/api/projects/{id}/members': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List members
     * @description The creator is listed first and is always an editor.
     */
    get: operations['getApiProjectsByIdMembers'];
    /**
     * Add or change a member
     * @description Owner only. The creator cannot be added as a member of their own project.
     */
    put: operations['putApiProjectsByIdMembers'];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/projects/{id}/members/{userId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    /**
     * Remove a member
     * @description The owner may remove anyone; a member may remove only themselves.
     */
    delete: operations['deleteApiProjectsByIdMembersByUserId'];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/files/directory': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List one directory
     * @description The folders and files directly inside one directory, plus the breadcrumb to it and the project storage total. One request per screen.
     */
    get: operations['getApiFilesDirectory'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/files/deleted': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List what has been deleted
     * @description Flat, and each entry carries the path it came from — a deleted subtree has no live parent to browse into. A folder that was deleted does not list its contents: those rows were never deleted themselves, and restoring the folder brings them back with it.
     */
    get: operations['getApiFilesDeleted'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/files/folders': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Create a folder
     * @description Names are unique within a directory, compared case-insensitively.
     */
    post: operations['postApiFilesFolders'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/files/folders/{id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    /**
     * Delete a folder
     * @description Soft by default: the folder is tombstoned and nothing inside it is touched, which is what makes restoring it exact. `purge=true` is the irreversible one — it cascades to the whole subtree, live files included, and reclaims every stored object. Only the literal word is accepted, and repeating the parameter is a 400.
     */
    delete: operations['deleteApiFilesFoldersById'];
    options?: never;
    head?: never;
    /**
     * Rename or move a folder
     * @description A move that would put a folder inside itself is refused.
     */
    patch: operations['patchApiFilesFoldersById'];
    trace?: never;
  };
  '/api/files/folders/{id}/restore': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Restore a deleted folder
     * @description Takes an optional `name`, because the old one may have been taken while the folder was gone. Renaming first would leave a window in which the tombstone still held it. Whatever was deleted inside the folder separately stays deleted. Restoring a folder that is not deleted answers 200 and changes nothing.
     */
    post: operations['postApiFilesFoldersByIdRestore'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/files/upload': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Upload a file
     * @description The request body is the file itself; metadata travels in the query string. Serializing the bytes into JSON would read the whole file into memory on both ends.
     */
    post: operations['postApiFilesUpload'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/files/{id}/download': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Download a file
     * @description Served through the API rather than from a public bucket, because who may read the bytes depends on project membership. `version` selects one entry of the history; absent means the current one. Repeating the parameter is a 400 rather than a silent choice between the two values.
     */
    get: operations['getApiFilesByIdDownload'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/files/{id}/versions': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List a file's versions
     * @description Newest first. The current version is the highest number, flagged as is_current.
     */
    get: operations['getApiFilesByIdVersions'];
    put?: never;
    /**
     * Append a version
     * @description The request body is the bytes, as the upload route does it. Bytes identical to the current version answer 200 and create nothing.
     */
    post: operations['postApiFilesByIdVersions'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/files/{id}/versions/{number}/restore': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Restore a version
     * @description Copies that version forward as a new one. History only ever grows, so the number goes up rather than back. Restoring the version that is already current creates nothing.
     */
    post: operations['postApiFilesByIdVersionsByNumberRestore'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/files/{id}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Read one file row
     * @description A screen addressed by file id -- the 3D studio -- has to resolve the row on a cold load, before it knows which folder the file is in.
     */
    get: operations['getApiFilesById'];
    put?: never;
    post?: never;
    /**
     * Delete a file
     * @description Soft by default: the row is tombstoned and every version keeps its bytes, so a restore is exact. `purge=true` is the irreversible one and the only path that reclaims storage. Only the literal word is accepted, and repeating the parameter is a 400. A repeat delete answers 204 either way.
     */
    delete: operations['deleteApiFilesById'];
    options?: never;
    head?: never;
    /** Rename or move a file */
    patch: operations['patchApiFilesById'];
    trace?: never;
  };
  '/api/files/{id}/move': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Move a file to another home
     * @description Between Assets, a deck and a component, in either direction. The name is re-deduplicated against the destination, so a move never fails on a name the file cannot see. Arriving in a deck makes the file a card in it, or its back; leaving one takes it out of the arrangement.
     */
    post: operations['postApiFilesByIdMove'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/files/{id}/restore': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Restore a deleted file
     * @description Takes an optional `filename`, because the old one may have been taken while the file was gone. Renaming first would leave a window in which the tombstone still held it. Restoring a file that is not deleted answers 200 and changes nothing.
     */
    post: operations['postApiFilesByIdRestore'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/components': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List a project’s components
     * @description Optionally narrowed to one kind, which is what a section screen asks for. Each row carries its own files, so a section draws its thumbnails without a request per component.
     */
    get: operations['getApiComponents'];
    put?: never;
    /**
     * Create a component
     * @description Starts with no artwork: a component is named first and its images are uploaded into it afterwards, which is what `missing_roles` on the response reports. Settings default to the studio’s own defaults for the kind.
     */
    post: operations['postApiComponents'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/components/order': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    /**
     * Reorder a section
     * @description The whole ordered list of one kind in one request, the way a deck’s cards are replaced. The ids have to be exactly the section’s live components, each once: a reorder arranges what is there and can neither add nor remove anything, so anything else is a client working from a listing that has moved on.
     */
    put: operations['putApiComponentsOrder'];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/components/{componentId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get one component
     * @description Including a tombstoned one: its settings and its artwork are what somebody deciding whether to restore it reads first.
     */
    get: operations['getApiComponentsByComponentId'];
    put?: never;
    post?: never;
    /**
     * Delete a component
     * @description Soft by default: the component is tombstoned and its artwork keeps every byte, so restoring it is exact. `purge=true` is the irreversible one — it takes the artwork with it and reclaims every stored object. Only the literal word is accepted.
     */
    delete: operations['deleteApiComponentsByComponentId'];
    options?: never;
    head?: never;
    /**
     * Rename a component or save its settings
     * @description Editors only. Both fields are optional; an absent one is left alone. Allowed on a tombstoned component, the way a deleted file’s 3D settings are — a component’s dial-in is not its contents.
     */
    patch: operations['patchApiComponentsByComponentId'];
    trace?: never;
  };
  '/api/components/{componentId}/restore': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Restore a deleted component
     * @description Brings the component back with whatever artwork it still has. Artwork deleted on its own stays deleted — a tombstone above a row is not a tombstone on it. Restoring a live component answers 200 and changes nothing.
     */
    post: operations['postApiComponentsByComponentIdRestore'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/models/{fileId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Read the 3D settings for an image
     * @description Answers 404 when the image has never been dialled in, which is how the studio knows to start from the defaults.
     */
    get: operations['getApiModelsByFileId'];
    /**
     * Save the 3D settings for an image
     * @description Editors only. There is one settings row per image, so this upserts rather than conflicting.
     */
    put: operations['putApiModelsByFileId'];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/decks': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * List the decks in a project
     * @description Each deck carries how many distinct cards it holds and how many pieces of card those add up to, so the screen needs no follow-up request per deck. The cards themselves come from the single-deck route.
     */
    get: operations['getApiDecks'];
    put?: never;
    /**
     * Create a deck
     * @description Starts empty. Cards are added with the card-list route.
     */
    post: operations['postApiDecks'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/decks/{deckId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Get a deck and its cards
     * @description Cards come back in print order, each with the whole file row behind it. A card whose image has been deleted is still listed — restoring the image puts it back in the run.
     */
    get: operations['getApiDecksByDeckId'];
    put?: never;
    post?: never;
    /**
     * Delete a deck
     * @description Soft by default: the deck is tombstoned and its artwork keeps every byte, so a restore is exact. `purge=true` is the irreversible one — it takes the cards with it and reclaims every stored object. Only the literal word is accepted.
     */
    delete: operations['deleteApiDecksByDeckId'];
    options?: never;
    head?: never;
    /**
     * Update a deck
     * @description Editors only. Every field is optional; an absent one is left alone.
     */
    patch: operations['patchApiDecksByDeckId'];
    trace?: never;
  };
  '/api/decks/{deckId}/restore': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Restore a deleted deck
     * @description Brings the deck back with whatever cards it still has. A card deleted on its own stays deleted — a tombstone above a row is not a tombstone on it. Restoring a live deck answers 200 and changes nothing.
     */
    post: operations['postApiDecksByDeckIdRestore'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/decks/{deckId}/cards': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    /**
     * Replace a deck’s cards
     * @description The whole ordered list in one request. Position is the array index, so adding, removing and reordering are the same call and none of them can interleave with another.
     */
    put: operations['putApiDecksByDeckIdCards'];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/decks/{deckId}/import': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Read a deck's import history marker
     * @description What this deck was last imported from, and whether a run is open. 404 means it has never been imported into — the artwork goes into the deck itself, so there is nothing to set up first.
     */
    get: operations['getApiDecksByDeckIdImport'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/decks/{deckId}/import/runs': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Read a deck's import history
     * @description Newest first, and empty for a deck that has never been imported into — there is nothing to set up first, so having no history is not an error. Counts are derived from each run’s own rows rather than cached.
     */
    get: operations['getApiDecksByDeckIdImportRuns'];
    put?: never;
    /**
     * Start an import run
     * @description Takes the whole export up front — every page number and title — and answers with the plan it computed: which pages land on cards that already exist, which are new, and which cards the export has stopped having, by name. Nothing is matched again while the pages upload. One run at a time per deck; a second answers 409 and names the open one, which is the only route back to abandoning it.
     */
    post: operations['postApiDecksByDeckIdImportRuns'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/decks/{deckId}/import/runs/{runId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Read one import run
     * @description The run and a row per card it touched. A row whose image has since been purged keeps the name and the page number it had. Scoped to the deck, like the as-of read beside it: a run of another deck is 404 here rather than another deck's history under this one's name.
     */
    get: operations['getApiDecksByDeckIdImportRunsByRunId'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/decks/import/runs/{runId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * Read one import run, without naming its deck
     * @description Superseded. Answers whatever run the caller can reach in their project, which is what it always did; the deck-scoped route is the one that can refuse a run belonging to another deck.
     */
    get: operations['getApiDecksImportRunsByRunId'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/decks/{deckId}/import/runs/{runId}/deck': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * The cards this deck held after one import
     * @description Per card, the newest ledger row at or before that run, minus the cards it removed. Only a finished run has an answer: an open one has not removed anything yet and an abandoned one handed the deck nothing, and both are 409. A card whose image was purged cannot be recovered from the ledger at all and is reported as a flag rather than a row.
     */
    get: operations['getApiDecksByDeckIdImportRunsByRunIdDeck'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/decks/import/runs/{runId}/pages': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Import one page of an export
     * @description The request body is the page image itself and its metadata travels in the query string, the way the upload route does it. The page has to be one the run planned; its title names the file and decides nothing else. Posting the same page twice answers 200 with what happened the first time.
     */
    post: operations['postApiDecksImportRunsByRunIdPages'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/decks/import/runs/{runId}/finish': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Finish an import run
     * @description The only destructive step: it applies the identities the plan decided, tombstones every card no page was planned onto, and hands the deck what it created. Refuses until every page the run declared has landed, and refuses with 422 if a hand edit has pushed the deck past its card cap while the run was open.
     */
    post: operations['postApiDecksImportRunsByRunIdFinish'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/decks/import/runs/{runId}/abandon': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Abandon an import run
     * @description Leaves everything already imported in place. Nothing is tombstoned, nothing is undone, and the deck is not touched.
     */
    post: operations['postApiDecksImportRunsByRunIdAbandon'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/print/outstanding': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * What each card still owes the printer
     * @description Every live card of every live deck in the project, with how many copies are already on paper at its current artwork and current back, and how many are not. A card owes copies because nothing has printed it, because its artwork has been re-imported since, because the deck was given a new back, or because its copy count went up — four situations and one subtraction, and `reason` says which.
     */
    get: operations['getApiPrintOutstanding'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/print/runs': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Record what came off the printer
     * @description Written after the document has been built, and it names the version of each card that went into it — the client is the only end that knows which bytes it drew. Recording is what makes the next run able to leave those cards out.
     */
    post: operations['postApiPrintRuns'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/print/runs/{runId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    /**
     * Undo a recorded print run
     * @description For the sheet that jammed. The run is removed rather than tombstoned — a claim that certain cards are on paper, withdrawn, was never true — and the cards it named go back to owing what they owed before it.
     */
    delete: operations['deleteApiPrintRunsByRunId'];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/canva-app/session': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Exchange a Canva app token for a session
     * @description The Canva app proves which Canva user is running it and nothing more. Where that user has been linked to an account here, this answers with an ordinary session — the same credential login issues, so the app then uses the whole API as any other client does and needs no surface of its own. Where they have not, it answers 200 with a pairing code for somebody signed in here to spend, because a valid token belonging to a stranger is not an authentication failure. `switch_account` asks for a code regardless, which is how somebody signed into the wrong account fixes it without leaving Canva.
     */
    post: operations['postApiCanvaAppSession'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/canva-app/pair': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /**
     * Link the Canva app to this account
     * @description Spends the code the app is showing. This is the one request in which both identities are present — the Canva user in the code, and the account in the token — which is the whole reason a person has to make it. A code that has expired, been spent, or never existed answers the same 404: eight characters of a small alphabet is worth guessing at if the response says which.
     */
    post: operations['postApiCanvaAppPair'];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/canva-app/links': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /**
     * The Canva accounts linked to this one
     * @description Newest first. A link is a standing grant, so it is listable and revocable.
     */
    get: operations['getApiCanvaAppLinks'];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  '/api/canva-app/links/{linkId}': {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    /**
     * Unlink a Canva account
     * @description The app falls back to asking for a pairing code the next time it is opened. Sessions it was already given are not revoked by this — those are ended from the sessions list, like any other.
     */
    delete: operations['deleteApiCanvaAppLinksByLinkId'];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
}
export type webhooks = Record<string, never>;
export interface components {
  schemas: {
    AuthResponse: {
      expires_at: string;
      token: string;
      user: {
        email: string;
        email_verified: boolean;
        id: string;
        name: string;
      };
    };
    CanvaAppLink: {
      canva_brand_id: string | null;
      created_at: string;
      id: string;
      last_used_at: string | null;
    };
    CanvaAppLinkList: {
      links: {
        canva_brand_id: string | null;
        created_at: string;
        id: string;
        last_used_at: string | null;
      }[];
    };
    CanvaAppSession:
      | {
          expires_at: string;
          /** @constant */
          linked: false;
          pairing_code: string;
        }
      | {
          expires_at: string;
          /** @constant */
          linked: true;
          token: string;
          user: {
            email: string;
            email_verified: boolean;
            id: string;
            name: string;
          };
        };
    Component: {
      created_at: string;
      created_by: string;
      deleted_at: string | null;
      files: {
        file: {
          byte_size: number;
          component_id: string | null;
          component_role: string | null;
          content_type: string;
          created_at: string;
          deck_id: string | null;
          deleted_at: string | null;
          filename: string;
          folder_id: string | null;
          id: string;
          image_height: number | null;
          image_width: number | null;
          name_locked: boolean;
          project_id: string;
          updated_at: string;
          uploaded_by: string;
        };
        /** @enum {unknown} */
        role: 'artwork' | 'cut';
      }[];
      id: string;
      kind: string;
      missing_roles: ('artwork' | 'cut')[];
      name: string;
      position: number;
      project_id: string;
      settings:
        | {
            back_color: string;
            edge_color: string;
            height_mm: number;
            /** @constant */
            kind: 'punchboard';
            seed: number;
            /** @enum {unknown} */
            sheet_state: 'intact' | 'punched';
            thickness_mm: number;
            width_mm: number;
          }
        | {
            bevel_mm: number;
            grain_color: string;
            grain_scale: number;
            /** @constant */
            kind: 'wood';
            longest_side_mm: number;
            printed: boolean;
            seed: number;
            simplify_tolerance: number;
            thickness_mm: number;
            /** @enum {unknown} */
            trace_source: 'alpha' | 'luminance';
            trace_threshold: number;
            wood_color: string;
          }
        | {
            corner_bevel_mm: number;
            depth_mm: number;
            height_mm: number;
            /** @constant */
            kind: 'box';
            seed: number;
            width_mm: number;
          }
        | {
            edge_color: string;
            /** @enum {unknown} */
            fold: 'bifold' | 'none' | 'quadfold';
            fold_gap_mm: number;
            height_mm: number;
            /** @constant */
            kind: 'board';
            seed: number;
            thickness_mm: number;
            width_mm: number;
          };
      updated_at: string;
    };
    ComponentList: {
      components: {
        created_at: string;
        created_by: string;
        deleted_at: string | null;
        files: {
          file: {
            byte_size: number;
            component_id: string | null;
            component_role: string | null;
            content_type: string;
            created_at: string;
            deck_id: string | null;
            deleted_at: string | null;
            filename: string;
            folder_id: string | null;
            id: string;
            image_height: number | null;
            image_width: number | null;
            name_locked: boolean;
            project_id: string;
            updated_at: string;
            uploaded_by: string;
          };
          /** @enum {unknown} */
          role: 'artwork' | 'cut';
        }[];
        id: string;
        kind: string;
        missing_roles: ('artwork' | 'cut')[];
        name: string;
        position: number;
        project_id: string;
        settings:
          | {
              back_color: string;
              edge_color: string;
              height_mm: number;
              /** @constant */
              kind: 'punchboard';
              seed: number;
              /** @enum {unknown} */
              sheet_state: 'intact' | 'punched';
              thickness_mm: number;
              width_mm: number;
            }
          | {
              bevel_mm: number;
              grain_color: string;
              grain_scale: number;
              /** @constant */
              kind: 'wood';
              longest_side_mm: number;
              printed: boolean;
              seed: number;
              simplify_tolerance: number;
              thickness_mm: number;
              /** @enum {unknown} */
              trace_source: 'alpha' | 'luminance';
              trace_threshold: number;
              wood_color: string;
            }
          | {
              corner_bevel_mm: number;
              depth_mm: number;
              height_mm: number;
              /** @constant */
              kind: 'box';
              seed: number;
              width_mm: number;
            }
          | {
              edge_color: string;
              /** @enum {unknown} */
              fold: 'bifold' | 'none' | 'quadfold';
              fold_gap_mm: number;
              height_mm: number;
              /** @constant */
              kind: 'board';
              seed: number;
              thickness_mm: number;
              width_mm: number;
            };
        updated_at: string;
      }[];
    };
    ComponentModel: {
      created_at: string;
      project_id: string;
      settings:
        | {
            back_color: string;
            back_file_id:
              | string
              | '00000000-0000-0000-0000-000000000000'
              | 'ffffffff-ffff-ffff-ffff-ffffffffffff'
              | null;
            bevel_mm: number;
            corner_radius_mm: number;
            height_mm: number;
            /** @constant */
            kind: 'card';
            seed: number;
            stock_color: string;
            thickness_mm: number;
            width_mm: number;
          }
        | {
            back_color: string;
            edge_color: string;
            height_mm: number;
            /** @constant */
            kind: 'punchboard';
            seed: number;
            /** @enum {unknown} */
            sheet_state: 'intact' | 'punched';
            thickness_mm: number;
            width_mm: number;
          }
        | {
            bevel_mm: number;
            grain_color: string;
            grain_scale: number;
            /** @constant */
            kind: 'wood';
            longest_side_mm: number;
            printed: boolean;
            seed: number;
            simplify_tolerance: number;
            thickness_mm: number;
            /** @enum {unknown} */
            trace_source: 'alpha' | 'luminance';
            trace_threshold: number;
            wood_color: string;
          }
        | {
            corner_bevel_mm: number;
            depth_mm: number;
            height_mm: number;
            /** @constant */
            kind: 'box';
            seed: number;
            width_mm: number;
          }
        | {
            edge_color: string;
            /** @enum {unknown} */
            fold: 'bifold' | 'none' | 'quadfold';
            fold_gap_mm: number;
            height_mm: number;
            /** @constant */
            kind: 'board';
            seed: number;
            thickness_mm: number;
            width_mm: number;
          };
      source_file_id: string;
      updated_at: string;
      updated_by: string;
    };
    Deck: {
      back_file_id: string | null;
      card_count: number;
      card_height_mm: number;
      card_width_mm: number;
      created_at: string;
      created_by: string;
      deleted_at: string | null;
      id: string;
      name: string;
      project_id: string;
      total_copies: number;
      updated_at: string;
    };
    DeckImport: {
      created_at: string;
      deck_id: string;
      id: string;
      open_run_id: string | null;
      source_label: string | null;
      updated_at: string;
    };
    DeckList: {
      decks: {
        back_file_id: string | null;
        card_count: number;
        card_height_mm: number;
        card_width_mm: number;
        created_at: string;
        created_by: string;
        deleted_at: string | null;
        id: string;
        name: string;
        project_id: string;
        total_copies: number;
        updated_at: string;
      }[];
    };
    DeckWithCards: {
      cards: {
        file: {
          byte_size: number;
          component_id: string | null;
          component_role: string | null;
          content_type: string;
          created_at: string;
          deck_id: string | null;
          deleted_at: string | null;
          filename: string;
          folder_id: string | null;
          id: string;
          image_height: number | null;
          image_width: number | null;
          name_locked: boolean;
          project_id: string;
          updated_at: string;
          uploaded_by: string;
        };
        file_id: string;
        position: number;
        quantity: number;
      }[];
      deck: {
        back_file_id: string | null;
        card_count: number;
        card_height_mm: number;
        card_width_mm: number;
        created_at: string;
        created_by: string;
        deleted_at: string | null;
        id: string;
        name: string;
        project_id: string;
        total_copies: number;
        updated_at: string;
      };
    };
    DeletedListing: {
      entries: {
        blocked_by: string | null;
        byte_size: number | null;
        content_type: string | null;
        deleted_at: string;
        deleted_by: string | null;
        /** @enum {unknown} */
        home_kind: 'component' | 'deck' | 'folder';
        id: string;
        /** @enum {unknown} */
        kind: 'component' | 'deck' | 'file' | 'folder';
        name: string;
        path: string;
        project_id: string;
      }[];
    };
    DirectoryListing: {
      breadcrumb: {
        created_at: string;
        id: string;
        name: string;
        parent_id: string | null;
        project_id: string;
        updated_at: string;
      }[];
      files: {
        byte_size: number;
        component_id: string | null;
        component_role: string | null;
        content_type: string;
        created_at: string;
        deck_id: string | null;
        deleted_at: string | null;
        filename: string;
        folder_id: string | null;
        id: string;
        image_height: number | null;
        image_width: number | null;
        name_locked: boolean;
        project_id: string;
        updated_at: string;
        uploaded_by: string;
      }[];
      folder: {
        created_at: string;
        id: string;
        name: string;
        parent_id: string | null;
        project_id: string;
        updated_at: string;
      } | null;
      folders: {
        created_at: string;
        id: string;
        name: string;
        parent_id: string | null;
        project_id: string;
        updated_at: string;
      }[];
      project_id: string;
      storage_quota_bytes: number;
      storage_used_bytes: number;
    };
    Email: string;
    File: {
      byte_size: number;
      component_id: string | null;
      component_role: string | null;
      content_type: string;
      created_at: string;
      deck_id: string | null;
      deleted_at: string | null;
      filename: string;
      folder_id: string | null;
      id: string;
      image_height: number | null;
      image_width: number | null;
      name_locked: boolean;
      project_id: string;
      updated_at: string;
      uploaded_by: string;
    };
    FileVersionList: {
      versions: {
        byte_size: number;
        checksum: string | null;
        content_type: string;
        created_at: string;
        created_by: string;
        file_id: string;
        image_height: number | null;
        image_width: number | null;
        is_current: boolean;
        version_number: number;
      }[];
    };
    FileVersionResult: {
      created: boolean;
      version: {
        byte_size: number;
        checksum: string | null;
        content_type: string;
        created_at: string;
        created_by: string;
        file_id: string;
        image_height: number | null;
        image_width: number | null;
        is_current: boolean;
        version_number: number;
      };
    };
    Folder: {
      created_at: string;
      id: string;
      name: string;
      parent_id: string | null;
      project_id: string;
      updated_at: string;
    };
    ImportPageResult: {
      file_id: string | null;
      file_version_number: number | null;
      matched_by: 'identity' | 'page_id' | 'page_number' | null;
      name: string;
      outcome: string;
      page_number: number;
      replayed: boolean;
      restored: boolean;
    };
    ImportRun: {
      counts: {
        added: number;
        pages: number;
        removed: number;
        restored: number;
        unchanged: number;
        updated: number;
      };
      finished_at: string | null;
      id: string;
      import_id: string;
      page_count: number;
      source_label: string | null;
      started_at: string;
      started_by: string;
      status: string;
    };
    ImportRunDeck: {
      cards: {
        card_id: string;
        file_id: string;
        file_version_number: number | null;
        image_deleted_at: string | null;
        last_run_id: string;
        name: string;
        outcome: string;
        page_number: number | null;
      }[];
      has_purged_history: boolean;
      run: {
        counts: {
          added: number;
          pages: number;
          removed: number;
          restored: number;
          unchanged: number;
          updated: number;
        };
        finished_at: string | null;
        id: string;
        import_id: string;
        page_count: number;
        source_label: string | null;
        started_at: string;
        started_by: string;
        status: string;
      };
    };
    ImportRunDetail: {
      cards: {
        file_id: string | null;
        file_version_number: number | null;
        matched_by: 'identity' | 'page_id' | 'page_number' | null;
        name: string;
        outcome: string;
        page_number: number | null;
        restored: boolean;
      }[];
      run: {
        counts: {
          added: number;
          pages: number;
          removed: number;
          restored: number;
          unchanged: number;
          updated: number;
        };
        finished_at: string | null;
        id: string;
        import_id: string;
        page_count: number;
        source_label: string | null;
        started_at: string;
        started_by: string;
        status: string;
      };
    };
    ImportRunList: {
      runs: {
        counts: {
          added: number;
          pages: number;
          removed: number;
          restored: number;
          unchanged: number;
          updated: number;
        };
        finished_at: string | null;
        id: string;
        import_id: string;
        page_count: number;
        source_label: string | null;
        started_at: string;
        started_by: string;
        status: string;
      }[];
    };
    Password: string;
    PrintOutstanding: {
      decks: {
        back_file_id: string | null;
        back_version_number: number | null;
        cards: {
          file_id: string;
          last_printed_at: string | null;
          owed_copies: number;
          printed_copies: number;
          printed_version_number: number | null;
          quantity: number;
          reason: 'artwork' | 'back' | 'copies' | 'never' | null;
          version_number: number;
        }[];
        deck_id: string;
        last_printed_at: string | null;
      }[];
    };
    PrintRun: {
      card_count: number;
      copies: number;
      created_at: string;
      created_by: string | null;
      id: string;
      project_id: string;
    };
    Project: {
      created_at: string;
      created_by: string;
      description: string | null;
      id: string;
      name: string;
      /** @enum {unknown} */
      role: 'editor' | 'viewer';
      updated_at: string;
    };
    ProjectList: {
      projects: {
        created_at: string;
        created_by: string;
        description: string | null;
        id: string;
        name: string;
        /** @enum {unknown} */
        role: 'editor' | 'viewer';
        updated_at: string;
      }[];
    };
    ProjectMemberList: {
      members: {
        email: string;
        is_creator: boolean;
        name: string;
        /** @enum {unknown} */
        role: 'editor' | 'viewer';
        user_id: string;
      }[];
    };
    SessionList: {
      sessions: {
        created_at: string;
        current: boolean;
        expires_at: string;
        id: string;
        user_agent: string | null;
      }[];
    };
    StartedImportRun: {
      counts: {
        added: number;
        pages: number;
        removed: number;
        restored: number;
        unchanged: number;
        updated: number;
      };
      finished_at: string | null;
      id: string;
      import_id: string;
      page_count: number;
      plan: {
        added: number;
        pages: {
          /** @enum {unknown} */
          action: 'add' | 'update';
          is_back: boolean;
          matched_by: 'identity' | 'page_id' | 'page_number' | null;
          name: string | null;
          page_number: number;
          title: string | null;
        }[];
        removed: {
          file_id: string;
          name: string;
        }[];
        updated: number;
      };
      source_label: string | null;
      started_at: string;
      started_by: string;
      status: string;
    };
    User: {
      email: string;
      email_verified: boolean;
      id: string;
      name: string;
    };
    /**
     * Format: uuid
     * @description a UUID
     */
    Uuid: string | '00000000-0000-0000-0000-000000000000' | 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  };
  responses: never;
  parameters: never;
  requestBodies: never;
  headers: never;
  pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
  postApiAuthSignup: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          email: components['schemas']['Email'];
          name: string;
          password: components['schemas']['Password'];
          id?: components['schemas']['Uuid'];
        };
      };
    };
    responses: {
      /** @description Account created */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['AuthResponse'];
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            details: {
              message: string;
              path: string;
            }[];
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  postApiAuthLogin: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          email: components['schemas']['Email'];
          password: components['schemas']['Password'];
        };
      };
    };
    responses: {
      /** @description Signed in */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['AuthResponse'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            details: {
              message: string;
              path: string;
            }[];
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  postApiAuthForgotPassword: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          email: components['schemas']['Email'];
        };
      };
    };
    responses: {
      /** @description Reset email enqueued */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            details: {
              message: string;
              path: string;
            }[];
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  postApiAuthResetPassword: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          password: components['schemas']['Password'];
          token: string;
        };
      };
    };
    responses: {
      /** @description Password changed */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            details: {
              message: string;
              path: string;
            }[];
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  getApiAuthMe: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description The account */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['User'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  postApiAuthLogout: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Signed out */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  getApiAuthSessions: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Active sessions */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['SessionList'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  deleteApiAuthSessionsById: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Revoked */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  postApiAuthChangePassword: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          current_password: string;
          new_password: components['schemas']['Password'];
        };
      };
    };
    responses: {
      /** @description Password changed */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            details: {
              message: string;
              path: string;
            }[];
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  getApiProjects: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Projects */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ProjectList'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  postApiProjects: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          name: string;
          description?: string | unknown | null;
          id?: components['schemas']['Uuid'];
        };
      };
    };
    responses: {
      /** @description Created */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Project'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            details: {
              message: string;
              path: string;
            }[];
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  getApiProjectsById: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description The project */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Project'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  deleteApiProjectsById: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Deleted */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  patchApiProjectsById: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          description?: string | unknown | null;
          name?: string;
        };
      };
    };
    responses: {
      /** @description Updated */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Project'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            details: {
              message: string;
              path: string;
            }[];
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  getApiProjectsByIdMembers: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Members */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ProjectMemberList'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  putApiProjectsByIdMembers: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          /** Format: email */
          email: string;
          /** @enum {unknown} */
          role: 'editor' | 'viewer';
        };
      };
    };
    responses: {
      /** @description Member set */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            details: {
              message: string;
              path: string;
            }[];
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  deleteApiProjectsByIdMembersByUserId: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
        userId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Removed */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  getApiFilesDirectory: {
    parameters: {
      query: {
        /** @description a UUID */
        project_id:
          string | '00000000-0000-0000-0000-000000000000' | 'ffffffff-ffff-ffff-ffff-ffffffffffff';
        /** @description a UUID */
        folder_id?:
          string | '00000000-0000-0000-0000-000000000000' | 'ffffffff-ffff-ffff-ffff-ffffffffffff';
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Directory listing */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['DirectoryListing'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  getApiFilesDeleted: {
    parameters: {
      query: {
        /** @description a UUID */
        project_id:
          string | '00000000-0000-0000-0000-000000000000' | 'ffffffff-ffff-ffff-ffff-ffffffffffff';
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description The deleted files and folders */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['DeletedListing'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  postApiFilesFolders: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          name: string;
          project_id: components['schemas']['Uuid'];
          id?: components['schemas']['Uuid'];
          parent_id?:
            | string
            | '00000000-0000-0000-0000-000000000000'
            | 'ffffffff-ffff-ffff-ffff-ffffffffffff'
            | null;
        };
      };
    };
    responses: {
      /** @description Created */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Folder'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            details: {
              message: string;
              path: string;
            }[];
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  deleteApiFilesFoldersById: {
    parameters: {
      query?: {
        purge?: 'true';
      };
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Deleted */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  patchApiFilesFoldersById: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          name?: string;
          parent_id?:
            | string
            | '00000000-0000-0000-0000-000000000000'
            | 'ffffffff-ffff-ffff-ffff-ffffffffffff'
            | null;
        };
      };
    };
    responses: {
      /** @description Updated */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Folder'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            details: {
              message: string;
              path: string;
            }[];
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  postApiFilesFoldersByIdRestore: {
    parameters: {
      query?: {
        name?: string;
      };
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Restored */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Folder'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  postApiFilesUpload: {
    parameters: {
      query: {
        filename: string;
        /** @description a UUID */
        project_id:
          string | '00000000-0000-0000-0000-000000000000' | 'ffffffff-ffff-ffff-ffff-ffffffffffff';
        /** @description a UUID */
        component_id?:
          string | '00000000-0000-0000-0000-000000000000' | 'ffffffff-ffff-ffff-ffff-ffffffffffff';
        /** @description a UUID */
        deck_id?:
          string | '00000000-0000-0000-0000-000000000000' | 'ffffffff-ffff-ffff-ffff-ffffffffffff';
        /** @description a UUID */
        folder_id?:
          string | '00000000-0000-0000-0000-000000000000' | 'ffffffff-ffff-ffff-ffff-ffffffffffff';
        /** @description a UUID */
        id?:
          string | '00000000-0000-0000-0000-000000000000' | 'ffffffff-ffff-ffff-ffff-ffffffffffff';
        role?: 'artwork' | 'back' | 'card' | 'cut';
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Uploaded */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['File'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Payload too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            details: {
              message: string;
              path: string;
            }[];
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  getApiFilesByIdDownload: {
    parameters: {
      query?: {
        version?: string;
      };
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description The file bytes */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  getApiFilesByIdVersions: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description The versions */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['FileVersionList'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  postApiFilesByIdVersions: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description The bytes were already the current version */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['FileVersionResult'];
        };
      };
      /** @description Created */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['FileVersionResult'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Payload too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  postApiFilesByIdVersionsByNumberRestore: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
        number: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description That version was already current */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['FileVersionResult'];
        };
      };
      /** @description Restored */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['FileVersionResult'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Payload too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  getApiFilesById: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description The file */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['File'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  deleteApiFilesById: {
    parameters: {
      query?: {
        purge?: 'true';
      };
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Deleted */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  patchApiFilesById: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          filename?: string;
          folder_id?:
            | string
            | '00000000-0000-0000-0000-000000000000'
            | 'ffffffff-ffff-ffff-ffff-ffffffffffff'
            | null;
          name_locked?: boolean;
        };
      };
    };
    responses: {
      /** @description Updated */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['File'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            details: {
              message: string;
              path: string;
            }[];
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  postApiFilesByIdMove: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          component_id?:
            | string
            | '00000000-0000-0000-0000-000000000000'
            | 'ffffffff-ffff-ffff-ffff-ffffffffffff'
            | null;
          deck_id?:
            | string
            | '00000000-0000-0000-0000-000000000000'
            | 'ffffffff-ffff-ffff-ffff-ffffffffffff'
            | null;
          folder_id?:
            | string
            | '00000000-0000-0000-0000-000000000000'
            | 'ffffffff-ffff-ffff-ffff-ffffffffffff'
            | null;
          /** @enum {unknown} */
          role?: 'artwork' | 'back' | 'card' | 'cut';
        };
      };
    };
    responses: {
      /** @description Moved */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['File'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            details: {
              message: string;
              path: string;
            }[];
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  postApiFilesByIdRestore: {
    parameters: {
      query?: {
        filename?: string;
      };
      header?: never;
      path: {
        id: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Restored */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['File'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  getApiComponents: {
    parameters: {
      query: {
        /** @description a UUID */
        project_id:
          string | '00000000-0000-0000-0000-000000000000' | 'ffffffff-ffff-ffff-ffff-ffffffffffff';
        kind?: 'board' | 'box' | 'punchboard' | 'wood';
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Components */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ComponentList'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  postApiComponents: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          /** @enum {unknown} */
          kind: 'board' | 'box' | 'punchboard' | 'wood';
          name: string;
          project_id: components['schemas']['Uuid'];
          id?: components['schemas']['Uuid'];
          settings?:
            | {
                back_color: string;
                edge_color: string;
                height_mm: number;
                /** @constant */
                kind: 'punchboard';
                seed: number;
                /** @enum {unknown} */
                sheet_state: 'intact' | 'punched';
                thickness_mm: number;
                width_mm: number;
              }
            | {
                bevel_mm: number;
                grain_color: string;
                grain_scale: number;
                /** @constant */
                kind: 'wood';
                longest_side_mm: number;
                printed: boolean;
                seed: number;
                simplify_tolerance: number;
                thickness_mm: number;
                /** @enum {unknown} */
                trace_source: 'alpha' | 'luminance';
                trace_threshold: number;
                wood_color: string;
              }
            | {
                corner_bevel_mm: number;
                depth_mm: number;
                height_mm: number;
                /** @constant */
                kind: 'box';
                seed: number;
                width_mm: number;
              }
            | {
                edge_color: string;
                /** @enum {unknown} */
                fold: 'bifold' | 'none' | 'quadfold';
                fold_gap_mm: number;
                height_mm: number;
                /** @constant */
                kind: 'board';
                seed: number;
                thickness_mm: number;
                width_mm: number;
              };
        };
      };
    };
    responses: {
      /** @description Created */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Component'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            details: {
              message: string;
              path: string;
            }[];
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  putApiComponentsOrder: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          component_ids: components['schemas']['Uuid'][];
          /** @enum {unknown} */
          kind: 'board' | 'box' | 'punchboard' | 'wood';
          project_id: components['schemas']['Uuid'];
        };
      };
    };
    responses: {
      /** @description The section in its new order */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ComponentList'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            details: {
              message: string;
              path: string;
            }[];
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  getApiComponentsByComponentId: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        componentId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description The component */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Component'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  deleteApiComponentsByComponentId: {
    parameters: {
      query?: {
        purge?: 'true';
      };
      header?: never;
      path: {
        componentId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Deleted */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  patchApiComponentsByComponentId: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        componentId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          name?: string;
          settings?:
            | {
                back_color: string;
                edge_color: string;
                height_mm: number;
                /** @constant */
                kind: 'punchboard';
                seed: number;
                /** @enum {unknown} */
                sheet_state: 'intact' | 'punched';
                thickness_mm: number;
                width_mm: number;
              }
            | {
                bevel_mm: number;
                grain_color: string;
                grain_scale: number;
                /** @constant */
                kind: 'wood';
                longest_side_mm: number;
                printed: boolean;
                seed: number;
                simplify_tolerance: number;
                thickness_mm: number;
                /** @enum {unknown} */
                trace_source: 'alpha' | 'luminance';
                trace_threshold: number;
                wood_color: string;
              }
            | {
                corner_bevel_mm: number;
                depth_mm: number;
                height_mm: number;
                /** @constant */
                kind: 'box';
                seed: number;
                width_mm: number;
              }
            | {
                edge_color: string;
                /** @enum {unknown} */
                fold: 'bifold' | 'none' | 'quadfold';
                fold_gap_mm: number;
                height_mm: number;
                /** @constant */
                kind: 'board';
                seed: number;
                thickness_mm: number;
                width_mm: number;
              };
        };
      };
    };
    responses: {
      /** @description Updated */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Component'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            details: {
              message: string;
              path: string;
            }[];
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  postApiComponentsByComponentIdRestore: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        componentId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Restored */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Component'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  getApiModelsByFileId: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        fileId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description The saved settings */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ComponentModel'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  putApiModelsByFileId: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        fileId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          settings:
            | {
                back_color: string;
                back_file_id:
                  | string
                  | '00000000-0000-0000-0000-000000000000'
                  | 'ffffffff-ffff-ffff-ffff-ffffffffffff'
                  | null;
                bevel_mm: number;
                corner_radius_mm: number;
                height_mm: number;
                /** @constant */
                kind: 'card';
                seed: number;
                stock_color: string;
                thickness_mm: number;
                width_mm: number;
              }
            | {
                back_color: string;
                edge_color: string;
                height_mm: number;
                /** @constant */
                kind: 'punchboard';
                seed: number;
                /** @enum {unknown} */
                sheet_state: 'intact' | 'punched';
                thickness_mm: number;
                width_mm: number;
              }
            | {
                bevel_mm: number;
                grain_color: string;
                grain_scale: number;
                /** @constant */
                kind: 'wood';
                longest_side_mm: number;
                printed: boolean;
                seed: number;
                simplify_tolerance: number;
                thickness_mm: number;
                /** @enum {unknown} */
                trace_source: 'alpha' | 'luminance';
                trace_threshold: number;
                wood_color: string;
              }
            | {
                corner_bevel_mm: number;
                depth_mm: number;
                height_mm: number;
                /** @constant */
                kind: 'box';
                seed: number;
                width_mm: number;
              }
            | {
                edge_color: string;
                /** @enum {unknown} */
                fold: 'bifold' | 'none' | 'quadfold';
                fold_gap_mm: number;
                height_mm: number;
                /** @constant */
                kind: 'board';
                seed: number;
                thickness_mm: number;
                width_mm: number;
              };
        };
      };
    };
    responses: {
      /** @description Saved */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ComponentModel'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            details: {
              message: string;
              path: string;
            }[];
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  getApiDecks: {
    parameters: {
      query: {
        /** @description a UUID */
        project_id:
          string | '00000000-0000-0000-0000-000000000000' | 'ffffffff-ffff-ffff-ffff-ffffffffffff';
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Decks */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['DeckList'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  postApiDecks: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          card_height_mm: number;
          card_width_mm: number;
          name: string;
          project_id: components['schemas']['Uuid'];
          back_file_id?:
            | string
            | '00000000-0000-0000-0000-000000000000'
            | 'ffffffff-ffff-ffff-ffff-ffffffffffff'
            | null;
          id?: components['schemas']['Uuid'];
        };
      };
    };
    responses: {
      /** @description Created */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Deck'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            details: {
              message: string;
              path: string;
            }[];
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  getApiDecksByDeckId: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        deckId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description The deck */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['DeckWithCards'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  deleteApiDecksByDeckId: {
    parameters: {
      query?: {
        purge?: 'true';
      };
      header?: never;
      path: {
        deckId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Deleted */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  patchApiDecksByDeckId: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        deckId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          back_file_id?:
            | string
            | '00000000-0000-0000-0000-000000000000'
            | 'ffffffff-ffff-ffff-ffff-ffffffffffff'
            | null;
          card_height_mm?: number;
          card_width_mm?: number;
          name?: string;
        };
      };
    };
    responses: {
      /** @description Updated */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['Deck'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            details: {
              message: string;
              path: string;
            }[];
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  postApiDecksByDeckIdRestore: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        deckId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Restored */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['DeckWithCards'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  putApiDecksByDeckIdCards: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        deckId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          cards: {
            file_id: components['schemas']['Uuid'];
            quantity: number;
          }[];
        };
      };
    };
    responses: {
      /** @description The deck as it now stands */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['DeckWithCards'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            details: {
              message: string;
              path: string;
            }[];
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  getApiDecksByDeckIdImport: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        deckId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description The binding */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['DeckImport'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  getApiDecksByDeckIdImportRuns: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        deckId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description The runs */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ImportRunList'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  postApiDecksByDeckIdImportRuns: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        deckId: string;
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          pages: {
            page_id: string;
            page_number: number;
            title?: string;
          }[];
          id?: components['schemas']['Uuid'];
          source_label?: string | unknown | null;
        };
      };
    };
    responses: {
      /** @description Started, with the plan */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['StartedImportRun'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            details: {
              message: string;
              path: string;
            }[];
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  getApiDecksByDeckIdImportRunsByRunId: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        deckId: string;
        runId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description The run */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ImportRunDetail'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  getApiDecksImportRunsByRunId: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        runId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description The run */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ImportRunDetail'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  getApiDecksByDeckIdImportRunsByRunIdDeck: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        deckId: string;
        runId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description The cards this deck held after that import */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ImportRunDeck'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  postApiDecksImportRunsByRunIdPages: {
    parameters: {
      query: {
        page_number: string;
        title?: string;
      };
      header?: never;
      path: {
        runId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description The page, already imported */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ImportPageResult'];
        };
      };
      /** @description Imported */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ImportPageResult'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Payload too large */
      413: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            details: {
              message: string;
              path: string;
            }[];
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  postApiDecksImportRunsByRunIdFinish: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        runId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Finished */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ImportRunDetail'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            details: {
              message: string;
              path: string;
            }[];
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  postApiDecksImportRunsByRunIdAbandon: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        runId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Abandoned */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['ImportRun'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  getApiPrintOutstanding: {
    parameters: {
      query: {
        /** @description a UUID */
        project_id:
          string | '00000000-0000-0000-0000-000000000000' | 'ffffffff-ffff-ffff-ffff-ffffffffffff';
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description What is outstanding */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['PrintOutstanding'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  postApiPrintRuns: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          cards: {
            copies: number;
            file_id: components['schemas']['Uuid'];
            version_number: number;
            back_file_id?:
              | string
              | '00000000-0000-0000-0000-000000000000'
              | 'ffffffff-ffff-ffff-ffff-ffffffffffff'
              | null;
            back_version_number?: number | null;
          }[];
          project_id: components['schemas']['Uuid'];
          id?: components['schemas']['Uuid'];
        };
      };
    };
    responses: {
      /** @description Recorded */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['PrintRun'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Conflict */
      409: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            details: {
              message: string;
              path: string;
            }[];
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  deleteApiPrintRunsByRunId: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        runId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Undone */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Forbidden */
      403: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  postApiCanvaAppSession: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          token: string;
          switch_account?: boolean;
        };
      };
    };
    responses: {
      /** @description A session, or the code that leads to one */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['CanvaAppSession'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            details: {
              message: string;
              path: string;
            }[];
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  postApiCanvaAppPair: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        'application/json': {
          code: string;
        };
      };
    };
    responses: {
      /** @description Linked */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['CanvaAppLink'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Validation failed */
      422: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            details: {
              message: string;
              path: string;
            }[];
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  getApiCanvaAppLinks: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description The links */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': components['schemas']['CanvaAppLinkList'];
        };
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
  deleteApiCanvaAppLinksByLinkId: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        linkId: string;
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Unlinked */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      /** @description Unauthorized */
      401: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Not found */
      404: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
      /** @description Internal server error */
      500: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          'application/json': {
            error: string;
          };
        };
      };
    };
  };
}
