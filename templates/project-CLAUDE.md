# <Project Name> — project instructions

Merges with the global `~/.claude/CLAUDE.md` (guardrails + strict git gate + Linear conventions). Keep this file for code-local, fast-moving facts only — cross-functional plans/decisions live in Linear (one home per fact).

## Linear
<!-- Linear is opt-in PER PROJECT (global CLAUDE.md §6). Personal side project: keep this
     section and fill in the team key. Work/company repo: DELETE this whole section —
     its presence is what opts the repo into Linear. -->
- Team: `<team key, e.g. KKD for personal side projects>`
- Project: <Linear project name, if this repo maps to one>

## Verification Commands
The Linear pipeline skills (starting-linear-ticket, freshness-check, linear-todo-runner) read these — they assume NO package manager or framework, so fill them in. Every command here must RUN TO COMPLETION and exit (the skills execute all of them as a gate):
- Test: <e.g. npm test>
- Lint / Typecheck: <e.g. npm run lint && npm run typecheck>
- Build: <e.g. npm run build>
- E2E: <e.g. npm run test:e2e — delete this line if the project has none>

## Dev Server (NOT a verification command — long-running)
- Dev: <e.g. npm run dev> <!-- used for manual testing / E2E server; never run as a completion gate -->

## Stack
- Language / framework: <...>
- Package manager: <npm | pnpm | yarn | bun | uv | poetry | ...>
- DB / infra: <...>

## Sharp Edges
- <non-obvious constraints, footguns, things that have bitten before>

## Conventions
- <code-local conventions not already in the global CLAUDE.md>
