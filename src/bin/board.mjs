#!/usr/bin/env node
// @ts-check
// board.mjs — the board a dispatcher reads before firing anything: who holds a claim, which lanes
// are open, what closed recently, and which lanes were left behind with nobody running them.
//
// USAGE
//   pandoras-router board
//
// IT WRITES NOTHING. No ledger record, no claim, no file, no lock. It reads CLAIMS.md, LANES.md,
// the bridge (for whether a lane's declared report already landed) and, for each open lane, the
// filesystem and git (does its worktree exist, does its branch exist) — all reads, never writes.
// The decision logic lives in ../lib/board.mjs, which is pure and unit-tested against fixtures;
// this file's only job is to gather the world for it and print what it returns.

import fs from 'node:fs';
import path from 'node:path';
import { readClaims } from '../lib/claims.mjs';
import { readLanes, reportOnBridge } from '../lib/lanes.mjs';
import { repoDirFor, git } from '../lib/gitread.mjs';
import { buildBoard } from '../lib/board.mjs';

// THE WORKSPACE ROOT is the directory holding `_handoffs/` and your repos. Never the package's own
// install location — it comes from $PANDORAS_ROOT or the current directory, same as every other
// driver in src/bin/.
const ROOT = path.resolve(process.env.PANDORAS_ROOT || process.cwd());

/**
 * Does this lane's branch still exist? UNKNOWN answers TRUE — same reasoning lane-alloc.mjs's own
 * probe uses: a probe that cannot see must not manufacture an orphan, because freeing a slot a live
 * lane is holding is the expensive direction. Spawns git only through gitread.mjs's `git()`, which
 * runs `execFileSync` with an argument array — no shell, ever.
 *
 * @param {string} root
 * @param {{repo:string, branch?:string}} lane
 * @returns {boolean}
 */
function laneBranchExists(root, lane) {
  if (!lane.branch || lane.branch === '-') return true;
  const dir = repoDirFor(root, lane.repo);
  if (!fs.existsSync(path.join(dir, '.git'))) return true;
  return git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${lane.branch}`]) !== null;
}

/** @param {string} root @param {{worktree?:string}} lane @returns {boolean} */
function laneWorktreeExists(root, lane) {
  if (!lane.worktree || lane.worktree === '-') return true;
  return fs.existsSync(path.join(root, lane.worktree));
}

function gatherProbes(root, lanes) {
  const handoffsDir = path.join(root, '_handoffs');
  /** @type {Record<string, {reportExists:boolean, worktreeExists:boolean, branchExists:boolean}>} */
  const probes = {};
  for (const l of lanes) {
    if (l.status !== 'OPEN') continue;
    probes[l.lane] = {
      reportExists: l.report && l.report !== '-' && l.report !== '?'
        ? reportOnBridge(handoffsDir, l.report).found : false,
      worktreeExists: laneWorktreeExists(root, l),
      branchExists: laneBranchExists(root, l),
    };
  }
  return probes;
}

const hAge = (h) => (h == null ? 'age unknown' : `${h.toFixed(1)}h`);

function section(title, rows, emptyNoun, renderRow) {
  const L = [`${title} — ${rows.length}`];
  if (!rows.length) {
    L.push(`  none. An empty section is a quiet board, not a proven-clean one: ${emptyNoun}.`);
    return L;
  }
  for (const r of rows) L.push(...renderRow(r).map((l) => `  ${l}`));
  return L;
}

function render(board) {
  const L = [];
  L.push('BOARD — what is going on in this workspace right now. Reads only; writes nothing.');
  L.push(`  claims  _handoffs/_lanes/CLAIMS.md      lanes  _handoffs/_lanes/LANES.md`);
  L.push('');

  L.push(...section(
    'ACTIVE CLAIMS', board.activeClaims,
    'nobody has taken a claim in the active window right now, not proof nobody is writing',
    (c) => {
      const flags = [c.suspect ? 'SUSPECT (past adjudication threshold)' : null,
        c.sameLaneTwice ? 'SAME LANE TWICE' : null, c.weak ? 'WEAK (no session id)' : null]
        .filter(Boolean).join(', ');
      return [`${c.repo} | ${c.chat} | ${hAge(c.ageH)} | session ${c.session || '(none)'}${flags ? ` | ${flags}` : ''}`];
    },
  ));
  L.push('');

  L.push(...section(
    'OPEN LANES', board.openLanes,
    'no lane holds an OPEN record with no CLOSE right now, not proof the repo is idle',
    (l) => [`${l.lane} | ${l.repo} | branch ${l.branch} | worktree ${l.worktree} | scope ${l.scope?.length ? l.scope.join(' ') : '(none declared)'} | ${hAge(l.ageH)}`],
  ));
  L.push('');

  L.push(...section(
    'RECENT CLOSES', board.recentCloses,
    'nothing closed in the last window, not proof nothing has ever shipped',
    (c) => [`${c.lane} | ${c.status} | ${c.report}${c.unrenamed ? ' | CLOSED MORE THAN ONCE — brief likely never renamed, read it before firing again' : ''}`],
  ));
  L.push('');

  L.push(...section(
    'ORPHANED LANES', board.orphaned,
    'no open lane failed its liveness checks right now, not proof every open lane is healthy',
    (o) => [o.headline, `  close it: ${o.closeCmd}`],
  ));

  return L.join('\n');
}

function main() {
  const claims = readClaims(ROOT);
  const lanes = readLanes(ROOT);
  const probes = gatherProbes(ROOT, lanes);
  const board = buildBoard({ claims: claims.rows, lanes, probes, now: Date.now() });
  console.log(render(board));
  process.exit(0);
}

main();
