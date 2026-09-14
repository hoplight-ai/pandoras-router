#!/usr/bin/env node
// @ts-check
// lane-open.mjs — open a lane from an allocator card. CREATES ONLY. Deletes nothing, ever.
//
// USAGE
//   pandoras-router open <brief-filename> --chat "Web ALPHA1"
//   pandoras-router open <brief-filename> --chat "..." --dry-run
//   pandoras-router open <brief-filename> --chat "..." --queued     open anyway, see below
//   pandoras-router open <brief-filename> --chat "..." --install    npm ci in the new checkout
//
// WHAT IT DOES, IN ORDER, STOPPING AT THE FIRST REFUSAL
//   1. Re-runs the allocator and finds this brief's card. No card, no lane.
//   2. Refuses a card the allocator queued behind another lane. `--queued` overrides that and the
//      override is recorded in the ledger, because "I decided to run it anyway" is a decision
//      someone should be able to find later.
//   3. TAKES THE STATE LOCK, and holds it through step 7 (CONC1, 2026-09-14). Inside it: re-reads
//      the claims and the ledger, re-runs the allocator's decision, and refuses, in the allocator's
//      own words, if this card no longer fires. Two dispatchers opening overlapping lanes at the
//      same moment used to both succeed here. See openCasVerdict in lib/open.mjs.
//   4. Refuses an existing branch or an existing checkout directory. Reusing a branch name that
//      has already been merged is the consumed-name rule's failure mode in git form.
//   5. Appends the four-field claim line to CLAIMS.md.
//   6. Appends an OPEN record to LANES.md carrying the lane's declared file scope — which is the
//      only place an active lane's scope is written down, and therefore the thing that makes a
//      second concurrent writer provable rather than assumed.
//   7. Creates the worktree on a new branch off origin/main, and records the base SHA — not the ref
//      — in the ledger, because origin/main moves and gate 3 needs a base that does not. AFTER the
//      records, so a crash leaves a recorded lane with no checkout rather than a checkout with no
//      record. A card whose target is NOT a git repository (a workspace root, say) opens IN PLACE
//      instead: no branch, no checkout, claim and ledger record only. See lib/open.mjs.
//
// The port is base + (open lanes already on this repo), so two lanes in one repo do not fight over
// 5173 and nobody has to remember which one took it.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gather, decide } from './lane-alloc.mjs';
import { git, isRepo, repoDirFor } from '../lib/gitread.mjs';
import { appendClaim, releaseClaim } from '../lib/claims.mjs';
import { recordOpen, recordNote, readLanes } from '../lib/lanes.mjs';
import { laneOpenPlan, openRefusal, openCasVerdict, resumeVerdict, IN_PLACE } from '../lib/open.mjs';
import { laneKey } from '../lib/lanes.mjs';
import { withLock } from '../lib/lock.mjs';
import { repoPolicy } from '../lib/policy.mjs';

// THE WORKSPACE ROOT is the directory holding `_handoffs/` and your repos. It is NEVER the
// package's own install location, so it comes from $PANDORAS_ROOT or the current directory.
const ROOT = path.resolve(process.env.PANDORAS_ROOT || process.cwd());

/**
 * Read the blocking claim's worktree: is it dirty, and how recently was anything under it written.
 *
 * THIS IS THE "LOOK BEFORE ADVISING" HALF OF Ops BETA2, and without it the age gate is the only
 * signal the refusal has. The holder's worktree path is not in the claim line — a claim has four
 * fields and none of them is a path — so it comes from that session's OPEN record in LANES.md.
 *
 * EVERY UNKNOWN ANSWERS null, AND null IS READ AS "A WRITER MAY BE HERE", never as crashed. No OPEN
 * record, no worktree on disk, a git call that failed: all null. That direction is the whole point.
 * The expensive mistake is telling somebody a live lane is dead.
 */
function holderLiveness(session) {
  const out = { worktreeDirty: null, newestTouchMin: null };
  if (!session) return out;
  const lane = readLanes(ROOT).find((l) => l.session === session && l.status === 'OPEN');
  if (!lane || !lane.worktree || lane.worktree === '-') return out;
  const dir = path.join(ROOT, lane.worktree);
  if (!fs.existsSync(dir)) return out;

  const porcelain = git(dir, ['status', '--short']);
  if (porcelain !== null && porcelain !== undefined) {
    out.worktreeDirty = String(porcelain).split('\n').filter((l) => l.trim()).length;
  }
  out.newestTouchMin = newestMtimeMin(dir);
  return out;
}

