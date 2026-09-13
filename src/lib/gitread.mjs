// gitread.mjs — read-only git. Every call here is a query; nothing in this file writes a ref, a
// commit, an index or a working tree. Callers that need to write do it themselves, in the open,
// where it can be read.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT_KEY } from './root.mjs';

// `--no-optional-locks` is not cosmetic and is the whole reason this line looks odd.
//
// `git status` refreshes the index and writes it back, which means it takes `.git/index.lock`
// even though the caller only wanted to read. Measured repeatedly: a board run holds that lock,
// one repo at a time, and releases it cleanly when the run completes. A run whose git child was
// killed mid-status left the lock behind, and an orphaned `.git/index.lock` makes every later
// `git add`, `git commit` and `git checkout --` in that repo fail with "Unable to create
// index.lock". Orphaned locks then jammed many repos at once, and each time somebody diagnosed
// it from scratch.
//
// The flag tells git not to take locks it does not strictly need. Proven by polling for the lock
// across consecutive status calls: observed with the plain command, never with this flag. It is
// safe on every subcommand used here, and safe on writing subcommands too, because it suppresses
// only the OPTIONAL lock, never one a real write needs.
export function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, '--no-optional-locks', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * STALE `.git/index.lock` DETECTION — the pure half, so it can be tested without a filesystem.
 *
 * `--no-optional-locks` above stops this router CAUSING orphaned locks. It does nothing about the
 * ones already there, and for a long while nothing DETECTED them. An orphaned lock makes every
 * later `git add`, `git commit` and `git checkout --` in that repo fail, and the only symptom is a
 * confusing error the next time a human commits. Orphaned locks have jammed a dozen or more repos
 * at once on several occasions, once for most of a day before anyone noticed. A board that claims
 * to say "who is writing where" should say when a repo cannot be written to at all.
 *
 * The grace period distinguishes the two states that look identical on disk: a lock held by a git
 * command running right now, and a lock left by one that died. Five minutes is well past any
 * ordinary git operation and well short of the most-of-a-day it once went unnoticed.
 */
export const LOCK_GRACE_MS = 5 * 60 * 1000;

export function classifyLock({ present, ageMs }) {
  if (!present) return { locked: false, stale: false, why: null };
  // A lock whose mtime is in the FUTURE cannot be judged by age, and the naive `ageMs < GRACE`
  // test called it fresh — so a clock skew, a restored backup or a touched file would mask a
  // genuinely orphaned lock indefinitely. Found by the red-proof fixture for this very check,
  // which is the entire argument for proving a guard can go red before trusting it.
  if (ageMs < 0) {
    return {
      locked: true,
      stale: true,
      why: `.git/index.lock has a mtime ${Math.round(-ageMs / 60000)} minutes in the FUTURE, so its age cannot be trusted. Treated as orphaned rather than fresh, because the alternative is a stale lock that never reports. THIS REPO CANNOT COMMIT until it is moved aside.`,
    };
  }
  if (ageMs < LOCK_GRACE_MS) {
    return {
      locked: true,
      stale: false,
      why: `.git/index.lock exists and is ${Math.round(ageMs / 1000)}s old — this may be a git command running right now, so it is reported and not judged.`,
    };
  }
  return {
    locked: true,
    stale: true,
    why: `.git/index.lock is ${Math.round(ageMs / 60000)} minutes old. Nothing this old is a live git command, so it is orphaned and THIS REPO CANNOT COMMIT until it is moved aside. Every git add, commit and checkout in it fails with "Unable to create index.lock".`,
  };
}

