// @ts-check
// close.mjs — the five gate decisions, with no git and no network in them, so they can be tested.
//
// GATE 1 IS CONTENT-VERIFIED, NOT ANCESTRY-VERIFIED, and that distinction is the whole reason this
// file exists. A squash merge copies a branch's changes onto main and throws the commit fingerprints
// away, so `git branch --merged` says "not merged" about work that is fully shipped, and a lane
// reading that answer either re-lands the work or refuses to close on a branch that is already live.
// Both are wrong. So: compare the BLOB of every path the branch touched, in three places.
//
//   base   = merge-base(origin/main, branch)      what the branch started from
//   branch = branch:path                          what the branch made it
//   main   = origin/main:path                     what main has now
//
// and read the three against each other:
//
//   branch == main                  MERGED — the content is there, however it got there
//   branch == base                  UNTOUCHED — the branch did not change this path at all
//   main != base and main != branch MAIN-MOVED — somebody else edited this path after the branch
//                                   started. Not proof of anything either way, and the honest
//                                   answer is to say so rather than to pick a verdict.
//   otherwise                       NOT MERGED
//
// A missing blob is a real state, not an error: it means the path does not exist in that tree, which
// is how deletions and additions read.

// findStatus/STATUS_WORDS: the ONE parser that locates a report's STATUS word, shared with
// the status-word sweep (via lib/verdict.mjs) so overrideReportStatusWord below can never rewrite a
// line that parser does not itself read as the status. See overrideReportStatusWord's own comment.
import { findStatus, checkText, STATUS_WORDS } from './report-check.mjs';
import { STRING_YES_CAVEAT } from './liveness.mjs';

export const ABSENT = null;

export function classifyPath(base, branch, main) {
  // UNTOUCHED is tested first because it is the more informative answer when both are true: a path
  // the branch never changed is not evidence that the branch landed.
  if (branch === base) return 'UNTOUCHED';
  if (branch === main) return 'MERGED';
  if (main !== base && main !== branch) return 'MAIN-MOVED';
  return 'NOT-MERGED';
}

/**
 * @param {Array<{path:string, verdict:string}>} paths
 * @returns {{merged:'yes'|'no', unmerged:Array, moved:Array}}
 */
export function gradeMerge(paths) {
  const unmerged = paths.filter((p) => p.verdict === 'NOT-MERGED');
  const moved = paths.filter((p) => p.verdict === 'MAIN-MOVED');
  return { merged: unmerged.length === 0 && moved.length === 0 ? 'yes' : 'no', unmerged, moved };
}

/**
 * GATE 3's real teeth. A repo's own verify script printed PASS against a pre-deploy build because
 * it asserted a string every build since that step was added contains. An assertion every
 * build passes is not an assertion. So a proof string is REFUSED unless it is new in this branch's
 * own diff — if the string was already on main, finding it on the live site proves nothing about
 * whether this deploy landed.
 *
 * @param {string} patch  unified diff of base..branch
 * @param {string} s      the candidate proof string
 */
export function proofStringNovel(patch, s) {
  if (!s || !s.trim()) return { novel: false, why: 'no proof string was supplied' };
  const added = String(patch ?? '')
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1));
  if (added.some((l) => l.includes(s))) return { novel: true, why: null };
  const removedOrContext = String(patch ?? '').includes(s);
  return {
    novel: false,
    why: removedOrContext
      ? `"${s}" appears in this branch's diff only as context or as a removed line, so it is already on main. A live probe for it would pass whether or not this deploy landed.`
      : `"${s}" does not appear as an added line anywhere in this branch's diff. A probe for a string the branch did not introduce cannot fail, and an assertion that cannot fail is decoration.`,
  };
}

/**
 * GATE 3's REACH QUESTION.
 *
 * The `string` form used to fetch ONE url — the repo's root, from POLICY.md — and ask whether the
 * proof string was in that HTML. That is right only when the change lands on the homepage, and on a
 * repo of separately-addressed static files it almost never does. A homepage that is a 1kB stub
 * carrying a title and one sentence shows NOTHING any lane ships, so the gate is a permanent false
 * red for that whole repo: measured, a lane changed two files under `scripts/`, both byte-identical
 * at their own live URLs when checked by hand, and still closed PARTIAL on live=no. A gate that
 * structurally cannot pass trains lanes to ignore the column.
 *
 * So the gate now asks WHERE a change lands before it asks whether it landed. POLICY.md's optional
 * `surfaces` table answers that per repo, one row per path prefix:
 *
 *   self   the file is served verbatim at its own URL under the site root, so the probe is
 *          `<url>/<path>` and finding the proof string there is real evidence, stronger than the
 *          homepage ever was.
 *   none   the path is not served and reaches no rendered page (CI config, a docs tree a framework
 *          never publishes). Nothing can be probed, so the gate is EXEMPT — the same value and the
 *          same reasoning as a gated product refusing an unauthenticated probe.
 *
 * THE DEFAULT IS THE OLD BEHAVIOUR AND THE UNDECLARED CASE FAILS CLOSED. A repo with no rows, or a
 * branch touching one path the table does not cover, gets the homepage probe exactly as before. That
 * direction is deliberate and it is the whole safety argument: a table that must LIST what is
 * unreachable can only ever be too short, and too short means a false red, which is the state we are
 * already in. A table listing what is reachable could be too short in the other direction and would
 * silently exempt a change that did need to reach a page. Never invert this.
 *
 * Longest declared prefix wins, so a repo can say "everything is served at its own path" with `.`
 * and still carve out one directory that is not.
 *
 * @param {string[]} touched   paths the branch touched, diffed against the lane's own base
 * @param {Array<{path:string, surface:'self'|'none'}>} surfaces  the repo's POLICY.md rows
 * @param {string} repo
 * @returns {{kind:'homepage'|'files'|'unreachable', probes:string[], undeclared:string[], why:string}}
 */
export function surfaceReach(touched, surfaces, repo = 'this repo') {
  const paths = (touched ?? []).filter(Boolean);
  const decl = (surfaces ?? []).filter((s) => s?.path);
  if (!paths.length)
    return { kind: 'homepage', probes: [], undeclared: [], why: `the branch touched no files against its base, so there is no changed file to locate. Probing ${repo}'s root url, as this gate always has.` };
  if (!decl.length)
    return { kind: 'homepage', probes: [], undeclared: paths, why: `${repo} has no rows in POLICY.md's surfaces table, so nothing here knows which url carries a change to it. Probing the root url, as this gate always has. Add rows for ${repo} if its root url is not where its changes show up.` };

  const match = (p) => {
    let best = null;
    for (const s of decl) {
      const d = s.path;
      if (!(d === '.' || d === p || p.startsWith(`${d}/`))) continue;
      const weight = d === '.' ? 0 : d.length;
      if (!best || weight > best.weight) best = { weight, surface: s.surface, dir: d };
    }
    return best;
  };
  const rows = paths.map((p) => ({ p, m: match(p) }));
  const undeclared = rows.filter((r) => !r.m).map((r) => r.p);
  if (undeclared.length)
    return {
      kind: 'homepage',
      probes: [],
      undeclared,
      why: `${undeclared.length} of ${paths.length} touched path(s) are not covered by ${repo}'s surfaces table (${undeclared.slice(0, 5).join(', ')}${undeclared.length > 5 ? `, +${undeclared.length - 5} more` : ''}), so this gate cannot say where they land. Falling back to the root url. An undeclared path is NEVER read as unreachable — that is the fail-closed direction, and it is why a missing row costs a false red rather than a false pass.`,
    };

  const probes = rows.filter((r) => r.m.surface === 'self').map((r) => r.p);
  if (!probes.length)
    return {
      kind: 'unreachable',
      probes: [],
      undeclared: [],
      why: `all ${paths.length} touched path(s) are declared \`none\` in ${repo}'s surfaces table: they are not served by the deployment and they render into no page`,
    };
  return {
    kind: 'files',
    probes,
    undeclared: [],
    why: `${probes.length} of ${paths.length} touched path(s) are served at their own url${probes.length < paths.length ? `; the other ${paths.length - probes.length} are declared \`none\` and cannot be probed` : ''}`,
  };
}

/**
 * GATE 3's `string` verdict, once the probes have been fetched. Pure, so the precedence can be
 * tested without a network — the fetching stays in lane-close.mjs.
 *
 * Precedence, and each step is a different fact about the deployment:
 *
 *   yes   some probed url served the proof string. The string is already known novel in this
 *         branch's diff, which narrows what a match can mean but does not prove the served build
 *         is the merged commit: a cached response, a stale build that happens to carry the string,
 *         or an unrelated route that echoes it all read the same from here. So the yes labels
 *         itself best-effort evidence (STRING_YES_CAVEAT, shared with lib/liveness.mjs); the sha
 *         form's yes is the one that says deployment identity.
 *   skip  a probe hit an auth wall (401/403) and no other probe found the string. ONE WALLED
 *         URL IS ENOUGH, even beside a dozen that answered 200, and that ordering was got wrong
 *         first: a lane changed one gated page alongside twelve public files, and grading the
 *         twelve 200s as a `no` claimed to have measured the one surface the string could possibly
 *         be on. It had not. A wall means unmeasured, and unmeasured outranks
 *         a negative from somewhere else.
 *   no    every probe answered 200, none was walled, and none carried the string. The surface is
 *         reachable and it is not serving this build. THIS IS THE CASE THAT MUST SURVIVE: a change
 *         that did need to reach a page and did not is a real red, and the reach question above
 *         must never convert it into an exemption.
 *   skip  nothing answered at all. A 404 on a path declared `self` means the file is not in the
 *         deployed tree — a wrong POLICY row OR a page that failed to ship, and those are not
 *         distinguishable from here. Not a pass either way.
 *
 * @param {{results:Array<{url:string,status:number,hasProof:boolean,error?:string}>, proof:string, mode:string, dropped?:number}} p
 */
export function liveStringVerdict({ results, proof, mode, dropped = 0 }) {
  const r = results ?? [];
  const tail = dropped ? ` NOTE: ${dropped} further changed file(s) were not probed — this close caps the probe list, and the cap is printed rather than hidden.` : '';
  const hit = r.find((x) => x.hasProof);
  if (hit) return { value: 'yes', why: `${hit.url} is serving "${proof}", a string this branch introduced. ${STRING_YES_CAVEAT}${tail}` };
  const served = r.filter((x) => x.status === 200);
  const walled = r.filter((x) => x.status === 401 || x.status === 403);
  if (walled.length)
    return {
      value: 'skip',
      why: `SKIP: ${walled.length} of ${r.length} url(s) answered ${walled[0].status} — ${walled.slice(0, 3).map((x) => x.url).join(', ')}. This repo's gated pages refuse an unauthenticated probe; drive the proof from a script that sends the credential the policy names. ${served.length ? `The other ${served.length} url(s) answered 200 without "${proof}", which is NOT read as a no: the string may well be behind the wall, and this close will not call a surface it could not open. ` : ''}Nothing was measured, and a skip is not a pass.${tail}`,
    };
  if (served.length)
    return {
      value: 'no',
      why: `${served.length} url(s) answered 200 and none carried "${proof}", which this branch added: ${served.slice(0, 4).map((x) => x.url).join(', ')}. Either the deploy has not landed, or the string is in a lazily-loaded chunk this fetch never asked for — for a bundled app that second case is the normal one and the sha probe is the only reliable form.${tail}`,
    };
  const detail = r.slice(0, 4).map((x) => `${x.url} ${x.error ? `(${x.error})` : x.status}`).join(', ');
  return {
    value: 'skip',
    why: `SKIP: none of the ${r.length} url(s) probed in ${mode} mode served anything readable: ${detail}. A 404 on a path POLICY.md declares served means either the row is wrong or the file never shipped, and this gate cannot tell those apart. Nothing was measured, and a skip is not a pass.${tail}`,
  };
}

