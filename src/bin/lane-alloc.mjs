#!/usr/bin/env node
// lane-alloc.mjs — turn the bridge into ready-to-fire lane cards.
//
// USAGE
//   pandoras-router alloc                 up to 8 cards
//   pandoras-router alloc --limit 4
//   pandoras-router alloc --as DISPATCH-A own-repo filtering (OWNED-ELSEWHERE)
//   pandoras-router alloc --strict        exit 1 on a refused prefix or a PARSE-FAIL
//   pandoras-router alloc --json          machine form
//
// WHAT IT REPLACES. A dispatch session reasoning out, in prose, per lane: which repo, which
// checkout, which branch, which port, how this repo deploys, how a deploy is proved, and what the
// report is called. Six facts, restated eight times a night, each restatement a chance to get one
// wrong. They are data. This prints the data.
//
// It writes nothing. `lane-open.mjs` acts on a card; this only produces them.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicy } from '../lib/policy.mjs';
import { loadPrefixes, classifyBridge } from '../lib/prefixes.mjs';
import { readClaims } from '../lib/claims.mjs';
import { parseBrief } from '../lib/briefs.mjs';
import { repoDirs, dirtyCount, git, repoDirFor } from '../lib/gitread.mjs';
import { readLanes, orphanVerdict } from '../lib/lanes.mjs';
import { allocate } from '../lib/alloc.mjs';
import { todayLocal, reportNameForStatus } from '../lib/naming.mjs';

// THE WORKSPACE ROOT is the directory holding `_handoffs/` and your repos. It is NEVER the
// package's own install location, so it comes from $PANDORAS_ROOT or the current directory.
const ROOT = path.resolve(process.env.PANDORAS_ROOT || process.cwd());
const HANDOFFS = path.join(ROOT, '_handoffs');

/**
 * Does this lane's branch still exist? UNKNOWN answers TRUE, deliberately.
 *
 * A probe that cannot see must not manufacture an orphan: reading "branch gone" off a repo that is
 * not there, or off a git call that failed for some unrelated reason, would free a slot a live lane
 * is holding. That is the expensive direction. An undetected orphan costs a stale queue line, which
 * is the state this whole verdict exists to improve on and is survivable.
 */
