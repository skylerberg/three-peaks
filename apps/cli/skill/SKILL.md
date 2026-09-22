---
name: threepeaks
description: Work with Three Peaks Hub (tools.threepeaksgames.com), the board game design tools, through the `threepeaks` CLI — push card art into a deck, set copy counts and the back, upload and version component artwork, move files around Assets, read what the printer still owes and what a Canva import did, and restore anything deleted. Use whenever Three Peaks Hub, threepeaks, a deck, card, component, punchboard, Assets or print run of a Three Peaks game comes up, in any repo.
---

# Three Peaks Hub

Three Peaks Hub is where a game's physical parts live: decks of card images
with copy counts and a back, components (wooden pieces, boxes, boards,
punchboards) with their artwork and 3D settings, and a folder tree called Assets
for everything else. The web app is where Skyler works; `threepeaks` is the
agent-facing surface onto the same API, so anything you change is in front of a
person the moment you change it.

`threepeaks` is linked into the global bin directory from
`~/Code/three-peaks-hub/apps/cli`, and talks to production by default.

## Before anything else

```sh
threepeaks whoami          # exit 3 => no credential, or it was refused
```

Exit 3 means **stop and say so**. Signing in needs a password you do not have;
`threepeaks login` is Skyler's to run, or `THREEPEAKS_TOKEN` holds a personal
access token Skyler made for you.

Three habits keep every other call boring:

- Pass `--project "<name>"` on everything that takes it.
- Add `--no-input` to every write, so nothing can block on a prompt.
- Add `--json` when you are going to parse the answer; read plain text otherwise.

## Which project?

Stop at the first answer:

1. **Something in the repo says so** — a Three Peaks Hub line in its agent
   instructions (`AGENTS.md`, or `CLAUDE.md` in a repo that still uses one), or
   `$THREEPEAKS_PROJECT`.
2. **Discovery** — `threepeaks project list`, matched against the game this repo
   is about. Take a match only if it is unmistakable.
3. **Ask Skyler**, then offer to record the answer as one line in those
   instructions, so the next agent stops at step 1.

Never lean on the configured `default-project`: it is one global value, set for
whatever game was current when somebody set it.

## Common jobs

Card art exported from a design tool, into a deck:

```sh
threepeaks deck show "Heroes" --project "Summit"
threepeaks deck upload "Heroes" out/cards/*.png --replace --project "Summit" --no-input
```

`--replace` is what makes a re-export safe to repeat: a card whose filename is
already in the deck gains a new version instead of failing, and identical bytes
change nothing. Without it a taken name is exit 5 for that file and the rest
still go up.

Arranging a deck — copies, order, the back:

```sh
threepeaks deck copies "Heroes" knight.png 3 --project "Summit" --no-input
threepeaks deck move-card "Heroes" knight.png --after squire.png --project "Summit" --no-input
threepeaks deck back "Heroes" back.png --project "Summit" --no-input
```

A copy count of 0 keeps the card and prints none of it. Taking a card out of a
deck means deleting its image or moving it to Assets — ask before either.

Component artwork, and its settings:

```sh
threepeaks component upload "Game box" box-wrap.png --project "Summit" --no-input
threepeaks component settings "Game box" --set depth_mm=45 --project "Summit" --no-input
```

A filled slot gains a version rather than losing its file. Settings keys are the
ones `component settings <component>` prints; an unknown key is refused with the
real ones listed.

What the printer still owes, and what the last Canva import did:

```sh
threepeaks print outstanding --project "Summit"
threepeaks deck import show "Heroes" latest --project "Summit"
```

Imports happen inside Canva, never here. Sheets are printed from the web app.

## Naming things

A reference resolves as: whole id → exact name, case-insensitive → id prefix of
4+ characters → unique substring. Ambiguity is exit 2 with the candidates
printed; re-run with an id from that list rather than guessing a longer
substring. Files in Assets are paths (`Art/Cards/cover.png`); a deck's cards are
named with `--deck <deck>`, a component's files with `--component <component>`
and their role.

## Don't, unless asked

Deleting is soft and `threepeaks trash restore` undoes it, but it still changes
what Skyler sees — delete only what you created this session. Never without an
explicit request: anything with `--purge`, `trash purge`, `project delete`,
`project member remove`, `deck import abandon`, `token revoke`,
`session revoke`. Purges are permanent and take every version's bytes with
them.

## Exit codes

`0` ok · `1` network or server · `2` usage or ambiguous reference · `3` not
signed in · `4` not found · `5` conflict · `6` invalid input · `7` read-only
access to that project.

## More

`threepeaks <command> --help` is authoritative for flags, and `commands.md`
beside this file is the whole surface at a glance. `threepeaks watch --project
"…"` streams realtime events as NDJSON — a live tap with no replay, so re-read
what you care about after any "Connection restored".