/**
 * A lane with no branch is an in-place lane on a non-git target (see lib/open.mjs). Gate 1 asks
 * whether the branch's content reached main; with no branch there is no such question, and the
 * honest answer is n/a rather than a skip, because nothing was left unmeasured.
 */
export function isBranchless(branch) {
  return !branch || branch === '-';
}

/**
 * GATE 3's diff base, and the fix for the defect lane ops-l1 reported on 2026-08-19.
 *
 * The novelty check above is right and stays. What was wrong is WHAT it measured against.
 * merge-base(origin/main, branch) answers "where did this branch start" only while the branch is
 * still unmerged. This workspace's doctrine is that a lane merges and pushes its own work, and the
 * instant it does, origin/main contains the branch, the merge base becomes the branch tip, the
 * branch's own diff is empty, and EVERY proof string is refused as un-novel. So a lane that did
 * exactly what it was told could not close, scored PARTIAL, and never released its claim — which is
 * very likely why LANES.md carries OPEN records whose done-files are already filed.
 *
 * Four candidates, best first. Any candidate equal to the branch tip is discarded rather than used,
 * because its diff is empty by construction and an empty diff refuses everything:
 *
 *   explicit             --base <sha>, the operator overrode it
 *   recorded-at-open     lane-open wrote the base into the OPEN record. Exact, and the only one
 *                        that stays true no matter what main does afterwards.
 *   main-at-lane-open    origin/main as of the OPEN record's timestamp. Derived, not recorded, and
 *                        it is what the worktree was actually created from. This is what rescues
 *                        every lane opened before the ledger carried a base field.
 *   merge-base           the old behaviour, still correct for a branch that has not landed yet.
 *
 * @param {{explicit?:string, recorded?:string, atOpen?:string, mergeBase?:string, branchTip?:string}} c
 * @returns {{base:string|null, source:string, why:string|null}}
 */
export function chooseProofBase({ explicit, recorded, atOpen, mergeBase, branchTip }) {
  const candidates = [
    ['explicit', explicit],
    ['recorded-at-open', recorded],
    ['main-at-lane-open', atOpen],
    ['merge-base', mergeBase],
  ];
  const usable = candidates.filter(([, sha]) => sha && sha !== branchTip);
  if (usable.length) {
    const [source, base] = usable[0];
    return { base, source, why: null };
  }
  const collapsed = candidates.some(([, sha]) => sha && sha === branchTip);
  return {
    base: null,
    source: collapsed ? 'collapsed' : 'none',
    why: collapsed
      ? `every candidate base is the branch tip ${branchTip}, so this branch is already contained in origin/main and its own diff is empty. A proof string cannot be shown to be novel against an empty diff. Nothing was measured, and a skip is not a pass — re-run with --base <the sha main was on when this lane opened>.`
      : 'no base commit could be determined for this branch, so its diff could not be read. Nothing was measured, and a skip is not a pass.',
  };
}

/**
 * GATE 4's filename match. A lane id must appear in the brief's filename as a WHOLE TOKEN, not as a
 * substring. Found 2026-08-20 while proving the gate-3 fix: lane `ops-l1` matched the file
 * `Ops-L1b-Collector-And-Defects.md`, because one lane id is a prefix of another. The consequence
 * runs both ways and both are wrong — a lane can be told its brief is still live when the live file
 * belongs to a different lane, or be credited with a rename someone else performed.
 *
 * A token boundary is any non-alphanumeric character, or the start/end of the name.
 */
export function briefMatchesLane(filename, lane) {
  if (!filename || !lane) return false;
  const f = filename.toLowerCase();
  const l = lane.toLowerCase();
  const isBoundary = (ch) => ch === undefined || !/[a-z0-9]/.test(ch);
  let from = 0;
  for (;;) {
    const i = f.indexOf(l, from);
    if (i < 0) return false;
    if (isBoundary(f[i - 1]) && isBoundary(f[i + l.length])) return true;
    from = i + 1;
  }
}

/**
 * GATE 5, and the reason four finished lanes were stamped PARTIAL in one night.
 *
 * The gate asked only whether a file exists at the lane's report filename. That is true the moment
 * the lane writes its OWN report — which every lane does before closing — so a lane that followed
 * the process exactly was told it was a colliding second session. Measured in one night: four lanes
 * each closed merged=yes green=yes live=yes and were still PARTIAL for this reason alone, and each
 * then held its repo, because a PARTIAL lane's claim is not released. The board consequently read
 * that repo as over its own writer cap.
 *
 * The real collision this gate exists to catch is a SECOND session of the same lane overwriting the
 * first's report. The distinguisher is time, and the OPEN record
 * already carries it. A report file written after this lane opened is this lane's own work. One
 * that was already on disk when it opened belongs to somebody else.
 *
 * An unknown open time refuses rather than passes: this guard exists because a report was
 * permanently destroyed, so its failure mode must stay "make the lane prove it", not "assume fine".
 */
export function reportFreeVerdict({ exists, reportMtimeMs, laneOpenedMs }) {
  if (!exists) return { free: true, own: false, why: 'the report filename is free' };
  if (!laneOpenedMs) {
    return {
      free: false,
      own: false,
      why: 'a file already exists at this report name and the lane\'s OPEN time could not be established, so it cannot be shown to be this lane\'s own. Refusing rather than assuming.',
    };
  }
  if (reportMtimeMs >= laneOpenedMs) {
    return {
      free: true,
      own: true,
      why: 'the file at this report name was written after the lane opened, so it is this lane\'s own report and not a collision',
    };
  }
  return {
    free: false,
    own: false,
    why: 'a report at this name existed BEFORE this lane opened. You are the second session — write to the -parallel-session-B name and record the collision in your incident log, naming both sessions. Do not open the existing file with Write.',
  };
}

/**
 * THE REPORT'S NAME MUST FOLLOW THE GRADE ON DISK, not only in the ledger string.
 *
 * THE DEFECT, 2026-09-05. `reportNameForStatus` has produced the graded name since 2026-08-30 and
 * lane-close has recorded it ever since. Nothing reconciled that name with the prefix the report
 * was actually FOUND under. So a lane that wrote its report to the `done-` slot lane-open reserved
 * and then graded PARTIAL had its CLOSE recorded against a `partial-` name, and the findings write
 * looked for that file, did not find it, and printed "is not on disk yet, so there is no report
 * block to read. Nothing written." — about a report that was on disk the whole time. A dispatcher
 * renamed it by hand afterwards, which is the machinery asking a human to do its job.
 *
 * WHY A RENAME AND NOT A LOOKUP. The prefix is the bridge's own statement of what happened, and
 * PREFIXES.md gives `partial-` a meaning `done-` does not have: a remainder. Leaving a PARTIAL
 * lane's report under `done-` tells every later reader the work finished. Reading around it would
 * fix this one close and leave the bridge lying.
 *
 * IT NEVER OVERWRITES. Two cases refuse rather than move: the graded name holding a file written
 * BEFORE this lane opened (another session's report — the 2026-08-15 collision this whole slot
 * mechanism exists for), and the graded name holding a file this lane wrote ITSELF, where a rename
 * would merge two reports into one. Both refuse, say why, and leave the findings to be read from
 * wherever the report actually is.
 *
 * Pure. The disk work is reconcileReportName in lane-close.mjs.
 *
 * @param {object} p
 * @param {string} p.graded        the filename the graded status calls for
 * @param {string[]} p.found       report slot names this lane wrote, excluding `graded`
 * @param {boolean} p.targetOwn    a file this lane wrote already sits at `graded`
 * @param {boolean} p.targetTaken  a file this lane did NOT write already sits at `graded`
 * @returns {{ok:boolean, from:string|null, to:string, why:string|null}}
 */
export function gradedReportRename({ graded, found = [], targetOwn = false, targetTaken = false }) {
  const from = found.find((n) => n && n !== graded) ?? null;
  if (!graded || !from) {
    return { ok: false, from: null, to: graded ?? null, why: null };
  }
  if (targetOwn) {
    return {
      ok: false,
      from,
      to: graded,
      why: `"${graded}" already holds a report this lane wrote, so renaming "${from}" onto it would merge two reports into one. Neither is touched. Decide by hand which is the report and delete nothing.`,
    };
  }
  if (targetTaken) {
    return {
      ok: false,
      from,
      to: graded,
      why: `"${graded}" existed before this lane opened, so it belongs to another session and is never written over. "${from}" keeps its name. Record the collision in your incident log, naming both, if this is a genuine collision.`,
    };
  }
  return {
    ok: true,
    from,
    to: graded,
    why: `the grade calls for "${graded}" and the report was found at "${from}"`,
  };
}

/**
 * THE CLOSE AND THE VERDICT SWEEP MUST NEVER RENAME A REPORT IN OPPOSITE DIRECTIONS.
 *
 * THE DEFECT. gradedReportRename (above) renames a report's FILENAME to match the gate grade.
 * The status-word sweep (lib/verdict.mjs's planFor) separately renames a report's filename to match
 * the STATUS word written INSIDE it. When a lane writes "STATUS: DONE" and the gates grade
 * PARTIAL, the two disagree forever: this close renames done-x.md to partial-x.md, the next
 * session-start sweep reads "DONE" still sitting in the body and renames it straight back. Seven
 * collisions on one bridge in one night were this loop, caught only because the sweep's own
 * "already exists" refusal is loud rather than silent.
 *
 * THE STANDING RULE ALREADY SETTLES WHO WINS: "the STATUS word inside the report is the only scope
 * claim" — but that assumes the word is TRUE. A gate grade is a measurement the lane cannot argue
 * with after the fact (it merged or it didn't; it built or it didn't), so when the two disagree
 * the grade wins and the WORD is corrected to match it, in the report itself, so every later
 * reader — human or sweep — finds the same fact the close already recorded.
 *
 * WHY THE WORD IS REWRITTEN IN PLACE, NOT APPENDED. report-check.mjs's findStatus (imported
 * above, so this can never read the report differently than the sweep does) locates the FIRST
 * status-word-bearing line inside the report's own block and stops there. A line appended
 * elsewhere in the file is never seen by that parser, so appending would leave the sweep reading
 * the stale word forever. Rewriting that exact line is the only fix findStatus can ever notice.
 *
 * NEVER FIRES WHEN THE WORDS ALREADY AGREE, and never invents a rename target of its own — it only
 * ever changes the one word both tools already read so it agrees with the one grade both tools
 * already compute.
 *
 * @param {object} p
 * @param {string} p.text          the report's current file content
 * @param {string} p.gradedStatus  'DONE' | 'PARTIAL' | 'BLOCKED' — gradeGates' own graded.status
 * @param {string} p.gradedLabel   the printed label, e.g. "PARTIAL (scope)" — audit note only,
 *                                 never compared against (comparison is against gradedStatus alone,
 *                                 the same three words agrees()/planFor() in lib/verdict.mjs use)
 * @param {string} p.stamp         ISO timestamp for the audit note
 * @returns {{changed:boolean, text:string, from:string|null, note:string|null}}
 */
export function overrideReportStatusWord({ text, gradedStatus, gradedLabel, stamp }) {
  const lines = text.split('\n');
  const status = findStatus(lines);
  if (!status || status.word === gradedStatus) {
    return { changed: false, text, from: status ? status.word : null, note: null };
  }
  const from = status.word;
  const note = `graded by lane-close ${stamp}, overrides the lane's own ${from} claim above`;
  lines[status.line] = `${lines[status.line].replace(STATUS_WORDS, gradedStatus)}  — ${note}`;
  return { changed: true, text: lines.join('\n'), from, note: `STATUS: ${gradedLabel} — ${note}` };
}