function laneBranchExists(root, lane) {
  if (!lane.branch || lane.branch === '-') return true;
  const dir = repoDirFor(root, lane.repo);
  if (!fs.existsSync(path.join(dir, '.git'))) return true;
  return git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${lane.branch}`]) ? true : false;
}

function arg(args, name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}

export function gather({ root = ROOT, as = null, seat = null, limit = 8, date = todayLocal() } = {}) {
  const policy = loadPolicy(root);
  const vocab = loadPrefixes(root);
  const bridge = classifyBridge(root, vocab);
  const claims = readClaims(root);

  const repos = repoDirs(root);
  const repoNames = new Set([...repos.map((r) => r.name), ...policy.repos.keys()]);
  const repoState = new Map(repos.map((r) => [r.name, { dirty: dirtyCount(r.dir), dir: r.dir }]));

  const refused = bridge.filter((b) => b.refused);
  const existingReports = new Set(bridge.map((b) => b.name));

  const briefs = [];
  const documents = [];
  for (const entry of bridge.filter((b) => b.routes === 'yes')) {
    const rec = parseBrief(path.join(HANDOFFS, entry.name), repoNames);
    if (rec) briefs.push(rec);
    else documents.push(entry.name);
  }
  const openLanes = readLanes(root);

  // ONLY `scope` PARTIALS ARE FIREABLE REMAINDERS (Gov DELTA1, 2026-09-06, step 4's other half).
  // A `partial-` file is always ROUTED as `remainder` per PREFIXES.md — that vocabulary is
  // unchanged — but a lane whose only failed gates were clerical (roadmap=no, renamed=no, an
  // unmeasured skip) has left no unfinished WORK behind, only unfinished paperwork, and printing it
  // beside a real `in-scope=no` or `live=no` remainder trains a reader to skim past both. The match
  // is by the lane's final report filename: `reportNameForStatus(rec.report, rec.status)` is the
  // same computation a close makes on its own report, so it recovers the graded name from the
  // ledger's reserved `done-` name without re-reading any file. A `partial-` file with no matching
  // lane record (hand-written, or the ledger predates this lane's OPEN row) is shown rather than
  // hidden — an unclassified remainder staying visible is the safe direction, the same argument the
  // classifier itself makes for every gate it cannot confirm.
  const kindByReport = new Map();
  for (const l of openLanes) {
    if (l.status === 'OPEN' || !l.report || l.report === '?' || l.report === '-') continue;
    kindByReport.set(reportNameForStatus(l.report, l.status), l.kind ?? null);
  }
  const hiddenClerical = [];
  const remainders = bridge
    .filter((b) => b.routes === 'remainder')
    .filter((b) => {
      const kind = kindByReport.get(b.name);
      if (kind === 'clerical') { hiddenClerical.push(b.name); return false; }
      return true;
    })
    .map((b) => remainderOf(root, b.name));

  // ORPHAN DETECTION lives HERE, not in alloc.mjs. The predicate is pure and unit-tested; the three
  // probes it needs (does the report exist, does the worktree exist, does the branch exist) all
  // touch the filesystem and git, which alloc.mjs deliberately cannot do — that is the whole reason
  // that module is testable without a repo. So this reads the world and passes lane names in.
  const orphans = new Map();
  for (const lane of openLanes) {
    if (lane.status !== 'OPEN') continue;
    const v = orphanVerdict(lane, {
      reportExists: lane.report && lane.report !== '-' ? existingReports.has(lane.report) : false,
      worktreeExists: !lane.worktree || lane.worktree === '-' ? true : fs.existsSync(path.join(root, lane.worktree)),
      branchExists: laneBranchExists(root, lane),
      now: Date.now(),
    });
    if (v) orphans.set(lane.lane, v);
  }
  const orphanedLanes = new Set(orphans.keys());

  const { cards, skipped, truncated } = allocate({
    briefs, policy, claims: claims.rows, repoState, existingReports, openLanes, orphanedLanes, limit, as, seat, date,
  });
  // `seat` is carried out of gather (additively) so the render can name the caller's
  // own seat in the shelf line instead of printing a menu it has to read past. It was
  // passed IN and dropped on the way out, which is why the line first rendered the placeholder
  // even when --seat was given.
  return { policy, vocab, bridge, claims, refused, briefs, documents, remainders, hiddenClerical, cards, skipped, truncated, repoState, openLanes, orphans, as, seat };
}

function remainderOf(root, name) {
  const text = fs.readFileSync(path.join(root, '_handoffs', name), 'utf8');
  const hints = text
    .split('\n')
    .filter((l) => /(remain|not done|unfinished|did not|still open|NOT BUILT|out of scope|deferred)/i.test(l))
    .map((l) => l.trim().replace(/^[-*>\s]+/, ''))
    .filter((l) => l.length > 20)
    .slice(0, 3);
  return { name, hints };
}

function render(r) {
  const L = [];
  L.push('LANE ALLOCATOR — ready-to-fire cards. Every field below is read from a file, not reasoned out.');
  L.push('  policy   _handoffs/_lanes/POLICY.md      prefixes  _handoffs/_lanes/PREFIXES.md');
  L.push('  claims   _handoffs/_lanes/CLAIMS.md      ledger    _handoffs/_lanes/LANES.md');
  L.push('');

  if (r.refused.length) {
    L.push('REFUSED FILENAMES — an unrecognized lifecycle word routes NOTHING. Never defaulted to live.');
    for (const b of r.refused) L.push(`  ${b.name}\n      ${b.reason}${b.meant ? `\n      did you mean: ${b.meant}` : ''}`);
    L.push('');
  }

  // ORPHANED lanes go ABOVE the cards, because they change what the cards mean: a slot the reader
  // would otherwise think was held has already been freed, and somebody still has to close the lane
  // properly. Deliberately NOT auto-closed — a CLOSE line carries seven gate results and writing one
  // here would manufacture measurements nobody took.
  if (r.orphans?.size) {
    L.push(`ORPHANED LANES — ${r.orphans.size}. An OPEN record with no CLOSE, on a lane that cannot still be running.`);
    L.push('  Flagged, never blocking — the same handling as STALE-CLAIM, for the same reason.');
    L.push('  The slot is FREED. The work state is UNKNOWN: this says nothing about whether the lane finished.');
    for (const [lane, v] of r.orphans) {
      L.push(`  ${lane}`);
      L.push(`      ${v.headline}`);
      L.push(`      close it properly (this runs the real gates): ${v.closeCmd}`);
    }
    L.push('');
  }

  const fireNow = r.cards.filter((c) => !c.firesAfter);
  const queued = r.cards.filter((c) => c.firesAfter);
  L.push(`CARDS — ${fireNow.length} may fire now, ${queued.length} queued behind another lane.`);
  L.push('  ORDER IS A QUEUE, NOT A RANKING. Inside a tier: `Priority:` from the brief, else `Filed:`,');
  L.push('  else the file\'s mtime. Each card says which rule applied. `mtime` means nobody stated an');
  L.push('  order and the list is last-touched time — read the briefs, do not trust the sequence.');
  L.push('');
  for (const c of r.cards) L.push(card(c));

  if (r.skipped.length) {
    L.push('NOT CARDED');
    for (const s of r.skipped) L.push(`  ${s.why.padEnd(16)} ${s.brief.file}\n      ${s.detail}`);
    L.push('');
  }

  // A truncated queue must say so. Without this, a dispatch whose repos all sit past the limit
  // reads the board as empty and stops, which is exactly what happened to ops on 2026-08-20.
  if (r.truncated?.length) {
    L.push(`TRUNCATED — ${r.truncated.length} live brief(s) were NOT carded because the card limit was reached.`);
    L.push('  This is a display cap, not a judgement about the work. Re-run with --limit 99 to see them all.');
    const byRepo = new Map();
    for (const t of r.truncated) {
      const k = t.targets?.[0] ?? '(no target)';
      byRepo.set(k, [...(byRepo.get(k) ?? []), t.file]);
    }
    for (const [repo, files] of [...byRepo.entries()].sort((a, b) => b[1].length - a[1].length)) {
      L.push(`  ${String(files.length).padStart(3)}  ${repo}`);
      for (const f of files) L.push(`         ${f}`);
    }
    L.push('');
  }

  if (r.remainders.length || r.hiddenClerical?.length) {
    L.push('REMAINDERS — `partial-` files are reports, never briefs. Do not execute their bodies.');
    L.push('  Finish the unfinished scope directly, or write it as a fresh brief. Leave the file named as it is.');
    for (const m of r.remainders) {
      L.push(`  ${m.name}`);
      for (const h of m.hints) L.push(`      ${h.slice(0, 140)}`);
    }
    // A PARTIAL classified `clerical` (roadmap=no, renamed=no, an
    // unmeasured skip — nothing confirmed wrong with the work) is not printed above as fireable
    // remainder work. Named here, never silently dropped, so a reader can still find one by hand.
    if (r.hiddenClerical?.length) {
      L.push(`  ${r.hiddenClerical.length} more filtered out as PARTIAL (clerical) — nothing confirmed unfinished, not printed as fireable work:`);
      for (const n of r.hiddenClerical) L.push(`      ${n}`);
    }
    L.push('');
  }

  L.push(
    [
      `CARDS-NOW\t${fireNow.length}`,
      `ORPHANED-LANES\t${r.orphans?.size ?? 0}`,
      `CARDS-QUEUED\t${queued.length}`,
      // A per-card UNDECLARED note is read by the lane that gets the card. This count is for whoever
      // is looking at a full queue wondering why nothing fires — on 2026-08-24 the answer was that
      // 4 of 8 briefs declared no scope, and no cap raise or extra dispatch chat would have helped.
      `CARDS-UNDECLARED\t${r.cards.filter((c) => !c.scopeDeclared).length}`,
      // Finished work still wearing a live filename. A number that should trend to zero: every one
      // of these is a brief somebody has to rename, and every one is a card a dispatch would
      // otherwise have re-fired.
      `CARDS-CLOSED-UNRENAMED\t${r.cards.filter((c) => c.closedBefore && !c.standingRefire).length}`,
      `LIVE-BRIEFS\t${r.briefs.length}`,
      `SKIPPED\t${r.skipped.length}`,
      `TRUNCATED\t${r.truncated?.length ?? 0}`,
      `REFUSED-PREFIX\t${r.refused.length}`,
      `REMAINDERS\t${r.remainders.length}`,
      `REMAINDERS-HIDDEN-CLERICAL\t${r.hiddenClerical?.length ?? 0}`,
      `DOCUMENTS\t${r.documents.length}`,
    ].join('\n'),
  );
  return L.join('\n');
}

function card(c) {
  const L = [];
  L.push(`  ┌─ ${c.lane}   [tier ${c.tier}]  ${c.firesAfter ? `QUEUED — fires after ${c.firesAfter}` : 'FIRE NOW'}`);
  L.push(`  │  brief     ${c.brief}`);
  L.push(`  │  repo      ${c.repo}`);
  L.push(`  │  checkout  ${c.checkout}          (git worktree; lane-open creates it)`);
  L.push(`  │  branch    ${c.branch}`);
  L.push(`  │  claim     ${c.repo} | <chat title> | <ISO now> | ${c.session}`);
  L.push(`  │  report    ${c.report}${c.reportTaken ? '   <- the plain name is TAKEN; this is the -N variant' : ''}`);
  L.push(`  │  port      ${c.port ?? '(no dev server)'}`);
  // WHICH RULE PUT THIS CARD WHERE IT IS. `mtime` is the weak answer and it says so in those words,
  // so the weakness is visible at the point of use rather than found out a month later by a
  // dispatcher who trusted the order.
  L.push(`  │  order     ${c.order}`);
  // MODEL, 2026-08-24. Every brief already carried a `Model:` line and nothing read it, so which
  // model ran a lane was whatever the person firing it happened to pick. An unrecognised name is
  // named as unrecognised and NEVER guessed — running the wrong model silently is worse.
  if (c.model) {
    L.push(c.modelId
      ? `  │  model     ${c.model}  →  ${c.modelId}`
      : `  │  model     ${c.model}  →  UNRECOGNISED, not guessed. Fix the brief's Model: line or pick deliberately.`);
  } else {
    L.push('  │  model     (brief names none — dispatcher\'s choice, and say which you used)');
  }
  L.push(`  │  deploy    ${deployLine(c.deploy)}`);
  L.push(`  │  verify    ${verifyLine(c)}`);
  L.push(
    c.scopeDeclared && c.scope.length === 0
      ? '  │  scope     none — declared `Touches: none`, so this lane writes no repo file, holds no writer slot, and serializes against nobody. Gate 7 fails its close on ANY touched path.'
      : `  │  scope     ${c.scope.join(', ')}${c.scopeDeclared ? '' : '   <- UNDECLARED: no `Touches:` line, so the scope is the whole repo and this lane serializes'}`,
  );
  // THE CLOSE-LEDGER CROSS-CHECK IS PRINTED IN BOTH DIRECTIONS. When it blocks, the same sentence is
  // already in the QUEUED line at the top of the card and this adds the report filename. When a
  // `Standing:` line exempts the brief, this is the ONLY place the reader learns the check ran and
  // was overridden on purpose — silence there would look identical to the check not existing.
  if (c.closedBefore) {
    L.push(c.standingRefire
      ? `  │  closed    lane ${c.closedBefore.lane} closed ${String(c.closedBefore.closed).slice(0, 10)} (${c.closedBefore.status}) — FIRES ANYWAY: this brief declares \`Standing: refire-until-passed\`. Report: ${c.closedBefore.report}`
      : `  │  closed    ${c.closedBefore.headline}`);
  }
  if (c.dirtyMain) L.push(`  │  note      main checkout has ${c.dirtyMain} dirty file(s) — the lane works in its own worktree, so this is a caution, not a block`);
  if (c.runsBeside) L.push(`  │  author    runs beside: ${c.runsBeside.slice(0, 110)}`);
  for (const t of c.traps) L.push(`  │  TRAP      ${t}`);
  L.push('  └─');
  return L.join('\n');
}

