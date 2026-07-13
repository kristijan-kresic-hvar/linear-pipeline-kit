#!/usr/bin/env node
// PreToolUse gate: DENY PR merges unless every APPLICABLE reviewer is clean on the
// PR's CURRENT head. Normative signal map: the ai-review-kit canonical playbook
// (~/DEV/ai-review-kit/ai-review-loop.md, installed per repo as
// .github/ai-review-loop.md) — step 5, "each leg has its own CLEAN artifact".
// Fail-closed: unverifiable state → deny. Best-effort layer — the CI merge-gate status
// (the kit's workflows/merge-gate.yml) is the server-side twin; web UI = human override.
// Regression tests: merge-gate.test.mjs (plain node, no network) — run it after edits.
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
const HOME = process.env.HOME || '';

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
// doesn't. Command substitution — backticks anywhere, `$(`/`(` outside single quotes —
// ALWAYS starts a new segment: `echo "$(gh pr merge 5)"` executes the inner command
// before echo ever runs, so it must not hide behind echo's safe lead (audit 2026-07-13).
const splitSegments = (s) => {
  const segs = []; let cur = '', q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") { cur += c; if (c === q) q = null; continue; }
    if (q === '"') {
      if (c === '"') { cur += c; q = null; continue; }
      if (c === '`' || (c === '$' && s[i + 1] === '(')) { segs.push(cur); cur = ''; if (c === '$') i++; continue; }
      cur += c; continue;
    }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === ';' || c === '(' || c === ')' || c === '`' || c === '\n'
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
// can merge). Adversarial finding 2026-07-07. NOT safe either (audit 2026-07-13):
// awk (system() executes), sed (GNU `e` command executes), git config (alias bodies),
// AND git rebase (`-x`/`--exec <cmd>` runs an arbitrary command each step — `git rebase
// -x "gh pr merge N"` smuggles a merge past a dropped segment, audit round 2). This is a
// regex gate, not a shell parser: it can't see every indirection, so the server-side CI
// twin + branch protection remain the real backstop — this layer just closes the cheap holes.
const SAFE_LEAD = /^\s*(?:sudo\s+|env\s+\S+=\S*\s+)*(?:git\s+(?:commit|add|status|log|diff|show|stash|checkout|switch|restore|worktree|fetch|pull|reset|tag|branch)|echo|printf|cat|tee|:|true|jq|grep|rg|ls|cd|mkdir|touch|cp|mv|export)\b/;
const scanSegs = splitSegments(cmd).filter((seg) => !SAFE_LEAD.test(seg));
const scan = scanSegs.join(' ; ');

// ---- Merge shapes that are NEVER allowed for the agent (no PR-state check needed) ----
if (/\bgh\s+api\b[^;&|]*\/merge\b/.test(scan) || /mergePullRequest|PullRequestAutoMerge/.test(scan)) {
  out('deny', 'merge-gate: REST/GraphQL PR merges (incl. auto-merge mutations) bypass the gate — use `gh pr merge` (gated) or the web UI');
}
// Any HTTP client (curl/wget/httpie/fetch) hitting the PR-merge endpoint, regardless of verb.
if (/\/pulls\/\d+\/merge\b/.test(scan)) {
  out('deny', 'merge-gate: direct call to the pulls/<n>/merge endpoint bypasses the gate — use `gh pr merge` or the web UI');
}
// Branch deletion is push-to-main-class destructive. Both API forms are denied HERE —
// the GraphQL deleteRef mutation (found 2026-07-07: `gh api graphql *` is allowlisted)
// and the REST DELETE /git/refs form (audit 2026-07-13: the installer provisions no
// settings-layer deny rule, so the hook can't assume one).
if (/\bgh\s+api\b/.test(scan) && /\bdeleteRef\b/.test(scan)) {
  out('deny', 'merge-gate: deleteRef mutation deletes branches — no agent use here; delete branches via the web UI or ask the user');
}
if (/\bgh\s+api\b/.test(scan) && /(?:^|\s)(?:-X|--method)[=\s]*DELETE\b/i.test(scan) && /\/git\/refs\//.test(scan)) {
  out('deny', 'merge-gate: REST branch deletion (DELETE git/refs) — delete branches via the web UI or ask the user');
}
// Interpreter/exec smuggling: argv arrays (subprocess.run(['gh','pr','merge',…]),
// execFileSync('gh',['pr','merge']), awk system()) never form the contiguous strings the
// rules above match. A wrapped merge/push can't be verified through a wrapper — deny and
// demand the direct command, which the gate CAN inspect.
const EXEC_SMUGGLE = /\b(?:node|python3?|ruby|perl|deno|bun)\b[^\n;&|]*\s-{1,2}(?:e|c|eval|p)\b|subprocess|child_process|exec\w*\s*\(|spawnSync|os\.system|\bsystem\s*\(|popen/i;
if (EXEC_SMUGGLE.test(scan) && /\b(?:gh|git)\b/.test(scan) && /\b(?:merge|push)\b/.test(scan)) {
  out('deny', 'merge-gate: inline interpreter/exec code referencing gh/git merge|push cannot be verified through a wrapper — run the command directly (gh pr merge / git push) so the gate can inspect it');
}
// `git rebase -x/--exec "<cmd>"` runs <cmd> at each (rewritten) commit — a merge/push
// smuggled there executes against heads the gate never verified (audit round 2). Same
// verdict as interpreter smuggling: can't verify through the wrapper → deny.
if (/\bgit\b[^\n;&|]*\brebase\b[^\n;&|]*\s(?:-x\b|--exec\b)/.test(scan) && /\b(?:merge|push)\b/.test(scan)) {
  out('deny', 'merge-gate: `git rebase -x/--exec` runs its command at rewritten heads the gate cannot verify — run the merge/push directly');
}

// ---- git push: parse the push grammar per segment instead of pattern-matching shapes.
// The old two-remote regex missed alternate remote names, multi-ref pushes, --all/--mirror,
// and bare `git push` while sitting on main (audit 2026-07-13). Deny any push whose target
// ref set can touch main/master; a push whose target can't be resolved fails closed.
const isMain = (ref) => /^(?:refs\/heads\/)?(?:main|master)$/.test(ref.replace(/^\+/, ''));
const pushProblem = (seg) => {
  const gi = seg.search(/\bgit\b/);
  if (gi < 0) return null;
  const toks = seg.slice(gi).split(/\s+/).filter(Boolean);
  const GIT_VAL = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
  let i = 1; let cdir = null;
  while (i < toks.length && toks[i].startsWith('-')) {
    if (toks[i] === '-C') cdir = toks[i + 1];
    i += GIT_VAL.has(toks[i]) ? 2 : 1;
  }
  if (toks[i] !== 'push') return null;
  const PUSH_VAL = new Set(['--receive-pack', '--exec', '-o', '--push-option']);
  let del = false; let repoFlag = false; const pos = [];
  for (i += 1; i < toks.length; i++) {
    const t = toks[i];
    if (t === '--delete' || t === '-d') { del = true; continue; }
    if (t === '--all' || t === '--mirror' || t === '--branches') return `${t} pushes every branch, including main/master`;
    // --repo supplies the remote out of the positional slot, so pos[0] is then a REFSPEC,
    // not the remote — don't slice it off (audit round 2: `git push --repo origin main`
    // was dropping `main`). Handle both `--repo X` and `--repo=X`.
    if (t === '--repo') { repoFlag = true; i++; continue; }
    if (t.startsWith('--repo=')) { repoFlag = true; continue; }
    if (/^\d*[<>]/.test(t)) continue; // redirections are not refs
    if (t.startsWith('-')) { if (PUSH_VAL.has(t)) i++; continue; }
    pos.push(t.replace(/^['"]|['"]$/g, ''));
  }
  // With --repo, every positional is a refspec; otherwise pos[0] is the remote (any name).
  const refs = repoFlag ? pos : pos.slice(1);
  let needBranch = refs.length === 0; // bare push targets the CURRENT branch
  for (const r of refs) {
    const dst = (del || !r.includes(':')) ? r : r.slice(r.indexOf(':') + 1);
    if (isMain(dst)) return `\`${r}\` targets main/master`;
    if (dst.includes('*')) return `\`${r}\` is a wildcard refspec — can't prove it excludes main/master`;
    if (/^\+?HEAD$/.test(dst)) needBranch = true; // HEAD refspec = current branch too
  }
  if (needBranch) {
    try {
      const dir = cdir
        ? cdir.replace(/^['"]|['"]$/g, '').replace(/^~(?=\/|$)/, HOME)
        : (input?.cwd || process.cwd());
      const br = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'],
        { cwd: dir, encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (/^(?:main|master)$/.test(br)) return 'the current branch is main/master';
    } catch {
      return 'the push target branch cannot be resolved — push an explicit feature branch (git push <remote> <branch>)';
    }
  }
  return null;
};
let pushWhy = null;
for (const seg of scanSegs) { pushWhy = pushProblem(seg); if (pushWhy) break; }
if (pushWhy) {
  // EXEMPTION (user-approved 2026-07-07): the ~/.claude config repo syncs by direct
  // push to main — its README's documented flow. Allowed ONLY when the command is a
  // single bare push (an 'allow' covers the whole Bash call, so no riders) and the
  // target repo's toplevel resolves to ~/.claude. Canonical form:
  //   git -C ~/.claude push origin main
  try {
    const segs = splitSegments(cmd).map((s) => s.trim()).filter(Boolean);
    const one = segs.length === 1 && segs[0].match(/^git\s+(?:-C\s+("[^"]+"|'[^']+'|\S+)\s+)?push(?:\s+(?:origin|upstream)\s+(?:main|master))?\s*$/);
    if (one) {
      let dir = one[1] ? one[1].replace(/^['"]|['"]$/g, '') : (input?.cwd || process.cwd());
      dir = dir.replace(/^~(?=\/|$)/, HOME);
      const top = execFileSync('git', ['rev-parse', '--show-toplevel'],
        { cwd: dir, encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (realpathSync(top) === realpathSync(join(HOME, '.claude'))) {
        out('allow', 'merge-gate: ~/.claude config repo — direct push to main is its documented sync flow (standing user exemption)');
      }
    }
  } catch { /* can't prove it's the config repo → treat as any other push */ }
  out('deny', `merge-gate: pushing to main/master is banned (global CLAUDE.md §5 — worktree + PR only): ${pushWhy}`);
}

// ---- gh pr merge, matched ANYWHERE (wrappers like bash -c, xargs, subshells included;
// unprovable position counts as gated, per adversarial review 2026-07-07). `-R owner/repo`
// is valid BEFORE the subcommand too (`gh -R o/r pr merge`) — match both placements. ----
const MERGE_RE = /\bgh\s+(?:(?:-R|--repo)[=\s]+(?:"[^"]*"|'[^']*'|\S+)\s+)?pr\s+merge\b/g;
const merges = [...scan.matchAll(MERGE_RE)];
if (!merges.length) process.exit(0); // no opinion — normal permission flow
// --help handling. An 'allow' covers the ENTIRE Bash call, so it's only safe when the
// whole call is nothing but help invocation(s) — `gh pr merge --help && rm -rf ~` must NOT
// be blanket-allowed on the strength of the help part (audit round 2). If every merge
// occurrence is help BUT there are other executable segments (riders), emit no opinion and
// let the normal permission flow vet those riders; only a pure help call gets 'allow'.
const allHelp = merges.every((mm) => /^\s+(?:-h|--help)\b/.test(scan.slice(mm.index + mm[0].length)));
if (allHelp) {
  const HELP_SEG = /^\s*gh\s+(?:(?:-R|--repo)[=\s]+(?:"[^"]*"|'[^']*'|\S+)\s+)?pr\s+merge\s+(?:-h|--help)\s*$/;
  const riders = scanSegs.map((s) => s.trim()).filter(Boolean).filter((s) => !HELP_SEG.test(s));
  if (!riders.length) out('allow', 'merge-gate: --help only');
  process.exit(0); // help + riders → no opinion; normal permission flow handles the riders
}
// One merge per Bash call — the gate verifies exactly ONE PR and its decision covers the
// whole call, so a second merge would ride an approval it never earned (audit 2026-07-13).
if (merges.length > 1) {
  out('deny', 'merge-gate: multiple `gh pr merge` invocations in one Bash call — run one merge per command so each PR is verified');
}
// GH_REPO switches the repo out-of-band of the text the gate parses — the verification
// would run against the wrong repo. Demand the explicit flag instead.
if (/\bGH_REPO=/.test(scan)) {
  out('deny', 'merge-gate: GH_REPO env selects the repository out-of-band — pass -R owner/repo explicitly so the gate verifies the same repo');
}
const m = merges[0];

const cwd = input?.cwd || process.cwd();
const T0 = Date.now();
const gh = (...args) => {
  if (Date.now() - T0 > 35000) throw new Error('gate deadline exceeded');
  return execFileSync('gh', args, { cwd, encoding: 'utf8', timeout: 6000, stdio: ['pipe', 'pipe', 'pipe'] });
};

try {
  // Tail is bounded to THIS segment — an -R on a later command in the same call must not
  // hijack which repo gets verified.
  const tail = scan.slice(m.index + m[0].length).split(' ; ')[0];
  // -R/--repo travels to every gh call; accept quoted and host-qualified forms.
  const REPO_RE = /(?:^|\s)(?:-R|--repo)[=\s]+['"]?(?:https?:\/\/)?(?:github\.com\/)?([\w.-]+\/[\w.-]+)/;
  const repoFlag = ((m[0].match(REPO_RE) || tail.match(REPO_RE) || [])[1]) || '';
  const R = repoFlag ? ['-R', repoFlag] : [];
  // Selector = first POSITIONAL token: skip flags, and skip the value of value-taking
  // flags so `-t 123` can't be mistaken for PR #123 (audit 2026-07-13). An unknown
  // value-flag leaves its value as a bogus selector → gh pr view fails → fail closed.
  const VAL_FLAGS = /^(?:-t|--subject|-b|--body|-F|--body-file|--match-head-commit|-A|--author-email|-R|--repo)$/;
  const toks = tail.trim().split(/\s+/).filter(Boolean);
  let sel = '';
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].startsWith('-')) { if (VAL_FLAGS.test(toks[i])) i++; continue; }
    sel = toks[i].replace(/^['"]|['"]$/g, ''); break;
  }

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
  // the Codex review app would otherwise hard-red the gate forever. Checked base-OR-head:
  // a PR that itself adds the Codex config must require the Codex leg (audit 2026-07-13 —
  // makes the skill's "exactly like the merge-gate's codexCfg probe" claim true).
  // 404 = not configured; any other error throws → fail closed (matches the CI twin).
  const agentsHasRules = (ref) => {
    try {
      const b64 = gh('api', `repos/${repo}/contents/AGENTS.md${ref ? `?ref=${ref}` : ''}`, '--jq', '.content');
      return /^##\s+Code Review Rules/m.test(Buffer.from(b64, 'base64').toString('utf8'));
    } catch (e) {
      if (/HTTP 404/.test(String(e.stderr || ''))) return false;
      throw e;
    }
  };
  const codexConfigured = () => agentsHasRules('') || agentsHasRules(head);
  // Config probes only when activity alone doesn't already require the leg.
  const claudeRequired = claudeActive || exists('.github/workflows/code-review.yml');
  const codexRequired = codexActive || codexConfigured();

  const files = (view.files || []).map((f) => f.path);
  const touchesReviewWf = files.includes('.github/workflows/code-review.yml');
  // Waiver is NARROW: only when every changed file is workflow config — bundling code
  // with a code-review.yml edit must NOT skip Claude (adversarial finding 2026-07-07).
  const waiver = touchesReviewWf && files.every((p) => p.startsWith('.github/workflows/'));

  // The "no reviewers" fallback must come AFTER the workflow-edit check, else a bootstrap
  // PR that ADDS code-review.yml alongside source escapes the split-PR rule: neither leg
  // is "required" yet (code-review.yml isn't on the default branch), so an early 'ask'
  // would wave through un-reviewable code (audit 2026-07-13). Bundling code with the
  // review-workflow edit is denied regardless of current reviewer state.
  if (touchesReviewWf && !waiver) {
    out('deny', `merge-gate BLOCKED PR #${num}: PR bundles code with a code-review.yml edit — Claude cannot review it (self-skip); split the PR`);
  }
  if (!claudeRequired && !codexRequired) {
    out('ask', 'merge-gate: no AI reviewers configured or active on this PR — manual approval only');
  }

  const problems = [];
  // (bundled-code + code-review.yml already denied above, before the no-reviewers gate.)

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
  // Verification is bound to THIS head; between here and the human clicking approve, a new
  // push could change the head (time-of-check/time-of-use). We surface the verified SHA and
  // stop at 'ask' — the human is the TOCTOU backstop. For a hard guarantee, pass
  // `--match-head-commit ${head}` on the merge; branch protection is the server-side twin.
  out('ask', `merge-gate PASSED for PR #${num} on ${head.slice(0, 8)}${waiver ? ' (Claude leg waived: workflow-only self-edit — verify on next PR)' : ''} — human approval still required (verified head ${head.slice(0, 8)}; a new push after this invalidates it)`);
} catch (e) {
  out('deny', `merge-gate: could not verify reviewer state (${String(e.message || e).slice(0, 120)}) — failing closed (docs/prose mentioning merges: write via file tools, not Bash heredocs)`);
}