/**
 * DECIDING WHETHER TO CLEAR ONE — the pure half.
 *
 * classifyLock only NAMES a stale lock. Naming it was not enough. Measured: several repos sat
 * unable to accept a commit until the next morning, found by hand during an unrelated task.
 * Nothing was watching, because detection was wired into a board nobody reads on a schedule.
 *
 * v1 froze the whole sweep whenever ANY git process existed anywhere on the machine. Reviewed and
 * replaced: on a machine running many lanes at once, a sweep that stands down for any git process
 * mostly does not sweep. Two sharper checks now decide:
 *
 * `heldOpen` — does some process hold THIS lock file open right now? Per-file, and race-free by
 * construction: git takes a lock with create-exclusive, so a second git can never OPEN an existing
 * lock, only fail against it. An unheld lock therefore stays unheld forever; there is no window in
 * which "not held" becomes "held" between the check and the clear.
 *
 * `bytes` — a genuine orphan is always ZERO bytes, because git creates the lock empty and fills it
 * with the new index only at the end. Every orphan measured across several incidents was empty.
 * A NON-empty stale lock is a mid-write snapshot of somebody's
 * index — moving it would still be reversible, but it is odd enough that a machine must not treat
 * it as routine. It is reported loudly and left for a human.
 */
export function sweepDecision({ present, ageMs, bytes, heldOpen, holderIsGit }) {
  if (!present) return { action: 'none', why: 'no lock file' };
  if (heldOpen) {
    if (holderIsGit === true) {
      return {
        action: 'leave',
        why: 'a git process is holding this lock file open right now, so it is doing its job. Clearing a held lock risks corrupting the index it protects. Left alone, however old it looks.',
      };
    }
    // AMENDED. `heldOpen` alone used to end the story: any holder at all
    // returned LEAVE, and the printed reason said "so it is doing its job". Two zero-byte locks in
    // one repo were held open by a non-git process.
    // Git was nowhere near them, the repo could not accept a single commit, and the sweep printed
    // that sentence over it. The clearing behaviour was right — a held file must not be moved — and
    // the REPORTING was the defect: an unresolvable jam was being announced in the vocabulary of a
    // healthy repo. It is now a blocker, which is a named state a human acts on, and clearing is
    // still refused.
    return {
      action: 'blocked',
      why:
        holderIsGit === false
          ? 'held open by a process that is NOT git. Git never comes to hold an existing lock — it takes locks create-exclusive — so no git command is waiting on this and none will release it. THIS REPO CANNOT COMMIT until a human works out what is holding it (`lsof` the path) and stops it. NOT cleared: moving a file another process holds open is not safe, and it would not help.'
          : 'held open by a process this sweep could not identify, so it cannot be shown to be git. Unknown is not "git is working": treating it as such is exactly how a jammed repo came to be reported as healthy. THIS REPO CANNOT COMMIT until a human checks it. NOT cleared.',
    };
  }
  const c = classifyLock({ present, ageMs });
  if (!c.stale) return { action: 'leave', why: c.why };
  if (bytes > 0) {
    return {
      action: 'report',
      why: `stale but NOT empty (${bytes} bytes). Every proven orphan is zero bytes — git creates the lock empty and fills it only at the end — so this is a mid-write index snapshot, not the known signature. Left for a human to look at.`,
    };
  }
  return { action: 'clear', why: c.why };
}

/**
 * WHERE THE LOCKS LIVE — the blind spot, made a testable function.
 *
 * A lane checkout's `.git` is a FILE pointing back at the parent repo, and the lane's real index
 * lock is `<parent>/.git/worktrees/<lane>/index.lock`. The first sweeper only looked at
 * `<dir>/.git/index.lock` under directories whose `.git` is a directory — so every lane lock was
 * invisible, and it printed "no lock anywhere" over 22 lanes that had been jammed for six days,
 * found only because a review went looking.
 *
 * Pure: takes what the filesystem said, returns every path that must be checked. The caller reads
 * `laneNames` from `.git/worktrees/` and passes them in.
 */
export function lockSites({ name, hasGitDir, laneNames }) {
  if (!hasGitDir) return []; // a lane folder: its lock is accounted for under its parent
  const sites = [];
  for (const base of FIXED_LOCKS) sites.push({ rel: `.git/${base}`, lane: null });
  for (const lane of [...laneNames].sort()) {
    for (const base of FIXED_LOCKS) sites.push({ rel: `.git/worktrees/${lane}/${base}`, lane });
  }
  return sites;
}