/**
 * THE IN-SCOPE GATE'S SHARED-FILE ALLOWLIST. Paths here are in scope for EVERY lane.
 *
 * Some repos require every lane to run a script that rewrites one repo-wide generated file — a
 * lockfile, a regenerated index, a pinned baseline. That file is never hand-edited and never in any
 * brief's `Touches:` line, so the required procedure trips the in-scope gate every time: measured,
 * a fully-landed, fully-green lane graded PARTIAL(scope) with one such file as the sole breach.
 *
 * The gate exists to catch a lane colliding with a NEIGHBOUR's files. A regenerated file has no
 * owner lane to collide with, so it is exempt by name. Nothing else is. Add a path here only when
 * all three facts hold: repo-wide, regenerated by a checked-in script, and required of any lane by
 * a standing rule. It ships empty; populate it for your own repos.
 */
export const ALWAYS_IN_SCOPE = new Set([]);

/**
 * GATE 7 (in-scope).
 *
 * The allocator proves two lanes' DECLARED scopes disjoint before letting them share a repo. That
 * proof is worth nothing if a lane can then edit outside its declaration, and until this gate
 * nothing ever measured that. At two writers a stray edit is rare; at four it is how one lane
 * silently overwrites a neighbour and the repo's whole concurrency argument collapses.
 *
 * So: every path the branch touched (from gate 1's own diff) is tested for containment in the
 * declared scope. Any path outside it fails the close, BY NAME, so the report says exactly which
 * files left the lane.
 *
 *   n/a  the lane declared no scope (whole repo) — it held the repo alone, nothing to breach.
 *        Also n/a for branchless in-place lanes and for lanes opened before this gate shipped
 *        (grandfathered: nobody is failed mid-flight on a rule that did not exist at open).
 *   yes  every touched path is inside the declaration (or is on ALWAYS_IN_SCOPE, above).
 *   no   at least one path is outside it. The breach list is the point of the gate.
 *
 * @param {string[]} touched   paths the branch touched, from the gate-1 diff
 * @param {string[]} scope     the lane's declared scope, normalized (WHOLE_REPO means undeclared)
 */
export function scopeCompliance(touched, scope) {
  if (!scope?.length || scope.includes('.')) {
    return { value: 'n/a', breaches: [], note: 'this lane declared no file scope, so it held the repo alone (the allocator serializes an undeclared lane against everyone). There is no declaration to breach. Recorded as N/A, not as a pass.' };
  }
  const inside = (p) => ALWAYS_IN_SCOPE.has(p) || scope.some((dir) => dir === p || p.startsWith(`${dir}/`));
  const breaches = (touched ?? []).filter((p) => !inside(p));
  if (!breaches.length) {
    return { value: 'yes', breaches: [], note: `all ${touched?.length ?? 0} touched path(s) are inside the declared scope [${scope.join(', ')}]` };
  }
  return {
    value: 'no',
    breaches,
    note: `${breaches.length} path(s) OUTSIDE the declared scope [${scope.join(', ')}]: ${breaches.slice(0, 8).join(', ')}${breaches.length > 8 ? ` (+${breaches.length - 8} more)` : ''}. The allocator let a neighbour run beside this lane on the strength of that declaration; an edit outside it may have collided with someone else's work. Check those files against other open lanes before merging anything further.`,
  };
}

/**
 * GATE 7 WHEN THE BRANCH HAS ZERO COMMITS AHEAD OF ITS DIFF BASE.
 *
 * scopeCompliance above always hands an empty touched-path list its own vacuous "0 touched paths
 * are inside the declared scope" pass, and that reading cannot tell two very different claims
 * apart: a lane that declared `Touches: none` and committed nothing kept its promise exactly, while
 * a lane that declared real files and committed none of them has left the promise unmeasured — the
 * work may still be coming, or the lane may have stalled mid-brief, and nothing here can tell which.
 * Measured on a catch-up lane: its close graded PARTIAL on
 * `in-scope=skip` for exactly this shape (compounded by a separate parser defect, fixed in
 * lib/briefs.mjs, that had also mis-read its declared scope as a shell command).
 *
 * Call this ONLY when the caller has already measured zero commits between the diff base and the
 * lane's own walk tip — `walk.length === 0` in lane-close.mjs. It does not itself touch git.
 *
 *   yes   `Touches: none` was declared (rec.declaredNone) — the promise was kept.
 *   n/a   no scope was declared at all (whole repo, undeclared) — unchanged from scopeCompliance's
 *         own reading; there is no declaration to have kept or broken.
 *   skip  a real file scope was declared and nothing was committed against it — unmeasured, and a
 *         skip is not a pass.
 *
 * @param {{declaredNone:boolean, scope:string[]}} p
 * @returns {{value:string, breaches:[], note:string}}
 */
export function zeroCommitScopeVerdict({ declaredNone, scope }) {
  if (declaredNone) {
    return { value: 'yes', breaches: [], note: 'declared no files, touched no files' };
  }
  if (!scope?.length || scope.includes('.')) {
    return { value: 'n/a', breaches: [], note: 'this lane declared no file scope, so it held the repo alone (the allocator serializes an undeclared lane against everyone). There is no declaration to breach. Recorded as N/A, not as a pass.' };
  }
  return {
    value: 'skip',
    breaches: [],
    note: `SKIP: this lane declared a file scope [${scope.join(', ')}] but the branch carries no commits ahead of its base to measure against it — a lane that promised files and wrote none is unmeasured, not clean. Nothing was decided, and a skip is not a pass.`,
  };
}

/**
 * GATE 7 AS THE CLOSE DRIVER GRADES IT.
 *
 * THE DEFECT THIS CLOSES (DRIVER1, 2026-09-14, found by the gate-matrix lane). The ledger stores
 * `Touches: none` as an empty scope, and scopeCompliance reads an empty scope as undeclared, so a
 * lane that promised to write no file and then committed some graded `n/a`, a pass. That is the
 * one declaration whose breach is the easiest to see, and the allocator had let that lane run beside
 * every other lane in the repo on the strength of it.
 *
 *   declaredNone, nothing touched     yes (zeroCommitScopeVerdict, unchanged)
 *   declaredNone, paths touched       no, every path named (ALWAYS_IN_SCOPE paths excepted, the same
 *                                     allowance scopeCompliance gives a declared scope)
 *   a real scope, nothing touched     skip (zeroCommitScopeVerdict, unchanged)
 *   otherwise                         scopeCompliance, unchanged
 *
 * @param {{touched:string[], scope:string[], declaredNone?:boolean}} p
 * @returns {{value:string, breaches:string[], note:string}}
 */
export function inScopeVerdict({ touched = [], scope = [], declaredNone }) {
  if (declaredNone) {
    const breaches = touched.filter((p) => !ALWAYS_IN_SCOPE.has(p));
    if (!breaches.length) return zeroCommitScopeVerdict({ declaredNone: true, scope });
    return {
      value: 'no',
      breaches,
      note: `this lane declared Touches: none and the branch touched ${breaches.length} path(s): ${breaches.slice(0, 8).join(', ')}${breaches.length > 8 ? ` (+${breaches.length - 8} more)` : ''}. The allocator let it run beside every other lane in the repo on the strength of that declaration; check those files against other open lanes before merging anything further.`,
    };
  }
  if (!touched.length && declaredNone !== undefined) return zeroCommitScopeVerdict({ declaredNone: false, scope });
  return scopeCompliance(touched, scope);
}

/**
 * WHICH COMMITS GATE 7 MEASURES.
 *
 * THE DEFECT THIS CLOSES (DRIVER1, 2026-09-14, found by the gate-matrix lane). The driver diffed from
 * merge-base(origin/main, branch). Once the branch is merged, that merge base IS the branch tip, the
 * diff is empty, and a lane with a real declared scope graded `skip`: a landed lane could not close
 * DONE on in-scope at all, and a lane that breached its scope and then landed was never measured.
 *
 * THE RULE.
 *   the merge base is behind the tip   diff from the merge base, unchanged. This is the lane's own
 *                                      net change, and after a fresh-base merge (`git merge
 *                                      origin/main` in the lane) it still excludes what neighbours
 *                                      landed on main in the meantime.
 *   merged, or no merge base, and a    WALK from the base recorded at OPEN: the paths the lane's own
 *   base was recorded at OPEN          commits changed, `log --no-merges --first-parent
 *                                      <recorded>..<branch>`. The branch is never moved by a landing
 *                                      (src/bin/lane-land.mjs), so its first-parent line is the lane's.
 *   merged, nothing recorded           diff from the merge base, which is empty, and the note says so;
 *                                      the zero-commit reading then grades it skip, not a pass.
 *   neither                            nothing to measure.
 *
 * WHY NOT A PLAIN DIFF FROM THE RECORDED BASE, which is what the finding proposed. A lane that brought
 * main in before landing (the fresh-base rule requires exactly that) carries every file a neighbour
 * landed since OPEN in `diff <recorded>..<branch>`, and gate 7 would name those files as this lane's
 * breaches. That trades a false skip for a false refusal. The first-parent walk reads only the lane's
 * own commits. Its cost: an edit made only inside a merge commit's conflict resolution is not
 * counted on a merged branch. The same walk is what the private workspace close measures gate 7 with.
 *
 * @param {{recordedBase?:string|null, mergeBase?:string|null, branchTip?:string|null}} p
 * @returns {{method:'diff'|'walk'|'none', from:string|null, note:string}}
 */
export function scopeDiffPlan({ recordedBase = null, mergeBase = null, branchTip = null }) {
  const collapsed = Boolean(mergeBase) && Boolean(branchTip) && mergeBase === branchTip;
  if (mergeBase && !collapsed) return { method: 'diff', from: mergeBase, note: `diffed from the merge base ${String(mergeBase).slice(0, 8)}` };
  if (recordedBase) {
    return {
      method: 'walk',
      from: recordedBase,
      note: collapsed
        ? `the branch is already merged (its merge base is its own tip), so the lane's own commits since the base recorded at OPEN ${String(recordedBase).slice(0, 8)} were measured instead`
        : `no merge base could be computed, so the lane's own commits since the base recorded at OPEN ${String(recordedBase).slice(0, 8)} were measured instead`,
    };
  }
  if (mergeBase) return { method: 'diff', from: mergeBase, note: 'the branch is already merged and no base was recorded at OPEN, so the diff from the merge base is empty and nothing the lane touched could be measured' };
  return { method: 'none', from: null, note: 'no merge base and no base recorded at OPEN, so nothing the lane touched could be measured' };
}

