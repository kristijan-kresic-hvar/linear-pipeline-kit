#!/usr/bin/env node
// PreToolUse gate: DENY PR merges unless every APPLICABLE reviewer is clean on the
// PR's CURRENT head. Normative signal map: the ai-review-kit canonical playbook
// (~/DEV/ai-review-kit/ai-review-loop.md, installed per repo as
// .github/ai-review-loop.md) — step 5, "each leg has its own CLEAN artifact".
// Fail-closed: unverifiable state → deny. Best-effort layer — the CI merge-gate status
// (the kit's workflows/merge-gate.yml) is the server-side twin; web UI = human override.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const out = (decision, reason) => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason },
  }));
  process.exit(0);
};

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { /* fall through */ }
const rawCmd = input?.tool_input?.command ?? '';

// Strip heredoc bodies fed to NON-shell consumers (python3 - <<EOF ... writing docs that
// merely mention merging) — that text is data, not commands. Heredocs feeding a shell
// (bash <<EOF) keep their body and stay gated. Live false positive 2026-07-07.
const stripDataHeredocs = (s) => s.replace(
  /((?:^|[;&|])[^\n;&|]*?<<-?\s*'?"?(\w+)'?"?[^\n]*\n)([\s\S]*?)(\n\2\b)/gm,
  (all, opener, tag, body, closer) => (
    // Keep the body when the consumer is a shell OR the body itself shells out —
    // `python3 <<EOF` with subprocess.run(['gh','pr','merge']) is code, not docs.
    /\b(ba|z|da)?sh\b/.test(opener) || /subprocess|child_process|exec\w*\s*\(|spawn|os\.system|popen/i.test(body)
      ? all : opener + closer
  ),
);
const cmd = stripDataHeredocs(rawCmd);

// SCAN = the parts of the command that could actually run a merge. A quoted string is
// DATA when the command verb can't merge (git commit -m "…", echo "…") but CODE when the
// verb executes it (gh api -f query="…mergePullRequest…", bash -c "…"). The discriminator
// is the command verb, so: split into shell segments (quote-aware — operators inside
// quotes don't split), then DROP segments whose leading verb can't merge. What's left is
// scanned with quotes intact, so a real gh-api payload survives while a commit message
// doesn't. Selector parsing uses `scan` too — a safe-lead segment quoting "gh pr merge N"
// must not hijack which PR gets verified.
const splitSegments = (s) => {
  const segs = []; let cur = '', q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === ';' || c === '(' || c === ')' || c === '\n'
      || (c === '&' && s[i + 1] === '&') || (c === '|' && s[i + 1] === '|')) {
      segs.push(cur); cur = ''; if (s[i + 1] === c) i++; continue;
    }
    if (c === '|') { segs.push(cur); cur = ''; continue; }
    cur += c;
  }
  segs.push(cur);
  return segs;
};
// Leading verbs that can never merge a PR — their args (incl. our own commit messages,
// echoed docs) are inert. `git` is split: `git commit`/`add`/etc. are safe, `git push` is NOT.
// node/python are NOT safe leads — `-e`/`-c` execute their args (child_process.execSync
// can merge). Adversarial finding 2026-07-07.
const SAFE_LEAD = /^\s*(?:sudo\s+|env\s+\S+=\S*\s+)*(?:git\s+(?:commit|add|status|log|diff|show|stash|checkout|switch|restore|worktree|fetch|pull|rebase|reset|tag|branch|config)|echo|printf|cat|tee|:|true|jq|sed|awk|grep|rg|ls|cd|mkdir|touch|cp|mv|export)\b/;
const scan = splitSegments(cmd).filter((seg) => !SAFE_LEAD.test(seg)).join(' ; ');