/**
 * `HEAD.lock` WAS NEVER LOOKED AT, AND IT JAMS A REPO JUST AS HARD (added later).
 *
 * `index.lock` blocks `git add` and `git commit`. `HEAD.lock` blocks anything that moves the branch
 * pointer — commit, checkout, reset, merge — and a `refs/heads/<branch>.lock` blocks writes to that
 * one branch. All three present identically: a zero-byte file nobody mentions. One repo held BOTH
 * an `index.lock` and a `HEAD.lock` while this function named neither, because this list did not
 * exist and the only path it ever built was the index one.
 *
 * The `refs/` tree is a walk rather than a fixed name, so it lives in `refLockFiles` below.
 */
export const FIXED_LOCKS = ['index.lock', 'HEAD.lock'];

/**
 * Every `*.lock` under a git directory's `refs/` tree. The impure half of the same blind spot: a
 * ref lock's path is data on disk, not a name that can be listed in advance.
 *
 * `gitDir` is the real git directory — `<checkout>/.git` for a plain checkout, and
 * `<parent>/.git/worktrees/<lane>` for a lane, which is the same indirection lockSites handles.
 */
export function refLockFiles(gitDir) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.lock')) out.push(p);
    }
  };
  walk(path.join(gitDir, 'refs'));
  return out.sort();
}

/** The impure half: read the lock's presence and age from disk. */
export function lockInfo(dir) {
  const lock = path.join(dir, '.git', 'index.lock');
  try {
    const st = fs.statSync(lock);
    return classifyLock({ present: true, ageMs: Date.now() - st.mtimeMs });
  } catch {
    return classifyLock({ present: false, ageMs: 0 });
  }
}

/**
 * "git could not answer" is NOT "the tree is clean", and for a long while the board could not tell
 * them apart. `git()` returns null on any failure, and readRepo turned that into `dirty === null`,
 * which rendered as `?` in one column while every other column and the verdict carried on as
 * though the repo had been measured. A sweep running while git is dying — the index.lock incident,
 * more than once — prints a clean, plausible, entirely fictional board. Named in several lane
 * reports and deliberately untouched in all of them.
 */
export function repoReadState({ porcelain, branch }) {
  if (porcelain === null) {
    return {
      unmeasured: true,
      dirty: null,
      why: 'git could not answer `status --porcelain` here, so NOTHING about this repo was measured — not its dirtiness, not its branch. This is not a clean tree and must not be read as one.',
    };
  }
  return {
    unmeasured: false,
    dirty: porcelain.split('\n').filter((l) => l.trim()).length,
    why: null,
    branch,
  };
}

export function isRepo(dir) {
  const dot = path.join(dir, '.git');
  return fs.existsSync(dot) && fs.statSync(dot).isDirectory();
}

/**
 * A lane card's `repo` field to a real directory. `ROOT_KEY` is the key the allocator and POLICY.md
 * both use for the workspace root itself, and it is NOT a subdirectory — joining it onto the root
 * produces a path that does not exist, which is how lane-open came to refuse every root card.
 */
export function repoDirFor(root, repo) {
  return repo === ROOT_KEY ? root : path.join(root, repo);
}

export function repoDirs(root) {
  const out = [];
  for (const name of fs.readdirSync(root).sort()) {
    const dir = path.join(root, name);
    let st;
    try { st = fs.statSync(dir); } catch { continue; }
    if (st.isDirectory() && isRepo(dir)) out.push({ name, dir });
  }
  return out;
}

export function dirtyCount(dir) {
  const p = git(dir, ['status', '--porcelain']);
  return p === null ? null : p.split('\n').filter((l) => l.trim()).length;
}

export const headSha = (dir) => git(dir, ['rev-parse', 'HEAD']);
export const branchOf = (dir) => git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);

/**
 * Commits in a window, split by which paths they touched. Used by the floor-watch line: a count,
 * printed, never a gate.
 */
export function commitClasses(dir, days, productPaths, opsPaths) {
  const since = `--since=${days} days ago`;
  const count = (paths) => {
    const out = git(dir, ['log', 'origin/main', since, '--format=%H', '--', ...paths]);
    if (out === null) return null;
    return out ? out.split('\n').filter(Boolean).length : 0;
  };
  return { product: count(productPaths), ops: count(opsPaths) };
}