/**
 * WHERE GATE 7'S COMMIT WALK STARTS.
 *
 * The walk is `rev-list --no-merges --first-parent <base>..<tip>`. That is right while the tip is
 * the lane's own commit or the lane's own fresh-base merge (first parent = the lane's line). It is
 * wrong the moment a dispatcher merges the branch into main with a merge commit and then
 * fast-forwards the branch onto it: the tip is now main's LANDING merge, whose first parent is main
 * and whose second parent is the lane's pre-landing tip. The first-parent walk then descends main's
 * side, never visits the lane's own commits, and is left holding only the neighbours' first-parent
 * commits — which the identity check below correctly refuses to attribute — so the gate reads SKIP
 * on a lane that breached nothing. Measured on two lanes, both with every declared path in scope
 * (counted, `git show --stat` of their own non-merge commits).
 *
 * The rule: a tip that is a merge AND sits on origin/main's own first-parent line since the base is
 * a landing merge, and the lane's commits hang off its SECOND parent, so the walk starts there. Any
 * other tip is walked as it is. Nothing here guesses: `parents` comes from `rev-list --parents -n1`
 * and `mainFP` from `rev-list --first-parent origin/main ^base`, both measured by the caller.
 *
 * TIGHTENED, because the rule above is not enough on its own. A branch fast-forwarded PAST its own
 * landing merge, onto a later main head that is a NEIGHBOUR's landing merge, satisfies it, and the
 * redirect then walks the neighbour's commits as this lane's: measured, one lane read NO on 18 of
 * another lane's paths. A false red is worse than the skip it replaced. So the redirect now demands an identity check that only this branch can pass: the
 * candidate second parent must appear in THIS BRANCH'S OWN REFLOG — it was once this branch's tip.
 * A neighbour's tip never was. No reflog, or a second parent that was never our tip, reads
 * `tip: null` and the caller records SKIP with the reason. Never a guessed NO.
 *
 * Known remainder, stated so nobody over-reads this: a branch advanced past its own landing merge
 * still reads SKIP rather than being graded on its own commits. The reflog holds the pre-landing
 * tip, so a later change could walk from the newest reflog entry that is the second parent of a
 * merge reachable from the tip; it is not done here because it needs a fixture repo to prove.
 *
 * @param {{tip:string, parents?:string[], mainFP?:Set<string>, formerTips?:Set<string>}} p
 * @returns {{tip:string|null, why:string|null}}
 */
export function walkTipFor({ tip, parents = [], mainFP = new Set(), formerTips = new Set() }) {
  if (parents.length >= 2 && mainFP.has(tip)) {
    const p2 = parents[1];
    if (formerTips.has(p2)) {
      return {
        tip: p2,
        why: `the branch tip ${tip.slice(0, 8)} is main's landing merge for this lane (a merge commit on origin/main's first-parent line whose second parent ${p2.slice(0, 8)} was once this branch's own tip, per its reflog), so the lane's own commits hang off that second parent and the walk starts there`,
      };
    }
    return {
      tip: null,
      why: `SKIP: the branch tip ${tip.slice(0, 8)} is a merge on origin/main's first-parent line, but its second parent ${p2.slice(0, 8)} was never this branch's tip (${formerTips.size ? `${formerTips.size} reflog entries checked` : 'no reflog was readable'}), so it is a NEIGHBOUR's landing merge and this branch was fast-forwarded past its own. The lane's commits cannot be attributed from here. Nothing was decided, and a skip is not a pass.`,
    };
  }
  return { tip, why: null };
}

/**
 * WHERE GATE 7'S WALK STARTS, WHEN THE LEDGER KNOWS (2026-09-03, `router.mjs land`).
 *
 * A LAND record carries the branch tip at the moment the lane was merged, written by the script
 * that did the merging. That is the identity every heuristic above was trying to reconstruct after
 * the fact: not a guess from parent order, not a reflog that expires, a value recorded when it was
 * known. So it wins outright. Without a LAND record, this is exactly walkTipFor, unchanged.
 *
 * @param {{land?:{tip:string, merge?:string}|null, tip:string, parents?:string[], mainFP?:Set<string>, formerTips?:Set<string>}} p
 * @returns {{tip:string|null, why:string|null}}
 */
export function walkStartFor({ land = null, ...rest }) {
  if (land && land.tip) {
    return {
      tip: land.tip,
      why: `the LAND record in LANES.md says this lane's branch stood at ${land.tip.slice(0, 8)} when it was merged${land.merge ? ` as ${land.merge.slice(0, 8)}` : ''}, so the walk starts there — recorded at landing time, never reconstructed`,
    };
  }
  return walkTipFor(rest);
}

/**
 * THE LANDING MERGE IS NOT "MAIN MOVING".
 *
 * `router land` merges the lane branch into main as ONE merge commit and, by rule, never
 * fast-forwards the branch onto it. So after every landing the branch lacks exactly one commit of
 * main's: its own landing merge. The fresh-base gate reads that as "main moved since you last
 * merged it" and the most recently landed lane can never pass — every close of it grades PARTIAL on
 * this gate alone. Measured on two lanes: "1 commit(s) on origin/main are not in this branch", and
 * the one commit was the LAND record's own merge sha.
 *
 * The rule: every commit main has that the branch lacks (`rev-list --parents <branch>..origin/main`,
 * measured by the caller) must be excused, and only two things excuse one:
 *   (a) it is this lane's own landing merge — the merge sha in its LAND record; or
 *   (b) it is a merge commit whose every non-first parent is contained in the branch — the branch
 *       was merged into main after it had merged main freshly, so the merge adds nothing the branch
 *       did not build. This is what a landing looks like when nobody recorded it.
 * Anything else — a neighbour's commit under the landing, a fix pushed after it, a neighbour's
 * landing merge whose second parent was never ours — stays unexplained and gate 2 still says no.
 * That is the rule's original intent, kept: main moved by OTHER lanes' content since the branch
 * last merged main, so a green build here is a build of one half.
 *
 * A gap that could not be listed (`ahead` is not an array: git failed) excuses nothing. A skip is
 * not a pass.
 *
 * @param {{ahead:{sha:string,parents?:string[]}[]|null, land?:{tip?:string,merge?:string}|null, isInBranch:(sha:string)=>boolean}} p
 * @returns {{contained:boolean, excused:{sha:string,as:string}[], unexplained:string[], why:string}}
 */
export function landingGapVerdict({ ahead, land = null, isInBranch }) {
  if (!Array.isArray(ahead)) {
    return { contained: false, excused: [], unexplained: [], why: 'the commits on origin/main that the branch lacks could not be listed, so none was excused. A skip is not a pass.' };
  }
  const excused = [];
  const unexplained = [];
  for (const c of ahead) {
    const parents = c.parents ?? [];
    if (land?.merge && c.sha === land.merge) { excused.push({ sha: c.sha, as: 'LAND merge' }); continue; }
    if (parents.length >= 2 && parents.slice(1).every((p) => isInBranch(p))) { excused.push({ sha: c.sha, as: 'merge of this branch' }); continue; }
    unexplained.push(c.sha);
  }
  const short = (x) => String(x).slice(0, 8);
  if (unexplained.length === 0) {
    const named = excused.map((e) => `${short(e.sha)} (${e.as})`).join(', ');
    return { contained: true, excused, unexplained, why: excused.length ? `${excused.length === 1 ? 'is' : 'are'} this branch's own landing: ${named}` : 'nothing on origin/main is missing from the branch' };
  }
  return {
    contained: false,
    excused,
    unexplained,
    why: `${unexplained.length} of them ${unexplained.length === 1 ? 'is' : 'are'} not a landing of this branch: ${unexplained.slice(0, 4).map(short).join(', ')}${unexplained.length > 4 ? ` (+${unexplained.length - 4} more)` : ''}${excused.length ? `; ${excused.length} excused as landing` : ''}`,
  };
}

/**
 * FRESH-BASE RULE for gate 2 (2026-08-22, pre-cap-raise). Two branches each build green alone and
 * nobody builds the combination — the classic way parallel lanes break main with every individual
 * lane green. So a green build only counts when the branch already CONTAINS origin/main's head at
 * build time: merge main in, rebuild, then it is a build of the union, not of one half.
 *
 * Pure decision over one measured fact (is origin/main's head an ancestor of the branch tip), plus
 * since 2026-09-04 one excuse: a gap made only of this branch's own landing (`gap`, from
 * landingGapVerdict) counts as containing the head, because the landing merge carries nothing the
 * branch did not already build. Grandfathered lanes get the observation as prose, not as a failure.
 *
 * @param {object} o
 * @param {boolean} o.containsMainHead   origin/main's head is an ancestor of the branch tip
 * @param {boolean} o.grandfathered      the lane predates the rule
 * @param {number|string|null} [o.behindBy]  commits on origin/main the branch lacks; absent when not measured
 * @param {{contained:boolean, why:string, unexplained:Array<string>}|null} [o.gap]  from landingGapVerdict
 * @returns {{fresh:boolean, why:string}}
 */
export function freshBaseVerdict({ containsMainHead, grandfathered, behindBy, gap = null }) {
  if (containsMainHead) return { fresh: true, why: 'the branch contains origin/main\'s head, so this build is a build of the combined result' };
  if (gap?.contained) {
    return { fresh: true, why: `the branch does not contain origin/main's head, but the only commit(s) it lacks ${gap.why} — a landing merge adds nothing the branch did not build, so this build is a build of the combined result` };
  }
  const gapCount = behindBy ? ` (${behindBy} commit(s) on origin/main are not in this branch${gap && gap.unexplained.length ? `; ${gap.why}` : ''})` : '';
  if (grandfathered) {
    return { fresh: true, why: `NOTE: the branch does NOT contain origin/main's head${gapCount} — this lane predates the fresh-base rule so the build still counts, but a green build on a stale base does not prove the combination builds. Merge origin/main and rebuild before pushing.` };
  }
  return { fresh: false, why: `the branch does NOT contain origin/main's head${gapCount}. A green build here proves only that this lane's half builds — not that it builds COMBINED with what landed on main since. Merge origin/main into the branch, rebuild, re-close. This is the rule that keeps four concurrent lanes from shipping a broken union of individually green branches.` };
}

/**
 * THE DRIVER'S READING OF THE FRESH-BASE RULE (GREEN1, 2026-09-14). freshBaseVerdict existed and
 * the close driver never called it, so a build on a base that predated a neighbour's landing still
 * graded `green=yes`. The driver now measures one thing before it builds, the output of
 * `git rev-list --parents <branch>..<base>` (every commit the base has that the branch lacks, each
 * line a sha followed by its parents), and hands it here.
 *
 * An empty list is a branch that contains the base's head. A non-empty list goes through
 * landingGapVerdict, so the branch's own landing merge is excused and nothing else is, and then
 * through freshBaseVerdict. `listed` null means git could not answer: `fresh` is null, which the
 * driver records as a skip, because an unmeasured base is not a fresh one.
 *
 * @param {object} o
 * @param {string|null} o.listed                 rev-list --parents output, or null when git failed
 * @param {{tip?:string, merge?:string}|null} [o.land]  the lane's LAND record, merge sha resolved
 * @param {(sha:string)=>boolean} o.isInBranch   is this commit an ancestor of the branch tip
 * @param {boolean} [o.grandfathered]
 * @param {string} [o.base]                      the ref name to say in the reason, e.g. main
 * @returns {{fresh:boolean|null, why:string, missing:string[]}}
 */
export function freshBaseFromRevList({ listed, land = null, isInBranch, grandfathered = false, base = 'origin/main' }) {
  const say = (s) => (base === 'origin/main' ? s : s.split('origin/main').join(base));
  if (listed === null || listed === undefined) {
    return { fresh: null, why: say('git could not list the commits on origin/main that the branch lacks, so whether this build is a build of the combined result was not measured'), missing: [] };
  }
  const ahead = String(listed).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [sha, ...parents] = l.split(/\s+/);
    return { sha, parents };
  });
  if (!ahead.length) {
    const v = freshBaseVerdict({ containsMainHead: true, grandfathered });
    return { fresh: v.fresh, why: say(v.why), missing: [] };
  }
  const gap = landingGapVerdict({ ahead, land, isInBranch });
  const v = freshBaseVerdict({ containsMainHead: false, grandfathered, behindBy: ahead.length, gap });
  return { fresh: v.fresh, why: say(v.why), missing: v.fresh ? [] : gap.unexplained };
}

