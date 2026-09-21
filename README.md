# three-peaks-hub

Board game design tools for Three Peaks Games, served at
**tools.threepeaksgames.com**.

A pnpm-workspace monorepo:

| Package                        | What it is                                                                      | Where it runs                            |
| ------------------------------ | ------------------------------------------------------------------------------- | ---------------------------------------- |
| `apps/api`                     | Hono + Kysely + Postgres                                                        | GKE                                      |
| `apps/web`                     | Svelte 5 (runes) + Vite SPA                                                     | GCS bucket behind a Google load balancer |
| `apps/preview-edge`            | Static edge for per-PR previews                                                 | Cloud Run                                |
| `packages/shared`              | Generated API and realtime clients, plus the constants both sides must agree on | —                                        |
| `infra/terraform`, `infra/k8s` | The load balancer, buckets, certificates, monitoring, manifests                 | —                                        |

## What it does today

- **Accounts.** Email and password (argon2), opaque session tokens hashed at
  rest, a sessions list you can revoke from, and password reset by signed link.
- **Projects.** Owner plus editor/viewer members. A caller with no access gets
  404, never 403.
- **Files.** Project-scoped folders and files, streaming uploads whose content
  type is decided by magic bytes rather than by what the client claims, a
  per-project storage quota, and a browser explorer with drag-and-drop.
- **3D.** Any uploaded image can be turned into a card or a wooden component,
  tuned against a live preview, and exported as a `.glb` at real-world scale.
  The silhouette of a wooden piece is cut from the image itself.
- **Realtime.** A WebSocket at `/ws`; every mutation announces itself, and
  delivery re-checks access per event.

## Getting started

Needs Node 24, pnpm 11 and a local PostgreSQL 18. Redis is optional — without
it the realtime bus stays in-process, which is right for one dev process.

```sh
pnpm install
pnpm setup:env          # writes apps/api/.env and .env.test from the examples
createdb three_peaks_hub
pnpm run migrate
pnpm dev                # api on :17310, web on :17300
```

Then open http://localhost:17300 and create an account. Password-reset emails go
to the console driver by default, so the reset link is printed in the API log.

## Everyday commands

```sh
pnpm test                       # every suite
pnpm --filter @three-peaks/api test tests/e2e/files.test.ts   # one file
pnpm run generate               # regenerate the committed clients
pnpm run check:all              # the whole gate
```

`AGENTS.md` is the architecture document: the conventions, the reasons behind
them, and the traps that have already cost time. Read it before changing the
auth boundary, the realtime tables, or anything about how the clients are
generated.

## Deployment

Push to `main`. The workflow builds the image, runs migrations as a Job, then
rolls out; the web half deploys after the API so a bundle is never served
against an endpoint that does not exist yet.

Live at **https://tools.threepeaksgames.com**. Opening a pull request publishes
a preview to `pr-<n>.tools.threepeaksgames.com` and comments the URL; closing it
removes both. A preview is a full same-origin virtual host — `/api` and `/ws`
reach the real API — so it needs no CORS and behaves exactly like production.
