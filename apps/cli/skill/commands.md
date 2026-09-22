# threepeaks — every command

Every project-scoped command also takes `--project <project>`, and every command
takes `--json`, `--no-input`, `--no-color` and `--api-url <url>`.
`threepeaks <command> --help` is authoritative; `tests/unit/skillCommands.test.ts`
fails when this list and the program disagree about which commands exist.

## Account

- `threepeaks login [--email <email>] [--password-stdin]` — sign in and store the session token
- `threepeaks logout` — end the session and forget the token
- `threepeaks signup [--email <email>] [--name <name>] [--password-stdin]` — create an account
- `threepeaks whoami` — the signed-in account
- `threepeaks status` — the server, the build it runs, and who is signed in
- `threepeaks account change-password [--password-stdin]` — current then new; sessions stay signed in
- `threepeaks account forgot-password [--email <email>]` — email a reset link
- `threepeaks account reset-password --token <token> [--password-stdin]` — spend a reset link
- `threepeaks session list` — active sessions; `*` marks this one
- `threepeaks session revoke <session> [--force]` — end one; ending this one signs the CLI out
- `threepeaks token list` — personal access tokens, never their secrets
- `threepeaks token create <name>` — prints the secret once, alone on stdout
- `threepeaks token revoke <token> [--force]`

## Projects

- `threepeaks project list`
- `threepeaks project show [project]` — owner, members, storage used of the quota
- `threepeaks project create <name> [--description <text>]`
- `threepeaks project update [project] [--name <name>] [--description <text>] [--clear-description]`
- `threepeaks project delete <project> [--force]` — owner only, permanent
- `threepeaks project leave [project] [--force]`
- `threepeaks project members [project]`
- `threepeaks project member add <email> [--role editor|viewer]` — owner only
- `threepeaks project member set-role <member> --role editor|viewer`
- `threepeaks project member remove <member> [--force]`

## Assets

- `threepeaks ls [folder]` — one folder: its folders, then its files
- `threepeaks mkdir <folder> [--parents]`
- `threepeaks upload <paths...> [--to <folder>] [--replace]` — `--replace` versions a taken name
- `threepeaks download <file> [--output <path>|-] [--version <n>] [--force] [--deck <deck>] [--component <component>]`
- `threepeaks file show <file>` — where it lives, type, size, version
- `threepeaks file rename <file> <name>`
- `threepeaks file move <file> (--to <folder> | --to-deck <deck> [--back] | --to-component <component> [--role artwork|cut])`
- `threepeaks file delete <file> [--purge] [--force]` — soft unless `--purge`
- `threepeaks file restore <entry> [--name <filename>]`
- `threepeaks file versions <file>`
- `threepeaks file push <file> <path>` — the next version from a local file
- `threepeaks file revert <file> <version>` — copies an old version forward
- `threepeaks folder rename <folder> <name>`
- `threepeaks folder move <folder> <parent>` — `/` is the root
- `threepeaks folder delete <folder> [--purge] [--force]`
- `threepeaks folder restore <entry> [--name <name>]`

`file` commands also take `--deck <deck>` or `--component <component>` to name a
card or a component's file instead of an Assets path.

## Trash

- `threepeaks trash list [--kind file|folder|deck|component]`
- `threepeaks trash restore <entry> [--name <name>]`
- `threepeaks trash purge <entry> [--force]` — permanent

## Decks

- `threepeaks deck list`
- `threepeaks deck show <deck> [--all]` — print order; `--all` includes deleted cards
- `threepeaks deck sizes`
- `threepeaks deck create <name> [--size <size> | --width <mm> --height <mm>]`
- `threepeaks deck update <deck> [--name <name>] [--size <size> | --width <mm> --height <mm>]`
- `threepeaks deck back <deck> (<card> | --none)`
- `threepeaks deck delete <deck> [--purge] [--force]`
- `threepeaks deck restore <deck> [--name <name>]`
- `threepeaks deck upload <deck> <paths...> [--back] [--replace]`
- `threepeaks deck download <deck> [--output <dir>] [--force]`
- `threepeaks deck copies <deck> <card> <count>` — 0 keeps the card, prints none
- `threepeaks deck move-card <deck> <card> (--top | --bottom | --before <card> | --after <card> | --position <n>) [--all]`
- `threepeaks deck model <deck> <card> [--set <key=value>]... [--file <path>|-] [--reset]` — a card's 3D settings
- `threepeaks deck import status <deck>`
- `threepeaks deck import runs <deck>`
- `threepeaks deck import show <deck> <run>` — `<run>` may be `latest`
- `threepeaks deck import as-of <deck> <run>`
- `threepeaks deck import abandon <deck> [--force]`

## Components

- `threepeaks component kinds`
- `threepeaks component list [--kind wood|box|board|punchboard]`
- `threepeaks component show <component>`
- `threepeaks component create <name> --kind <kind> [--set <key=value>]... [--file <path>|-]`
- `threepeaks component rename <component> <name>`
- `threepeaks component settings <component> [--set <key=value>]... [--file <path>|-] [--reset]`
- `threepeaks component upload <component> <path> [--role artwork|cut]` — a filled slot gains a version
- `threepeaks component download <component> [--role artwork|cut] [--output <path>|-] [--force]`
- `threepeaks component move <component> (--top | --bottom | --before <component> | --after <component> | --position <n>)`
- `threepeaks component delete <component> [--purge] [--force]`
- `threepeaks component restore <component> [--name <name>]`

## Printing, Canva, links

- `threepeaks print outstanding [--deck <deck>] [--all]` — what each card still owes, and why
- `threepeaks canva pair <code>`
- `threepeaks canva links`
- `threepeaks canva unlink <link> [--force]`
- `threepeaks canva build` — which bundle last ran inside Canva
- `threepeaks url project [project]`
- `threepeaks url members`
- `threepeaks url trash`
- `threepeaks url folder [folder]`
- `threepeaks url decks`
- `threepeaks url deck <deck> [--history]`
- `threepeaks url print [--deck <deck>]`
- `threepeaks url scene`
- `threepeaks url section <kind>`
- `threepeaks url component <component>`
- `threepeaks url file <file> [--deck <deck>] [--component <component>] [--3d]`

## Everything else

- `threepeaks watch` — realtime events as NDJSON; without `--project`, every project
- `threepeaks config get [key]`
- `threepeaks config set <key> <value>` — `api-url`, `default-project`, `web-url`
- `threepeaks config unset <key>`
- `threepeaks config path`
- `threepeaks completion --shell bash|zsh|fish`