/**
 * ANCESTRY-LIVE for gate 3's sha form (2026-08-22, pre-cap-raise). Equality was correct at one
 * writer: the site serves your sha or your deploy did not land. At several writers the LAST push
 * wins the alias, so a lane whose work landed fine reads `no` whenever a neighbour deployed after
 * it — a permanent false red on exactly the days the system is busiest, which is how the earlier
 * defect-4 class of gate gets ignored. So: pass when the served release CONTAINS this branch's
 * head (git ancestry). This still cannot pass on stale bytes — an older build does not contain
 * this branch's commit.
 */
export function liveShaVerdict({ served, sha, isAncestor, servedKnown }) {
  if (!served) return { value: 'no', why: 'the deployed surface answered without a release field, so the build cannot identify itself' };
  if (served === sha) return { value: 'yes', why: `deployment identity: release=${served} matches the branch head exactly. The deployment named its own commit, so this cannot have passed on stale bytes.` };
  if (isAncestor) return { value: 'yes', why: `deployment identity: release=${served.slice(0, 8)} CONTAINS this branch's head ${sha.slice(0, 8)} — a later lane deployed on top of this one, which is the normal case with concurrent writers. This lane's work is in the live build, and the deployment named its own commit, so this cannot have passed on stale bytes.` };
  if (servedKnown === false) return { value: 'skip', why: `SKIP: the served release ${served.slice(0, 8)} is not a commit this checkout knows, so ancestry could not be measured. Run \`git fetch origin\` in the repo and re-close. Nothing was measured, and a skip is not a pass.` };
  return { value: 'no', why: `release=${served.slice(0, 8)} neither matches nor contains this branch's head ${sha.slice(0, 8)} — the alias is serving a build without this lane's work. Check for a stacked deploy before re-firing anything.` };
}

/**
 * WHICH PROOF RAN, in the words every live verdict leads with (VERIFY1, 2026-09-14). The close
 * driver dispatches on the policy's `verify` column, and a reader of the ledger or the printed row
 * must be able to tell a string match from a commit echo without opening POLICY.md, so the form and
 * the row that named it head the sentence.
 *
 * @param {{kind:string, path?:string, field?:string, header?:string, name?:string}|null} verify
 * @returns {string}
 */
export function verifyFormLabel(verify) {
  const v = verify ?? { kind: 'none' };
  if (v.kind === 'sha') return `sha form (verify sha:${v.path}:${v.field})`;
  if (v.kind === 'header') return `header form (verify header:${v.path}:${v.header})`;
  if (v.kind === 'string') return 'string form (verify string, the liveness row\'s URL-and-string probe)';
  if (v.kind === 'script') return `script form (verify script:${v.name})`;
  if (v.kind === 'none') return 'none form (verify none)';
  return `unknown form (${v.kind})`;
}

/**
 * THE COMMIT A COMMIT-ECHO PROOF COMPARES AGAINST. The merge commit a LAND record names, when the
 * checkout knows it; otherwise the lane branch's tip. Either is contained by any later deploy built
 * on top of it, which is what lets the sha and header forms pass a lane a neighbour deployed after.
 * A squash-merged lane with no LAND record has a tip main does not contain, and grades no rather
 * than a guess; recording the landing fixes it. Pure: the resolved commits are handed in.
 *
 * @param {{landMerge?:string|null, branchTip?:string|null}} p
 * @returns {{sha:string|null, source:string}}
 */
export function laneCommitFor({ landMerge = null, branchTip = null }) {
  if (landMerge) return { sha: landMerge, source: 'the merge commit the LAND record names' };
  if (branchTip) return { sha: branchTip, source: 'the lane branch tip' };
  return { sha: null, source: 'no LAND record and no branch tip this checkout can resolve' };
}

// `exempt` joins `n/a` as a pass. Both mean "this gate does not apply here"; the difference is that
// n/a is structural (no deployed surface at all) and exempt is measured (the surface answered, and
// what it answered was a refusal, which is correct for a gated product). Neither claims the build
// was verified, and the close's note says so in words on every exempt close.
const PASS = new Set(['yes', 'n/a', 'exempt']);

/**
 * DONE requires all seven. Anything else is PARTIAL and this function writes the reason line, so a
 * lane cannot report DONE and then list a barred step underneath it.
 *
 * GATE 6 (owner-way-in) applies to repos behind a login and is `n/a` for the rest — a missing
 * ownerWay field reads as n/a so older callers and ledger lines stay valid.
 * When it FAILS, "owner locked out" leads the reason, ahead of every other failed gate: a product
 * the owner cannot open is the first thing the report says, not a line item.
 *
 * GATE 7 (in-scope) applies to lanes that declared a file scope and ran beside others on the
 * strength of it — see scopeCompliance above. A missing inScope field reads as n/a so every older
 * caller and ledger line stays valid.
 *
 * GATE 8 (roadmap) fails a lane whose brief names no roadmap row: work that leaves no trace on the
 * board is work nobody can see happened. Same convention again — a missing roadmap field reads n/a.
 * The roadmap verdict itself lives outside this module; this only grades the value it is handed.
 */
export function gradeGates(g) {
  const rows = [
    ['merged', g.merged, 'branch content is not on main — content-verified per path, not by ancestry'],
    ['green', g.green, 'the build was not observed green'],
    ['live', g.live, 'the deployed surface was not proved to be serving this build'],
    ['renamed', g.renamed, 'the brief still carries no closed prefix, so the next dispatch will fire it again'],
    ['report-free', g.reportFree, 'the report filename is already taken — writing there would replace another lane\'s report'],
    ['owner-way-in', g.ownerWay ?? 'n/a', 'owner locked out — the owner\'s stored credential no longer opens the live deployment'],
    ['in-scope', g.inScope ?? 'n/a', 'the branch touched files OUTSIDE the lane\'s declared scope — the disjointness the allocator proved at open no longer holds, and a neighbour\'s work may have been collided with'],
    ['roadmap', g.roadmap ?? 'n/a', 'no roadmap row named — this lane\'s brief cites no board row, so finishing it moves nothing anyone can see'],
    // GATE 9 (findings). A `FINDING:` line missing fix/size/owner is a problem handed to the owner
    // with no solution attached — see lib/finding-lines.mjs. A missing findings field reads n/a, so
    // every older caller and ledger line stays valid.
    ['findings', g.findings ?? 'n/a', 'a FINDING: line is missing fix, size, or owner — every problem raised needs a solution named alongside it'],
    // GATE 10 (no-side-files). A new REFERENCE-/SWEEP-/TRIAGE- file on the bridge during this
    // lane's window, with no `Side-file: allowed` line in its brief — see lib/side-files-gate.mjs.
    // A missing noSideFiles field reads n/a, so every older caller and ledger line stays valid.
    ['no-side-files', g.noSideFiles ?? 'n/a', 'a new REFERENCE-/SWEEP-/TRIAGE- file appeared on the bridge during this lane\'s window with no `Side-file: allowed` line in its brief — the tracker already exists, and this is the surface proliferation the rule refuses'],
  ];
  const failed = rows.filter(([, v]) => !PASS.has(v));
  // Owner lockout is never buried behind a skipped build or an unrenamed brief.
  failed.sort(([a], [b]) => (a === 'owner-way-in' ? -1 : b === 'owner-way-in' ? 1 : 0));
  const skipped = failed.filter(([, v]) => v === 'skip');
  const lockedOut = failed.some(([name, v]) => name === 'owner-way-in' && v === 'no');

  let status = failed.length ? 'PARTIAL' : 'DONE';
  let reason = failed.length
    ? (lockedOut ? 'owner locked out; ' : '') + failed.map(([name, v, why]) => `${name}=${v}: ${why}`).join('; ')
    : '';

  // NINTH INPUT: THE REPORT'S OWN STATUS WORD. With the eight gates as the whole grade, a report
  // that said PARTIAL or BLOCKED in its own words is overruled by eight gates that happened to
  // pass. Measured twice on one live bridge: two lanes each recorded a DONE CLOSE row over a report
  // whose own STATUS word said PARTIAL. The standing rule already settles which one wins: "the
  // STATUS word inside the report is the only scope claim." So a report saying PARTIAL or BLOCKED
  // can never grade DONE, whatever the eight gates measured.
  //
  // IT ONLY EVER LOWERS THE GRADE. A lane with a failing gate is not raised back to DONE by a
  // missing, absent or contradicting report word — the gate reason still leads the report in that
  // case, unchanged from before this input existed. And it never fires on a lane with no report yet
  // (`reportStatusWord` null or 'DONE'), which is the ordinary shape of a lane closing before it
  // writes up.
  if (status === 'DONE' && (g.reportStatusWord === 'PARTIAL' || g.reportStatusWord === 'BLOCKED')) {
    status = g.reportStatusWord;
    reason = `all gates passed, but the report's own STATUS word says ${g.reportStatusWord} — the standing rule is that "the STATUS word inside the report is the only scope claim," and the word outranks a passing gate grade.`;
  }

  return {
    status,
    failed: failed.map(([name, v, why]) => ({ gate: name, value: v, why })),
    reason,
    skippedCount: skipped.length,
    lockedOut,
  };
}

/**
 * MAY THIS CLOSE RENAME THE BRIEF ITSELF?
 *
 * Gate 4 is the only one of the eight a close can satisfy on its own. `merged` needs a merge,
 * `green` needs a build, `live` needs a deploy, `in-scope` needs the lane not to have wandered,
 * `roadmap` needs the brief's author to have named a board row. Gate 4 needs a file renamed in a
 * directory this script is already writing to, and printing an instruction instead is expensive:
 * measured on one bridge, a large share of PARTIAL close records named only `renamed=no`, and
 * lanes routinely ran the close more than once for it.
 *
 * THE ONE CONDITION, AND IT IS NOT NEGOTIABLE: gate 4 must be the SOLE failure. A brief whose lane
 * did not merge, did not build, or wandered outside its scope must stay live, because the next
 * dispatch firing it again is the correct outcome — that is the whole point of the gate. Renaming
 * on a partial close would convert a visible unfinished lane into an invisible one, which is worse
 * than the double close this removes.
 *
 * IT NEVER FIRES IN MEASURE-ONLY MODE. A script that says "nothing was written" and moved a file is
 * lying about the more important half.
 *
 * WIDENED ON ONE CONDITION AND NO OTHER: the lane's own report is on the
 * bridge. The original rule above reads gate 4 as the SOLE failure, and it left a large share of
 * close rows saying `renamed=no` — a lane that shipped, wrote its report, and then closed PARTIAL
 * because one unrelated gate was unmeasured, with the brief left live for a human to rename by hand.
 *
 * WHY "REPORT ON THE BRIDGE" IS THE RIGHT CONDITION AND "NOTHING ELSE FAILED" WAS TOO NARROW. The
 * fear the original rule answers is a half-done brief going invisible. Two things already prevent
 * that and neither depends on this rename. The report is filed under the graded prefix, and
 * PREFIXES.md routes `partial-` as `remainder` — lane-alloc reads those and prints the unfinished
 * scope as fireable, which is where a remainder belongs. And a brief left live after its lane filed
 * a CLOSE is refused by the allocator as CLOSED-UNRENAMED anyway (lib/lanes.mjs), so "staying
 * live" does not mean "fires again": it means a card that refuses itself and a rename somebody does
 * by hand. The standing rule settles the last of it: "the `done-` prefix marks the brief consumed,
 * nothing more; the STATUS word inside the report is the only scope claim."
 *
 * NO REPORT, NO RENAME. A lane with a failing gate and nothing written at any of its own report
 * slots has left no record of what happened, and that brief must stay live. That is the refusal this
 * function keeps, and it is the one worth keeping.
 *
 * THE BRIEF GETS `consumed-`, NOT A GRADED PREFIX. PREFIX_FOR_STATUS names REPORT prefixes
 * (`done-`, `partial-`, `blocked-`); PREFIXES.md gives exactly one word for an executed brief and it
 * is `consumed-`. Stamping `partial-` on a brief would claim it was a report.
 *
 * IT NEVER FIRES IN MEASURE-ONLY MODE. A script that says "nothing was written" and moved a file is
 * lying about the more important half.
 *
 * @param {{failed?:Array<{gate:string}>, liveBrief:string|null, apply:boolean, reportOnBridge?:boolean}} p
 * @returns {{ok:boolean, to?:string, why:string, because?:string}}
 */
