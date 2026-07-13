---
name: creating-linear-project
description: Use when standing up a NEW Linear project from a spec/plan — turns a planning doc (Obsidian/repo spec or a brainstorm) into a Linear Project with a durable description + phase map, then hands off to creating-linear-tickets for the phase's issues. Triggers — "create a Linear project", "set up the project in Linear", "kick off <X> in Linear", "make a project for <X>".
---

# Creating a Linear Project

Stands up the **project shell + durable context + phase map** for a body of work, so individual tickets (created by `creating-linear-tickets`) have a home and a source of truth. This is the project-level companion to the ticket-level `creating-linear-tickets`.

> **Linear MCP note:** hosted server, **upsert** tools (`save_*`). Full tool surface + param gotchas (incl. `save_project` `addTeams`, `save_status_update`, `save_milestone`): read `~/.claude/skills/creating-linear-tickets/linear-mcp-reference.md` — one home per fact, don't re-inline it here.

## When to use
- Starting a new project/initiative that will hold multiple tickets across phases.
- You have a planning doc/spec (Obsidian note, repo `*.md`, or a brainstorm) to base it on.

## When NOT to use
- A single ticket or quick bug → use `creating-linear-tickets` directly.
- The project already exists → just add tickets with `creating-linear-tickets`.
- Throwaway/spike work → `rapid-prototype` (no Linear at all).

## Steps

1. **Read the spec.** Ingest the planning doc (vault note / repo spec / brainstorm). If the spec is thin, run `superpowers:brainstorming` first — don't invent scope.
2. **Confirm team + dedupe.** Team comes from the project's `.claude/CLAUDE.md` (`Team:` line) — never hardcode. Run `list_projects` (filter by team) to confirm no project with this name already exists.
3. **Break the work into logical phases.** Phases are the durable structure (e.g. Spec → Setup → Tokens → Layouts → …). Keep them coarse; tickets live inside phases.
4. **Create the project** with `save_project`:
   - `name`, `addTeams: ["<team>"]`, optional `lead: "me"`, `icon`, `state: "started"` (or planned).
   - `summary` (≤255 chars).
   - `description` (markdown) = the **durable context**: goal, primary KPI/constraints, stack, the **phase map** (mark the current phase), locked decisions, and links to the repo + the source spec doc. **This description IS the project doc — one home per fact** (don't duplicate it elsewhere).
5. **(Optional) Milestones per phase.** If phases should be tracked as milestones, `save_milestone` one per phase. Skip if the phase map in the description is enough — don't add milestones nobody will look at.
6. **Hand off to tickets.** For the **current/next phase only**, invoke `creating-linear-tickets` to create that phase's issues *into this project* — with acceptance criteria, dependency relations (`blockedBy`), and scout Implementation Snapshots. Don't front-load every phase's tickets; create them phase-by-phase as work approaches.
7. **Seed cross-session memory.** Post one `save_status_update` (`type:"project"`, `health:"onTrack"`). **Lead the body with a `**CURRENT STATE:**` block — 3 bullets: active phase · current blocker (or "none") · next action** — so a cold agent parses where things stand in one read; follow with supporting detail. Use the same `CURRENT STATE:` lead on every later status update (they're append-only, so the latest must be self-summarizing).

## Notes
- **Bulk writes → Haiku** (per global CLAUDE.md): if you're creating many milestones/labels/tickets in one go, delegate the mechanical `save_*` calls to a Haiku subagent; compose content with the main model.
- Preserve the `Bug`/`Feature`/`Improvement` label convention on any issues created downstream.
- Keep the strict git gate (worktree + PR, never merge without approval) — it applies to all work under the project.
