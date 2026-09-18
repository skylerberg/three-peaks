# threepeaks

The command-line client for **Three Peaks Hub** — projects, Assets, decks,
components, print runs, the Canva link and the realtime stream, from a terminal
or a script. It talks to the same API the web app does and nothing else.

## Install

From the main checkout (not a worktree — the links point into the checkout they
were made from):

```sh
pnpm install
pnpm --filter @three-peaks/cli run install:global   # --force replaces an old link
```

That links `threepeaks` into pnpm's global bin directory and the agent skill
into `~/.claude/skills/threepeaks`. The launcher runs the TypeScript source
directly, so there is no build step and a `git pull` is an upgrade.

## Signing in

```sh
threepeaks login --email you@example.com   # prompts for the password
threepeaks whoami
threepeaks status                          # server, the build it runs, who you are
```

The password is never stored. The session token goes into the macOS Keychain
(service `threepeaks-cli`), or a chmod-600 file under the config directory
elsewhere; using it slides its expiry forward, so only a session nobody comes
back to lapses. `--password-stdin` reads it from the first line of stdin
instead of a prompt.

```sh
threepeaks signup --email you@example.com --name "Your Name"
threepeaks logout                          # ends the session on the server too
threepeaks account change-password         # current, then new; sessions stay signed in
threepeaks account forgot-password --email you@example.com
threepeaks account reset-password --token <token from the emailed link>
threepeaks session list                    # * marks this one
threepeaks session revoke 3f9a1c2b         # ending this one signs the CLI out
```

### Personal access tokens

```sh
TOKEN=$(threepeaks token create "build server")   # the secret, alone, on stdout
THREEPEAKS_TOKEN=$TOKEN threepeaks project list
threepeaks token list                              # names and last use; never a secret
threepeaks token revoke "build server"
```

A token acts as your account for scripts and agents. It never expires and
survives a password change: revoking it is the only way it stops working, and a
`threepeaks watch` running on it is disconnected within half a minute. The secret
is printed once, at creation. An account holds at most 50.

## Projects and members

```sh
threepeaks project list
threepeaks project create "Summit" --description "A climbing game"
threepeaks project show Summit              # owner, members, storage used of the quota
threepeaks project update Summit --name "Summit 2e" --clear-description
threepeaks project members Summit           # the creator is listed as owner
threepeaks project member add them@example.com --role viewer --project Summit   # editor by default
threepeaks project member set-role them@example.com --role editor --project Summit
threepeaks project member remove them@example.com --project Summit
threepeaks project leave Summit
threepeaks project delete Summit            # owner only; permanent, files and all
```

Only the owner manages members or deletes a project; a viewer who tries to
change anything exits 7. `member add` refuses somebody already on the project
rather than changing their role behind your back — that is `set-role`. The
owner cannot be removed, demoted, or leave; there is no transfer, only
`project delete`.

Every command that works inside one project takes `--project`. Without it the
project comes from `THREEPEAKS_PROJECT`, then from
`threepeaks config set default-project <project>`.

## Assets: folders and files

Assets is the folder tree: everything that is neither a deck's card nor a
component's artwork. A folder is named by its path from the root (`Art/Cards`)
or its id; path segments match whole and case-insensitively, never by
substring.

```sh
threepeaks ls                                   # the root
threepeaks ls Art/Cards --project Summit
threepeaks mkdir -p Art/Cards                   # creates missing parents; an existing folder is fine
threepeaks upload cover.png rules.pdf --to Art
threepeaks upload cover.png --to Art --replace  # that name is there? add a version instead
```

### Naming a file

`<file>` is a file id, or an Assets path whose last segment is matched like any
other reference. `--deck <deck>` looks among a deck's cards instead, and
`--component <component>` among a component's files, by role (`artwork`, `cut`)
or name.

```sh
threepeaks download Art/cover.png -o ~/Desktop      # into a directory, under its own name
threepeaks download Art/cover.png --version 2       # an old version, saved as cover.v2.png
threepeaks download ace.png --deck Heroes -o - > ace.png
threepeaks file show Art/cover.png
threepeaks file versions Art/cover.png
threepeaks file push Art/cover.png ./cover-final.png    # the next version
threepeaks file revert Art/cover.png 2                  # copies v2 forward as a new version
threepeaks file rename Art/cover.png box-front.png
threepeaks file move Art/box-front.png --to Archive     # / is the root
threepeaks file move Art/ace.png --to-deck Heroes       # --back makes it the deck's back
threepeaks file move Art/wrap.png --to-component "Game box" --role artwork
```

A download never overwrites a local file without `--force`, and `-o -` writes
the bytes alone to stdout. History only grows: `file revert` copies an old
version forward rather than rewinding the number. A move between two Assets
folders keeps the name and refuses a clash; a move into or out of a deck or a
component renames on arrival instead (`cover (2).png`) and says so.

### Uploads

