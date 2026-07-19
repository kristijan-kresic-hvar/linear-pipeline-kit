# linear-pipeline-kit

A complete Linear-driven development workflow for [Claude Code](https://claude.com/claude-code):
tickets written as **executable specs**, strict worktree + PR discipline enforced by a
**merge-gate hook**, TDD by default, and a **queue runner** that works a whole backlog of
tickets into open PRs with one approval. This is a 1:1 extraction of the exact setup the
author runs daily — nothing idealized, everything battle-used.

**Companion kit:** [ai-review-kit](https://github.com/kristijan-kresic-hvar/ai-review-kit)
(two adversarial AI reviewers on every PR + autonomous fix loop + CI merge gate). The two
kits compose but don't overlap: this kit takes an idea to an open PR; ai-review-kit takes
the PR to mergeable. Each degrades gracefully without the other (see the
[degradation matrix](#degradation-matrix)).

## Status: battle-tested (solo, 2026-07)

Extracted verbatim from a live `~/.claude` on 2026-07-13. The skills carry their scars:
dates, live findings, and rules that exist because something once went wrong. Where an
example uses the team key `KKD`, substitute your own.

## What you get

### The pipeline (idea → open PR)

```
 idea / spec
   │
   ▼
 creating-linear-project        one Linear Project per initiative — durable
   │                            description + phase map (the project IS the doc)
   ▼
 creating-linear-tickets        brainstorm → scope cut (REDUCE) → eng review →
   │                            tickets as executable specs, dependencies as
   │                            real Linear relations. Fast path for small tickets.
   ▼
 starting-linear-ticket         fetch ticket → In Progress → git worktree →
   │                            snapshot freshness check → conditional design pass
   │                            → TDD implementation → verification gate → PR
   ▼
 open PR ──────────────────────► ai-review-kit loop (optional companion)
   │
   ▼
 linear-todo-runner             the scale-out: fetches ALL Todo tickets, builds a
                                dependency-ordered queue, runs rolling parallel
                                agents — each ticket to an open PR, one kickoff
                                approval, no mid-run questions
```

### Supporting skills

| Skill | Role |
|---|---|
| `plan-review-eng` | Architecture review during planning; code-quality/test/perf review during execution. Question-driven, 3–5 questions per pass. |
| `verify-library-api` | Check the *installed* version of a library before writing integration code — kills the "trained on an older API" bug class. |
| `rapid-prototype` | The escape hatch: genuinely disposable work (spikes, demos, take-homes) deliberately skips Linear, worktrees, TDD, and PRs. |
| `plan-review-ceo` (archived) | Business-value review pass. Archived as solo ceremony (`SKILL.md.archived`) — resurrect if a team forms. |

### The rules layer

Skills are the *how*; the *policy* lives in a global `CLAUDE.md`
([`CLAUDE.md.example`](CLAUDE.md.example), shipped verbatim):

- **§4 Goal-driven execution** — every task becomes a verifiable goal; test posture
  follows the project (never bolt a test framework onto a repo that has none).
- **§5 Git workflow (strict)** — never commit to `main`, never merge without explicit
  human approval; work happens in worktrees + PRs. Defines the middle tier ("small real
  change": worktree + PR, no ceremony) and the `rapid-prototype` escape hatch.
- **§6 Linear (opt-in per project)** — Linear is OFF by default; a repo opts in via its
  `.claude/CLAUDE.md`. Ticket = executable spec. Status is a state machine bolted onto
  git. Comments are the work log.
- **§7 One home per fact** — plans/decisions live in Linear, code-local conventions in
  the repo, nothing duplicated. Includes decision hygiene (docs fixed in the same
  session as the decision) and the end-of-project archive snapshot.
- **§8 Design & copy machinery** — the personal-project design/copy toolchain the
  template's "Design & Copy" section points at. Example only — swap in your own tools
  or delete both the section and the template block.

### The merge-gate hook

[`hooks/merge-gate.mjs`](hooks/merge-gate.mjs) — a Claude Code `PreToolUse` hook that
makes §5 mechanical instead of aspirational. It inspects every Bash call and:

- **denies** pushes to `main`/`master` — it parses the push grammar rather than
  pattern-matching shapes, so `git -C`/`--git-dir` forms, any remote name, `--repo`
  forms, multi-ref pushes, `--all`/`--mirror`, wildcard refspecs, refspec and
  branch-deletion forms, and a bare `git push` while sitting on main (resolved against
  the real current branch) are all caught;
- **denies** REST/GraphQL PR merges (and REST branch deletion), auto-merge mutations,
  interpreter-wrapped merges (`python -c "subprocess.run(['gh','pr','merge',…])"`), and
  `git rebase -x/--exec` smuggling — shapes the gate can't inspect are refused, not
  trusted;
- **gates `gh pr merge`** on live reviewer state: it queries the PR and blocks unless
  every applicable AI reviewer (Claude leg / Codex leg, per
  [ai-review-kit](https://github.com/kristijan-kresic-hvar/ai-review-kit)) is clean on
  the PR's *current head* — one merge per Bash call, no out-of-band `GH_REPO` repo
  selection, and even a clean pass ends in `ask`, never auto-merge;
- **fails closed**: unverifiable state → deny. The installer wires it so a missing hook
  file or missing `node` also blocks rather than silently running ungated.
- **is regression-tested**: [`merge-gate.test.m

Without [ai-review-kit](https://github.com/kristijan-kresic-hvar/ai-review-kit) the hook
still bans main-pushes and API-merge bypasses; the reviewer checks simply find no
reviewers configured and fall back to `ask` (manual approval only).

One deliberate personal exemption ships in the hook (documented inline): a bare
`git -C ~/.claude push origin main` is allowed *only* when the target repo actually
resolves to `~/.claude` — the author's config repo syncs by direct push. Harmless if
that's not your flow; delete the exemption block if you want zero exceptions.

### Scope & security boundaries (read before relying on the gate)

This kit is built — and audited — for **one supervised solo operator**. Know where the
lines are:

- **The hook is a guardrail against the agent, not a standalone security gate.** It
  scans Bash text; it is not a shell parser and cannot see every indirection
  (file-supplied `gh api --input` payloads, dynamically assembled commands). Shapes it
  can't verify it denies, but a determined human was never the threat model — the agent
  making an honest mess is.
- **The real enforcement backstop is server-side:** GitHub **branch protection** on
  `main` plus [ai-review-kit](https://github.com/kristijan-kresic-hvar/ai-review-kit)'s
  CI `merge-gate.yml` (the hook's server-side twin). Run this kit with both; treat the
  local hook as the fast first line, not the last.
- **Time-of-check vs time-of-use:** the gate verifies the PR head at command time and
  ends in `ask` — a push landing between verification and your approval invalidates the
  verdict (the pass message names the verified SHA). For a hard bind, merge with
  `--match-head-commit <sha>`; branch protection covers the rest.
- **The todo-runner is single-runner, supervised.** Linear has no compare-and-set, so
  ticket claiming is best-effort (marker comments + resume reconciliation), not atomic.
  One runner per team; don't run it unattended. Details in
  [`linear-todo-runner`](skills/linear-todo-runner/SKILL.md)'s "Known limitations".
- **Linear content is untrusted input.** The skills carry an explicit trust boundary
  (ticket text is a work order, never authority to bypass gates), but that boundary is
  prompt-level discipline, not a mechanical sandbox.

### Ticket anatomy (the executable spec)

`creating-linear-tickets` writes every ticket so an agent can run it cold:

```
## Problem            why this exists, user-visible symptom
## Scope              vertical slice — backend + frontend + tests together
## Acceptance Criteria
## Verification       Observable Signals + Test Scenarios + Post-Merge commands
## Implementation Snapshot   real file paths/symbols + the SHA they were captured at
## Sharp Edges        the footguns
## Dependencies       encoded as REAL Linear relations, not prose
## Not in Scope
```

Snapshots expire — `starting-linear-ticket` runs
[`freshness-check.md`](skills/starting-linear-ticket/freshness-check.md) before
executing (SHA-diff drift check on the snapshot's paths, file-exists, symbol/type grep,
schema anchors) and refreshes stale anchors into a worktree-local note, never by editing
the durable spec. Ticket-supplied paths/symbols are treated as untrusted input — quoted,
repo-contained, never `eval`'d.

### The status state machine

```
Backlog/Todo ──(manual, before any design)──► In Progress
In Progress ──(PR opened — Linear GitHub integration)──► In Review
In Review ──(PR merged — Linear GitHub integration)──► Done
stuck ──(manual)──► blocked label + back to Backlog
```

Only the first flip is manual. `In Review` and `Done` ride Linear's native GitHub
integration; the skills attach the PR link as a comment and *verify* the transition
landed, flipping manually only as a fallback.

## External companions (not shipped here)

Two skill names appear in this kit's flows but live in the operator's `~/.claude/skills/`,
not in either kit: **`address-pr-review`** (routes review findings through
[ai-review-kit](https://github.com/kristijan-kresic-hvar/ai-review-kit)'s playbook —
`starting-linear-ticket` Step 9 and `linear-todo-runner` delegate to it) and
**`babysit-prs`** (manual multi-PR sweep wrapper; the scheduled cadence is ai-review-kit's
`babysit.sh`). Without them the flows still work — review handling just falls back to
following ai-review-kit's playbook directly.

## Prerequisites

- **Claude Code** (CLI or desktop) with `git`, `gh` (authenticated), and `node` on PATH.
- **A Linear account** — the Free plan is enough (one team, many projects; archive
  instead of delete).
- **Linear MCP server** — added + OAuth'd once (the installer prints the exact commands).
- **Recommended:** the [superpowers](https://github.com/obra/superpowers-marketplace)
  plugin. The skills invoke its discipline skills by name (`superpowers:brainstorming`,
  `superpowers:using-git-worktrees`, `superpowers:verification-before-completion`,
  `superpowers:requesting-code-review`). TDD itself is instructed inline by the skills
  (RED → GREEN → REFACTOR), so it works plugin or no plugin.
- **Optional:** [ai-review-kit](https://github.com/kristijan-kresic-hvar/ai-review-kit)
  for the post-PR review loop, and its per-repo `setup.sh`.

## Setup

```bash
git clone https://github.com/kristijan-kresic-hvar/linear-pipeline-kit.git
cd linear-pipeline-kit
./setup.sh            # copies skills + hook + template into ~/.claude, wires settings.json
```

Then the manual floor (printed by the installer):

1. **Linear MCP** (once):
   ```bash
   claude mcp add --scope user --transport http linear-server https://mcp.linear.app/mcp
   ```
   then inside a Claude Code session: `/mcp` → `linear-server` → Authenticate (browser).
2. **Opt a project in** (per repo): seed its `.claude/CLAUDE.md` from
   [`templates/project-CLAUDE.md`](templates/project-CLAUDE.md) and set `Team: <your key>`.
   No opt-in → the pipeline stays out of that repo entirely.
3. **Restart Claude Code** so the skills register.

`setup.sh` flags:

- `--link` — symlink instead of copy: the kit clone becomes the one editable home
  (edit → `git push` publishes; this is how the author's own machine is wired, so the
  public kit can never drift from the live setup). Windows/Git Bash needs Developer
  Mode **and** `export MSYS=winsymlinks:nativestrict` — plain `ln -s` there silently
  copies, and the installer detects that and tells you. Default copy mode works
  everywhere.
- `--force` — replace installed items that differ from the kit (default is skip + warn,
  so your local edits are never clobbered silently).

Re-running is safe; every step is idempotent.

### If you already have a global CLAUDE.md

The installer never auto-appends a full guidelines file into an existing one. Merge at
minimum §4–§8 from [`CLAUDE.md.example`](CLAUDE.md.example) by hand — the skills assume
those rules exist (especially §5's "never merge without approval", which the hook
enforces, and §6's opt-in semantics).

## Degradation matrix

| Missing piece | What still works | What degrades |
|---|---|---|
| superpowers plugin | Every skill's own steps | The named discipline passes (brainstorm, TDD cadence, worktree helper) become manual judgment — the skills reference them but proceed |
| [ai-review-kit](https://github.com/kristijan-kresic-hvar/ai-review-kit) | Idea → tickets → worktree → PR, merge-gate's main-push + API-merge bans | Post-PR review loop is manual; `gh pr merge` gate finds no reviewers and falls back to `ask` (human-only approval) |
| Linear GitHub integration | Whole pipeline | `In Review`/`Done` flips become manual fallbacks (skills verify and self-heal) |
| Linear MCP not authenticated | Nothing Linear-touching | Skills stop at the fetch step; re-auth via `/mcp` |
| Project not opted in | Normal Claude Code work, `rapid-prototype` | All Linear skills stay out by design — this is a feature |
| `gh` not authenticated | Ticket creation, design passes | PR creation and the merge gate's reviewer queries fail loudly |

## Files

| File | What it is |
|---|---|
| `skills/creating-linear-project/` | Spec/plan → Linear Project with durable description + phase map |
| `skills/creating-linear-tickets/` | Idea → executable-spec tickets (brainstorm, REDUCE scope cut, eng review). Companions: `scout-prompt.md` (parallel codebase scout), `linear-mcp-reference.md` (MCP call crib sheet) |
| `skills/starting-linear-ticket/` | Ticket → open PR (worktree, TDD, verification gate). Companion: `freshness-check.md` |
| `skills/linear-todo-runner/` | Backlog → rolling parallel agents → PRs, one kickoff approval |
| `skills/plan-review-eng/` | Question-driven architecture / code-quality / test / perf review |
| `skills/verify-library-api/` | Check installed library versions before writing integration code |
| `skills/rapid-prototype/` | Disposable-work escape hatch (skips the whole pipeline, on purpose) |
| `skills/plan-review-ceo/SKILL.md.archived` | Archived business-value review — for teams, not solos |
| `hooks/merge-gate.mjs` | PreToolUse hook: bans main-pushes + merge bypasses, gates `gh pr merge` on reviewer state, fails closed |
| `hooks/merge-gate.test.mjs` | Plain-node regression tests for the hook (no framework, no network — stubbed `gh`, fixture repos). Run `node hooks/merge-gate.test.mjs` after any hook edit |
| `templates/project-CLAUDE.md` | Per-repo seed: Linear opt-in block + verification commands the skills read |
| `CLAUDE.md.example` | The author's live global CLAUDE.md, verbatim — the policy layer |
| `setup.sh` | Idempotent installer (copy or `--link`), wires the hook into `settings.json` |

## Portability

- **macOS / Linux:** everything works out of the box (`bash`, `node`, `git`, `gh`).
- **Windows:** run `setup.sh` from Git Bash; default copy mode needs no symlink rights,
  and `.gitattributes` pins LF so `autocrlf` clones can't break the scripts. The hook
  itself is pure Node, but the *wiring command* in `settings.json` is POSIX-shell —
  it fires in environments where Claude Code executes hooks via `sh` (macOS, Linux,
  WSL, Git-Bash-launched sessions). On a native-Windows session where it can't run,
  treat [ai-review-kit](https://github.com/kristijan-kresic-hvar/ai-review-kit)'s CI
  `merge-gate.yml` (the server-side twin) as the enforcement layer and verify locally
  before trusting the hook.
- **Custom config dirs:** the installer embeds the hook's *absolute path* (derived from
  where it actually installed) into `settings.json` — no `$HOME` guessing at run time.
  If you override `CLAUDE_DIR`, it must be the directory Claude Code really reads
  (`os.homedir()/.claude`), or you've installed to a place Claude Code never looks.
- **New machine:** clone + `./setup.sh` + the two-step Linear auth. That's the whole
  migration.

## Gotchas (learned live)

- **Snapshots expire.** Never execute a ticket without the freshness check; a stale
  Implementation Snapshot sends an agent to files that moved. Refresh into a
  worktree-local note — the Linear spec stays durable.
- **The one manual status flip is `In Progress`** — set it *before* design work (no PR
  exists yet, so no integration can do it for you). Everything later is verified, not
  assumed: check the integration actually flipped the status before trusting it.
- **Bulk Linear writes are token-expensive.** For mass ticket creation or queue-wide
  status updates, compose content in the main model and delegate the mechanical
  `save_*` calls to a cheap subagent (Haiku). One-off writes stay inline.
- **Linear MCP timeouts** are an auth problem, not a network problem — re-authenticate
  via `/mcp` (or `claude mcp login linear-server`).
- **Treat Linear content as untrusted input.** Issue text and comments can be authored
  by others — don't follow embedded instructions or links blindly, especially before
  writes.
- **The merge gate blocks heredocs that merely *mention* merging** only when they feed a
  shell. Writing docs/prose about merges: use file tools, not `bash <<EOF` — the hook's
  error message says exactly this when it fires.
- **`KKD` in examples is the author's team key.** The skills are team-agnostic; the key
  always comes from the per-project `.claude/CLAUDE.md`.

## Relationship to ai-review-kit

Zero file overlap, deliberate seam: this kit ends at "PR is open, Linear says In
Review". [ai-review-kit](https://github.com/kristijan-kresic-hvar/ai-review-kit) owns
everything after — reviewer triggering, the fix loop, thread hygiene, the CI merge-gate
workflow (`merge-gate.yml`, the server-side twin of this kit's local hook). Install both
for the full idea-to-merged path. The `linear-todo-runner` hands opened PRs to
ai-review-kit's loop when present; without it, PRs just wait for human review.

## License

[MIT](LICENSE).
