#!/usr/bin/env node
// @ts-check
// close.mjs — the close. An agent says it finished; this finds out.
//
// THE WHOLE IDEA. A worker's word for its own completion is the least reliable signal in the
// system, and it is the one almost every orchestrator trusts. This trusts none of it. It measures
// the repository, the build, the deployed surface, the declared file scope and the report's own
// text, and it grades. DONE requires every gate to pass. Anything else is PARTIAL, with the
// failing gates named.
//
// A SKIP IS NOT A PASS. Every gate that could not measure says so in those words, and a skip never
// grades DONE. That single rule is most of the value here: the failure mode of a verification
// system is not a wrong answer, it is a soft dash that everybody learns to read as green.
//
// USAGE
//   pandoras-router close <lane>                       measure only, write nothing
//   pandoras-router close <lane> --apply                also rename the brief, record the CLOSE and
//                                                       release the lane's claim, the last two under
//                                                       the state lock in one section
//   pandoras-router close <lane> --no-build             skip the build (records skip, not a pass)
//   pandoras-router close <lane> --proof "<string>"     the string the liveness probe looks for,
//                                                       overriding the policy's `expect`
//
// THE GATES
//   merged        every path the branch touched is byte-identical on main (content, not ancestry)
//   green         `npm run build` in the lane's own checkout exited 0
//   live          the deployed surface was asked, over HTTP, and is serving this build
//   renamed       the brief carries a closed prefix, so the next dispatch does not fire it again
//   in-scope      every path the branch touched is inside the scope the lane declared at open
//   findings      every `FINDING:` line carries a fix, a size and an owner
//   no-side-files no new REFERENCE-/SWEEP-/TRIAGE- file appeared during this lane's window
//
// Gates this driver deliberately does NOT run: anything that writes to a tracker. A close reports;
// filing is a separate, explicit act.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadPolicy, repoPolicy } from '../lib/policy.mjs';
import { loadPrefixes, classify } from '../lib/prefixes.mjs';
import { readLanes, recordClose, laneKey } from '../lib/lanes.mjs';
import { releaseClaim, claimsFile } from '../lib/claims.mjs';
import { withLock } from '../lib/lock.mjs';
import { git, repoDirFor, isRepo } from '../lib/gitread.mjs';
import { probeLiveness, LIVE_SKIPPED } from '../lib/liveness.mjs';
import { parseFindingLines, findingsGateVerdict, ownerDecisionLines } from '../lib/finding-lines.mjs';
import { SIDE_FILE_RE, sideFileAllowed, extractBriefTitle, noSideFilesVerdict } from '../lib/side-files-gate.mjs';
import { findStatus } from '../lib/report-check.mjs';
import {
  classifyPath, gradeMerge, gradeGates, isBranchless, briefMatchesLaneOrKey,
  renameOnCloseVerdict, classifyPartialKind, partialStatusLabel,
  closeReportRefusal, inScopeVerdict, scopeDiffPlan,
} from '../lib/close.mjs';

// THE WORKSPACE ROOT is the directory holding `_handoffs/` and your repos. It is NEVER the
// package's own install location, so it comes from $PANDORAS_ROOT or the current directory.
const ROOT = path.resolve(process.env.PANDORAS_ROOT || process.cwd());
const BRIDGE = path.join(ROOT, '_handoffs');

const has = (args, name) => args.includes(name);
function arg(args, name, dflt = null) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}

