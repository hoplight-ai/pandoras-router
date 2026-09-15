#!/usr/bin/env node
// board-test.mjs — the failing test written before src/lib/board.mjs and src/bin/board.mjs
// existed (Router BOARDCMD1). Every fixture lives under a temp directory built with
// fs.mkdtempSync; nothing here reads or writes the live bridge. No network, no secrets.
//
//   node test/board-test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');

const tests = [];
const T = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------- fixture plumbing

function tmpRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandoras-board-test-'));
  fs.mkdirSync(path.join(dir, '_handoffs', '_lanes'), { recursive: true });
  return dir;
}

function writeClaims(root, lines) {
  fs.writeFileSync(path.join(root, '_handoffs', '_lanes', 'CLAIMS.md'), `${lines.join('\n')}\n`);
}

function writeLanes(root, lines) {
  fs.writeFileSync(path.join(root, '_handoffs', '_lanes', 'LANES.md'), `${lines.join('\n')}\n`);
}

const iso = (hoursAgo) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();

// ---------------------------------------------------------------- module load (RED before it exists)

let boardLib = null;
let loadError = null;
try {
  boardLib = await import('../src/lib/board.mjs');
} catch (e) {
  loadError = String(e.message).split('\n')[0];
}

T('RED-PROOF src/lib/board.mjs exports buildBoard', () => {
  assert.equal(loadError, null, `src/lib/board.mjs did not load: ${loadError}`);
  assert.equal(typeof boardLib.buildBoard, 'function');
});

T('RED-PROOF src/bin/board.mjs exists as a driver', () => {
  assert.ok(
    fs.existsSync(path.join(REPO, 'src', 'bin', 'board.mjs')),
    'src/bin/board.mjs (new) has not been written yet',
  );
});

// Everything below needs buildBoard to exist; skip the assertions cleanly (as a single named
// FAIL) rather than throwing past every remaining test name when the module truly is missing.
const { buildBoard } = boardLib ?? {};

// ---------------------------------------------------------------- 1. one active claim, one open lane

T('a workspace with one active claim and one open lane reports exactly one of each', () => {
  if (!buildBoard) throw new Error('buildBoard unavailable');
  const claims = [
    { repo: 'web', chat: 'Web CEILING1', session: 'dispatch-lane-ceiling1', stamp: iso(1), ageH: 1, stale: false, suspect: false, weak: false, malformed: false },
  ];
  const lanes = [
    {
      lane: 'ceiling1', repo: 'web', branch: 'ceiling1-a', worktree: 'web-ceiling1', scope: ['app/x'],
      session: 'dispatch-lane-ceiling1', opened: iso(1), status: 'OPEN', closed: null, report: 'done-ceiling1.md',
    },
  ];
  const board = buildBoard({ claims, lanes });
  assert.equal(board.activeClaims.length, 1);
  assert.equal(board.openLanes.length, 1);
  assert.equal(board.counts.activeClaims, 1);
  assert.equal(board.counts.openLanes, 1);
  assert.equal(board.activeClaims[0].repo, 'web');
  assert.equal(board.openLanes[0].lane, 'ceiling1');
});

// ---------------------------------------------------------------- 2. suspect threshold

T('a claim past the suspect threshold is flagged, and one inside it is not', () => {
  if (!buildBoard) throw new Error('buildBoard unavailable');
  const claims = [
    { repo: 'web', chat: 'Web A', session: 's-a', stamp: iso(1), ageH: 1, stale: false, suspect: false, weak: false, malformed: false },
    { repo: 'web', chat: 'Web B', session: 's-b', stamp: iso(8), ageH: 8, stale: false, suspect: true, weak: false, malformed: false },
  ];
  const board = buildBoard({ claims, lanes: [] });
  const fresh = board.activeClaims.find((c) => c.session === 's-a');
  const old = board.activeClaims.find((c) => c.session === 's-b');
  assert.equal(fresh.suspect, false);
  assert.equal(old.suspect, true);
});

// ---------------------------------------------------------------- 3. same lane twice

