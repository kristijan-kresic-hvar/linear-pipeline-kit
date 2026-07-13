# Snapshot Freshness Check

Cheap probes the implementing agent runs at Step 4.5 of `starting-linear-ticket` (Path A only — rich tickets with an Implementation Snapshot section). The goal is to catch stale anchors — files that moved, symbols that were renamed, columns that were dropped — before they cause wrong-file edits or reinvented helpers.

These probes are framework-agnostic: they rely on file-existence checks, symbol greps, and the ticket's own Post-Merge Verification commands. Do not assume a particular stack.

## Probes

For each entry in the ticket's Implementation Snapshot:

### 1. Files exist

For every path under "Files to modify" and "Files to create":

```bash
# Files to modify — must exist
test -f <repo-root>/<path> || echo "STALE: file missing"

# Files to create — should NOT exist (or be empty / a stub)
test ! -e <repo-root>/<path> || test ! -s <repo-root>/<path> || echo "WARN: file already exists with content"
```

A "Files to modify" path that's missing → stale. The file likely moved or was renamed.

A "Files to create" path that already has content → not necessarily stale, but the agent should investigate before overwriting.

### 2. Symbol references resolve

For each "Patterns to follow: see `<symbol>` in `<path>` for ..." entry:

```bash
# Symbol must still exist at the referenced path (use rg if available, else grep)
rg -n "(function|const|class|def|export.*) <symbol>" <repo-root>/<path> >/dev/null \
  || echo "STALE: symbol <symbol> not found in <path>"
```

If the grep misses, the symbol was renamed, moved, or deleted. The agent shouldn't blindly trust the pattern reference.

### 3. Schema / data-model anchors exist

For each "Schema touched: `<table>.<column>`" or data-model anchor entry, verify the anchor still exists using whatever is appropriate for the project's stack. Prefer a cheap, framework-agnostic probe:

```bash
# Grep the schema/migration/model definition for the table or column name
rg -n "<table>|<column>" <repo-root>/<schema-or-migrations-dir> >/dev/null \
  || echo "STALE: schema anchor <table>.<column> not found"
```

If the project exposes a live schema, you can also query it directly. (Example: if the project uses Supabase/Postgres, query `information_schema.columns`; adapt to the project's stack — ORM model files, a `schema.prisma`, SQL migrations, etc.) As a final confirmation, run the ticket's **Post-Merge Verification** commands, which encode the project-specific way to assert the data model is intact.

Empty / no-match result → stale. The column or table was dropped or renamed.

### 4. Type references resolve

For each "Types/interfaces touched: `<TypeName>` in `<path>`" entry:

```bash
rg -n "(type|interface|enum|class|struct) <TypeName>" <repo-root>/<path> >/dev/null \
  || echo "STALE: type <TypeName> not found in <path>"
```

## Decision

| All probes pass | Trust the snapshot. Proceed to Step 5 (Create Task List). |
|---|---|
| Any probe reports STALE | Spawn Rescue Scout (see `~/.claude/skills/creating-linear-tickets/scout-prompt.md` "Rescue Scout" mode if that skill exists; otherwise instruct the subagent to refresh only the broken anchors). The scout refreshes only the broken anchors and writes the refreshed snapshot to `<worktree>/SNAPSHOT.md`. |
| WARN only (e.g., file-to-create exists) | Investigate manually before deciding. Don't auto-rescue. |

## What to refresh

The Rescue Scout should refresh **only the broken anchors**, not the whole snapshot. If "Files to modify" is fine but a schema anchor is stale, the scout reproduces just the schema section. This keeps the rescue cheap and avoids re-litigating decisions that were correct.

## What NOT to do

- **Don't** edit the Linear ticket. The durable spec hasn't changed. The refreshed snapshot is worktree-local.
- **Don't** ignore a STALE result and proceed. That's the failure mode this check exists to prevent.
- **Don't** skip this step "because the ticket was created today." A repo with 10+ commits/day can invalidate a snapshot in hours.
- **Don't** treat freshness checks as optional. They're cheap (single grep / single query each).

## Why these probes and not others

These are chosen because they catch the specific failure modes observed in past sessions:

- File-existence catches the "file was renamed" failure (most common after refactors).
- Symbol grep catches the "helper was renamed/deleted" failure (common after consolidation passes).
- Schema/data-model check catches the "column was renamed in a migration" failure (most damaging because tests can pass with the wrong key — e.g. slug-vs-UUID class bugs).

Probes that are **not** included on purpose:
- Full type-check / lint / build — too slow for a freshness gate.
- Running the test suite — same.
- Probing every internal helper used by the snapshot's referenced symbols — over-broad, scout will catch downstream issues during rescue.
