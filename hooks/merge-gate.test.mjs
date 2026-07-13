#!/usr/bin/env node
// Plain-node regression tests for merge-gate.mjs — no framework, no network.
// Run: node hooks/merge-gate.test.mjs
// gh is stubbed via PATH (canned `pr view` + 404s → the reviewer probe path ends in
// 'ask, no AI reviewers'); git runs against throwaway fixture repos in a temp dir.
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'merge-gate.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'merge-gate-test-'));
const stubBin = join(tmp, 'bin');
const ghLog = join(tmp, 'gh.log');
mkdirSync(stubBin);
writeFileSync(join(stubBin, 'gh'), `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
case "$*" in
  "pr view"*) echo '{"number":7,"headRefOid":"deadbeefdeadbeefdeadbeefdeadbeefdeadbeef","files":[],"url":"https://github.com/own/repo/pull/7"}' ;;
  "api --paginate --slurp"*) echo '[[]]' ;;
  *) echo "HTTP 404" >&2; exit 1 ;;
esac
`);
chmodSync(join(stubBin, 'gh'), 0o755);

// Fixture repos: one sitting on main, one on a feature branch.
const repoMain = join(tmp, 'repo-main');
const repoFeat = join(tmp, 'repo-feat');
execFileSync('git', ['init', '-q', '-b', 'main', repoMain]);
execFileSync('git', ['init', '-q', '-b', 'feat', repoFeat]);

const run = (command, cwd = repoFeat) => {
  writeFileSync(ghLog, '');
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({ tool_input: { command }, cwd }),
    encoding: 'utf8',
    env: { ...process.env, PATH: `${stubBin}:${process.env.PATH}`, HOME: tmp, GH_LOG: ghLog },
  });
  let decision = 'none', reason = '';
  try {
    const o = JSON.parse(r.stdout).hookSpecificOutput;
    decision = o.permissionDecision; reason = o.permissionDecisionReason;
  } catch { /* no output = no opinion */ }
  return { decision, reason, ghLog: readFileSync(ghLog, 'utf8') };
};

let fail = 0;
const t = (name, command, expect, extra) => {
  const res = run(command, extra?.cwd);
  const ok = res.decision === expect && (!extra?.logHas || res.ghLog.includes(extra.logHas));
  if (!ok) {
    fail++;
    console.log(`FAIL ${name}\n  cmd: ${command}\n  want: ${expect}${extra?.logHas ? ` (gh log ~ "${extra.logHas}")` : ''}\n  got:  ${res.decision} — ${res.reason}\n  gh log: ${res.ghLog.trim() || '(empty)'}`);
  } else console.log(`ok   ${name}`);
};

// ---- API/interpreter merge bypasses (deny before any gh call) ----
t('REST merge endpoint', 'gh api repos/o/r/pulls/5/merge -X PUT', 'deny');
t('GraphQL merge mutation', `gh api graphql -f query='mutation{mergePullRequest(input:{})}'`, 'deny');
t('GraphQL deleteRef', `gh api graphql -f query='mutation{deleteRef(input:{})}'`, 'deny');
t('REST branch deletion', 'gh api -X DELETE repos/o/r/git/refs/heads/foo', 'deny');
t('python subprocess merge', `python3 -c "import subprocess; subprocess.run(['gh','pr','merge','5'])"`, 'deny');
t('awk system() merge', `awk 'BEGIN{system("gh pr merge 5 --squash")}'`, 'deny');

// ---- push-to-main detection ----
t('explicit push origin main', 'git push origin main', 'deny');
t('push alternate remote', 'git push gh main', 'deny');
t('multi-ref push', 'git push origin dev main', 'deny');
t('push --all', 'git push --all origin', 'deny');
t('push --mirror', 'git push --mirror origin', 'deny');
t('refspec dst main', 'git push origin HEAD:main', 'deny');
t('delete remote main', 'git push origin :main', 'deny');
t('push -d main', 'git push origin --delete main', 'deny');
t('git -C push main', `git -C ${repoFeat} push origin main`, 'deny');
t('bare push while on main', 'git push', 'deny', { cwd: repoMain });
t('bare push + remote while on main', 'git push origin', 'deny', { cwd: repoMain });
t('push HEAD while on main', 'git push origin HEAD', 'deny', { cwd: repoMain });
t('bare push on feature branch', 'git push', 'none', { cwd: repoFeat });
t('feature push untouched', 'git push -u origin feature/xyz', 'none');
t('branch NAMED like main untouched', 'git push origin feature/main-page', 'none');
t('force-with-lease main', 'git push --force-with-lease origin main', 'deny');
t('chained safe then push', 'git add -A && git commit -m wip && git push origin main', 'deny');

// ---- data vs code (safe leads stay safe) ----
t('commit message mentioning merge', 'git commit -m "gh pr merge 5 later"', 'none');
t('echo mentioning push', 'echo "git push origin main is banned"', 'none');
t('backtick exec inside echo', 'echo `gh pr merge 5`', 'ask', { logHas: 'pr view 5' });
t('command substitution inside echo', 'echo "$(gh pr merge 5)"', 'ask', { logHas: 'pr view 5' });

// ---- gh pr merge gating ----
t('plain merge is gated', 'gh pr merge 5 --squash', 'ask', { logHas: 'pr view 5' });
t('help only', 'gh pr merge --help', 'allow');
t('help short flag', 'gh pr merge -h', 'allow');
t('help + real merge is NOT allowed', 'gh pr merge --help; gh pr merge 5 --squash', 'deny');
t('two merges in one call', 'gh pr merge 5 --squash && gh pr merge 6 --squash', 'deny');
t('repo flag before subcommand', 'gh -R own/repo pr merge 5', 'ask', { logHas: '-R own/repo' });
t('quoted repo flag', 'gh pr merge -R "own/repo" 5', 'ask', { logHas: '-R own/repo' });
t('GH_REPO env selection', 'GH_REPO=own/repo gh pr merge 5', 'deny');
t('numeric flag value not the selector', 'gh pr merge -t 123 5 --squash', 'ask', { logHas: 'pr view 5' });
t('selector after flags', 'gh pr merge --squash 15', 'ask', { logHas: 'pr view 15' });
t('bash -c wrapped merge still gated', `bash -c "gh pr merge 9 --squash"`, 'ask', { logHas: 'pr view 9' });

// ---- heredoc data stays data ----
t('doc heredoc mentioning merge', `cat > notes.md <<'EOF'\nrun gh pr merge 5 to merge\nEOF`, 'none');
t('shell heredoc stays gated', `bash <<'EOF'\ngh pr merge 5\nEOF`, 'ask');

rmSync(tmp, { recursive: true, force: true });
if (fail) { console.log(`\n${fail} FAILURES`); process.exit(1); }
console.log('\nall green');