T('two claims from one lane on one repo are reported as the same lane twice', () => {
  if (!buildBoard) throw new Error('buildBoard unavailable');
  const claims = [
    { repo: 'web', chat: 'Web DUP1', session: 's-1', stamp: iso(1), ageH: 1, stale: false, suspect: false, weak: false, malformed: false },
    { repo: 'web', chat: 'Web DUP1', session: 's-2', stamp: iso(1), ageH: 1, stale: false, suspect: false, weak: false, malformed: false },
    { repo: 'web', chat: 'Web SOLO', session: 's-3', stamp: iso(1), ageH: 1, stale: false, suspect: false, weak: false, malformed: false },
  ];
  const board = buildBoard({ claims, lanes: [] });
  const dupRows = board.activeClaims.filter((c) => c.chat === 'Web DUP1');
  const soloRow = board.activeClaims.find((c) => c.chat === 'Web SOLO');
  assert.equal(dupRows.length, 2);
  assert.ok(dupRows.every((c) => c.sameLaneTwice === true), 'both rows of the duplicated lane must be flagged');
  assert.equal(soloRow.sameLaneTwice, false);
});

// ---------------------------------------------------------------- 4. OPEN+CLOSE is a close, not an open lane

T('a lane with an OPEN and a CLOSE appears under closes and not under open lanes', () => {
  if (!buildBoard) throw new Error('buildBoard unavailable');
  const lanes = [
    {
      lane: 'finished1', repo: 'web', branch: 'finished1-a', worktree: 'web-finished1', scope: ['app/y'],
      session: 'dispatch-lane-finished1', opened: iso(5),
      status: 'DONE', closed: iso(0.5), report: 'done-finished1.md', reason: '',
    },
  ];
  const board = buildBoard({ claims: [], lanes });
  assert.equal(board.openLanes.length, 0);
  assert.equal(board.recentCloses.length, 1);
  assert.equal(board.recentCloses[0].lane, 'finished1');
  assert.equal(board.recentCloses[0].status, 'DONE');
  assert.equal(board.recentCloses[0].report, 'done-finished1.md');
});

// ---------------------------------------------------------------- 5. orphaned: worktree gone

T('an open lane whose worktree directory has been removed appears as orphaned, carrying the verdict text', () => {
  if (!buildBoard) throw new Error('buildBoard unavailable');
  const lanes = [
    {
      lane: 'ghost1', repo: 'web', branch: 'ghost1-a', worktree: 'web-ghost1', scope: ['app/z'],
      session: 'dispatch-lane-ghost1', opened: iso(2), status: 'OPEN', closed: null, report: 'done-ghost1.md',
    },
  ];
  const claims = [
    { repo: 'web', chat: 'Web GHOST1', session: 'dispatch-lane-ghost1', stamp: iso(2), ageH: 2, stale: false, suspect: false, weak: false, malformed: false },
  ];
  const board = buildBoard({
    claims, lanes,
    probes: { ghost1: { reportExists: false, worktreeExists: false, branchExists: true } },
  });
  assert.equal(board.orphaned.length, 1);
  assert.equal(board.orphaned[0].lane, 'ghost1');
  assert.match(board.orphaned[0].headline, /ORPHANED/);
  assert.match(board.orphaned[0].why, /does not exist on disk/);
});

// ---------------------------------------------------------------- 6. empty workspace, driver output

T('an empty workspace prints all four empty-section sentences and exits 0', () => {
  const root = tmpRoot();
  writeClaims(root, ['# empty']);
  writeLanes(root, ['# empty']);
  const r = spawnSync(process.execPath, [path.join(REPO, 'src', 'bin', 'board.mjs')], {
    env: { ...process.env, PANDORAS_ROOT: root },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const out = r.stdout;
  assert.match(out, /quiet board/i);
  const quietCount = (out.match(/quiet board/gi) || []).length;
  assert.equal(quietCount, 4, `expected 4 empty-section sentences, saw ${quietCount}\n${out}`);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- run

let pass = 0;
const fails = [];
for (const t of tests) {
  try { t.fn(); pass++; } catch (e) { fails.push({ name: t.name, message: e.message }); }
}
for (const f of fails) console.log(`FAIL  ${f.name}\n      ${String(f.message).split('\n')[0]}`);
console.log('');
console.log(`BOARD ASSERTIONS  ${pass}/${tests.length} pass, ${fails.length} fail`);
if (fails.length) throw new Error(`board-test.mjs: ${fails.length}/${tests.length} assertion(s) failed.`);