Every upload command checks all of its local paths before sending anything,
then sends one file at a time. A file the server refuses — most often a name
already taken, which `--replace` turns into a new version — is reported on
stderr and passed over; the rest still go up, and the command exits with the
first failure's code. A refused credential or a viewer's 403 stops the batch at
once. Bytes identical to a file's current version are reported as unchanged and
add nothing.

### Deleting and restoring

Deleting is soft: the thing is hidden, every version keeps its bytes, and it
still counts against the project's storage. Deleting a folder leaves its
contents untouched, and restoring it brings the whole of it back, except
anything deleted inside it separately.

```sh
threepeaks file delete Art/cover.png
threepeaks folder delete Archive
threepeaks trash list                        # files, folders, decks and components
threepeaks trash restore Art/cover.png       # path, name or id from the list
threepeaks trash restore Art/cover.png --name cover-old.png   # its old name was taken
threepeaks trash purge Archive --force       # permanent, and reclaims the storage
```

`--purge` on a delete and `trash purge` are the only permanent deletions, and
they ask first (`--force` skips the prompt and is required with `--no-input`).
A purged folder takes its whole subtree, live files included. A trash entry
with something under BLOCKED BY sits inside a deleted folder, deck or
component; restore that first. Any entry can be restored under a new name with
`--name`.

## Decks

A deck is an ordered list of card images, each with a copy count, one card size
and one image on the back.

```sh
threepeaks deck list
threepeaks deck sizes                                  # the named card sizes
threepeaks deck create Heroes --size tarot             # or --width 60 --height 90; poker by default
threepeaks deck upload Heroes art/*.png                # each image becomes a card, in the order given
threepeaks deck upload Heroes back.png --back          # the back: a card held at 0 copies
threepeaks deck upload Heroes art/knight.png --replace # same name: a new version, not a conflict
threepeaks deck show Heroes                            # print order; --all includes deleted cards
threepeaks deck copies Heroes knight.png 3             # 0 keeps the card and prints none of it
threepeaks deck move-card Heroes knight.png --top      # or --bottom, --before/--after <card>, --position <n>
threepeaks deck back Heroes back.png                   # or --none
threepeaks deck update Heroes --name "Base game" --size poker
threepeaks deck download Heroes -o proofs/             # every live card and the back
threepeaks deck delete Heroes                          # restorable: threepeaks deck restore Heroes
threepeaks deck delete Heroes --purge --force          # permanent, bytes and all
```

A card is named by its filename, file id or id prefix. A card whose image is
deleted keeps its place and its copy count so a restore lands where it was;
`deck show` hides it unless `--all`, and `move-card` arranges it only with
`--all`. To take a card out of a deck, delete its image or move it to Assets
with the file commands.

### A card's 3D settings

```sh
threepeaks deck model Heroes knight.png                        # never dialled in: defaults sized to the deck
threepeaks deck model Heroes knight.png --set thickness_mm=0.5 --set back_file_id=back.png
threepeaks deck model Heroes knight.png --file settings.json   # a JSON object laid over the current settings
threepeaks deck model Heroes knight.png --reset
```

### Import history

Designs are imported from inside Canva, not from here. The CLI reads what
imports did and clears a run left open.

```sh
threepeaks deck import status Heroes           # last source, last finished run, any open run
threepeaks deck import runs Heroes
threepeaks deck import show Heroes latest      # a run id, id prefix, or `latest`
threepeaks deck import as-of Heroes 3f9a1c2b   # the cards the imports had put in the deck as of a finished run
threepeaks deck import abandon Heroes          # pages already imported keep the versions they wrote
```

## Components

Wooden pieces, boxes, boards and punchboards. Each kind has a section in the
web app, and each component owns its own files: one `artwork` image, plus a
`cut` SVG for a punchboard — the die line, where every closed path is a token.

```sh
threepeaks component kinds                              # the kinds and the files each takes
threepeaks component list --kind box                    # by section, in section order
threepeaks component create "Retail box" --kind box --set width_mm=200 --set depth_mm=40
threepeaks component upload "Retail box" box-wrap.png   # fills the missing slot
threepeaks component upload Sprue sprue-cut.svg --role cut
threepeaks component show "Retail box"                  # files, what is missing, settings
threepeaks component settings "Retail box" --set corner_bevel_mm=2
threepeaks component settings "Retail box" --file box.json   # - reads stdin
threepeaks component settings "Retail box" --reset      # back to the studio defaults
threepeaks component download "Retail box" -o out/
threepeaks component move "Retail box" --top            # or --bottom, --before X, --after X, --position N
threepeaks component rename "Retail box" "Big box"
threepeaks component delete "Big box"                   # restorable; --purge destroys it for good
threepeaks component restore "Big box" --name "Old box" # when its name has been taken meanwhile
```

