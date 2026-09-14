#!/usr/bin/env node
// @ts-check
// lane-land.mjs — land a lane on main as ONE merge commit, and write the LAND record.
//
//   pandoras-router land <lane>             merge, record, print the push/deploy step
//   pandoras-router land <lane> --push      also push main (deploys on `push` repos)
//   pandoras-router land <lane> --dry-run   print the plan and the message, change nothing
//   pandoras-router land <lane> --record <merge sha>
//                                                   the lane was merged by hand already; write the
//                                                   LAND record for that merge without merging again
//
// WHAT IT GUARANTEES, and why each part is there (see lib/land.mjs):
//   - ONE merge commit per lane (--no-ff, always). That commit's second parent is the lane's tip
//     forever, on every clone, so "what did this lane touch" is `git show --stat <merge>` and
//     undoing it is `git revert -m 1 <merge>`.
//   - The message is the audit card: lane, brief, report, branch @ tip, scope, the revert command.
//   - A LAND record in LANES.md: lane, repo, branch, tip, merge, brief, report, ISO. The close
//     reads it, so the in-scope gate walks from the recorded tip instead of reconstructing the
//     boundary from parent order or reflogs.
//   - THE BRANCH IS NEVER MOVED. No fast-forward after the merge, ever. The branch tip is the record.
//   - Refusals, not prompts: branchless lane, checkout not on main, dirty main, already contained,
//     does not contain origin/main (fresh-base rule). Each refusal says what to do.
//
// What it does NOT do: deploy serverless functions (a repo whose deploy style is `push+fns` makes
// that the lane's own step, BEFORE the push), or push unless asked. It prints the next command.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLanes, append } from '../lib/lanes.mjs';
import { git, repoDirFor, isRepo, headSha, branchOf, dirtyCount } from '../lib/gitread.mjs';
import { loadPolicy, repoPolicy } from '../lib/policy.mjs';
import { loadPrefixes, classify } from '../lib/prefixes.mjs';
import { briefMatchesLane, isBranchless } from '../lib/close.mjs';
import { landMessage, landRefusal } from '../lib/land.mjs';

// THE WORKSPACE ROOT is the directory holding `_handoffs/` and your repos. It is NEVER the
// package's own install location, so it comes from $PANDORAS_ROOT or the current directory.
const ROOT = path.resolve(process.env.PANDORAS_ROOT || process.cwd());

