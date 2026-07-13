# Linear MCP tool reference (shared)

Single home for the Linear MCP tool-surface facts. The pipeline skills (`creating-linear-project`,
`creating-linear-tickets`, `starting-linear-ticket`, `linear-todo-runner`) point here instead of
carrying their own copies — edit THIS file, never re-inline the note.

- **Upsert surface — there is no `create_issue`/`update_issue`/`create_project`/`create_comment`.**
  The write tools are `mcp__linear-server__save_issue`, `save_project`, `save_comment`,
  `save_status_update`, `save_document`, `save_milestone`: each **creates** when no `id` is passed
  and **updates** when `id` is given.
  - Status changes: `save_issue {id, state}`.
  - PR/work-log links: `save_issue {id, links: [{url, title}]}` — **append-only**, existing links survive.
  - Labels: preserve existing `Bug`/`Feature`/`Improvement` labels on every update.
- **`save_issue` key params:** `title` (required on create), `team` (required on create — a team
  **name or ID**; the param is `team`, **not** `teamId`), `description` (markdown, literal newlines
  not `\n`), `state`, `priority` (0=None, 1=Urgent, 2=High, 3=Medium, 4=Low), `project`, `cycle`,
  `milestone`, `assignee`, `labels` (names/ids), `links` (append-only), `parentId` (→ sub-issues;
  children inherit team/project from the parent), `blockedBy`/`blocks`/`relatedTo` (append-only
  arrays of issue ids/identifiers) plus `removeBlockedBy`/`removeBlocks`/`removeRelatedTo`.
- **Project-level tools:** `save_project` requires `name` + at least one team via `addTeams`;
  `save_status_update` takes `{type:"project", project, health, body}`; `save_milestone` for
  project milestones; `create_issue_label` takes `teamId` (omit for a workspace-level label).
- **Reads:** `get_issue` — issue fields, `attachments`, `documents`, and the Linear
  `gitBranchName`. **Pass `includeRelations: true`** to get the dependency edges
  `blockedBy`/`blocks`/`relatedTo`/`duplicateOf`; they are **omitted by default** (a plain
  `get_issue` returns no relations at all). It does **not** return parent/children in the
  payload — enumerate a parent's sub-issues with `list_issues {parentId}`. `list_issues`
  (filter by `parentId`, `state`, `project`, …),
  `get_project`, `list_projects`, `list_teams`, `list_issue_statuses`, `list_issue_labels`,
  `list_comments`, `list_milestones`, `get_milestone`.
- **Team is never hardcoded.** Read the team from the project's `.claude/CLAUDE.md` and confirm it
  (via `list_teams`) before any `save_issue`/`save_project`. No team declared = the project has NOT
  opted into Linear — don't write.
- **Names drift server-side.** If a call fails with an unknown-tool error, run `/mcp` to confirm the
  live tool list before retrying.