/** Newest mtime under a tree, in minutes, skipping the directories that churn on their own. */
function newestMtimeMin(dir, depth = 0) {
  const SKIP = new Set(['node_modules', '.git', 'dist', '.next', 'out', 'coverage']);
  if (depth > 3) return null;
  let newest = null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.env.local') continue;
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) {
        const sub = newestMtimeMin(full, depth + 1);
        if (sub !== null && (newest === null || sub < newest)) newest = sub;
      } else {
        const min = (Date.now() - fs.statSync(full).mtimeMs) / 60_000;
        if (newest === null || min < newest) newest = min;
      }
    } catch { /* unreadable entry: contributes nothing, stays unknown */ }
  }
  return newest;
}

function arg(args, name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}

/**
 * DOES THIS NEW CHECKOUT GET ITS DEPENDENCIES, AND IF NOT, DOES THE SCRIPT SHOUT ABOUT IT?
 *
 * The pure half of the install decision, so the rule can be asserted without running `npm ci` 860 MB
 * at a time. `run` means do the install; `warn` means print the loud paragraph naming the exact
 * command, which is the case that costs a lane its first half hour: a checkout with no
 * node_modules fails nearly every test, and that is byte-for-byte what a genuinely broken main
 * looks like from the outside.
 *
 * NOT INSTALLED BY DEFAULT, and the reason is disk rather than time — one app's node_modules can
 * be most of a gigabyte, and a busy board carries dozens of checkouts at once. So the caller
 * chooses and the omission is never silent. `run` and `warn` are mutually exclusive by
 * construction.
 *
 * @param {{inPlace:boolean, hasPackageJson:boolean, hasModules:boolean, install:boolean}} p
 * @returns {{run:boolean, warn:boolean, why:string}}
 */
export function installPlan({ inPlace, hasPackageJson, hasModules, install }) {
  if (inPlace) return { run: false, warn: false, why: 'an in-place lane works in the repo itself, which already has whatever it has' };
  if (!hasPackageJson) return { run: false, warn: false, why: 'no package.json in this checkout, so there is nothing to install' };
  if (hasModules) return { run: false, warn: false, why: 'this checkout already carries node_modules' };
  if (install) return { run: true, warn: false, why: '--install was passed and this checkout has no node_modules' };
  return { run: false, warn: true, why: 'no node_modules and no --install: the lane must install before it believes any red' };
}

/**
 * DOES THIS NEW CHECKOUT GET THE REPO'S `.env.local`?
 *
 * THE DEFECT: `git worktree add` copies tracked files only, and a repo that needs a credential
 * keeps it in a gitignored `.env.local`, so a fresh checkout has none. A lane worker whose first
 * job touches one fails cold — one wasted run, discovered only because a dispatcher happened to be
 * watching. Unlike node_modules (hundreds of megabytes, correctly opt-in via --install), an env
 * file is bytes, not megabytes, so there is no disk argument for making this one opt-in too: it is
 * copied whenever it is missing. THIS MULTIPLIES A CREDENTIAL FILE ONCE PER CHECKOUT; the README
 * says so under "What this touches on your machine".
 *
 * NEVER OVERWRITES: a worktree that already carries its own `.env.local` — a RESUME, or a lane
 * that wrote one itself before this ran — is left exactly as it is.
 *
 * An optional per-repo allowlist (POLICY.md's `env` table, Router ENV1) narrows WHAT is copied,
 * never WHETHER — that decision stays exactly this function's job. See copyEnvFile below.
 *
 * @param {{inPlace:boolean, repoEnvExists:boolean, worktreeEnvExists:boolean}} p
 * @returns {{copy:boolean, why:string}}
 */