export function renameOnCloseVerdict({ failed, liveBrief, apply, reportOnBridge = false }) {
  if (!liveBrief) return { ok: false, why: '' };
  const names = (failed ?? []).map((f) => f.gate);
  if (!names.length) return { ok: false, why: '' };
  const soleGate4 = names.length === 1 && names[0] === 'renamed';
  if (!soleGate4 && !reportOnBridge) {
    return {
      ok: false,
      why: `NOT renamed by this close: ${names.length} gate(s) failed (${names.join(', ')}) and this lane has written no report at any of its own report slots, so nothing on the bridge records what happened. Its brief must stay live for the next dispatch`,
    };
  }
  if (!/\.md$/i.test(liveBrief)) return { ok: false, why: 'NOT renamed: the bridge file is not a .md file' };
  const because = soleGate4 ? 'sole-failure' : 'report-on-bridge';
  if (!apply) {
    return {
      ok: false,
      because,
      why: `measure only — with --apply this close would rename "${liveBrief}" to "consumed-${liveBrief}", ${soleGate4
        ? 'which is the only gate standing between it and DONE'
        : `because this lane's report is already on the bridge. The unfinished scope travels with that report, which the allocator reads as a remainder; the brief staying live would only be refused as CLOSED-UNRENAMED (${names.length} gate(s) failed: ${names.join(', ')})`}`,
    };
  }
  return { ok: true, to: `consumed-${liveBrief}`, why: '', because };
}

/**
 * MAY THIS CLOSE REMOVE THE WORKTREE? The DISK question, kept apart from the REPORT question.
 *
 * Until 2026-09-02 lane-close asked one thing before archive-tagging and removing a checkout:
 *
 *     } else if (graded.status === 'DONE') {
 *
 * `graded.status` is gradeGates' verdict over EIGHT gates, and exactly one of them — `merged` —
 * says anything about whether that directory still holds work anybody needs. The rest are about
 * deployment (green, live), paperwork (renamed, report-free, roadmap) or concurrency bookkeeping
 * (owner-way-in, in-scope). Tying the directory to all eight means a lane can do everything right,
 * land its work on main, and still leave a gigabyte standing because nobody wrote a roadmap row.
 *
 * That is not hypothetical. Gate 8 (`roadmap`) shipped with no grandfather clause, and measured:
 * several closes after it were PARTIAL for `roadmap=no` and NOTHING ELSE — each merged, green
 * and live, and each leaving a checkout git would have cleaned up without complaint.
 *
 * WHAT A REMOVAL ACTUALLY DESTROYS, which is the whole argument: uncommitted and untracked files
 * in that one directory. Nothing else. The branch survives, its commits survive, and lane-close
 * archive-tags the branch before it touches the folder. So the safety of the removal rests on
 * `merged` plus the four refusals in worktreeRemovable() below — never on paperwork.
 *
 * `merged` is the one gate kept, and it is kept deliberately. `no` means the content was measured
 * and is not on main; `skip` means it could not be measured at all. Both leave the checkout
 * standing, because a branch whose landing is unproved is a branch somebody will want to resume
 * from — which is exactly what a lane does when it resumes after closing PARTIAL.
 *
 * ELIGIBILITY IS NOT PERMISSION. This says the close has no REPORTING reason to keep the folder.
 * worktreeRemovable() still runs afterwards and still refuses a dirty tree, an unregistered path,
 * the repo's own working copy, and the directory the calling session is standing in.
 *
 * @param {{status:string, merged:string, failed?:Array<{gate:string}>}} p
 * @returns {{ok:boolean, why:string}}
 */
export function removalEligible({ status, merged, failed = [] }) {
  if (!PASS.has(merged))
    return {
      ok: false,
      why: `merged=${merged} — this close did not prove the branch's content reached main, so the checkout stays. It is the one gate that speaks to whether work would be lost, and it is the only one this decision reads`,
    };
  if (status === 'DONE') return { ok: true, why: 'full pass — all eight gates' };
  const names = failed.map((f) => f.gate).filter((n) => n !== 'merged');
  return {
    ok: true,
    why: `PARTIAL on ${names.length ? names.join(', ') : 'no named gate'}, and none of those is about this directory — merged=${merged}, so the content is on main and the branch is archive-tagged before anything is removed. The unfinished scope stays with the live brief and the PARTIAL report, which is where it belongs; it was never being carried by a folder`,
  };
}

/**
 * Rider 2026-08-18: lane-close is the only path that removes a worktree, and it may remove ONLY
 * the lane's own, ONLY on a full-pass close. This is the pure half of that decision; the dirty-tree
 * refusal is left to `git worktree remove` itself, which is never given --force.
 *
 * @param {{repo:string, worktree:string, registered:string[]}} p  registered = basenames from
 *        `git worktree list --porcelain` of the lane's repo
 */
/**
 * Is `child` the same directory as `parent`, or somewhere beneath it?
 *
 * Pure string comparison — no filesystem, so the caller resolves symlinks before calling if it
 * cares about them. The separator in the prefix test is the whole point: without it `/code/web-x1`
 * swallows `/code/web-x10`, and a guard that blocks legitimate cleanups forever is a guard
 * somebody removes.
 */
export function pathIsInside(child, parent) {
  const c = String(child ?? '').replace(/\/+$/, '');
  const p = String(parent ?? '').replace(/\/+$/, '');
  if (!c || !p) return false;
  return c === p || c.startsWith(`${p}/`);
}

/**
 * May this close remove the lane's worktree?
 *
 * THREE refusals. The third exists because a dispatcher session once killed itself: it was opened
 * inside the worktree `web-x1`, closed that lane, and `git worktree remove` took away the
 * directory its own shell was standing in. An agent session's working folder is pinned at startup
 * and cannot move, so there was no recovery — the session died and took two in-flight jobs with it.
 * On macOS an open cwd is not a lock; git removes it happily.
 *
 * Nothing in the old signature could see where the calling process was standing, so the case was
 * unreachable rather than merely unhandled.
 *
 * A REFUSAL HERE IS NOT A FAILED CLOSE. The merge, the tag, the report and the claim release all
 * still happen; only the directory removal is skipped. A close that reports DONE and leaves one
 * worktree standing is correct behaviour, not a partial.
 *
 * `cwd` and `worktreeAbs` are OPTIONAL and absolute. Omit them and the old two-refusal behaviour is
 * exactly preserved, which matters because every existing caller passes neither. Pass paths already
 * resolved through realpath if a symlinked route to the same directory should also be caught.
 *
 * THE FOURTH REFUSAL — UNCOMMITTED WORK.
 *
 * `git worktree remove` already refuses a dirty tree, and this close never passes --force, so the
 * work was never actually at risk. What was missing is a DECISION anyone can read. git's refusal
 * arrives as a stderr string nobody grades, on a path that also produces "not a working tree" and
 * "is a main working tree" and half a dozen other messages; the close printed whichever line came
 * back and moved on. The whole point of the deterministic version is that the refusal is a value,
 * tested, with the tripped condition named — not a message that happened to be printed.
 *
 * `dirty` is the porcelain lines from the worktree's own tree, and it is OPTIONAL for the same
 * backwards-compatibility reason as cwd. `null` means UNMEASURED and is not read as dirty: a caller
 * that could not run git must not have its removal refused as though it had found changes. An empty
 * array means measured and clean.
 *
 * Every refusal now carries a `condition` token, so the close can print WHICH one tripped rather
 * than leaving four different situations behind one sentence.
 */
export function worktreeRemovable({ repo, worktree, registered, cwd = null, worktreeAbs = null, dirty = null }) {
  if (!worktree || worktree === repo)
    return { ok: false, condition: 'own-checkout', why: `the lane's checkout IS the repo's own working copy (${repo}) — never removed` };
  if (!registered.includes(worktree))
    return { ok: false, condition: 'not-registered', why: `${worktree} is not a registered worktree of ${repo}, so there is nothing this close may remove` };
  if (cwd && worktreeAbs && pathIsInside(cwd, worktreeAbs))
    return {
      ok: false,
      condition: 'session-cwd',
      why: `this session is standing inside ${worktree}; removing it would delete this session's working folder and kill the chat. Close from the repo's own checkout instead, or run the removal from elsewhere once this session is done`,
    };
  if (Array.isArray(dirty) && dirty.length)
    return {
      ok: false,
      condition: 'uncommitted-work',
      why: `${worktree} holds ${dirty.length} uncommitted change(s) and removing it would destroy them: ${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? `, +${dirty.length - 5} more` : ''}. Commit them, or move them somewhere that is backed up, then remove the worktree by hand. This close will not delete unsaved work and will never reach for --force to get past it`,
    };
  return { ok: true, condition: null, why: null };
}

/**
 * MAY THIS CLOSE PROCEED, GIVEN WHAT THE REPORT ITSELF SAYS?
 *
 * A close that grades its gates and then prints a report FILENAME has never read the report. What
 * that costs, measured across one bridge: more than half of the reports saying DONE admitted in
 * their own text a step that was skipped, not run, not merged or not deployed; a few carried no
 * STATUS word at all, which the standing rule already says makes them PARTIAL; and about a third
 * carried no `Evidence:` line, which leaves the `done-` prefix meaning "consumed" and nothing more.
 *
 * `report-check.mjs` has measured all three the whole time. It was simply never in the close path.
 * So this is not a new judgment about reports; it is the existing judgment, finally consulted at
 * the one moment it can change an outcome.
 *
 * THREE REFUSALS, checked in order, first one wins:
 *
 *   no-status-word           the report block carries no DONE / PARTIAL / BLOCKED. The standing
 *                            rule ("a report with no STATUS word is PARTIAL") makes this
 *                            unreadable as a scope claim whatever the gates said.
 *   done-without-evidence    STATUS DONE and no `Evidence:` line.
 *   done-honest-unaddressed  STATUS DONE and report-check's done-honest heuristic WARNs — the body
 *                            names a skipped, barred or deferred step beside a DONE. There are two
 *                            valid answers to a reviewer, fix it or overrule it in writing, and
 *                            silence is not a third; so an `overruled:` line naming report-check
 *                            lets the close through, and nothing else does.
 *
 * WHAT A REFUSAL IS. The same shape as worktreeRemovable(): a value with a named condition and a
 * sentence, decided here and acted on by lane-close.mjs. The caller aborts the close with a
 * non-zero exit and writes NOTHING — no ledger line, no rename, no worktree removal, no claim
 * release — and it does so on a dry run as well, because printing DONE over a body that contradicts
 * it is already the failure, the same argument as the working-copy guard in lib/reclaim.mjs.
 *
 * WHAT IT IS NOT. It is not a gate. A gate makes a close PARTIAL and the close still happens; this
 * stops the close entirely, because the disagreement is between the report and itself and no
 * grade can be recorded honestly until a person resolves it. It also judges nothing about a report
 * that does not exist yet: a lane that closes before writing its report is the normal order and is
 * left alone.
 *
 * done-honest is a HEURISTIC and it is being given teeth here, which is a real cost: a report that
 * quotes the word "skipped" inside a quoted passage now has to say so. That is what the `overruled:`
 * line is for, it is one sentence, and requiring it is the point — the review found the same phrase
 * standing unexplained in 76 files, and no one of them had ever been asked.
 *
 * @param {{file:string, present:boolean, statusFound?:boolean, statusWord?:string|null,
 *          evidencePresent?:boolean, doneHonestWarn?:boolean, doneHonestSummary?:string,
 *          doneHonestDetail?:string[], overruled?:boolean}} p
 * @returns {{ok:boolean, condition:string|null, why:string|null}}
 */