Uploading into a slot that already holds a file adds a new version of that
file, so the previous artwork stays one `file revert` away. If the slot's file
has been deleted, restore or purge it first — the command names both. A deleted
component is still found by name for `show`, `settings`, `download` and
`delete --purge`; `rename`, `upload` and `move` refuse it until it is restored.

### Settings

`--set key=value` coerces by the type the stored setting already has: numbers,
`true`/`false`, strings, and `null` to clear a nullable one. An unknown key is
refused with the real keys listed, and `kind` can never change. `--file` lays a
JSON object over the stored settings before any `--set` is applied. A save that
changes nothing sends nothing.

## Printing

```sh
threepeaks print outstanding                 # per deck: cards not yet on paper, and why
threepeaks print outstanding --deck Heroes --all
```

The reasons are "never printed", "new artwork", "new back" and "N more".
Sheets are built, and runs recorded or undone, on the web app's print screen:
the PDF is made in the browser, so the CLI can neither build nor record one.

## The Canva app

```sh
threepeaks canva pair ABCD-2345     # the code the app shows; case and hyphen are optional
threepeaks canva links
threepeaks canva unlink 1a2b3c4d    # sessions it already holds stay signed in
threepeaks canva build              # which bundle last ran inside Canva; needs no login
```

## Links into the web app

```sh
threepeaks url deck Heroes --project Summit               # the deck editor
threepeaks url deck Heroes --history --project Summit
threepeaks url file Art/cover.png --project Summit        # its version history
threepeaks url file knight.png --deck Heroes --3d --project Summit
threepeaks url folder Art/Cards --project Summit
```

Also `project`, `members`, `trash`, `decks`, `print [--deck]`, `scene`,
`section <kind>` and `component`. The bare URL goes to stdout so it drops
straight into a commit message; `--json` gives `{ "url": ... }`. Every link
addresses things by id, so a rename never breaks one somebody pasted.

## Watching realtime events

```sh
threepeaks watch --project Summit | jq 'select(.type == "deck_updated")'
```

`watch` prints every event the server delivers as one compact JSON object per
line on stdout — the `{ type, project_id, data }` envelope, exactly as it
arrived — and everything else on stderr. Without `--project` it follows every
project you can see, including ones shared with you while it runs; unlike every
other command it ignores the default project, because quietly narrowing a live
stream is the failure it exists to debug.

It reconnects on its own, backing off from one second to thirty, and pings the
server every thirty seconds so a connection that silently died is replaced
rather than waited on. There is no replay: events published while it was
disconnected are gone, so treat the "Connection restored" line on stderr as the
cue to re-read whatever you were following. It exits 3 when its credential is
revoked, and 1 when the account has too many open connections and the server
closed this one to make room: reconnecting would only take the slot back from
whichever client it was handed to.

## Naming things

A project, deck, component, card, member, session, token or trash entry is
named by its id, its exact name (case-insensitive), an id prefix of at least
four characters, or a unique substring of its name — tried in that order. A
name that matches more than one is exit 2, with the candidates listed: re-run
with one of the ids shown. The 8-character ids every listing prints are the
handle to script with; names change and ids don't.

## Output and exit codes

Every command takes `--json` for machine-readable output (the API's own
objects), `--no-input` to fail rather than prompt, and `--no-color`. Exit codes:

| code | meaning                                      |
| ---- | -------------------------------------------- |
| 0    | ok                                           |
| 1    | network or server error                      |
| 2    | usage, or an ambiguous reference             |
| 3    | not signed in, or the credential was refused |
| 4    | not found                                    |
| 5    | conflict                                     |
| 6    | invalid input                                |
| 7    | you can read this project but not change it  |

## Shell completion

```sh
# zsh — into a directory on $fpath, or eval it in ~/.zshrc after compinit
threepeaks completion -s zsh > "${fpath[1]}/_threepeaks"

# bash — in ~/.bashrc
eval "$(threepeaks completion -s bash)"

# fish
threepeaks completion -s fish > ~/.config/fish/completions/threepeaks.fish
```

TAB completes commands and flags, and — where a reference is expected —
projects, decks, cards (of the deck already typed), components, members, trash
entries, import runs, and Assets paths one folder at a time. Lookups are cached
for thirty seconds under the config directory and give up after a second and a
half: an unreachable server just means no suggestions, never an error in the
middle of a prompt.

## Which server it talks to

Production (`https://tools.threepeaksgames.com`) by default. `--api-url`,
`THREEPEAKS_API_URL` or `threepeaks config set api-url <url>` choose another —
`http://localhost:17310` for a local API. Tokens are stored per server.
`THREEPEAKS_TOKEN` overrides the stored token, `THREEPEAKS_WEB_URL` (or
`config set web-url`) is the base `url` builds links from, and
`THREEPEAKS_CONFIG_DIR` moves the config directory from
`~/.config/threepeaks`.

## Working on the CLI

The root `AGENTS.md` has a section on the package: where its tests run, what it
may import, and how a command is put together.