// ── GATE: merged ──────────────────────────────────────────────────────────────────────────────
//
// CONTENT, NOT ANCESTRY. `git branch --merged` answers a question about graph shape, and the graph
// can say merged while a later commit on main has reverted or overwritten the lane's bytes. So
// every path the branch touched is compared blob-by-blob against main. See classifyPath.
function gateMerged(repoDir, branch, BASE) {
  if (isBranchless(branch))
    return { value: 'n/a', note: 'this lane has no branch — it ran in place on a target that is not a git repository, so there is nothing to merge. Recorded as N/A, not as a pass.', paths: [], base: null };
  const base = git(repoDir, ['merge-base', BASE, branch]);
  if (!base)
    return { value: 'skip', note: `SKIP: could not compute merge-base(${BASE}, ${branch}) — ${BASE} may not be fetched. Nothing was measured, and a skip is not a pass.`, paths: [], base: null };
  const names = git(repoDir, ['diff', '--name-only', base, branch]);
  if (names === null)
    return { value: 'skip', note: 'SKIP: git diff failed. Nothing was measured, and a skip is not a pass.', paths: [], base };
  const files = names.split('\n').filter(Boolean);
  if (!files.length) {
    // Two very different situations produce an empty diff and they must not read the same. A branch
    // already contained in main has a merge base that has COLLAPSED onto its own tip: its work
    // landed. A branch that genuinely changed nothing has a base behind its tip.
    const tip = git(repoDir, ['rev-parse', branch]);
    return base === tip
      ? { value: 'yes', note: `this branch is fully contained in ${BASE} — its content landed, and the merge base has collapsed onto the branch tip ${String(tip).slice(0, 8)}, which is why the diff is empty`, paths: [], base }
      : { value: 'yes', note: 'the branch introduces no changes against its merge base', paths: [], base };
  }
  const blob = (rev, p) => git(repoDir, ['rev-parse', '--verify', '--quiet', `${rev}:${p}`]);
  const paths = files.map((p) => ({ path: p, verdict: classifyPath(blob(base, p), blob(branch, p), blob(BASE, p)) }));
  const g = gradeMerge(paths);
  return { value: g.merged, paths, unmerged: g.unmerged, moved: g.moved, base, note: mergeNote(g, files.length, BASE) };
}

/** The merged gate's sentence. Named paths, never a bare verdict: "no" has to say which files. */
function mergeNote(g, total, BASE) {
  if (g.merged === 'yes') return `all ${total} touched path(s) are byte-identical on ${BASE}`;
  if (g.merged === 'skip')
    return `SKIP: ${total} touched path(s) and none could be compared against ${BASE}. Nothing was measured, and a skip is not a pass.`;
  const unmerged = (g.unmerged ?? []).map((p) => p.path);
  const moved = (g.moved ?? []).map((p) => p.path);
  const more = unmerged.length - 8;
  const lead = unmerged.length
    ? `${unmerged.length} of ${total} touched path(s) are NOT on ${BASE}: ${unmerged.slice(0, 8).join(', ')}${more > 0 ? ` (+${more} more)` : ''}`
    : `all ${total} touched path(s) reached ${BASE}`;
  return lead
    + (moved.length ? `. ${moved.length} path(s) MOVED on ${BASE} after this branch touched them, which is a separate hazard — somebody else edited them: ${moved.slice(0, 4).join(', ')}` : '');
}

// ── GATE: green ───────────────────────────────────────────────────────────────────────────────
//
// A TARGET WITH NO BUILD CANNOT BE BUILT, and calling that a skip is the "gate that structurally
// cannot pass" defect: it trains everyone to ignore the column. `n/a` is a pass and means there
// was nothing to measure; `skip` is not a pass and means something went unmeasured.
//
// THE TEST IS A `build` SCRIPT, NOT A package.json. Plenty of repos have the second and not the
// first.
function gateGreen(checkoutDir, run) {
  const pkgPath = path.join(checkoutDir, 'package.json');
  let buildScript = null;
  if (fs.existsSync(pkgPath)) {
    try { buildScript = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))?.scripts?.build ?? null; } catch { buildScript = null; }
  }
  if (!buildScript)
    return { value: 'n/a', note: `${path.basename(checkoutDir)} has no \`build\` script, so there is no build to run. Recorded as N/A, not as a skip — nothing was left unmeasured.` };
  if (!fs.existsSync(path.join(checkoutDir, 'node_modules')))
    return { value: 'skip', note: `SKIP: ${checkoutDir} has no node_modules, so the build could not run. Install first (\`npm --prefix <checkout> ci\`, or open the lane with --install). A skip is not a pass.` };
  if (!run)
    return { value: 'skip', note: 'SKIP: --no-build was passed, so no build was run. A skip is not a pass.' };
  try {
    execFileSync('npm', ['run', 'build'], { cwd: checkoutDir, stdio: 'ignore', timeout: 15 * 60_000 });
    return { value: 'yes', note: 'npm run build exited 0' };
  } catch (e) {
    return { value: 'no', note: `npm run build failed: ${String(e.message).slice(0, 200)}` };
  }
}