export function doneReportRefusal({
  file,
  present,
  statusFound = false,
  statusWord = null,
  evidencePresent = false,
  doneHonestWarn = false,
  doneHonestSummary = '',
  doneHonestDetail = [],
  overruled = false,
}) {
  if (!present) return { ok: true, condition: null, why: null };

  if (!statusFound)
    return {
      ok: false,
      condition: 'no-status-word',
      why: `REFUSED: ${file} carries no STATUS word, and the standing rule is that a report with no STATUS word is PARTIAL — write "STATUS: DONE" or "STATUS: PARTIAL" in the report block and close again; this close recorded nothing.`,
    };

  if (statusWord !== 'DONE') return { ok: true, condition: null, why: null };

  if (!evidencePresent)
    return {
      ok: false,
      condition: 'done-without-evidence',
      why: `REFUSED: ${file} says STATUS DONE with no "Evidence:" line, and the project's governing rules require every done- report to carry one naming the verification run, its result and the date — add it, or file this as PARTIAL, and close again; this close recorded nothing.`,
    };

  if (doneHonestWarn && !overruled) {
    const first = doneHonestDetail[0] ? ` first at ${String(doneHonestDetail[0]).slice(0, 120)};` : '';
    return {
      ok: false,
      condition: 'done-honest-unaddressed',
      why: `REFUSED: ${file} says STATUS DONE while report-check's done-honest check flags it (${doneHonestSummary || 'a skipped, barred or deferred step named beside a DONE'});${first} a reviewer's objection has two valid answers, fix it or overrule it in writing — finish the step, file PARTIAL, or add a line reading "overruled: report-check flagged <what> in <path>; <why it is acceptable here>", then close again; this close recorded nothing.`,
    };
  }

  return { ok: true, condition: null, why: null };
}

/**
 * THE CLOSE DRIVER'S REPORT REFUSAL: report-check's reading of the report, handed to
 * doneReportRefusal with the report's presence stated.
 *
 * THE DEFECT THIS REPLACES (DRIVER1, 2026-09-14, found by the gate-matrix lane). src/bin/close.mjs
 * called doneReportRefusal directly, passing the status word, a hand-written Evidence regex and
 * `doneHonestWarn: false`, but never `present` or `statusFound`. doneReportRefusal returns ok at once
 * unless told a report is present, so none of the three refusals could fire on a real close, and the
 * honesty flag could not have fired even if presence had been passed.
 *
 * THE SHAPE is the private workspace close's reportRefusalFor, so the two cannot disagree: presence
 * is true whenever report text was read; the status, Evidence and done-honest answers are
 * report-check's own checks (checkText), never a second parser; the overrule is overrulesReportCheck.
 * A file report-check reads as a consumed brief rather than a lane report is never refused, and says
 * so in a note, because a check that cannot apply must not pass silently either.
 *
 * Pure apart from report-check's date fallback, which stats `file` only when its name carries no
 * date.
 *
 * @param {{file:string, text:string|null}} p
 * @returns {{ok:boolean, condition:string|null, why:string|null, note?:string}}
 */
export function closeReportRefusal({ file, text }) {
  if (text === null || text === undefined) return doneReportRefusal({ file, present: false });
  const checked = checkText(text, file);
  if (checked.kind !== 'report')
    return { ok: true, condition: null, why: null, note: `NOTE: report-check reads ${file} as a ${checked.kind}, not a lane report, so the report rules were not applied to it.` };
  const by = Object.fromEntries(checked.checks.map((c) => [c.name, c]));
  return doneReportRefusal({
    file,
    present: true,
    statusFound: by.status?.status === 'PASS',
    statusWord: checked.statusWord,
    evidencePresent: by.evidence?.status === 'PASS',
    doneHonestWarn: by['done-honest']?.status === 'WARN',
    doneHonestSummary: by['done-honest']?.summary ?? '',
    doneHonestDetail: by['done-honest']?.detail ?? [],
    overruled: overrulesReportCheck(text),
  });
}

/**
 * Does this report answer report-check's objection in the L6 form?
 *
 * The overrule line names the reviewer, and this is deliberately literal about it: `overruled:
 * eslint flagged an unused import` answers a DIFFERENT reviewer and must not release this one. L6's
 * own words are that the line "names the objection, the file, and the reason", and the reviewer
 * being answered here is report-check, so its name is the part that can be checked mechanically.
 * The rest of the sentence is a human's to write and a human's to read.
 */
