// revert-test.mjs — `pandoras-router revert <lane>`.
//
// Covers, in order: the four pure ledger refusals in lib/revert.mjs (no lane, no LAND record, more
// than one LAND record, already reverted); the two repository-state refusals (not on main, dirty
// tree); the merge-shape refusal (the named commit is not a real merge); a real merge in a
// throwaway git repository actually reverted, with the file back to its earlier content and the
// lane branch untouched; the spawn asserted to be an argument array with shell:false, via a fake
// spawnSync exactly the way the build gate's own suite does it (see build-gate-test.mjs); a REVERT
// record round-tripping through parseLanes; an old-shaped ledger with no REVERT record parsing
// unchanged; a second revert of the same lane refused; and --dry-run spawning nothing and writing
// nothing.
//
// Every fixture is a fresh directory under os.tmpdir(), torn down after its own test. This
// repository's own git state is never touched.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let lib, bin, lanes, loadError;
try {
  lib = await import('../src/lib/revert.mjs');
  bin = await import('../src/bin/revert.mjs');
  lanes = await import('../src/lib/lanes.mjs');
} catch (e) {
  loadError = String(e.message).split('\n')[0];
}

const tests = [];
const T = (name, fn) => tests.push({ name, fn });
const ISO = '2026-09-15T09:40:03.000Z';
const HEADER = '# LANES fixture for revert-test.mjs';

function sh(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, ['init', '-q', '-b', 'main']);
  sh(dir, ['config', 'user.name', 'Revert Test']);
  sh(dir, ['config', 'user.email', 'revert-test@example.com']);
}

/**
 * A repo shaped exactly like one `router land` just landed: main has file.txt = 'before', a lane
 * branch changed it to 'after' and was merged into main with --no-ff. Returns the lane branch's
 * tip and the merge sha, and leaves the repo checked out on main, clean.
 */
function landedRepo(dir) {
  initRepo(dir);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'before\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-q', '-m', 'base']);
  sh(dir, ['checkout', '-q', '-b', 'lane-branch']);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'after\n');
  sh(dir, ['commit', '-aq', '-m', 'lane change']);
  const tip = sh(dir, ['rev-parse', 'HEAD']);
  sh(dir, ['checkout', '-q', 'main']);
  sh(dir, ['merge', '-q', '--no-ff', '--no-edit', '-m', 'merge lane-branch', 'lane-branch']);
  const merge = sh(dir, ['rev-parse', 'HEAD']);
  return { tip, merge };
}

function makeWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pandoras-revert-'));
  fs.mkdirSync(path.join(ws, '_handoffs', '_lanes'), { recursive: true });
  return ws;
}

function writeLedger(ws, lines) {
  fs.writeFileSync(path.join(ws, '_handoffs', '_lanes', 'LANES.md'), `${lines.join('\n')}\n`);
}

function landLines(lane, repo, branch, tip, merge) {
  return [
    HEADER,
    `OPEN | ${lane} | ${repo} | ${branch} | - | - | - | . | test | ${ISO} | -`,
    `LAND | ${lane} | ${repo} | ${branch} | ${tip} | ${merge} | - | - | ${ISO}`,
  ];
}

function cleanup(ws) {
  fs.rmSync(ws, { recursive: true, force: true });
}

// ---------------------------------------------------------------- the four pure ledger refusals

T('planRevert refuses a lane that does not appear in the ledger at all', () => {
  const r = lib.planRevert('ghost1', []);
  assert.equal(r.ok, false);
  assert.match(r.why, /ghost1/);
  assert.match(r.why, /ledger/i);
});

T('planRevert refuses a lane with no LAND record: it never landed, nothing to reverse', () => {
  const r = lib.planRevert('demo1', [{ lane: 'demo1', repo: 'demo', branch: 'b', land: null, landCount: 0 }]);
  assert.equal(r.ok, false);
  assert.match(r.why, /no LAND record/i);
});