export function envCopyPlan({ inPlace, repoEnvExists, worktreeEnvExists }) {
  if (inPlace) return { copy: false, why: 'an in-place lane works in the repo itself, which already has its own .env.local if it has one' };
  if (worktreeEnvExists) return { copy: false, why: 'this checkout already carries its own .env.local' };
  if (!repoEnvExists) return { copy: false, why: 'the repo carries no .env.local to copy' };
  return { copy: true, why: 'the repo carries a .env.local this checkout does not have yet' };
}

/**
 * Split a `.env.local` file's text down to the `KEY=...` lines whose key is on `keys`, in the
 * file's OWN order (never the allowlist's order — the allowlist is a filter, not a re-sort).
 * Comments and blank lines are dropped unconditionally: an allowlisted copy is a clean file, not
 * the original with some lines blanked out. A key on `keys` the text does not contain is named in
 * `missing`, never invented as an empty line.
 *
 * @param {string} text
 * @param {string[]} keys
 * @returns {{lines:string[], found:string[], missing:string[]}}
 */
export function filterEnvLines(text, keys) {
  const wanted = new Set(keys);
  const foundOrder = [];
  const found = new Set();
  const lines = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (!m || !wanted.has(m[1]) || found.has(m[1])) continue;
    lines.push(line);
    found.add(m[1]);
    foundOrder.push(m[1]);
  }
  const missing = keys.filter((k) => !found.has(k));
  return { lines, found: foundOrder, missing };
}

/**
 * The disk half of envCopyPlan. A plain file copy, never a symlink (a symlinked credential would
 * follow the repo's own file if either copy is ever edited, which defeats the point of a lane
 * having its own checkout), mode 600 because a credential file has no business being
 * group/world-readable. Never throws: a failed copy is reported and the lane still opens correctly
 * — the same "loud, not fatal" shape installPlan's own failure handling uses just above.
 *
 * `envKeys`, when given (POLICY.md's optional `env` table — see policy.mjs), narrows the copy to
 * exactly those variable names via filterEnvLines instead of copying the whole file. Omitted or
 * empty means today's behaviour: the whole file, byte for byte.
 *
 * @param {{repoDir:string, checkoutDir:string, inPlace:boolean, envKeys?:string[]|null}} p
 * @returns {{copy:boolean, why:string, copied:boolean, error:string|null}}
 */
export function copyEnvFile({ repoDir, checkoutDir, inPlace, envKeys = null }) {
  const repoEnvPath = path.join(repoDir, '.env.local');
  const worktreeEnvPath = path.join(checkoutDir, '.env.local');
  const plan = envCopyPlan({
    inPlace,
    repoEnvExists: fs.existsSync(repoEnvPath),
    worktreeEnvExists: !inPlace && fs.existsSync(worktreeEnvPath),
  });
  if (!plan.copy) {
    if (!inPlace && !fs.existsSync(worktreeEnvPath) && !fs.existsSync(repoEnvPath)) {
      console.log('  env        no .env.local to copy');
    }
    return { ...plan, copied: false, error: null };
  }
  try {
    if (envKeys && envKeys.length) {
      const source = fs.readFileSync(repoEnvPath, 'utf8');
      const { lines, found, missing } = filterEnvLines(source, envKeys);
      fs.writeFileSync(worktreeEnvPath, lines.length ? `${lines.join('\n')}\n` : '');
      fs.chmodSync(worktreeEnvPath, 0o600);
      const missingNote = missing.length ? `; missing: ${missing.join(', ')}` : '';
      console.log(`  env        ${found.length} of ${envKeys.length} keys copied from the repo (mode 600)${missingNote}`);
      return { ...plan, copied: true, error: null };
    }
    fs.copyFileSync(repoEnvPath, worktreeEnvPath);
    fs.chmodSync(worktreeEnvPath, 0o600);
    console.log('  env        .env.local copied from the repo (mode 600)');
    return { ...plan, copied: true, error: null };
  } catch (e) {
    const error = String(e.message).slice(0, 160);
    console.log(`  env        .env.local copy FAILED (${error}); copy it by hand.`);
    return { ...plan, copied: false, error };
  }
}