// ---- Merge shapes that are NEVER allowed for the agent (no PR-state check needed) ----
if (/\bgh\s+api\b[^;&|]*\/merge\b/.test(scan) || /mergePullRequest|PullRequestAutoMerge/.test(scan)) {
  out('deny', 'merge-gate: REST/GraphQL PR merges (incl. auto-merge mutations) bypass the gate — use `gh pr merge` (gated) or the web UI');
}
// Any HTTP client (curl/wget/httpie/fetch) hitting the PR-merge endpoint, regardless of verb.
if (/\/pulls\/\d+\/merge\b/.test(scan)) {
  out('deny', 'merge-gate: direct call to the pulls/<n>/merge endpoint bypasses the gate — use `gh pr merge` or the web UI');
}
// Branch deletion is push-to-main-class destructive. REST DELETE forms are denied at the
// settings layer (deny rules); the GraphQL deleteRef mutation has no legitimate agent use
// in this setup — deny outright (found 2026-07-07: `gh api graphql *` is allowlisted).
if (/\bgh\s+api\b/.test(scan) && /\bdeleteRef\b/.test(scan)) {
  out('deny', 'merge-gate: deleteRef mutation deletes branches — no agent use here; delete branches via the web UI or ask the user');
}
// Interpreter/exec smuggling: argv arrays (subprocess.run(['gh','pr','merge',…]),
// execFileSync('gh',['pr','merge'])) never form the contiguous strings the rules above
// match. A wrapped merge/push can't be verified through a wrapper — deny and demand the
// direct command, which the gate CAN inspect.
const EXEC_SMUGGLE = /\b(?:node|python3?|ruby|perl|deno|bun)\b[^\n;&|]*\s-{1,2}(?:e|c|eval|p)\b|subprocess|child_process|exec\w*\s*\(|spawnSync|os\.system|popen/i;
if (EXEC_SMUGGLE.test(scan) && /\b(?:gh|git)\b/.test(scan) && /\b(?:merge|push)\b/.test(scan)) {
  out('deny', 'merge-gate: inline interpreter/exec code referencing gh/git merge|push cannot be verified through a wrapper — run the command directly (gh pr merge / git push) so the gate can inspect it');
}
// `git -C <path> push` / `git -c k=v push` etc. must match too — a contiguous-only
// `git push` regex let -C forms push main anywhere (found testing the exemption below).
// `--delete`/`-d` may sit BETWEEN remote and ref (`git push origin --delete main` deletes
// remote main) — without the optional group the adjacency requirement let it through
// while `Bash(git push origin *)` allowlisted it (found 2026-07-07).
if (/\bgit\s+(?:-C\s+(?:"[^"]+"|'[^']+'|\S+)\s+|-c\s+\S+\s+|--git-dir[=\s]\S+\s+|--work-tree[=\s]\S+\s+)*push\b[^;&|]*(\s(?:origin|upstream)\s+(?:--delete\s+|-d\s+)?\+?(?:refs\/heads\/)?(?:main|master)\b|:(?:refs\/heads\/)?(?:main|master)(\s|$))/.test(scan)) {
  // EXEMPTION (user-approved 2026-07-07): the ~/.claude config repo syncs by direct
  // push to main — its README's documented flow. Allowed ONLY when the command is a
  // single bare push (an 'allow' covers the whole Bash call, so no riders) and the
  // target repo's toplevel resolves to ~/.claude. Canonical form:
  //   git -C ~/.claude push origin main
  try {
    const segs = splitSegments(cmd).map((s) => s.trim()).filter(Boolean);
    const one = segs.length === 1 && segs[0].match(/^git\s+(?:-C\s+("[^"]+"|'[^']+'|\S+)\s+)?push(?:\s+(?:origin|upstream)\s+(?:main|master))?\s*$/);
    if (one) {
      const HOME = process.env.HOME || '';
      let dir = one[1] ? one[1].replace(/^['"]|['"]$/g, '') : (input?.cwd || process.cwd());
      dir = dir.replace(/^~(?=\/|$)/, HOME);
      const top = execFileSync('git', ['rev-parse', '--show-toplevel'],
        { cwd: dir, encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (realpathSync(top) === realpathSync(join(HOME, '.claude'))) {
        out('allow', 'merge-gate: ~/.claude config repo — direct push to main is its documented sync flow (standing user exemption)');
      }
    }
  } catch { /* can't prove it's the config repo → treat as any other push */ }
  out('deny', 'merge-gate: pushing to main/master is banned (global CLAUDE.md §5 — worktree + PR only)');
}

// ---- gh pr merge, matched ANYWHERE (wrappers like bash -c, xargs, subshells included;
// unprovable position counts as gated, per adversarial review 2026-07-07) ----
if (!/\bgh\s+pr\s+merge\b/.test(scan)) process.exit(0); // no opinion — normal permission flow
if (/\bgh\s+pr\s+merge\s+(-h|--help)\b/.test(scan)) out('allow', 'merge-gate: --help only');
// Selector: parse from the LAST occurrence in scan — safe-lead segments (commit messages,
// echoed prose) are dropped there, so a quoted "gh pr merge N" can't point the check at
// the wrong PR (fixed 2026-07-07; was parsed from cmd).
const merges = [...scan.matchAll(/\bgh\s+pr\s+merge\b/g)];
const m = merges[merges.length - 1];

const cwd = input?.cwd || process.cwd();
const T0 = Date.now();
const gh = (...args) => {
  if (Date.now() - T0 > 35000) throw new Error('gate deadline exceeded');
  return execFileSync('gh', args, { cwd, encoding: 'utf8', timeout: 6000, stdio: ['pipe', 'pipe', 'pipe'] });
};

try {
  const tail = scan.slice(m.index + m[0].length);
  // -R/--repo travels to every gh call; selector = first arg right after `merge`, or the
  // first number/URL anywhere in the tail (handles `gh pr merge --squash 15`).
  const repoFlag = (tail.match(/(?:^|\s)(?:-R|--repo)[=\s]+([\w.-]+\/[\w.-]+)/) || [])[1] || '';
  const R = repoFlag ? ['-R', repoFlag] : [];
  const toks = tail.trim().split(/\s+/).filter(Boolean);
  let sel = toks[0] && !toks[0].startsWith('-') ? toks[0].replace(/^['"]|['"]$/g, '') : '';
  if (!sel) sel = toks.find((t) => /^\d+$/.test(t) || /^https?:\/\//.test(t)) || '';

  const view = JSON.parse(gh('pr', 'view', ...(sel ? [sel] : []), ...R, '--json', 'number,headRefOid,files,url'));
  const num = view.number;
  const head = view.headRefOid;
  const repo = repoFlag || (view.url.match(/github\.com\/([^/]+\/[^/]+)\/pull\//) || [])[1];
  if (!repo) throw new Error('could not determine repository');

  // exists(): 404 = genuinely absent; ANY other error = unknown → fail closed (throw).
  const exists = (path) => {
    try { gh('api', `repos/${repo}/contents/${path}`, '--jq', '.path'); return true; } catch (e) {
      if (/HTTP 404/.test(String(e.stderr || ''))) return false;
      throw e;
    }
  };

  const CODEX = /^chatgpt-codex-connector(\[bot\])?$/;
  const flat = (s) => JSON.parse(s).flat();
  const reviews = flat(gh('api', '--paginate', '--slurp', `repos/${repo}/pulls/${num}/reviews`));
  const comments = flat(gh('api', '--paginate', '--slurp', `repos/${repo}/issues/${num}/comments`));
  const reactions = flat(gh('api', '--paginate', '--slurp', `repos/${repo}/issues/${num}/reactions`));

  const claudeActive = reviews.some((r) => r.user?.login === 'claude[bot]');
  const codexActive = reviews.some((r) => CODEX.test(r.user?.login || ''))
    || comments.some((c) => CODEX.test(c.user?.login || ''))
    || reactions.some((r) => CODEX.test(r.user?.login || ''));
  // Codex "configured" = AGENTS.md CONTAINS the official '## Code Review Rules' section
  // (openai/codex#25738) — NOT bare file presence. Generic AGENTS.md briefings without
  // the Codex review app would otherwise hard-red the gate forever. 404 = not configured;
  // any other error throws → fail closed (matches the CI twin's codexCfg).
  const codexConfigured = () => {
    try {
      const b64 = gh('api', `repos/${repo}/contents/AGENTS.md`, '--jq', '.content');
      return /^##\s+Code Review Rules/m.test(Buffer.from(b64, 'base64').toString('utf8'));
    } catch (e) {
      if (/HTTP 404/.test(String(e.stderr || ''))) return false;
      throw e;
    }
  };
  // Config probes only when activity alone doesn't already require the leg.
  const claudeRequired = claudeActive || exists('.github/workflows/code-review.yml');
  const codexRequired = codexActive || codexConfigured();

  if (!claudeRequired && !codexRequired) {
    out('ask', 'merge-gate: no AI reviewers configured or active on this PR — manual approval only');
  }

  const problems = [];
  const files = (view.files || []).map((f) => f.path);
  const touchesReviewWf = files.includes('.github/workflows/code-review.yml');
  // Waiver is NARROW: only when every changed file is workflow config — bundling code
  // with a code-review.yml edit must NOT skip Claude (adversarial finding 2026-07-07).
  const waiver = touchesReviewWf && files.every((p) => p.startsWith('.github/workflows/'));
  if (touchesReviewWf && !waiver) {
    problems.push('PR bundles code with a code-review.yml edit — Claude cannot review it (self-skip); split the PR');
  }

  if (claudeRequired && !waiver && !touchesReviewWf) {
    if (!claudeActive) {
      problems.push('Claude is configured (code-review.yml) but has never reviewed this PR — check the workflow run / CLAUDE_CODE_OAUTH_TOKEN');
    } else {
      // LATEST claude[bot] verdict on the head (reviews are chronological) — a later
      // CHANGES_REQUESTED on the same SHA must override an earlier APPROVED.
      const latest = reviews.filter((r) => r.user?.login === 'claude[bot]' && r.commit_id === head).pop();
      if (latest?.state !== 'APPROVED') problems.push(`Claude's latest verdict on head ${head.slice(0, 8)} is ${latest?.state || 'NONE'}, not APPROVED`);
    }
  }

  if (codexRequired) {
    if (!codexActive) {
      problems.push('Codex is configured (AGENTS.md § Code Review Rules) but has never touched this PR — comment "@codex review" (or drop that section if Codex reviews were turned off)');
    } else {
      const th = JSON.parse(gh(
        'api', 'graphql',
        '-f', 'query=query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100){totalCount nodes{isResolved comments(first:1){nodes{author{login}}}}}}}}',
        '-F', `o=${repo.split('/')[0]}`, '-F', `r=${repo.split('/')[1]}`, '-F', `n=${num}`,
        '--jq', '{total: .data.repository.pullRequest.reviewThreads.totalCount, unresolved: [.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false) | select(((.comments.nodes[0].author.login) // "") | test("codex"))] | length}',
      ));
      if (th.total > 100) problems.push(`${th.total} review threads — too many to verify (cap 100)`);
      if (th.unresolved > 0) problems.push(`${th.unresolved} unresolved Codex thread(s)`);

      // Clean signals: comment naming the head (authoritative) — matches Codex's actual
      // phrase, and any embedded 10+ hex-char prefix of the head. A 👍 reaction newer than
      // the head commit is accepted here as a SECONDARY clean signal (this hook runs
      // synchronously and CAN read reactions; the CI twin merge-gate.yml can't — no event
      // fires for reactions — so it requires the comment; the divergence is platform-forced,
      // not a preference). Still human-gated: the hook ends in 'ask', never auto-merge. A
      // backdated force-push can defeat the date check — acceptable solo, revisit for teams.
      let clean = comments.some((c) => CODEX.test(c.user?.login || '')
        && /didn'?t find any major issues/i.test(c.body || '')
        && ((c.body || '').match(/\b[0-9a-f]{10,40}\b/g) || []).some((h) => head.startsWith(h)));
      if (!clean) {
        const commitDate = gh('api', `repos/${repo}/commits/${head}`, '--jq', '.commit.committer.date').trim();
        clean = reactions.some((r) => CODEX.test(r.user?.login || '') && r.content === '+1' && r.created_at > commitDate);
      }
      if (!clean) problems.push(`Codex has no clean signal on head ${head.slice(0, 8)} (re-trigger with "@codex review")`);
    }
  }

  // A waiver must never reduce the applicable reviewer count to zero.
  if (waiver && !codexRequired) {
    problems.push('self-edit waiver leaves ZERO reviewers — merge via the web UI after personal review');
  }

  if (problems.length) out('deny', `merge-gate BLOCKED PR #${num}: ${problems.join('; ')}`);
  out('ask', `merge-gate PASSED for PR #${num} on ${head.slice(0, 8)}${waiver ? ' (Claude leg waived: workflow-only self-edit — verify on next PR)' : ''} — human approval still required`);
} catch (e) {
  out('deny', `merge-gate: could not verify reviewer state (${String(e.message || e).slice(0, 120)}) — failing closed (docs/prose mentioning merges: write via file tools, not Bash heredocs)`);
}