T('planRevert refuses a lane with more than one LAND record: a person decides which', () => {
  const r = lib.planRevert('demo1', [
    { lane: 'demo1', repo: 'demo', branch: 'b', land: { merge: 'm1', tip: 't1', brief: null, report: null, at: ISO }, landCount: 2, revert: null },
  ]);
  assert.equal(r.ok, false);
  assert.match(r.why, /more than one|2 LAND records/i);
});

T('planRevert refuses a lane already reverted, naming when', () => {
  const r = lib.planRevert('demo1', [
    { lane: 'demo1', repo: 'demo', branch: 'b', land: { merge: 'm1', tip: 't1', brief: null, report: null, at: ISO }, landCount: 1, revert: { merge: 'm1', commit: 'r1', who: 'someone', at: '2026-09-14T00:00:00.000Z' } },
  ]);
  assert.equal(r.ok, false);
  assert.match(r.why, /2026-09-14T00:00:00\.000Z/);
});

T('planRevert accepts a lane with exactly one LAND record and no REVERT record', () => {
  const r = lib.planRevert('demo1', [
    { lane: 'demo1', repo: 'demo', branch: 'lane-branch', land: { merge: 'm1', tip: 't1', brief: 'b.md', report: 'r.md', at: ISO }, landCount: 1, revert: null },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.merge, 'm1');
  assert.equal(r.tip, 't1');
  assert.equal(r.repo, 'demo');
  assert.equal(r.branch, 'lane-branch');
});

// ---------------------------------------------------------------- the two repository-state refusals

T('repoStateRefusal refuses when the checkout is not on main', () => {
  const r = lib.repoStateRefusal({ onMain: false, dirty: 0, repo: 'demo' });
  assert.equal(r.ok, false);
  assert.match(r.why, /not on main/);
});

T('repoStateRefusal refuses when the main checkout is dirty', () => {
  const r = lib.repoStateRefusal({ onMain: true, dirty: 3, repo: 'demo' });
  assert.equal(r.ok, false);
  assert.match(r.why, /3 uncommitted change/);
});

T('repoStateRefusal passes a clean checkout on main', () => {
  const r = lib.repoStateRefusal({ onMain: true, dirty: 0, repo: 'demo' });
  assert.equal(r.ok, true);
});

// ---------------------------------------------------------------- the merge-shape refusal

T('mergeShapeRefusal refuses a commit with fewer than two parents', () => {
  const r = lib.mergeShapeRefusal({ merge: 'abc123', parentCount: 1 });
  assert.equal(r.ok, false);
  assert.match(r.why, /not a merge commit/);
});

T('mergeShapeRefusal passes a real two-parent merge', () => {
  const r = lib.mergeShapeRefusal({ merge: 'abc123', parentCount: 2 });
  assert.equal(r.ok, true);
});

// ---------------------------------------------------------------- runRevert end to end

T('runRevert: a real merge in a throwaway repo is reverted, the file goes back, the branch does not move', () => {
  if (loadError) throw new Error(loadError);
  const ws = makeWorkspace();
  const dir = path.join(ws, 'demo');
  const { tip, merge } = landedRepo(dir);
  writeLedger(ws, landLines('demo1', 'demo', 'lane-branch', tip, merge));

  const r = bin.runRevert({ root: ws, lane: 'demo1', who: 'tester' });
  assert.equal(r.ok, true, r.why);
  assert.equal(fs.readFileSync(path.join(dir, 'file.txt'), 'utf8'), 'before\n');
  assert.equal(sh(dir, ['rev-parse', 'lane-branch']), tip, 'the lane branch tip must not move');
  assert.equal(sh(dir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
  assert.equal(sh(dir, ['status', '--porcelain']), '', 'main must be clean after a successful revert');
  const newHead = sh(dir, ['rev-parse', 'HEAD']);
  assert.notEqual(newHead, merge, 'the revert must produce a NEW commit on main, never rewrite the merge');

  cleanup(ws);
});

T('runRevert: the spawn receives an argument array with shell:false, never a string', () => {
  if (loadError) throw new Error(loadError);
  const ws = makeWorkspace();
  const dir = path.join(ws, 'demo');
  const { tip, merge } = landedRepo(dir);
  writeLedger(ws, landLines('demo1', 'demo', 'lane-branch', tip, merge));

  /** @type {{cmd:string, args:string[], opts:any}|null} */
  let call = null;
  const fakeSpawnSync = (cmd, args, opts) => {
    call = { cmd, args, opts };
    return { status: 0, stdout: '', stderr: '', error: null };
  };
  const r = bin.runRevert({ root: ws, lane: 'demo1', who: 'tester', spawnSync: fakeSpawnSync });
  assert.equal(r.ok, true, r.why);
  assert.ok(call, 'spawnSync was never called');
  assert.equal(call.cmd, 'git');
  assert.deepEqual(call.args, ['-C', dir, 'revert', '-m', '1', merge]);
  assert.equal(call.opts.shell, false, 'shell must be explicitly false, never omitted');
  assert.ok(Array.isArray(call.args), 'args must be an array, never a pre-joined string');

  cleanup(ws);
});

T('runRevert: a LAND record pointing at a non-merge commit is refused before anything is spawned', () => {
  if (loadError) throw new Error(loadError);
  const ws = makeWorkspace();
  const dir = path.join(ws, 'demo');
  initRepo(dir);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'only\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-q', '-m', 'one commit, no merge']);
  const single = sh(dir, ['rev-parse', 'HEAD']);
  writeLedger(ws, landLines('demo1', 'demo', 'main', single, single));

  let called = false;
  const r = bin.runRevert({ root: ws, lane: 'demo1', spawnSync: () => { called = true; return { status: 0 }; } });
  assert.equal(r.ok, false);
  assert.match(r.why, /not a merge commit/);
  assert.equal(called, false, 'must not spawn a revert on a commit that is not a real merge');

  cleanup(ws);
});

T('runRevert: refused when the checkout is not on main, nothing spawned', () => {
  if (loadError) throw new Error(loadError);
  const ws = makeWorkspace();
  const dir = path.join(ws, 'demo');
  const { tip, merge } = landedRepo(dir);
  sh(dir, ['checkout', '-q', 'lane-branch']);
  writeLedger(ws, landLines('demo1', 'demo', 'lane-branch', tip, merge));

  let called = false;
  const r = bin.runRevert({ root: ws, lane: 'demo1', spawnSync: () => { called = true; return { status: 0 }; } });
  assert.equal(r.ok, false);
  assert.match(r.why, /not on main/);
  assert.equal(called, false);

  cleanup(ws);
});

T('runRevert: refused when the main checkout is dirty, nothing spawned', () => {
  if (loadError) throw new Error(loadError);
  const ws = makeWorkspace();
  const dir = path.join(ws, 'demo');
  const { tip, merge } = landedRepo(dir);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'dirty edit\n');
  writeLedger(ws, landLines('demo1', 'demo', 'lane-branch', tip, merge));

  let called = false;
  const r = bin.runRevert({ root: ws, lane: 'demo1', spawnSync: () => { called = true; return { status: 0 }; } });
  assert.equal(r.ok, false);
  assert.match(r.why, /uncommitted change/);
  assert.equal(called, false);

  cleanup(ws);
});

