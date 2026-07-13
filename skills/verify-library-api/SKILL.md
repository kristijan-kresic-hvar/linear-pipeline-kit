---
name: verify-library-api
description: Use when using any framework or library API, especially fast-moving ones in active projects — Astro, Tailwind CSS v4, Next.js, Anthropic SDK, Framer Motion — prevents assuming outdated API patterns; check the INSTALLED version before writing integration code
---

# Verify Library API Before Using

## Overview

Libraries change between versions. API patterns from training data may be outdated.

**Core principle:** Check the installed version and verify the API matches BEFORE writing code that uses it.

## When to Use

**Use when:**
- Calling any framework/library API you haven't verified this session
- A library API doesn't behave as expected
- Spawning an agent to work with framework-specific code
- Upgrading or installing a new package version

**Especially for:** Astro, Tailwind CSS v4, Next.js, the Anthropic SDK, Framer Motion, and any rapidly-evolving library.

## Steps

### 1. Check Installed Version

Use the package manager the project actually uses — check the project's `.claude/CLAUDE.md`
(Verification Commands section) and the lockfiles present in the repo (e.g. `package-lock.json`,
`pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `uv.lock`, `poetry.lock`, `requirements.txt`).
Do not assume a package manager or language. Examples:

```bash
# Python (pick the one matching the project's tooling)
pip show <package> | grep Version
uv pip show <package> | grep Version
python -c "import importlib.metadata as m; print(m.version('<package>'))"

# Node.js (pick the one matching the project's lockfile)
npm ls <package>
pnpm list <package>
yarn why <package>
cat node_modules/<package>/package.json | grep '"version"'
```

When in doubt, read the installed package metadata directly — it does not depend on which
package manager produced it (`node_modules/<package>/package.json`, the dist-info/`METADATA`
in `site-packages/`).

### 2. Verify API Matches That Version

**In order of reliability:**
1. Read actual source in `node_modules/` or `site-packages/` (most reliable)
2. Check changelog for breaking changes between your known version and installed version
3. Look up docs for the installed version — prefer the `find-docs` skill (ctx7 supports version-pinned IDs like `/org/project/version`) over a raw `WebSearch("<library> <version> <api-name> documentation")`

### 3. When Spawning Agents

When dispatching explore or implementation agents for framework-specific code, include:

```markdown
IMPORTANT: Check the installed version of <framework> before making claims
about conventions or expected patterns. If anything doesn't match what you
expect, use WebSearch to look up documentation for that specific version.
Do NOT rely on training knowledge for framework conventions — flag
uncertainty rather than asserting code is broken.
```

## Common Mistakes

**Trusting training knowledge over installed version**
- Training data has a cutoff. Newer patterns (e.g., Next.js 16 `proxy.ts` replacing `middleware.ts`) will be confidently misidentified as broken code.

**Checking docs but not the version**
- Docs for v3 don't apply to your v2 install. Always check version first.

**Skipping verification for "well-known" APIs**
- Even stable libraries make breaking changes. 30 seconds to verify saves hours debugging.

## Red Flags

- "I know this API" — verify anyway, it may have changed
- "The docs say..." — which version's docs?
- "This file is wrong / not integrated" — did you check the framework version first?
- An explore agent claims code "doesn't follow convention" — verify the convention for the installed version