// ── GATE: live ────────────────────────────────────────────────────────────────────────────────
//
// THE DIFFERENTIATED ONE. Everything above measures the repository; this measures the thing a
// person opens. It is entirely configuration-driven (POLICY.md's `liveness` table) and it SKIPS,
// loudly and by name, when a repo declares nothing. See lib/liveness.mjs.
//
// `gradeGates` treats `skipped` as a failure, which is the point: an unmeasured deployment cannot
// grade DONE. A repo that genuinely has no deployed surface says so with a policy row it never
// writes — the honest answer there is to leave it unconfigured and accept PARTIAL, or to point the
// row at whatever artifact does prove the ship.
async function gateLive(rp, proofOverride) {
  const config = rp.liveness
    ? { ...rp.liveness, expect: proofOverride ?? rp.liveness.expect }
    : null;
  const v = await probeLiveness({ config, repo: rp.repo });
  return { value: v.value === LIVE_SKIPPED ? 'skip' : v.value, note: v.why };
}

async function main() {
  const args = process.argv.slice(2);
  const lane = args.find((a) => !a.startsWith('--'));
  if (!lane) {
    console.error('usage: pandoras-router close <lane> [--apply] [--no-build] [--proof "<string>"]');
    process.exit(2);
  }
  const apply = has(args, '--apply');
  const noBuild = has(args, '--no-build');
  const proofOverride = arg(args, '--proof');

  const lanes = readLanes(ROOT);
  const rec = lanes.find((l) => l.lane === lane);
  if (!rec) {
    console.error(`REFUSED: no record for lane "${lane}" in _handoffs/_lanes/LANES.md. A lane id is matched exactly, never fuzzily — this close will not guess which lane you meant.`);
    process.exit(2);
  }

  const policy = loadPolicy(ROOT);
  const rp = repoPolicy(policy, rec.repo);
  if (!rp) {
    console.error(`REFUSED: "${rec.repo}" has no row in the repos table of _handoffs/_lanes/POLICY.md, so its deploy style and verification method are unknown. The close does not guess either one.`);
    process.exit(2);
  }

  const repoDir = repoDirFor(ROOT, rec.repo);
  const gitRepo = isRepo(repoDir);
  const hasOrigin = gitRepo && git(repoDir, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']) !== null;
  const BASE = hasOrigin ? 'origin/main' : 'main';
  if (hasOrigin) git(repoDir, ['fetch', '-q', 'origin']);

  // ---- merged
  const merged = gitRepo
    ? gateMerged(repoDir, rec.branch, BASE)
    : { value: 'n/a', note: `${rec.repo} is not a git repository, so there is nothing to merge.`, paths: [], base: null };

  // ---- green
  const checkoutDir = rec.worktree && rec.worktree !== '-' ? path.resolve(ROOT, rec.worktree) : repoDir;
  const green = gateGreen(checkoutDir, !noBuild);

  // ---- live
  const live = await gateLive(rp, proofOverride);

  // ---- in-scope
  //
  // The allocator proved two lanes' DECLARED scopes disjoint before letting them share a repo.
  // That proof is worth nothing if a lane can then edit outside its declaration.
  // WHICH COMMITS (DRIVER1, 2026-09-14): the merge base while it is behind the branch tip; once the
  // branch is merged that base is the tip itself and measures nothing, so the lane's own commits since
  // the base recorded at OPEN are read instead. See scopeDiffPlan in lib/close.mjs, including why a
  // plain diff from the recorded base would name a neighbour's files.
  //
  // WHICH GRADE: inScopeVerdict in lib/close.mjs, where a Touches: none lane that committed files
  // grades no with the paths named rather than n/a.
  let inScope = { value: 'n/a', note: 'this lane declared no file scope, so it held the repo alone and there is nothing to breach.' };
  const declared = rec.scope ?? [];
  if (gitRepo && !isBranchless(rec.branch) && (declared.length || rec.declaredNone)) {
    const plan = scopeDiffPlan({
      recordedBase: rec.base ?? null,
      mergeBase: merged.base,
      branchTip: git(repoDir, ['rev-parse', rec.branch]),
    });
    const listed = plan.method === 'diff'
      ? git(repoDir, ['diff', '--name-only', plan.from, rec.branch])
      : plan.method === 'walk'
        ? git(repoDir, ['log', '--no-merges', '--first-parent', '--format=', '--name-only', `${plan.from}..${rec.branch}`])
        : '';
    if (listed === null) {
      inScope = { value: 'skip', note: `SKIP: git could not list what the branch touched (${plan.note}). Nothing was measured, and a skip is not a pass.` };
    } else {
      const touched = [...new Set(listed.split('\n').filter(Boolean))];
      const v = inScopeVerdict({ touched, scope: declared, declaredNone: rec.declaredNone });
      inScope = { value: v.value, note: `${v.note} (${plan.note})` };
    }
  }

  // ---- renamed
  const vocab = loadPrefixes(ROOT);
  const key = laneKey(rec.lane);
  const bridgeFiles = fs.existsSync(BRIDGE) ? fs.readdirSync(BRIDGE).filter((f) => f.endsWith('.md')) : [];
  const laneBriefs = bridgeFiles.filter((f) => briefMatchesLaneOrKey(f, rec.lane, key));
  const liveBriefs = laneBriefs.filter((f) => classify(f, vocab).state === 'live');
  const renamed = liveBriefs.length
    ? { value: 'no', note: `the brief still carries no closed prefix, so the next dispatch will fire it again: ${liveBriefs.join(', ')}` }
    : { value: 'yes', note: laneBriefs.length ? `every brief for this lane carries a closed prefix (${laneBriefs.join(', ')})` : 'no brief for this lane is on the bridge' };

  // ---- the report, and the two gates that read it
  const reportName = rec.report && rec.report !== '-' ? rec.report : null;
  const reportPath = reportName ? path.join(BRIDGE, reportName) : null;
  let reportText = null;
  if (reportPath && fs.existsSync(reportPath)) reportText = fs.readFileSync(reportPath, 'utf8');

  const parsedFindings = reportText === null ? null : parseFindingLines(reportText);
  const findings = findingsGateVerdict(parsedFindings);

  let briefText = null;
  for (const f of laneBriefs) {
    try { briefText = fs.readFileSync(path.join(BRIDGE, f), 'utf8'); break; } catch { /* next */ }
  }
  const sideFiles = bridgeFiles
    .filter((f) => SIDE_FILE_RE.test(f))
    .map((f) => ({
      name: f,
      mtimeIso: new Date(fs.statSync(path.join(BRIDGE, f)).mtimeMs).toISOString(),
      text: safeRead(path.join(BRIDGE, f)),
    }));
  const noSideFiles = noSideFilesVerdict({
    files: sideFiles,
    // The window is [the lane's OPEN stamp, now). No stamp means no window, and the gate says so.
    window: { start: rec.opened && rec.opened !== '?' ? rec.opened : null, end: new Date().toISOString() },
    allowed: sideFileAllowed(briefText ?? ''),
    laneId: rec.lane,
    briefTitle: extractBriefTitle(briefText ?? ''),
    doneFileText: reportText,
  });

  // ---- the grade
  const graded = gradeGates({
    merged: merged.value,
    green: green.value,
    live: live.value,
    renamed: renamed.value,
    reportFree: 'n/a',
    inScope: inScope.value,
    findings: findings.value,
    noSideFiles: noSideFiles.value,
    reportStatusWord: statusWordOf(reportText),
  });

  // ---- may the close proceed, given what the report itself says
  //
  // Asked whenever the lane's report is on the bridge, whatever the gates graded, the same as the
  // private workspace close: a report with no STATUS word, a DONE with no Evidence line, or a DONE
  // beside an unanswered honesty flag stops the close before anything is written, dry run included.
  // No report yet is the normal order and refuses nothing. See closeReportRefusal in lib/close.mjs
  // for the defect this replaces (DRIVER1, 2026-09-14): the call used to omit the flag saying a
  // report was present, so none of the three could fire.
  const refusal = closeReportRefusal({ file: reportName ?? '<report>', text: reportText });
  if (refusal.note) console.log(`  ${refusal.note}`);

  // ---- print
  const rows = [
    ['merged', merged.value, merged.note],
    ['green', green.value, green.note],
    ['live', live.value, live.note],
    ['renamed', renamed.value, renamed.note],
    ['in-scope', inScope.value, inScope.note],
    ['findings', findings.value, findings.note],
    ['no-side-files', noSideFiles.value, noSideFiles.note],
  ];
  console.log(`close ${rec.lane} (${rec.repo})${apply ? '' : ' — MEASURE ONLY, nothing written'}`);
  for (const [name, value, note] of rows) console.log(`  ${name.padEnd(14)} ${String(value).padEnd(8)} ${note}`);

  const kind = classifyPartialKind({ failed: graded.failed, reportStatusWord: statusWordOf(reportText) }).kind;
  console.log(`  STATUS         ${partialStatusLabel(graded.status, kind)}`);
  if (graded.reason) console.log(`  reason         ${graded.reason}`);

  if (findings.rows?.length) {
    for (const l of ownerDecisionLines({ rows: findings.rows, report: reportName ?? '<report>' })) console.log(l);
  }

  if (!refusal.ok) {
    console.log(`  ${refusal.why}`);
    process.exit(1);
  }

  if (!apply) {
    console.log('  Nothing was written. Re-run with --apply to rename the brief and record the CLOSE.');
    return;
  }

  // ---- apply
  const renamePlan = renameOnCloseVerdict({
    failed: graded.failed,
    liveBrief: liveBriefs[0] ?? null,
    apply: true,
    reportOnBridge: Boolean(reportText),
  });
  if (renamePlan.ok && renamePlan.to) {
    fs.renameSync(path.join(BRIDGE, liveBriefs[0]), path.join(BRIDGE, renamePlan.to));
    console.log(`  renamed        ${liveBriefs[0]} -> ${renamePlan.to}`);
  } else if (renamePlan.why) {
    console.log(`  rename         ${renamePlan.why}`);
  }

  // ---- the CLOSE row and the claim release: ONE locked section (CONC1, 2026-09-14)
  //
  // Measuring can take a fifteen-minute build, and the ledger read at the top of this run is that old
  // by now. So the lane's record is re-read under the lock first: if another close recorded a CLOSE
  // for this lane while this one was measuring, this one writes nothing rather than stacking a second
  // verdict on top of a record it never read. Then the CLOSE row and the release of the lane's claim
  // land together, so no open can read a closed lane still holding its claim, or a released claim on a
  // lane with no CLOSE.
  const written = withLock(ROOT, () => {
    const now = readLanes(ROOT).find((l) => l.lane === rec.lane);
    if (!now || now.closed !== rec.closed) {
      return { refused: `REFUSED: lane ${rec.lane} was closed by another run while this one was measuring (its record now reads ${now?.status ?? 'missing'}, closed ${now?.closed ?? '-'}). Nothing was recorded and no claim was released. Re-run the close to measure against the record as it stands.` };
    }
    recordClose(ROOT, {
      lane: rec.lane,
      status: graded.status,
      merged: merged.value,
      green: green.value,
      live: live.value,
      renamed: renamed.value,
      reportFree: 'n/a',
      stamp: new Date().toISOString(),
      reason: graded.reason ?? '',
      ownerWay: '-',
      inScope: inScope.value,
      roadmap: '-',
      kind: kind ?? '-',
    });
    // The claim is keyed on the session the OPEN row recorded, the same join key lane-open wrote it
    // under. Released as commented history, never deleted; see releaseRewrite in lib/claims.mjs.
    const released = rec.session && rec.session !== '?' && fs.existsSync(claimsFile(ROOT)) ? releaseClaim(ROOT, rec.session) : [];
    return { released };
  });
  if (written.refused) {
    console.error(`  ${written.refused}`);
    process.exit(1);
  }
  console.log('  recorded       a CLOSE row in _handoffs/_lanes/LANES.md');
  if (written.released.length) {
    for (const l of written.released) console.log(`  released       the claim ${l}`);
  } else {
    console.log(`  claim          no active claim line carried ${rec.session || '(no session)'}, so there was nothing to release`);
  }
}

function safeRead(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

/** The report's own STATUS word, or null. `findStatus` reads LINES, not a blob. */
function statusWordOf(text) {
  if (!text) return null;
  return findStatus(String(text).split('\n'))?.word ?? null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // A LOCK_HELD refusal names the live holder; print that, not a stack that buries it.
  main().catch((e) => { console.error(e?.code === 'LOCK_HELD' ? e.message : String(e?.stack ?? e)); process.exit(1); });
}
