# @three-peaks/shared

Source-only. No build step, no `dist/`, no `main` field — `exports` points
straight at `.ts`, and every consumer (tsc under `moduleResolution: bundler`,
Vite, vitest, esbuild, tsx) reads TypeScript natively.

That is not a shortcut; the root `AGENTS.md` explains the build-order cycle it
avoids and the two eslint-enforced rules that keep it acyclic.

What belongs here is anything the API and the web app must **agree** on or
something breaks silently — project roles, upload limits, password rules — plus
the two generated clients under `src/api/` and `src/realtime/`.

Its `.ts` sources compile as part of _both_ apps' programs, so it must satisfy
the union of their compiler options. `verbatimModuleSyntax` and
`isolatedModules` are set in its own tsconfig so a violation fails here rather
than in whichever app happens to build first.