export function overrulesReportCheck(text) {
  return String(text ?? '')
    .split('\n')
    .some((l) => /^\s*[-*>\s#_]*overruled\s*:/i.test(l) && /report-check/i.test(l));
}

/**
 * Which bridge terms does this report overrule the vocabulary check on?
 *
 * THE GAP THIS CLOSES. The vocabulary-alias refusal had no overrule at all: overrulesReportCheck()
 * above was consulted only by the done-honest branch, so a report could carry a correctly written
 * overrule line and still be refused. Measured live: a lane was merged and removal-eligible on
 * every gate, its heading carried the plain words beside the codename, the brief that would have
 * supplied the registered plain name had been consumed off the bridge, and an
 * `overruled: report-check flagged "X12" ...` line changed nothing. That is the third
 * option the rule says does not exist — the reviewer objected and no answer could be heard.
 *
 * THE SHAPE, and why it is narrower than overrulesReportCheck(). A vocabulary objection is about ONE
 * token, so the overrule is scoped to the token, never to the whole check: the line must quote the
 * term it answers, and only that term is released. A done-honest overrule that names report-check
 * and quotes no bridge term releases no vocabulary finding, and vice versa, so the two reviewers are
 * not conflated even though a lane may name either one. The reviewer may be named as `vocabulary`,
 * `vocab`, or `report-check` (the refusal is printed by the close's own `--check-report` pass, so a
 * lane answering what it read there is answering the same reviewer). A line that names none of them
 * answers a different reviewer and releases nothing, the same rule as above.
 *
 *   overruled: vocabulary flagged "LABEL1" in _handoffs/done-...md; LABEL1 is a label that lives
 *              in the database, not a lane codename
 *
 * The rest of the sentence is a human's to write and a human's to read.
 *
 * @param {string} text  the whole report
 * @returns {Set<string>}  the quoted terms released, exactly as written (alias matching is case-sensitive)
 */
export function overrulesVocabulary(text) {
  const released = new Set();
  for (const l of String(text ?? '').split('\n')) {
    if (!/^\s*[-*>\s#_]*overruled\s*:/i.test(l)) continue;
    if (!/\b(vocabulary|vocab|report-check)\b/i.test(l)) continue;
    for (const m of l.matchAll(/["“`']([^"”`']{1,80})["”`']/g)) {
      const term = m[1].trim();
      if (term) released.add(term);
    }
  }
  return released;
}

/**
 * Does a vocabulary finding fall inside the released set? A fuzzy finding's token is written
 * `<what was matched> (≈ <alias>)`, and a lane overrules it by quoting either half.
 */
export function vocabularyFindingOverruled(finding, released) {
  if (!released?.size) return false;
  const token = String(finding?.token ?? '');
  if (released.has(token)) return true;
  const fuzzy = token.match(/^(.*) \(≈ (.*)\)$/);
  return Boolean(fuzzy && (released.has(fuzzy[1]) || released.has(fuzzy[2])));
}

// ----------------------------------------------------------------- clerical vs scope partials
//
// Measured over the ledger's CLOSE rows, the four commonest gate failures are clerical rather than
// substantive: renamed=no, live=no, in-scope=skip and roadmap=no.
// A lane that shipped its work and then closed PARTIAL because nobody renamed a file has cost a
// whole second cycle for a paperwork step the close was standing next to. The four additions below
// let the close do the clerical half itself.
//
// THE LINE NONE OF THEM CROSS: nothing here turns an unmeasured gate into a pass. Every fallback
// that measures nothing still records `skip` and still prints that a skip is not a pass. What they
// remove is the case where the close COULD have measured or COULD have acted and did neither.

/**
 * GATE 4'S MATCHER, WIDENED TO A CONTINUATION LANE AND NO FURTHER.
 *
 * `briefMatchesLane` matches the lane id as a whole token, which is right and which has one blind
 * spot: a continuation lane's id carries a suffix that no bridge filename has. Measured: lane
 * `theta1-b` closed with gate 4 reading "the brief still carries no closed prefix" about a brief
 * that had been renamed `consumed-2026-08-22-Web-THETA1-...` hours earlier.
 *
 * The fallback is `laneKey()` from lib/lanes.mjs, which is the SAME normalisation the
 * CLOSED-UNRENAMED check already uses to recognise `hotel2-b` as `hotel2`. It is not a fuzzy match and
 * it must never become one: `laneKey('ops-l1b')` is `ops-l1b`, so `ops-l1` still cannot claim
 * `Ops-L1b-...`, and `alpha1` still cannot claim `ALPHA12`. The caller computes the key; this stays
 * pure so both halves are testable.
 */
export function briefMatchesLaneOrKey(filename, lane, key = null) {
  if (briefMatchesLane(filename, lane)) return true;
  if (!key || key === lane) return false;
  return briefMatchesLane(filename, key);
}

/**
 * WHICH CLAIM LINES A CLOSE MAY RELEASE, and which it may only NAME.
 *
 * The release itself already works and has since 2026-08-20: `releaseRewrite` comments the line out
 * with a `# RELEASED <iso> — claim id ...` header and never deletes it. The gap is the miss. The
 * fourth field is a JOIN KEY derived from the lane, so a continuation lane writes
 * `dispatch-lane-x-w3` where the ledger's OPEN row says `dispatch-lane-x`, the exact
 * match finds nothing, and the close prints "no claim line matched this lane's session id" and
 * stops. That has happened, and the record shows a human releasing the claim by
 * hand. lib/claims.mjs' own header explains at length why the key cannot simply be changed.
 *
 * SO THIS NAMES AND DOES NOT ACT. An exact match is released, as it always was. A line that is not
 * an exact match but shares this lane's KEY and REPO is reported as a near miss for a human to
 * adjudicate, and is left standing. Releasing it automatically would be the one unrecoverable kind
 * of mistake available here: `dispatch-lane-x` may be a different, live lane, and this folder
 * is not a git repository. Naming it costs one printed line and removes the hunt.
 *
 * @param {{rows:Array<{session:string,repo:string,key:string,raw:string,stale?:boolean,malformed?:boolean}>, session:string, key:string, repo:string}} p
 */
export function claimReleasePlan({ rows = [], session, key, repo }) {
  const usable = rows.filter((r) => r && !r.malformed && r.session);
  const exact = usable.filter((r) => r.session === session);
  if (exact.length)
    return { exact, nearMiss: [], why: `${exact.length} claim line(s) carry this lane's session id exactly` };
  const nearMiss = usable.filter((r) => !r.stale && key && r.key === key && (!repo || r.repo === repo));
  return {
    exact: [],
    nearMiss,
    why: nearMiss.length
      ? `no claim line carries the session id "${session}", but ${nearMiss.length} active claim(s) on ${repo} share this lane's key "${key}" — NOT released, because a claim id one suffix away may belong to a different live lane and this folder is not a git repository. Adjudicate and release by hand.`
      : `no claim line carries the session id "${session}" and none on ${repo} shares this lane's key "${key}" — nothing was removed`,
  };
}

/**
 * THE DEPLOYMENT STATUS ROUTE. A deployment that can answer "which commit am I serving?" turns the
 * liveness gate from a string search into an ancestry proof. Configure the path your apps expose;
 * the default is a common convention and nothing here depends on it.
 */
export let STATUS_ROUTE = '/api/status';

export function setStatusRoute(route) {
  STATUS_ROUTE = route;
  return STATUS_ROUTE;
}

/** The one sentence a close prints when neither deploy probe exists. Shared so it cannot drift. */
export const NO_DEPLOY_PROBE = 'no verify:prod script and no deployment status route';

/**
 * GATE 3'S SECOND ASK, and why it can only ever improve the reading.
 *
 * `live=no` is 56 of 269 close rows and a large share of the rest read `skip`. A skip means the gate
 * measured NOTHING — no url in POLICY.md, no proof string supplied, a fetch that failed — and a
 * lane in that position usually has a perfectly good deploy check sitting in its own repo that
 * nobody asked. This asks it.
 *
 * IT FIRES ONLY ON `skip`. A `no` is a real red and must survive; a `yes`, `n/a` or `exempt` is
 * already decided. So this can turn an unmeasured gate into a measured one and can never turn a
 * measured failure into a pass.
 *
 * ORDER: the repo's own `verify:prod` first, because it is the check the repo's authors wrote for
 * exactly this question; then the deployment's own status route, which is how a repo using
 * POLICY.md's `sha:` form proves a deploy. Neither available leaves the skip standing with the
 * reason named, because a skip is not a pass.
 *
 * A SCRIPT NAMED IN THE DOCS BUT ABSENT FROM package.json IS NOT RUNNABLE and the mismatch is
 * printed rather than swallowed: `npm run verify:prod` would exit non-zero on "Missing script", and
 * recording that as `no` would blame the deployment for a documentation error.
 */
export function deployProbePlan({ value, hasScript, namedInDocs = false, url = null }) {
  if (value !== 'skip') return { probe: 'none', why: '' };
  if (hasScript)
    return { probe: 'verify:prod', why: 'this repo declares a `verify:prod` script, which is the check its own authors wrote for this question, so the gate runs it rather than recording an unmeasured skip' };
  if (!url)
    return { probe: 'none', why: `live=skip stands: ${NO_DEPLOY_PROBE} (POLICY.md carries no url for this repo, so nothing could be asked). A skip is not a pass.` };
  return {
    probe: 'status-route',
    why: namedInDocs
      ? "this repo's docs name `npm run verify:prod` but its package.json has no such script, so nothing runnable was found by that name; asking the status route instead"
      : 'no `verify:prod` script, so the gate asks the deployment for its status route before it records an unmeasured skip',
  };
}

/** The repo's own deploy check, graded by its exit code and nothing else. */
export function verifyProdVerdict({ code, tail = '' }) {
  if (code === 0)
    return { value: 'yes', why: '`npm run verify:prod` exited 0 in this repo\'s own checkout, so the repo\'s own deploy check passed' };
  return {
    value: 'no',
    why: `\`npm run verify:prod\` exited ${code}, so this repo's own deploy check FAILED. Its last line: ${String(tail).trim().slice(0, 200) || '(no output)'}. A missing credential and a stale deploy both land here, so read that line before concluding which one this is.`,
  };
}

/**
 * The deployment status route as a fallback probe. Ancestry, exactly as the `sha:` form of gate 3 grades it.
 *
 * @param {object} o
 * @param {number|null} o.status        the route's HTTP status, or null when nothing answered
 * @param {string|null} [o.served]      the release field it answered with; absent when it answered none
 * @param {string} o.sha                the branch head
 * @param {boolean} [o.isAncestor]
 * @param {boolean|null} [o.servedKnown]
 * @returns {{value:string, why:string}}
 */
export function obsProbeVerdict({ status, served, sha, isAncestor = false, servedKnown = null }) {
  if (status !== 200 || !served)
    return {
      value: 'skip',
      why: `SKIP: ${NO_DEPLOY_PROBE} — ${STATUS_ROUTE} answered ${status || 'nothing'}${status === 200 ? ' with no release field' : ''}. Nothing was measured, and a skip is not a pass.`,
    };
  const v = liveShaVerdict({ served, sha, isAncestor, servedKnown });
  return { value: v.value, why: `${STATUS_ROUTE}: ${v.why}` };
}

/**
 * GATE 7'S DERIVED LIST — what the lane actually touched, attached to a reading that decided nothing.
 *
 * `in-scope=skip` is 48 of 269 close rows, and a skip here says only that the gate could not
 * attribute the branch's commits. The next reader then has no idea what the lane touched, and the
 * cheapest way to find out — one `git diff --name-only` — is a thing the close was already holding a
 * base and a branch for. A brief with no `Touches:` line reads `n/a` for the same lack of a list.
 *
 * IT NEVER CHANGES THE VALUE. The list is attached to whatever the gate decided, labelled `derived`
 * per the receipt-provenance rule, so a skip stays a skip and is no longer silent about the files.
 */
export function scopeDerivedNote({ touched, base, source = null, branch = 'the branch', cap = 12 }) {
  if (!base) return ' derived: no diff base could be established, so there is no touched-file list to attach.';
  const range = `${String(base).slice(0, 8)}..${branch}`;
  const from = source ? ` (base from ${source})` : '';
  if (touched === null)
    return ` derived: the touched-file list could not be computed — \`git diff --name-only ${range}\` failed${from}. Still unmeasured, and a skip is not a pass.`;
  if (!touched.length) return ` derived: \`git diff --name-only ${range}\`${from} lists 0 path(s).`;
  const shown = touched.slice(0, cap);
  const more = touched.length - shown.length;
  return ` derived: ${touched.length} touched path(s) from \`git diff --name-only ${range}\`${from} — ${shown.join(', ')}${more ? ` (+${more} more)` : ''}.`;
}

/**
 * TWO KINDS OF PARTIAL.
 *
 * THE MEASURED DEFECT. Over one week's PARTIAL closes, most failed only `roadmap=no` and a minority
 * only `in-scope=no` (a lane can carry more than one failure). Both print as the identical word PARTIAL,
 * so a board reader cannot tell "this lane's brief cited no roadmap row" from "this lane's branch
 * wandered outside its declared scope and may have collided with a neighbour" — one is paperwork,
 * the other is the exact hazard the in-scope gate exists to catch.
 *
 * THE RULE DOES NOT CHANGE. `gradeGates` above still decides DONE or PARTIAL and nothing here
 * overrides it — a PARTIAL stays PARTIAL either way. This only qualifies it: SCOPE means the work
 * itself is unfinished or unsafe; CLERICAL means a measurement or paperwork gap with nothing
 * confirmed wrong about the work. `alloc` reads `scope` as fireable remainder work; `clerical`
 * is filtered out of that list (never out of the ledger — a clerical PARTIAL is still a PARTIAL).
 *
 * THE TWO LISTS, taken from the brief's own words:
 *   SCOPE      in-scope=no, merged=no, live=no, the report's own STATUS word says PARTIAL or
 *              BLOCKED, done-without-evidence, done-honest-unaddressed. Also owner-way-in=no and
 *              report-free=no, neither one named by the brief because the four report-refusals in
 *              doneReportRefusal already stop those two from ever reaching a recorded close — but
 *              an unlisted gate defaults to scope rather than silently reading as clerical, which
 *              is the conservative direction and matches "in-scope=no ... must never be folded
 *              into the clerical bucket."
 *   CLERICAL   roadmap=no, renamed=no, and `green` only when its value is `skip` (never run, or
 *              this checkout cannot run one) — never when its value is `no`. A build gate that
 *              ACTUALLY WENT RED is real unfinished work, whatever the brief's shorthand phrase
 *              "green=no" reads like; the brief's own qualifier ("when the build later passed, or
 *              was never run") is a claim this function cannot verify from a gate value alone
 *              without re-running an old branch's build, so it is applied the safe way: a
 *              confirmed red build is scope, an unmeasured one is clerical. `in-scope=skip` (the
 *              gate could not be measured, as opposed to `in-scope=no`, a confirmed breach) reads
 *              the same way — unmeasured is clerical, confirmed is scope.
 *
 * REPORT-CONTENT SIGNALS are optional (`reportStatusWord`, `doneWithoutEvidence`,
 * `doneHonestUnaddressed`) because not every caller has read the report: `lane-close.mjs` has it
 * (the report it just graded through `doneReportRefusal`), a historical LANES.md regrade can
 * recover it by re-reading the still-present report file, and a caller with neither passes nothing
 * and gets a verdict from the gates alone.
 *
 * @param {{failed?:Array<{gate:string,value?:string}>, reportStatusWord?:(string|null),
 *          doneWithoutEvidence?:boolean, doneHonestUnaddressed?:boolean}} p
 * @returns {{kind:('scope'|'clerical'|null), scope:string[], clerical:string[]}}
 */
export function classifyPartialKind({ failed = [], reportStatusWord = null, doneWithoutEvidence = false, doneHonestUnaddressed = false } = {}) {
  const scope = [];
  const clerical = [];
  if (reportStatusWord === 'PARTIAL' || reportStatusWord === 'BLOCKED') scope.push(`report says ${reportStatusWord}`);
  if (doneWithoutEvidence) scope.push('done-without-evidence');
  if (doneHonestUnaddressed) scope.push('done-honest-unaddressed');

  const ALWAYS_CLERICAL = new Set(['roadmap', 'renamed']);
  // Gates whose `no` is a CONFIRMED breach (scope) and whose `skip` is only an unmeasured gap
  // (clerical). `green` is handled in the same loop, one line down, for the identical reason.
  const CONFIRM_SCOPE_WHEN_NO = new Set(['merged', 'live', 'in-scope']);

  for (const f of failed) {
    const gate = typeof f === 'string' ? f : f.gate;
    const value = typeof f === 'string' ? null : (f.value ?? null);
    if (gate === 'green') {
      if (value === 'no') scope.push('green=no');
      else clerical.push(`green=${value ?? 'skip'}`);
    } else if (ALWAYS_CLERICAL.has(gate)) {
      clerical.push(`${gate}=${value ?? 'no'}`);
    } else if (CONFIRM_SCOPE_WHEN_NO.has(gate)) {
      if (value === 'no') scope.push(`${gate}=no`);
      else clerical.push(`${gate}=${value ?? 'skip'}`);
    } else {
      // owner-way-in, report-free, or any gate this function does not yet know — conservative
      // default, never silently clerical.
      scope.push(`${gate}=${value ?? '?'}`);
    }
  }

  if (!scope.length && !clerical.length) return { kind: null, scope, clerical };
  return { kind: scope.length ? 'scope' : 'clerical', scope, clerical };
}

/** `PARTIAL (scope)` / `PARTIAL (clerical)` — the one place that renders the pair as a string, so
 *  fire-board.mjs and lane-close.mjs's own printed report never format it two different ways. */
export function partialStatusLabel(status, kind) {
  return status === 'PARTIAL' && kind ? `PARTIAL (${kind})` : status;
}

