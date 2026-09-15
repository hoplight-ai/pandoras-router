#!/usr/bin/env node
// @ts-check
// revert.mjs — `pandoras-router revert <lane>`: find the merge a lane landed as, reverse it, and
// write a record saying so.
//
// WHAT THIS COMMAND NEVER DOES, said here first because a command named `revert` invites the wrong
// assumption: IT NEVER FORCE-PUSHES, AND IT NEVER DELETES A BRANCH. A revert here is a new commit on
// main that reverses a merge; history is added to, never rewritten. The lane's branch and its tip
// stay exactly where they are, because that tip is the record of what the lane wrote and reverting
// the merge does not make it untrue.
//
// It also does not push. It makes a local commit and stops, printing the one line a dispatcher runs
// next — this repository's main carries a ruleset that only takes a pull-request merge, so pushing
// is the dispatcher's act, never this command's (see README.md).
//
//   pandoras-router revert <lane>              revert the lane's LAND merge, commit, stop
//   pandoras-router revert <lane> --dry-run    print the plan, run nothing, write nothing
//
// HOW IT DECIDES WHAT TO REVERSE: see lib/revert.mjs's `planRevert`, which reads the ledger LAND
// record for the lane and refuses (naming its own fix) when the lane never landed, landed more than
// once, or was already reverted. Everything below that is repository state this file measures itself
// — read-only through lib/gitread.mjs — plus the one write: `git revert -m 1 <merge>`, spawned as an
// argument array with no shell, the same discipline `src/lib/build.mjs` uses to run npm (see
// docs/THREAT-MODEL.md).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { readLanes, recordRevert } from '../lib/lanes.mjs';
import { git, repoDirFor, isRepo, branchOf, dirtyCount } from '../lib/gitread.mjs';
import { planRevert, repoStateRefusal, mergeShapeRefusal, revertArgs } from '../lib/revert.mjs';

/**
 * The whole command, dependency-injected so a test can run it against a throwaway repository with a
 * real or a fake `spawnSync`. Production always uses the real one; only tests pass a fake.
 *
 * The result shape is uniform — `ok`, `why`, `plan`, `dryRun` and `revertCommit` are always
 * present, null (or false) when they do not apply — the same convention `lib/revert.mjs`'s
 * `planRevert` uses, and for the same reason: it narrows cleanly through `@ts-check`.
 *
 * @param {{root:string, lane:string, dryRun?:boolean, who?:string, spawnSync?:typeof nodeSpawnSync}} p
 * @returns {{ok:boolean, why:string|null, plan:object|null, dryRun:boolean, revertCommit:string|null}}
 */
export function runRevert({ root, lane, dryRun = false, who = process.env.USER || 'unknown', spawnSync = nodeSpawnSync }) {
  const refuse = (why) => ({ ok: false, why, plan: null, dryRun: false, revertCommit: null });

  const lanes = readLanes(root);
  const plan = planRevert(lane, lanes);
  if (!plan.ok) return refuse(plan.why);

  const repoDir = repoDirFor(root, plan.repo);
  if (!isRepo(repoDir)) {
    return refuse(`${plan.repo}'s own checkout is not a git repository at ${path.relative(root, repoDir)}.`);
  }

  const onMain = branchOf(repoDir) === 'main';
  const dirty = dirtyCount(repoDir) ?? 0;
  const state = repoStateRefusal({ onMain, dirty, repo: plan.repo });
  if (!state.ok) return refuse(state.why);

  // The first-parent rule only means anything on a real merge: confirm the recorded merge sha still
  // names a commit with two parents before anything writes.
  const parentsOut = git(repoDir, ['rev-list', '--parents', '-n1', plan.merge]);
  const parentCount = parentsOut ? parentsOut.trim().split(/\s+/).filter(Boolean).length - 1 : 0;
  const shape = mergeShapeRefusal({ merge: plan.merge, parentCount });
  if (!shape.ok) return refuse(shape.why);

  const args = revertArgs(plan.merge);
  console.log(`revert — lane ${plan.lane}   (${plan.repo}, reversing merge ${plan.merge.slice(0, 12)})`);
  console.log(`  brief    ${plan.brief ?? '(none recorded)'}`);
  console.log(`  report   ${plan.report ?? '(none recorded)'}`);
  console.log(`  branch   ${plan.branch} stays exactly where it is @ ${String(plan.tip).slice(0, 8)}; only main gets a new commit`);
  console.log(`  command  git -C ${plan.repo} ${args.join(' ')}   (argument array, no shell)`);
  if (dryRun) {
    console.log('\n  (dry run — nothing run, nothing recorded)');
    return { ok: true, why: null, plan, dryRun: true, revertCommit: null };
  }

  const r = spawnSync('git', ['-C', repoDir, ...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    // Best-effort abort so a conflicted revert never leaves main mid-operation; the abort is itself a
    // write, so it goes through the same injected, no-shell spawnSync as the revert it is undoing.
    spawnSync('git', ['-C', repoDir, 'revert', '--abort'], { shell: false, stdio: 'ignore' });
    const detail = (r.stderr || r.stdout || String(r.error?.message ?? '')).trim();
    console.error(`REVERT FAILED and was aborted; ${plan.repo}'s main is back where it was. Resolve the conflict by hand: git -C ${plan.repo} revert -m 1 ${plan.merge}`);
    return refuse(`revert of ${plan.merge.slice(0, 12)} in ${plan.repo} failed and was aborted; main is back where it was.${detail ? ` ${detail}` : ''} Resolve it by hand: git -C ${plan.repo} revert -m 1 ${plan.merge}`);
  }

  const revertCommit = git(repoDir, ['rev-parse', 'HEAD']);
  const line = recordRevert(root, { lane: plan.lane, repo: plan.repo, merge: plan.merge, revertCommit, who });
  console.log(`\n  reverted as ${String(revertCommit).slice(0, 12)}`);
  console.log(`  REVERT record written:\n    ${line}`);
  console.log(`  next: push the lane's own branch and open a pull request against main — this repository's main is reached through a pull-request merge, never a direct push (see README.md).`);
  return { ok: true, why: null, plan, dryRun: false, revertCommit };
}

const ROOT = path.resolve(process.env.PANDORAS_ROOT || process.cwd());

function main() {
  const args = process.argv.slice(2);
  const lane = args.find((a) => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  if (!lane) {
    console.error('usage: pandoras-router revert <lane> [--dry-run]');
    process.exit(2);
  }
  const result = runRevert({ root: ROOT, lane, dryRun });
  if (!result.ok) {
    console.error(`REFUSED: ${result.why}`);
    process.exit(2);
  }
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