T('runRevert: a REVERT record round-trips through parseLanes and folds onto the lane', () => {
  if (loadError) throw new Error(loadError);
  const ws = makeWorkspace();
  const dir = path.join(ws, 'demo');
  const { tip, merge } = landedRepo(dir);
  writeLedger(ws, landLines('demo1', 'demo', 'lane-branch', tip, merge));

  const r = bin.runRevert({ root: ws, lane: 'demo1', who: 'tester' });
  assert.equal(r.ok, true, r.why);
  const folded = lanes.readLanes(ws).find((l) => l.lane === 'demo1');
  assert.ok(folded.revert, 'the REVERT record must fold onto the lane');
  assert.equal(folded.revert.merge, merge);
  assert.equal(folded.revert.who, 'tester');
  assert.equal(folded.land.tip, tip, 'the LAND row is append-only and must still read the original tip');
  assert.equal(folded.land.merge, merge, 'the LAND row is append-only and must still read the original merge');

  cleanup(ws);
});

T('runRevert: a second revert of the same lane is refused', () => {
  if (loadError) throw new Error(loadError);
  const ws = makeWorkspace();
  const dir = path.join(ws, 'demo');
  const { tip, merge } = landedRepo(dir);
  writeLedger(ws, landLines('demo1', 'demo', 'lane-branch', tip, merge));

  const first = bin.runRevert({ root: ws, lane: 'demo1', who: 'tester' });
  assert.equal(first.ok, true, first.why);
  const second = bin.runRevert({ root: ws, lane: 'demo1', who: 'tester' });
  assert.equal(second.ok, false);
  assert.match(second.why, /already has a REVERT record/i);

  cleanup(ws);
});