function arg(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

function findBrief(lane, vocab) {
  const names = fs.readdirSync(path.join(ROOT, '_handoffs')).filter((f) => f.endsWith('.md') && briefMatchesLane(f, lane));
  const live = names.find((f) => classify(f, vocab).routes === 'yes');
  return live ?? names.find((f) => !/^(done|partial|blocked|parked|reconstructed)-/i.test(f)) ?? null;
}

function main() {
  const args = process.argv.slice(2);
  const lane = args.find((a) => !a.startsWith('--') && a !== arg(args, '--record'));
  const push = args.includes('--push');
  const dry = args.includes('--dry-run');
  const recordSha = arg(args, '--record');
  if (!lane) {
    console.error('usage: pandoras-router land <lane> [--push] [--dry-run] [--record <merge sha>]');
    process.exit(2);
  }

  const rec = readLanes(ROOT).find((r) => r.lane === lane);
  if (!rec) {
    console.error(`REFUSED: no OPEN record for lane "${lane}" in _handoffs/_lanes/LANES.md. The router only lands lanes it opened; a lane id is matched exactly, never fuzzily.`);
    process.exit(2);
  }
  const policy = loadPolicy(ROOT);
  const pol = repoPolicy(policy, rec.repo);
  const vocab = loadPrefixes(ROOT);
  const brief = findBrief(lane, vocab);
  const report = rec.report && rec.report !== '-' ? rec.report : null;

  if (isBranchless(rec.branch)) {
    console.error(`REFUSED: ${landRefusal({ branchless: true }).why}`);
    process.exit(2);
  }
  const repoDir = repoDirFor(ROOT, rec.repo);
  if (!isRepo(repoDir)) {
    console.error(`REFUSED: ${rec.repo}'s own checkout is not a git repository at ${path.relative(ROOT, repoDir)}.`);
    process.exit(2);
  }

  // --record: the merge already happened by hand. Verify the sha is a merge that contains the
  // branch tip, then write the ledger link. Nothing else is touched.
  if (recordSha) {
    const parents = (git(repoDir, ['rev-list', '--parents', '-n1', recordSha]) ?? '').trim().split(/\s+/).filter(Boolean);
    if (parents.length < 3) {
      console.error(`REFUSED: ${recordSha} is not a merge commit (${Math.max(0, parents.length - 1)} parent(s)). A LAND record points at the ONE merge that landed the lane; a fast-forward has no such commit and the ledger must not pretend it does.`);
      process.exit(2);
    }
    const tip = parents[2];
    const line = append(ROOT, ['LAND', lane, rec.repo, rec.branch, tip, parents[0], brief ?? '-', report ?? '-', new Date().toISOString()]);
    console.log(`LAND record written (by hand, --record):\n  ${line}`);
    console.log(`  revert:  git -C ${rec.repo} revert -m 1 ${parents[0].slice(0, 12)}`);
    return;
  }

  // A LOCAL-ONLY REPO HAS NO `origin/main`, AND THAT IS NOT THE SAME AS BEING BEHIND ONE.
  // Every ref below used to be the literal string `origin/main`. `git merge-base --is-ancestor
  // origin/main <tip>` on a repo with no remote does not answer "no", it ERRORS, the helper returns
  // null, and the fresh-base check reads that as "the branch does not contain main" — so the lane is
  // refused forever with an instruction (`git merge origin/main`) that also cannot run. Measured
  // on a deliberately remote-less repo — one holding records that must never be pushed anywhere —
  // whose lanes could be opened and never landed. `lane-open.mjs` already resolves the base this
  // way. The remote path is unchanged in every respect when a remote exists.
  const hasOrigin = git(repoDir, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']) !== null;
  const BASE = hasOrigin ? 'origin/main' : 'main';
  if (hasOrigin) git(repoDir, ['fetch', '-q', 'origin']);
  const onMain = branchOf(repoDir) === 'main';
  const dirty = dirtyCount(repoDir);
  const tip = git(repoDir, ['rev-parse', rec.branch]);
  if (!tip) {
    console.error(`REFUSED: branch ${rec.branch} does not exist in ${rec.repo}. Nothing to land; if it was deleted after a hand merge, use --record <merge sha>.`);
    process.exit(2);
  }
  const alreadyContained = git(repoDir, ['merge-base', '--is-ancestor', tip, 'main']) !== null;
  const containsMain = git(repoDir, ['merge-base', '--is-ancestor', BASE, tip]) !== null;
  const refusal = landRefusal({ branchless: false, onMain, dirty, alreadyContained, containsMain, repo: rec.repo, branch: rec.branch, worktree: rec.worktree, base: BASE });
  if (!refusal.ok) {
    console.error(`REFUSED: ${refusal.why}`);
    process.exit(2);
  }

  // Local main may sit behind origin/main; bring it level first so the merge lands on the real head.
  // ff-only: if local main has unpushed commits of its own, that is a finding, not something to merge over.
  const localMain = headSha(repoDir);
  const originMain = git(repoDir, ['rev-parse', BASE]);
  if (localMain !== originMain) {
    const behind = git(repoDir, ['merge-base', '--is-ancestor', 'main', BASE]) !== null;
    if (!behind) {
      console.error(`REFUSED: ${rec.repo}'s local main (${localMain.slice(0, 8)}) is not an ancestor of ${BASE} (${originMain.slice(0, 8)}) — it carries unpushed commits of its own. Push or reconcile them first; a landing must sit on the head everyone else sees.`);
      process.exit(2);
    }
  }

  const message = landMessage({ repo: rec.repo, lane, brief, report, branch: rec.branch, tip, scope: rec.scope });
  console.log(`lane-land — ${lane}   (${rec.repo}, branch ${rec.branch} @ ${tip.slice(0, 8)})`);
  console.log(`  brief    ${brief ?? '(none found on the bridge)'}`);
  console.log(`  report   ${report ?? '(none named)'}`);
  console.log(`  deploy   ${pol ? pol.deploy : '(repo not in POLICY)'}`);
  if (!hasOrigin) console.log('  remote   none — this repo is local-only, so the fresh-base check reads local main and nothing is pushed');
  if (localMain !== originMain) console.log(`  main     local ${localMain.slice(0, 8)} is behind ${BASE} ${originMain.slice(0, 8)}; fast-forwarding local main first (main only, never the branch)`);
  console.log('  message:');
  for (const l of message.split('\n')) console.log(`    ${l}`);
  if (dry) {
    console.log('\n  (dry run — nothing merged, nothing recorded, nothing pushed)');
    return;
  }

  if (localMain !== originMain) {
    const ff = git(repoDir, ['merge', '--ff-only', BASE]);
    if (ff === null) {
      console.error(`REFUSED: could not fast-forward local main onto ${BASE}. Nothing merged.`);
      process.exit(1);
    }
  }
  const merged = git(repoDir, ['merge', '--no-ff', '--no-edit', '-m', message, rec.branch]);
  if (merged === null) {
    git(repoDir, ['merge', '--abort']);
    console.error(`MERGE FAILED and was aborted; ${rec.repo}'s main is back where it was. A conflict here means the lane did not bring main in cleanly — resolve it IN THE LANE WORKTREE (git -C ${rec.worktree} merge ${BASE}), build green there, then land again.`);
    process.exit(1);
  }
  const mergeSha = headSha(repoDir);
  const line = append(ROOT, ['LAND', lane, rec.repo, rec.branch, tip, mergeSha, brief ?? '-', report ?? '-', new Date().toISOString()]);
  console.log(`\n  merged as ${mergeSha.slice(0, 12)} (merge commit; the branch ${rec.branch} was NOT moved and still points at ${tip.slice(0, 8)})`);
  console.log(`  LAND record written:\n    ${line}`);
  console.log(`  revert:  git -C ${rec.repo} revert -m 1 ${mergeSha.slice(0, 12)}`);

  const deploy = pol?.deploy ?? 'unknown';
  if (deploy === 'push+fns') console.log(`  DEPLOY NOTE: ${rec.repo} ships serverless functions separately — run the functions deploy FIRST, then push; check the repo's own deploy notes before deploying.`);
  if (push && !hasOrigin) {
    console.log('  not pushed: this repo has no remote, and creating one is not a landing\'s call.');
  } else if (push) {
    const pushed = git(repoDir, ['push', 'origin', 'main']);
    if (pushed === null) {
      console.error(`  PUSH FAILED. The merge and the LAND record stand; push by hand: git -C ${rec.repo} push origin main`);
      process.exit(1);
    }
    console.log(`  pushed origin/main → ${mergeSha.slice(0, 12)}${deploy.startsWith('push') ? ' (this is the deploy on a push repo)' : ''}`);
  } else {
    console.log(hasOrigin
      ? `  not pushed. Next: git -C ${rec.repo} push origin main${deploy.startsWith('push') ? '   (this is the deploy)' : ''}`
      : `  not pushed: ${rec.repo} has no remote. Nothing leaves this machine.${deploy === 'cli' ? ' Deploy is the repo\'s own CLI script, never a push.' : ''}`);
  }
}

main();
