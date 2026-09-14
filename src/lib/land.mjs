// @ts-check
// land.mjs — the pure half of `router land <lane>`: the merge message and the refusals. No git, no
// filesystem, so both are unit-tested.
//
// WHY A LANDING SCRIPT EXISTS: to audit completed work, so you can understand how and why it
// happened when you need to revert it or follow its logic. Everything a lane produces already
// exists — the brief, the report, the ledger row, the commits — except the LINK from a change on
// main back to the lane that made it. Dispatchers merging by hand sometimes write a merge commit
// and sometimes fast-forward, and a fast-forward dissolves the one boundary that says "these
// commits were this lane's". The in-scope gate is then reduced to guessing from parent order and
// reflogs, because nothing recorded the truth at the moment it was known.
//
// So: one merge commit per lane, whose message names the lane, the brief and the report; a LAND
// record in the ledger carrying the branch tip and the merge sha; and the branch LEFT WHERE IT
// WAS. Then every question has one lookup — change on main → merge commit → lane → report — and
// undoing a lane is one command: `git revert -m 1 <merge>`.

/**
 * Merge commits are usually exempt from a commit-label convention, on the grounds that git writes
 * them and nobody chose the wording. This merge's wording IS chosen. A landing is not a feature, a
 * fix or a proof; it is the act of putting one of those on main, and anything counting shipped work
 * should be able to tell the two apart.
 */
const short = (sha) => String(sha ?? '').slice(0, 8);

/**
 * The merge commit message. First line is a git merge subject — `Merge branch '<branch>' into main:
 * land lane <lane>, <brief title>` — and the body is the audit card. Every field is written even
 * when unknown, in words, so a reader never has to wonder whether a blank was a missing value or a
 * missing feature.
 *
 * WHY A MERGE SUBJECT AND NOT `<product>: <sentence> [<class>]`. A repo with a commit-msg hook that
 * enforces a class vocabulary refuses an invented class on every landing. Measured: the subject
 * `web: land lane x1, <title> [merge]` was refused with `"[merge]" is not a class`; the landing
 * swallowed the hook's output, printed "MERGE FAILED and was aborted", and sent the dispatcher to
 * resolve a conflict that did not exist — `git merge-tree` was clean.
 *
 * Such hooks conventionally exempt `Merge branch `, `Merge pull request ` and `Merge remote-tracking `
 * subjects, which is what git itself writes. So the landing writes what git writes, and the lane's
 * own commits keep carrying whatever label the repo requires.
 *
 * @param {{repo:string, lane:string, brief?:string|null, report?:string|null, branch:string, tip:string, scope?:string[]}} p
 */
export function landMessage({ repo, lane, brief = null, report = null, branch, tip, scope = [] }) {
  const title = brief ? brief.replace(/\.md$/i, '') : null;
  const subject = `Merge branch '${branch}' into main: land lane ${lane}${title ? `, ${title}` : ''}`;
  const scopeLine = scope && scope.length && !scope.includes('.') ? scope.join(' ') : '(whole repo)';
  return [
    subject,
    '',
    `Lane: ${lane}`,
    `Brief: ${brief ?? '(none found on the bridge)'}`,
    `Report: ${report ?? '(none named)'}`,
    `Branch: ${branch} @ ${short(tip)}`,
    `Scope: ${scopeLine}`,
    'Ledger: _handoffs/_lanes/LANES.md, the LAND record for this lane carries the branch tip and this merge sha',
    'Revert: git revert -m 1 <this merge sha>  (one command undoes the whole lane; the branch and its archive tag survive)',
    '',
    'Landed by the router. The branch was not moved: its tip stays the record of what this lane wrote.',
  ].join('\n');
}

/**
 * The refusals, in the order a dispatcher can act on them. Each `why` names the fix.
 *
 * `base` is the ref the fresh-base rule was measured against: `origin/main` normally, plain `main` in
 * a repo with no remote. It is only used to make the instruction runnable — a local-only repo told to
 * `git merge origin/main` gets an error, not a fix.
 *
 * @param {{branchless?:boolean, onMain?:boolean, dirty?:number, alreadyContained?:boolean, containsMain?:boolean, repo?:string, branch?:string, worktree?:string, base?:string}} p
 * @returns {{ok:boolean, why:string|null}}
 */
export function landRefusal({ branchless = false, onMain = true, dirty = 0, alreadyContained = false, containsMain = true, repo = 'the repo', branch = 'the branch', worktree = 'the lane worktree', base = 'origin/main' } = {}) {
  if (branchless)
    return { ok: false, why: `this lane ran in place with no branch (a root lane), so there is nothing to land. Its work is already where it lives; the report and the ledger row are its record.` };
  if (!onMain)
    return { ok: false, why: `${repo}'s own checkout is not on main. A landing merges INTO main from the repo's own working copy; check out main there first (never from inside a lane worktree, which this session must not stand in either).` };
  if (dirty > 0)
    return { ok: false, why: `${repo}'s main checkout has ${dirty} uncommitted change(s). A merge into a dirty tree mixes someone's half-finished edit into the landing. Commit or stash it first, or find out whose it is.` };
  if (alreadyContained)
    return { ok: false, why: `${branch} is already contained in main, so there is nothing to land. If it was landed by hand, record it with --record <merge sha> so the ledger carries the link; if main was fast-forwarded onto it, the lane's boundary is already lost and the ledger row can only say so.` };
  if (!containsMain)
    return { ok: false, why: `${branch} does not contain ${base}'s head (the fresh-base rule). Bring main into the lane first — from the lane worktree: git -C ${worktree} merge ${base} — build green there, then land. A landing merge never resolves that for the lane, because a conflict resolved here was never built anywhere.` };
  return { ok: true, why: null };
}