T('runRevert: --dry-run spawns nothing and writes no REVERT record', () => {
  if (loadError) throw new Error(loadError);
  const ws = makeWorkspace();
  const dir = path.join(ws, 'demo');
  const { tip, merge } = landedRepo(dir);
  writeLedger(ws, landLines('demo1', 'demo', 'lane-branch', tip, merge));
  const before = fs.readFileSync(path.join(ws, '_handoffs', '_lanes', 'LANES.md'), 'utf8');

  let called = false;
  const r = bin.runRevert({ root: ws, lane: 'demo1', dryRun: true, spawnSync: () => { called = true; return { status: 0 }; } });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.dryRun, true);
  assert.equal(called, false, 'a dry run must never spawn');
  const after = fs.readFileSync(path.join(ws, '_handoffs', '_lanes', 'LANES.md'), 'utf8');
  assert.equal(after, before, 'a dry run must never write a REVERT record');
  assert.equal(fs.readFileSync(path.join(dir, 'file.txt'), 'utf8'), 'after\n', 'a dry run must never touch the repo');

  cleanup(ws);
});

// ---------------------------------------------------------------- old ledger lines still parse

T('a ledger with no REVERT record parses byte-for-byte the same as it did before this change', () => {
  const text = [
    '# LANES fixture, no REVERT rows',
    `OPEN | demo1 | demo | lane-branch | wt | 1234 | done-x.md | . | sess | ${ISO} | basesha`,
    `LAND | demo1 | demo | lane-branch | tipsha | mergesha | brief.md | done-x.md | ${ISO}`,
  ].join('\n');
  const parsed = lanes.parseLanes(text);
  assert.equal(parsed.length, 1);
  const rec = parsed[0];
  assert.equal(rec.lane, 'demo1');
  assert.equal(rec.repo, 'demo');
  assert.equal(rec.branch, 'lane-branch');
  assert.equal(rec.worktree, 'wt');
  assert.equal(rec.status, 'OPEN');
  assert.equal(rec.base, 'basesha');
  assert.equal(rec.land.tip, 'tipsha');
  assert.equal(rec.land.merge, 'mergesha');
  assert.equal(rec.land.brief, 'brief.md');
  // the fields this lane adds default sanely on a ledger that has never seen a REVERT row
  assert.equal(rec.revert, null);
});

// ---------------------------------------------------------------------------------------------

if (loadError) {
  console.log(`SUITE red: revert.mjs does not exist yet — ${loadError}`);
  throw new Error(loadError);
}

let red = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    red++;
    console.log(`  RED ${name}\n      ${String(e.message ?? e).split('\n').join('\n      ')}`);
  }
}
console.log(`revert-test.mjs: ${tests.length - red} of ${tests.length} passed`);
if (red) throw new Error(`${red} of ${tests.length} revert-test.mjs assertions red`);
