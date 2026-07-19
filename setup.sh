#!/usr/bin/env bash
# linear-pipeline-kit installer — installs the Linear-driven workflow into ~/.claude
# (user-level: skills, merge-gate hook, project template). Run from anywhere.
#
# Usage: setup.sh [--link] [--force]
#   --link   symlink items into ~/.claude instead of copying. The kit clone becomes
#            the single editable home — edits land here, `git push` publishes them.
#            (Windows/Git Bash: symlinks additionally need Developer Mode AND
#            `export MSYS=winsymlinks:nativestrict` — otherwise MSYS `ln -s` silently
#            copies. The installer detects and warns. Default copy mode works everywhere.)
#   --force  replace existing items that differ from the kit (default: skip + note).
#
# CLAUDE_DIR overrides the target for testing. If you override it for real use, it MUST
# be the directory Claude Code actually reads (os.homedir()/.claude) — the wired hook
# command embeds this path.
set -euo pipefail

KIT="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
LINK=0; FORCE=0
for a in "$@"; do
  case "$a" in
    --link) LINK=1 ;;
    --force) FORCE=1 ;;
    *) echo "usage: setup.sh [--link] [--force]"; exit 1 ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "error: node is required (the merge-gate hook runs on it)"; exit 1; }
mkdir -p "$CLAUDE_DIR/skills" "$CLAUDE_DIR/hooks" "$CLAUDE_DIR/templates"

# ln -s that verifies a real symlink materialized — MSYS/Git Bash `ln -s` silently
# deep-copies unless MSYS=winsymlinks:nativestrict is set.
mklink() {
  ln -s "$1" "$2"
  if [ ! -L "$2" ]; then
    echo "  ! $3: ln -s produced a COPY, not a link (MSYS/Git Bash default) —"
    echo "    export MSYS=winsymlinks:nativestrict (needs Developer Mode) and re-run --link"
    return 1
  fi
}

# install <src> <dest> <name> — dest absent: install. dest identical: converge.
# dest differs / is a foreign or dangling symlink: skip unless --force.
install_item() {
  local src="$1" dest="$2" name="$3"
  # dest IS the source (CLAUDE_DIR pointed into the kit): rm+link here would delete the
  # kit's own files and leave a self-referential dangling link. Never touch it.
  if [ -e "$dest" ] && [ ! -L "$dest" ] && [ "$dest" -ef "$src" ]; then
    echo "  ! $name: destination IS the kit source ($src) — skipping (check CLAUDE_DIR)"
    return
  fi
  if [ -L "$dest" ]; then
    if [ "$(readlink "$dest")" = "$src" ]; then
      if [ "$LINK" = 1 ]; then echo "  = $name (already linked)"; return; fi
      if [ "$FORCE" = 1 ]; then rm -rf "$dest"; cp -R "$src" "$dest"; echo "  ~ $name (kit link -> materialized as copy)"; return; fi
      echo "  ! $name is a symlink into this kit — left as is (copy mode + --force materializes a copy)"
      return
    fi
    # Symlink to somewhere else (an old clone, or dangling) — never write through it.
    if [ "$FORCE" = 0 ]; then
      echo "  ! $name is a symlink to $(readlink "$dest") — left as is (re-run with --force to replace)"
      return
    fi
    rm -rf "$dest"
  elif [ -e "$dest" ]; then
    if diff -rq "$src" "$dest" >/dev/null 2>&1; then
      if [ "$LINK" = 1 ]; then
        rm -rf "$dest"; mklink "$src" "$dest" "$name" || return 0
        echo "  ~ $name (identical copy -> replaced with link)"
      else echo "  = $name (already installed, identical)"; fi
      return
    fi
    if [ "$FORCE" = 0 ]; then
      echo "  ! $name exists and DIFFERS from the kit — left as is (re-run with --force to replace)"
      return
    fi
    rm -rf "$dest"
  fi
  if [ "$LINK" = 1 ]; then mklink "$src" "$dest" "$name" || return 0; echo "  + $name (linked)"
  else cp -R "$src" "$dest"; echo "  + $name (copied)"; fi
}

