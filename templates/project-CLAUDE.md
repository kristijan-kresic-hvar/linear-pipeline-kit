# <Project Name> — project instructions

Merges with the global `~/.claude/CLAUDE.md` (guardrails + strict git gate + Linear conventions). Keep this file for code-local, fast-moving facts only — cross-functional plans/decisions live in Linear (one home per fact).

## Linear
<!-- Linear is opt-in PER PROJECT (global CLAUDE.md §6). Personal side project: keep this
     section and fill in the team key. Work/company repo: DELETE this whole section —
     its presence is what opts the repo into Linear. -->
- Team: `<team key, e.g. KKD for personal side projects>`
- Project: <Linear project name, if this repo maps to one>

## Verification Commands
The Linear pipeline skills (starting-linear-ticket, freshness-check, linear-todo-runner) read these — they assume NO package manager or framework, so fill them in. Every command here must RUN TO COMPLETION and exit on its own (the skills run all of them, in-process, as a completion gate). Do NOT list anything that needs a running server or blocks — that's the E2E / Dev entries below:
- Test: <e.g. npm test>          # unit/integration; no server dependency
- Lint / Typecheck: <e.g. npm run lint && npm run typecheck>
- Build: <e.g. npm run build>

## E2E (server-dependent — run ONCE, in Step 7's E2E flow, not in the gate above)
- E2E: <e.g. npm run test:e2e> <!-- delete if none. starting-linear-ticket Step 7 starts the dev server, runs this, then stops it — keep it OUT of Verification Commands so it isn't run serverless or re-run inside implementation subagents -->

## Dev Server (NOT a verification command — long-running)
- Dev: <e.g. npm run dev> <!-- used for manual testing / the E2E server; never run as a completion gate -->

## Stack
- Language / framework: <...>
- Package manager: <npm | pnpm | yarn | bun | uv | poetry | ...>
- DB / infra: <...>

## Design & Copy
<!-- Personal/side projects with a UI or marketing surface: the toolchain is global
     CLAUDE.md §8 (impeccable driver, mobbin reference pass, copywriting/copy-editing/
     marketing-psychology for marketing copy). Bootstrap per §8: create
     .claude/product-marketing.md + DESIGN.md via /impeccable document, run the mobbin
     pass, check parked watch-items (React project → vercel react skills, etc.).
     Delete this section for company/work repos — §8 does not apply there. -->
- Register: <brand | product>
- Design source: <impeccable-driven | Figma file if one exists>

## Sharp Edges
- <non-obvious constraints, footguns, things that have bitten before>

## Conventions
- <code-local conventions not already in the global CLAUDE.md>