function deployLine(d) {
  if (d === 'push') return 'git push origin main deploys. Push OR CLI-deploy, never both (alias race).';
  if (d === 'push+fns') return 'run the functions deploy FIRST (serverless functions do not ship on a push), then git push origin main; check the repo\'s own deploy notes before deploying. Never both push and CLI.';
  if (d === 'cli') return 'push does NOT deploy — run the repo\'s own deploy command. Drain the queue, deploy once.';
  return 'nothing deploys from this repo.';
}

function verifyLine(c) {
  const v = c.verify;
  if (v.kind === 'sha') return `GET ${c.url}${v.path} and require JSON field "${v.field}" === the sha you pushed. This is the only proof that cannot pass on stale bytes.`;
  if (v.kind === 'string') return `supply a proof string with --proof; lane-close REFUSES it unless it is new in this branch's own diff. ${c.url ?? '(no url in policy)'}`;
  if (v.kind === 'script') return `npm run ${v.name}`;
  return 'no deployed surface — the live gate is N/A, and lane-close records it as such rather than as a pass.';
}

function main() {
  const args = process.argv.slice(2);
  const known = ['--limit', '--as', '--seat', '--strict', '--json'];
  const bad = args.filter((a) => a.startsWith('--') && !known.includes(a));
  if (bad.length) {
    console.error(`usage: pandoras-router alloc [--limit N] [--as NAME] [--seat SEAT] [--strict] [--json]  (unknown: ${bad.join(', ')})`);
    process.exit(2);
  }
  const r = gather({ as: arg(args, '--as', null), seat: arg(args, '--seat', null), limit: Number(arg(args, '--limit', 8)) });
  if (args.includes('--json')) console.log(JSON.stringify({ cards: r.cards, skipped: r.skipped.map((s) => ({ ...s, brief: s.brief.file })), refused: r.refused }, null, 2));
  else console.log(render(r));
  const fail = r.refused.length + r.skipped.filter((s) => s.why === 'PARSE-FAIL' || s.why === 'NO-POLICY').length;
  process.exit(args.includes('--strict') && fail ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
