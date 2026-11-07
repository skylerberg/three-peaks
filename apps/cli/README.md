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

## Card layouts

A card can be drawn instead of uploaded: a **layout** says where the frame, the
art and each line of copy go, and each card supplies its own values for those
slots. Change a card's rules and pushing again renders it and adds a version;
change the layout and every card drawn from it is re-rendered. Both are stored
in the project; the YAML files below are how you edit them.

```sh
threepeaks layout push hero.yaml                    # create, or replace the layout of that name
threepeaks layout pull Hero -o hero.yaml            # the stored layout, as YAML
threepeaks layout preview hero.yaml cards.yaml -o preview/   # PNGs on disk; nothing on the server changes
threepeaks layout preview hero.yaml --deck Heroes -o preview/  # the deck's stored cards, drawn with this file
threepeaks deck cards pull Heroes -o cards.yaml
threepeaks deck cards push Heroes cards.yaml --dry-run
threepeaks deck cards push Heroes cards.yaml
threepeaks deck render Heroes --check               # exit 5 if any card's image is behind its content
threepeaks deck render Heroes                       # after a new version of art, an icon or a font
threepeaks layout list
threepeaks layout show Hero                         # fields, files, and the decks drawn from it
threepeaks layout delete Hero                       # refused while any card is drawn from it
```

A layout, with every setting it can have:

```yaml
name: Hero
size: poker # or width_mm and height_mm; must match the deck's cards
dpi: 300 # the default
fonts: # TTF, OTF or WOFF files, by Assets path or id
  body: Fonts/Lora-Regular.ttf
  bold: Fonts/Lora-Bold.ttf
icons: # PNG, JPEG or SVG, written {coin} in copy
  coin: Icons/coin.svg
fields: # what each card supplies: text or image
  name: text
  cost: text
  rules: text
  art: image
elements: # painted in order, first at the back; box is [x, y, width, height] in mm
  - type: image
    box: [0, 0, 63, 88]
    file: Frames/hero.png # a fixed image -- or field: art, for each card's own
    fit: fill # cover (default), contain or fill
    rotate: 0 # any element: 0 (default), 90, 180 or 270, clockwise about the box's centre
  - type: image
    box: [4, 14, 55, 34]
    field: art
    when: art # any element: drawn only when this field is not empty
  - type: rect
    box: [4, 51, 55, 33]
    fill: '#ffffff' # default none
    stroke: '#3b2a1a' # default none
    stroke_mm: 0.3 # 0.25 when there is a stroke
    radius_mm: 2 # default 0
    opacity: 0.9 # default 1
  - type: text
    box: [7, 54, 49, 27]
    text: '{{rules}}' # {{field}} is replaced by the card's value
    font: body
    bold_font: bold # needed only if the copy uses **bold**
    size_pt: 10
    min_size_pt: 6 # shrinks in quarter points until it fits; default size_pt
    line_height: 1.2 # the default
    color: '#1a1a1a' # default black
    align: left # left (default), center, right
    valign: middle # top (default), middle, bottom
```

### Elements placed by other elements

An element with an `id` can have the edges of other boxes pinned to it, so a
backing is as long as the name on it and a banner as long as the ability it
carries. A box written as edges takes two of `left`, `right` and `width`, and
two of `top`, `bottom` and `height`; any edge can be a number or another
element's edge, moved by so many millimetres:

```yaml
elements:
  - type: rect # listed first, so painted behind the name
    box: { left: name.left - 2, right: 60, top: 70, height: 7 }
    fill: '#000000'
  - type: image # a banner whose middle stretches to the ability's length
    box: { left: 4, width: 9, top: ability.top - 6, bottom: 88 }
    file: Art/banner.png
    slice: [80, 0, 0, 0] # top, right, bottom, left, in the image's own pixels
  - type: text
    id: name
    box: [5, 70, 50, 7] # the most room the name may take
    text: '{{name}}'
    font: body
    size_pt: 12
    align: right
    valign: middle
    hug: true
  - type: text
    id: ability
    box: [4, 30, 9, 55]
    text: '{{ability}}'
    font: body
    size_pt: 10
    align: center
    valign: bottom
    hug: true
```

`hug: true` makes a text element measure as the copy it set rather than as its
box: the edges that `align` and `valign` hold stay where they are, and the
others close in on the copy. Edges are worked out in whatever order the pins
need, separately from the order elements are painted, and a layout whose pins
go round in a circle is refused. An element pinned to one that draws nothing on
a card -- left out by `when`, an empty image field, empty copy -- is left out
too. Pins name the box as it came out on the card, after any rotation; a
quarter turn lays text along the box's long side.

`slice` cuts an image into nine pieces: the corners keep their proportions, the
edges stretch one way and the middle both, all at the scale that fits the
image's tighter side into the box. Draw the image at the proportions of the
shortest box it will fill -- a banner as short as one line of copy makes it --
and its ends come out the same size on every card. One number is all four
insets and two are top-and-bottom then the sides. A sliced image is stretched
to fill its box.

A deck's cards:

```yaml
layout: Hero # every card's, unless it names its own
cards:
  - name: knight # the deck's knight.png
    copies: 3 # optional; left alone when absent
    fields:
      name: Knight
      cost: 3
      rules: "**Defend:** gain 2 {coin}.\nDraw a card."
      art: Art/knight.png
```

Copy is markup: `{icon}` draws one of the layout's icons one em square,
`**bold**` switches to `bold_font`, a newline breaks the line, and a backslash
prints `{`, `}`, `*` or `\` as itself. A card whose copy does not fit its box
even at `min_size_pt`, or uses a character its font has no glyph for, is
refused by name; the rest of the file still goes up.

`deck cards push` creates the cards the deck lacks and re-renders the rest, and
only a card whose image comes out different gains a version — pushing an
unchanged file changes nothing. It never removes a card: one the file has
stopped naming is listed, with the command that would delete it. New cards are
added at the end of the deck; the order is the deck's to arrange.

A layout follows the current version of every file it names, so a new frame
or icon in Assets reaches the cards at the next `deck render`, and `--check`
says which are behind before then. A Canva import into the same deck removes
any card its design does not name, laid-out ones included — its plan lists
them before anything happens.

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
