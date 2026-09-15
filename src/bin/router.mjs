#!/usr/bin/env node
// @ts-check
// router.mjs — the one front door. Everything a dispatcher needs to route lanes is a subcommand
// here, so nobody has to remember six script names or which one reads which file.
//
//   pandoras-router board      what is going on right now: claims, open lanes, recent closes,
//                              orphaned lanes. Reads only, writes nothing
//   pandoras-router alloc      ready-to-fire lane cards
//   pandoras-router open       open a lane from a card   (creates only)
//   pandoras-router close      the gate close            (measures; --apply to record)
//   pandoras-router land       land a lane on main as ONE merge commit + a LAND record
//                              (the audit link: change on main -> lane -> brief -> report;
//                              revert is `git revert -m 1 <merge>`; the branch never moves)
//   pandoras-router claim      take/release a claim WITHOUT a lane, for direct work
//   pandoras-router apply      apply a unified diff atomically, by index
//   pandoras-router check      validate the workspace before anything fires (reads only, writes nothing)
//
// Arguments after the subcommand pass straight through, so `pandoras-router alloc --limit 4` and
// running `lane-alloc.mjs --limit 4` directly are the same run.
//
// WHERE IT READS FROM. Every driver resolves the WORKSPACE root — the directory holding
// `_handoffs/` and your repos — from `$PANDORAS_ROOT`, falling back to the current directory.
// The package's own install location is never the workspace root.

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const MAP = {
  board: ['board.mjs'],
  alloc: ['lane-alloc.mjs'],
  open: ['lane-open.mjs'],
  close: ['close.mjs'],
  land: ['lane-land.mjs'],
  claim: ['claim.mjs'],
  apply: ['apply-atomic.mjs'],
  check: ['check.mjs'],
};

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || !MAP[cmd]) {
  console.error(`usage: pandoras-router <${Object.keys(MAP).join('|')}> [args]`);
  process.exit(cmd ? 2 : 0);
}
const [script, ...fixed] = MAP[cmd];
const r = spawnSync(process.execPath, [path.join(HERE, script), ...fixed, ...rest], { stdio: 'inherit' });
process.exit(r.status ?? 1);