function die(msg) {
  console.error(`lane-open REFUSED\n  ${msg}`);
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  const brief = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--chat');
  const chat = arg(args, '--chat', null);
  const dry = args.includes('--dry-run');
  const allowQueued = args.includes('--queued');
  const install = args.includes('--install');
  if (!brief || !chat) {
    console.error('usage: pandoras-router open <brief-filename> --chat "<chat title>" [--dry-run] [--queued] [--install]');
    process.exit(2);
  }

  // The PREVIEW read, deliberately outside the lock: it finds the card and gives the fast refusal, and
  // nothing is written on its say-so. The authoritative read is the re-read inside the lock below.
  const r = gather({ root: ROOT, limit: 999, lockRead: false });
  const card = r.cards.find((c) => c.brief === brief);
  if (!card) {
    const near = r.skipped.find((s) => s.brief.file === brief);
    die(near
      ? `"${brief}" was not carded: ${near.why} — ${near.detail}`
      : `no card for "${brief}". Run: pandoras-router alloc --limit 99`);
  }
  if (card.firesAfter && !allowQueued) {
    // Two different sentences, because "someone else is writing here" and "you never released your
    // own claim" want opposite responses. See openRefusal.
    if (card.blockedBy) {
      const live = holderLiveness(card.blockedBy.session);
      const r = openRefusal({
        blockingChat: card.blockedBy.chat,
        blockingSession: card.blockedBy.session,
        myChat: chat,
        mySession: card.session,
        ageH: card.blockedBy.ageH,
        worktreeDirty: live.worktreeDirty,
        newestTouchMin: live.newestTouchMin,
      });
      die(`card "${card.lane}" is QUEUED on ${card.repo}.\n  ${r.message}`);
    }
    die(`card "${card.lane}" is QUEUED behind ${card.firesAfter}.\n  Opening it anyway puts two writers in ${card.repo}. If that is deliberate, re-run with --queued and the override goes in the ledger.`);
  }

  const repoDir = repoDirFor(ROOT, card.repo);
  if (!fs.existsSync(repoDir)) die(`${card.repo} does not exist at ${repoDir} — there is nothing to open a lane on.`);

  // A card whose target is not a git repository opens IN PLACE rather than being refused. See
  // lib/open.mjs for why: the allocator has always offered workspace-root cards and this script has
  // always refused all of them, so every root lane to date was claimed by hand.
  const plan_ = laneOpenPlan({ repo: card.repo, branch: card.branch, checkout: card.checkout, repoIsGit: isRepo(repoDir) });
  const inPlace = plan_.mode === IN_PLACE;

  const checkoutDir = inPlace ? repoDir : path.join(ROOT, card.checkout);

  const baseRef = inPlace ? null
    : git(repoDir, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']) ? 'origin/main' : 'main';
  // Resolved to a sha and written into the OPEN record. `origin/main` is a moving target; the sha is
  // not, and gate 3 needs a base that survives this lane merging its own work.
  const baseSha = inPlace ? null : git(repoDir, ['rev-parse', baseRef]);
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const session = card.session;

  /**
   * Everything that depends on the ledger: resume, the existing-checkout and existing-branch
   * refusals, the port, the branch and worktree the OPEN row names. A function of the ledger it is
   * handed, because it runs twice: once against the allocator's read for --dry-run, and once against
   * the re-read INSIDE the lock for the real open, so the port and the resume verdict are never
   * computed from a ledger somebody else has since appended to.
   */
  const planFrom = (ledger) => {
    // RESUME (Gov-GAMMA1 W2). A PARTIAL close leaves its checkout standing by design, and this script
    // used to refuse every one of them — so every retry of a partial lane left the machinery and was
    // stitched by hand. The refusal is unchanged for every OTHER existing directory; see resumeVerdict
    // for why "PARTIAL close" is the one explanation that makes reuse safe rather than merely likely.
    const priorLane = ledger.find((l) => laneKey(l.lane) === laneKey(card.lane) && l.repo === card.repo) ?? null;
    const resume = inPlace
      ? { resume: false, why: 'in-place lanes have no checkout to reuse' }
      : resumeVerdict({ checkoutExists: fs.existsSync(checkoutDir), lane: priorLane });

    if (!inPlace && fs.existsSync(checkoutDir) && !resume.resume) {
      return { refusal: `checkout directory ${card.checkout} already exists, and it is not resumable.\n  ${resume.why}\n  Nothing was created and nothing was removed.` };
    }
    if (!inPlace && !resume.resume) {
      const branchExists = git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${card.branch}`]);
      if (branchExists) return { refusal: `branch ${card.branch} already exists in ${card.repo}. Branch names are never reused — a merged name reused is the consumed-name rule's failure in git form. Rename the brief or open with a new lane id.` };
    }

    const openHere = ledger.filter((l) => l.status === 'OPEN' && l.repo === card.repo).length;
    const port = card.port ? card.port + openHere : null;
    // ON RESUME THE BRANCH COMES FROM THE LEDGER, not from the card. The card derives a branch name
    // from the brief's filename, and a brief renamed between passes would derive a different one — at
    // which point the lane would be told to work on a branch its own checkout is not standing on.
    const resumeBranch = resume.resume ? (priorLane.branch && priorLane.branch !== '-' ? priorLane.branch : card.branch) : null;
    const ledgerBranch = resumeBranch ?? plan_.branch ?? '-';
    const ledgerWorktree = resume.resume ? (priorLane.worktree && priorLane.worktree !== '-' ? priorLane.worktree : card.checkout) : (plan_.worktree ?? '-');
    return { refusal: null, priorLane, resume, port, ledgerBranch, ledgerWorktree };
  };

  if (dry) {
    const p = planFrom(r.openLanes);
    if (p.refusal) die(p.refusal);
    const plan = [
      p.resume.resume
        ? `(no worktree created — RESUME on the existing ${p.ledgerWorktree}, branch ${p.ledgerBranch})`
        : inPlace
          ? `(no worktree — ${plan_.why})`
          : `git -C ${card.repo} worktree add -b ${card.branch} ../${card.checkout} ${baseRef}`,
      `CLAIMS.md  += ${card.repo} | ${chat} | ${stamp} | ${session}`,
      `LANES.md   += OPEN | ${card.lane} | ${card.repo} | ${p.ledgerBranch} | ${p.ledgerWorktree} | ${p.port ?? '-'} | ${card.report} | ${card.scope.join(' ')} | ${session} | ${stamp} | ${baseSha ?? '-'}`,
    ];
    console.log(`lane-open DRY RUN — nothing was written.\n${plan.map((x) => `  ${x}`).join('\n')}`);
    process.exit(0);
  }

  // ---- THE COMPARE-AND-SET, one locked section (CONC1, 2026-09-14) ----------------------------
  //
  // Re-read the claims and the ledger, re-run the allocator's decision against them, re-check this
  // card, then write the claim, the OPEN row and create the worktree, all without letting go of the
  // lock. The card above was computed from a read another dispatcher may have written past since;
  // this is where that is caught. See openCasVerdict in lib/open.mjs.
  //
  // RECORDS FIRST, WORKTREE SECOND. It used to be the other way round, so a crash between the two left
  // a checkout no record explains, which lane-open refuses forever as an unexplained directory. Now
  // the worst a crash leaves is a recorded lane with no checkout, which resumeVerdict and the orphan
  // probe both already read correctly. The worktree add stays INSIDE the lock: outside it, a second
  // open reading the ledger in that gap would see an OPEN row whose checkout does not exist, call the
  // lane orphaned, and open straight over it.
  //
  // Refusals are built inside and printed outside, so nothing calls process.exit while holding the
  // lock. (The lock releases on exit anyway; this keeps the section's shape honest.)
  const opened = withLock(ROOT, () => {
    const fresh = decide(r);
    const freshCard = fresh.cards.find((c) => c.brief === brief) ?? null;
    const cas = openCasVerdict({ card, freshCard, queued: allowQueued });
    if (!cas.ok) return { cas };

    const p = planFrom(fresh.openLanes);
    if (p.refusal) return { refusal: p.refusal };

    // THE RESUMED MARKER IS A COMMENT LINE, NOT A FOURTH-FIELD SUFFIX, and that is deliberate. The
    // fourth field is a JOIN KEY: lane-close pairs a claim with its OPEN record on it, and alloc maps
    // session -> declared scope through it. One character of drift there already cost a close
    // (`dispatch-lane-x` vs `-x-w3`, matcher found nothing). So the identity
    // stays byte-identical and the marker sits where a human reads it.
    const claimLine = appendClaim(ROOT, {
      repo: card.repo, chat, stamp, session,
      note: p.resume.resume ? `RESUMED ${stamp} by lane-open — ${p.resume.why}` : null,
    });
    const ledgerLine = recordOpen(ROOT, {
      lane: card.lane, repo: card.repo,
      branch: p.resume.resume ? p.ledgerBranch : plan_.branch,
      worktree: p.resume.resume ? p.ledgerWorktree : plan_.worktree,
      port: p.port, report: card.report, scope: card.scope, session, stamp, base: baseSha,
    });
    if (p.resume.resume) recordNote(ROOT, card.lane, `RESUME: reopened on the existing checkout ${p.ledgerWorktree} — ${p.resume.why}`);
    if (freshCard.firesAfter) recordNote(ROOT, card.lane, `OVERRIDE --queued: opened while queued behind ${freshCard.firesAfter}`);

    if (!inPlace && !p.resume.resume) {
      const added = git(repoDir, ['worktree', 'add', '-b', card.branch, checkoutDir, baseRef]);
      if (added === null || !fs.existsSync(checkoutDir)) {
        // The records are already written. The claim is released as commented history so the repo is
        // not held by a lane with nowhere to work, and a NOTE says why. The OPEN row stays: this file is
        // append-only, and its missing checkout is exactly what the orphan probe reads as a freed slot.
        const released = releaseClaim(ROOT, session);
        recordNote(ROOT, card.lane, `WORKTREE-FAILED: git worktree add failed after the claim and OPEN row were written; ${released.length} claim line(s) released. Record the CLOSE with: pandoras-router close ${card.lane}`);
        return { refusal: `git worktree add failed for ${card.checkout}, after the claim and the OPEN row were written.\n  The claim was released (commented, in CLAIMS.md) and a WORKTREE-FAILED note is in LANES.md.\n  The OPEN row stands with no checkout, which the board reads as an orphan with its slot freed.\n  Record the CLOSE with: pandoras-router close ${card.lane}` };
      }
    }
    return { p, claimLine, ledgerLine, overrode: freshCard.firesAfter };
  });

  if (opened.cas) {
    const cas = opened.cas;
    let detail = '';
    if (cas.blockedBy) {
      const live = holderLiveness(cas.blockedBy.session);
      detail = `\n  ${openRefusal({
        blockingChat: cas.blockedBy.chat,
        blockingSession: cas.blockedBy.session,
        myChat: chat,
        mySession: card.session,
        ageH: cas.blockedBy.ageH,
        worktreeDirty: live.worktreeDirty,
        newestTouchMin: live.newestTouchMin,
      }).message}`;
    }
    die(`card "${card.lane}" is QUEUED on ${card.repo} on the re-check under the state lock — the board moved after the allocator's read. Nothing was written.\n  ${cas.why}${detail}`);
  }
  if (opened.refusal) die(opened.refusal);
  const { claimLine, ledgerLine } = opened;
  const { resume, port, ledgerBranch, ledgerWorktree, priorLane } = opened.p;

  console.log(`lane-open OK — ${card.lane}${resume.resume ? '  (RESUMED)' : ''}`);
  console.log(resume.resume
    ? `  RESUME     ${ledgerWorktree}   (existing branch ${ledgerBranch}) — ${resume.why}`
    : inPlace
      ? `  IN PLACE   ${card.repo} — ${plan_.why}`
      : `  checkout   ${card.checkout}   (branch ${card.branch} off ${baseRef} @ ${baseSha})`);
  console.log(`  port       ${port ?? '(no dev server for this repo)'}`);
  // DEPENDENCIES. `git worktree add` copies tracked files and nothing else, so a fresh checkout has
  // no node_modules. That is not a mild inconvenience: the test run reports near-total failure,
  // which is what a genuinely red `main` looks like from the outside, and the close's build gate
  // records `skip` however good the work is. Measured on one board, most standing worktrees had no
  // node_modules.
  //
  // NOT INSTALLED BY DEFAULT, and the reason is disk rather than time: an app's node_modules can be
  // most of a gigabyte and a busy board carries dozens at once. So the choice is the caller's and
  // the omission is loud. A failed install does NOT unwind the lane — the checkout, the claim and the ledger record
  // are already correct, and an install can be re-run by hand.
  const pkgHere = !inPlace && fs.existsSync(path.join(checkoutDir, 'package.json'));
  const haveModules = !inPlace && fs.existsSync(path.join(checkoutDir, 'node_modules'));
  const deps = installPlan({ inPlace, hasPackageJson: pkgHere, hasModules: haveModules, install });
  if (deps.run) {
    console.log(`  install    npm ci in ${card.checkout} ...`);
    try {
      execFileSync('npm', ['ci'], { cwd: checkoutDir, stdio: 'inherit', timeout: 20 * 60_000 });
      console.log('  install    OK');
    } catch (e) {
      console.log(`  install    FAILED (${String(e.message).slice(0, 160)}). The lane is open and correct; run \`npm ci\` in the checkout by hand.`);
      recordNote(ROOT, card.lane, `npm ci failed at open: ${String(e.message).slice(0, 200)}`);
    }
  }
  // CREDENTIALS. `git worktree add` copies tracked files only, so a fresh checkout has no
  // .env.local even when the repo it came from needs one to run at all. See envCopyPlan above.
  // Not gated on --install: bytes, not megabytes, so there is no reason to make a lane ask twice.
  // envKeys narrows the copy to POLICY.md's per-repo allowlist (Router ENV1); a repo with no `env`
  // row there gets null, which is today's whole-file behaviour, unchanged.
  copyEnvFile({ repoDir, checkoutDir, inPlace, envKeys: repoPolicy(r.policy, card.repo)?.env ?? null });
  console.log(`  report     ${card.report}`);
  console.log(`  claim      ${claimLine}`);
  console.log(`  ledger     ${ledgerLine}`);
  if (opened.overrode) {
    console.log(`  OVERRIDE   opened with --queued while it was queued behind ${opened.overrode} — recorded in LANES.md`);
  }
  console.log('');
  if (resume.resume) {
    // The branch is standing where the previous pass left it, which is behind main by however long
    // ago that pass ran. Gate 2 (fresh-base) fails a close whose branch does not contain
    // origin/main's head, so bringing it forward is the first act of the resumed pass, not an
    // optional tidy. It is NOT done here: this script creates and never modifies existing work.
    console.log(`  RESUMED on work the previous pass left behind. Its branch is BEHIND origin/main by`);
    console.log(`  whatever landed since. Bring it forward first — the close gates measure against a base`);
    console.log(`  that contains main's head, and a stale branch fails gate 2 however good the work is.`);
    console.log(`  Read ${priorLane.report} before you start: it names what did NOT close and why.`);
    console.log('');
  }
  console.log(inPlace
    ? `  Work in ${card.repo} itself — there is no checkout and no branch, so nothing here is\n  recoverable by commit. Read a file before you overwrite it. Close it with:`
    : '  A LANE WORKER opens its session INSIDE that checkout and runs bare commands there.\n  A DISPATCHER does not. Stay in the repo\'s own working copy and reach this checkout by path,\n  because closing the lane later removes this directory and would take the session with it.\n  Close it with:');
  console.log(`    pandoras-router close ${card.lane} --status DONE`);
  // Asked a SECOND time, against the disk as it stands now rather than against the answer above: an
  // install that ran and failed leaves the checkout in exactly the state this warning is for.
  if (installPlan({ inPlace, hasPackageJson: pkgHere, hasModules: fs.existsSync(path.join(checkoutDir, 'node_modules')), install: false }).warn) {
    console.log('');
    console.log('  THIS CHECKOUT HAS NO node_modules, so its first gate run will report crashed rows that');
    console.log('  look exactly like a broken main, and the close\'s build gate will record skip. Run this');
    console.log('  BEFORE you believe any red, and before any build, gate or hermetic run:');
    console.log(`      npm --prefix ${card.checkout} ci`);
    console.log('  Or re-open with --install next time and this script does it.');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    // A live holder past the wait: the refusal names it, and a stack trace would bury that.
    if (e?.code === 'LOCK_HELD' || e?.code === 'LOCK_NO_STATE') die(e.message);
    throw e;
  }
}