echo "== skills -> $CLAUDE_DIR/skills =="
for d in "$KIT"/skills/*/; do
  [ -d "$d" ] || continue
  s="$(basename "$d")"
  install_item "$KIT/skills/$s" "$CLAUDE_DIR/skills/$s" "skills/$s"
done

echo "== merge-gate hook =="
install_item "$KIT/hooks/merge-gate.mjs" "$CLAUDE_DIR/hooks/merge-gate.mjs" "hooks/merge-gate.mjs"

echo "== project template =="
install_item "$KIT/templates/project-CLAUDE.md" "$CLAUDE_DIR/templates/project-CLAUDE.md" "templates/project-CLAUDE.md"

# Wire the merge-gate hook into settings.json (idempotent — checked by command content).
# Fail-closed by design: missing node OR missing hook file blocks the Bash call (exit 2)
# instead of silently running ungated. The hook path is embedded ABSOLUTE, derived from
# where this installer actually put the hook — no $HOME assumptions at run time.
echo "== settings.json hook wiring =="
node - "$CLAUDE_DIR/settings.json" <<'EOF'
const fs = require('fs');
const path = require('path');
const sp = path.resolve(process.argv[2]);
// Normalize to forward slashes: on Windows path.join yields backslashes, which are
// escape chars inside the POSIX double-quoted shell string below AND would trip the
// metachar guard — Node and Git-Bash `sh` both accept forward-slash paths (audit round 2:
// the old guard rejected every Windows path, silently disabling the hook there).
const hook = path.join(path.dirname(sp), 'hooks', 'merge-gate.mjs').replace(/\\/g, '/');
// bail = the enforcement hook could NOT be wired. Exit NON-zero so `set -e` aborts the
// installer loudly instead of printing success while the security gate is absent
// (audit round 2). Backslash dropped from the reject set — normalized away above.
const bail = (why) => { console.error(`  ! merge-gate NOT wired: ${why}. Fix and re-run, or wire by hand (see README).`); process.exit(1); };
if (/["'$\x60\n]/.test(hook)) bail(`hook path ${hook} contains shell metacharacters`);
const CMD = `IN=$(cat); command -v node >/dev/null 2>&1 || { echo 'merge-gate: node not found on PATH — blocking' >&2; exit 2; }; [ -f "${hook}" ] || { echo 'merge-gate: hook file missing — blocking' >&2; exit 2; }; printf %s "$IN" | node "${hook}"`;
let s = {};
if (fs.existsSync(sp)) {
  try { s = JSON.parse(fs.readFileSync(sp, 'utf8')); }
  catch { bail(`${sp} exists but is not valid JSON`); }
}
if (s === null || typeof s !== 'object' || Array.isArray(s)) bail(`${sp} is not a JSON object`);
if (s.hooks == null) s.hooks = {};
if (typeof s.hooks !== 'object' || Array.isArray(s.hooks)) bail(`${sp}: "hooks" is not an object`);
if (s.hooks.PreToolUse == null) s.hooks.PreToolUse = [];
if (!Array.isArray(s.hooks.PreToolUse)) bail(`${sp}: "hooks.PreToolUse" is not an array`);
// A FUNCTIONAL wiring = a Bash-matcher entry whose command hook is type "command" and
// actually pipes to `node "<hook>"`. A bare `.includes(hook)` substring match wrongly
// accepts a suffixed backup path (`node "<hook>.bak"` contains `<hook>`) or a placeholder
// (`echo <hook>`) as wired, leaving the real hook uninstalled (audit round 3). Match the
// canonical `node "<hook>"` invocation the installer writes — the closing quote right after
// the path rejects `.bak`/other suffixes; a hand-wired variant is treated as stale and
// re-normalized to canonical. (hook has no `"` — the metachar guard above guarantees it.)
const runsHook = (cmd) => (cmd || '').includes(`node "${hook}"`);
const isLiveWiring = (e) => e?.matcher === 'Bash' && Array.isArray(e?.hooks)
  && e.hooks.some(h => h?.type === 'command' && runsHook(h?.command));
const mentionsGate = (h) => (h?.command || '').includes('merge-gate.mjs');
let dropped = 0;
for (const e of s.hooks.PreToolUse) {
  if (!Array.isArray(e?.hooks)) continue;
  const live = isLiveWiring(e);
  const n = e.hooks.length;
  // Drop any merge-gate hook that isn't THIS install's functional one (stale path,
  // suffixed backup, placeholder, wrong type). Keep a correct entry's other hooks intact.
  e.hooks = e.hooks.filter(h => !(mentionsGate(h) && !(live && h?.type === 'command' && runsHook(h?.command))));
  dropped += n - e.hooks.length;
}
s.hooks.PreToolUse = s.hooks.PreToolUse.filter(e => !Array.isArray(e?.hooks) || e.hooks.length > 0);
if (dropped) console.log(`  ~ removed ${dropped} stale/nonfunctional merge-gate wiring(s)`);
const wired = s.hooks.PreToolUse.some(isLiveWiring);
if (wired && !dropped) { console.log('  = merge-gate already wired in settings.json'); process.exit(0); }
if (!wired) {
  s.hooks.PreToolUse.push({
    matcher: 'Bash',
    hooks: [{ type: 'command', command: CMD, timeout: 45, statusMessage: 'merge-gate: verifying reviewer approvals' }],
  });
}
fs.writeFileSync(sp, JSON.stringify(s, null, 2) + '\n');
console.log(wired ? '  = merge-gate wiring refreshed' : '  + merge-gate wired into settings.json (PreToolUse / Bash)');
EOF

# Global CLAUDE.md: the workflow's rules live there (§4 goal-driven, §5 git gate,
# §6 Linear, §7 one-home-per-fact). Never auto-append a full guidelines file into an
# existing one — that's a manual merge.
echo "== global CLAUDE.md =="
if [ -L "$CLAUDE_DIR/CLAUDE.md" ] && [ ! -e "$CLAUDE_DIR/CLAUDE.md" ]; then
  echo "  ! CLAUDE.md is a dangling symlink to $(readlink "$CLAUDE_DIR/CLAUDE.md") — fix it by hand"
elif [ ! -e "$CLAUDE_DIR/CLAUDE.md" ]; then
  cp "$KIT/CLAUDE.md.example" "$CLAUDE_DIR/CLAUDE.md"
  echo "  + installed CLAUDE.md (from CLAUDE.md.example — adapt the personal bits)"
elif grep -q 'Task Tracking with Linear' "$CLAUDE_DIR/CLAUDE.md"; then
  echo "  = CLAUDE.md already carries the Linear workflow rules"
else
  echo "  ! CLAUDE.md exists but has no Linear workflow section — merge the relevant"
  echo "    sections (at minimum §4-§8) from $KIT/CLAUDE.md.example by hand."
fi

echo
echo "== remaining manual steps =="
echo "[linear] add + authenticate the Linear MCP server (browser OAuth, once):"
echo "         claude mcp add --scope user --transport http linear-server https://mcp.linear.app/mcp"
echo "         then inside a claude session: /mcp -> linear-server -> Authenticate"
echo "[opt-in] Linear is OFF by default, per project. To opt a repo in, seed its"
echo "         .claude/CLAUDE.md from templates/project-CLAUDE.md and set 'Team: <key>'."
echo "[plugin] recommended: the superpowers plugin (brainstorming, worktrees, verification) —"
echo "         claude plugin marketplace add obra/superpowers-marketplace"
echo "         claude plugin install superpowers@superpowers-marketplace"
echo "         Without it the skills still run; the referenced discipline skills no-op."
echo "[review] optional companion: ai-review-kit (AI reviewers + fix loop + CI merge gate)"
echo "         https://github.com/kristijan-kresic-hvar/ai-review-kit"
echo "         Without it, review steps degrade to manual review — see README degradation matrix."
echo
echo "Restart Claude Code so the skills register."
