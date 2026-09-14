// lock.mjs — one exclusive lock on the router's state directory, `_handoffs/_lanes/`.
//
// THE DEFECT, 2026-09-14, found by three independent reviewers reading the public repo. Every write
// to LANES.md and CLAIMS.md was read, concatenate, writeFileSync, with nothing between the read and
// the write. Two dispatchers running `alloc` then `open` at the same moment both read an empty board,
// both proved their scopes clear, and both wrote: two claims, two OPEN rows, two writers in one repo,
// which is the one thing this router exists to refuse. The ledger append had the same shape, so two
// appends landing together lost one of them, and a reader arriving mid-write read a truncated file
// and wrote the truncation back. test/concurrency-test.mjs races real processes against all of it.
//
// WHAT IT CHECKS
//   - The lock is `_handoffs/_lanes/.lock`, created with `fs.openSync(path, 'wx')`: the create fails
//     if the file exists, atomically, on any local filesystem macOS or Linux gives us. The file holds
//     the holder's pid, hostname, ISO time, script name and a random nonce.
//   - A lock is STALE, and is broken with ONE printed line naming whose it was, when either
//       (a) its holder is on THIS host and its pid is not alive (`process.kill(pid, 0)` says ESRCH), or
//       (b) it is older than STALE_MS, whoever and wherever the holder is.
//     A pid on another host proves nothing here, so only the age can break that one.
//   - A LIVE lock is never broken. The caller waits, polling, up to WAIT_MS, then refuses with an
//     error that names the holder. Nothing is written by a refused caller.
//   - Breaking is itself serialized by a short-lived guard file, `.lock.break`, and the breaker
//     re-reads the lock under that guard and unlinks it only if its bytes are still the ones it judged
//     stale. Without the guard, two waiters that both found one dead lock would each unlink it, and
//     the second unlink would remove the lock the first one had just taken: two holders.
//   - Re-entrant inside one process: a locked section that calls another locked function (appendClaim
//     inside lane-open's compare-and-set, say) runs inline, and only the outermost release lets go.
//   - A process that exits normally, including through `process.exit()` inside a section, releases
//     on the `exit` event. A process killed by a signal releases nothing; its lock is case (a) above.
//   - Every state-file write goes through `writeStateFile`, which REFUSES to write unless this process
//     holds the lock for that root, and writes a temporary sibling then renames it over the target, so
//     no reader ever sees a half-written file. The two-phase write is `replaceFromIndex` from
//     lib/atomic.mjs, reused rather than written a second time.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   - It does not lock anything but the router's own records. A repo's files are guarded by claims
//     and scopes, not by this; this guards the files those decisions are written in.
//   - It is not a network-filesystem lock. `wx` on NFS has historically been unreliable, and a
//     workspace on a network share should not run two dispatchers at once.
//   - It is synchronous only. A section that returns a promise is refused, because the lock would be
//     released before the promise settled and the section would run unlocked while looking locked.
//   - It cannot tell a reused pid from its original holder. A dead holder whose pid the OS has handed
//     to an unrelated process reads as alive until STALE_MS, and callers are refused by name until
//     then. That is the safe direction: a wait, never two writers.
//   - Two narrow windows are named rather than closed. A holder on another host (or one stuck past
//     STALE_MS) that releases at the very instant a breaker unlinks can lose a newer lock taken in
//     between; and a breaker that dies holding `.lock.break` is cleared after GUARD_STALE_MS without a
//     further guard. Both need a locked section to run for minutes, and the longest section this
//     router has is two small file reads, two small writes and one `git worktree add`.
//   - It never deletes a lock file whose holder is alive, and it never tells a human to.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { replaceFromIndex } from './atomic.mjs';

/**
 * The error a refused lock throws: `code` says which refusal, `holder` names who held it.
 * @typedef {Error & {code?: string, holder?: object|null}} LockError
 */

/**
 * Past this age a lock is broken whoever holds it. FIVE MINUTES, and the number is headroom, not a
 * measurement of anything slow: the longest locked section here is lane-open's compare-and-set, which
 * is two small reads, two small appends and one `git worktree add`, seconds at the very worst. A lock
 * this old belongs to a process that is hung or gone, and every caller before this bound was refused
 * by name, so a human already had five minutes of refusals telling them which process to look at.
 */
export const STALE_MS = 5 * 60_000;

/**
 * How long a caller waits for a live holder before refusing. SIXTY SECONDS: long enough to outlast a
 * worktree add on a large repo, short enough that a dispatcher stuck behind a hung holder hears about
 * it inside a minute rather than sitting silent until the stale bound.
 */
export const WAIT_MS = 60_000;

/** Between polls. Jittered so two waiters do not retry in lockstep forever. */
const POLL_MS = 20;

/**
 * The break guard is held for one read and one unlink, microseconds. Older than this, its breaker
 * died mid-break and the guard is cleared.
 */
export const GUARD_STALE_MS = 10_000;

/**
 * A lock file that exists but does not parse. `wx` creates it empty and the holder writes its JSON a
 * moment later, so a fresh unreadable lock is somebody mid-create and is waited on; an old one is a
 * holder that died in that moment.
 */
const UNREADABLE_GRACE_MS = 2_000;

export const lockDir = (root) => path.join(root, '_handoffs', '_lanes');
export const lockPath = (root) => path.join(lockDir(root), '.lock');
const guardPath = (root) => `${lockPath(root)}.break`;

const HOST = os.hostname();
/** lock path -> { nonce, depth } for every lock this process holds right now. */
const HELD = new Map();
let exitHookInstalled = false;

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists and belongs to somebody else. Alive.
    return e.code === 'EPERM';
  }
}

function readHolder(file) {
  let raw;
  let stat;
  try {
    raw = fs.readFileSync(file, 'utf8');
    stat = fs.statSync(file);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  let holder = null;
  try { holder = JSON.parse(raw); } catch { holder = null; }
  return { raw, holder, mtimeMs: stat.mtimeMs };
}

function describe(h) {
  if (!h.holder) return `an unreadable lock file (${Math.round((Date.now() - h.mtimeMs) / 1000)}s old)`;
  const { pid, host, at, by } = h.holder;
  return `pid ${pid} on host "${host}"${by ? ` (${by})` : ''}, taken ${at}`;
}

/** Why this lock is stale, in words, or null if it must be treated as live. */
function staleReason(h, now = Date.now()) {
  if (!h.holder) {
    const age = now - h.mtimeMs;
    return age > UNREADABLE_GRACE_MS ? `it never finished being written and is ${Math.round(age / 1000)}s old` : null;
  }
  const taken = Date.parse(h.holder.at);
  const age = Number.isNaN(taken) ? now - h.mtimeMs : now - taken;
  if (h.holder.host === HOST && !pidAlive(h.holder.pid)) {
    return 'that process is not alive on this host';
  }
  if (age > STALE_MS) {
    return `it is ${Math.round(age / 1000)}s old, past the ${STALE_MS / 1000}s stale bound`;
  }
  return null;
}

/**
 * Break a lock judged stale, under the guard, only if it is still byte-for-byte the lock that was
 * judged. Returns true if this call removed it (and printed the line), false otherwise.
 */
function tryBreak(root, judged, why, log) {
  const guard = guardPath(root);
  let fd;
  try {
    fd = fs.openSync(guard, 'wx');
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    try {
      if (Date.now() - fs.statSync(guard).mtimeMs > GUARD_STALE_MS) fs.unlinkSync(guard);
    } catch { /* gone already, or another waiter cleared it */ }
    return false;
  }
  try {
    fs.closeSync(fd);
    const now = readHolder(lockPath(root));
    if (!now || now.raw !== judged.raw) return false; // released or re-taken since it was judged
    fs.unlinkSync(lockPath(root));
    log(`lock BROKEN — ${path.relative(root, lockPath(root))} was held by ${describe(judged)}; ${why}. Taking it.`);
    return true;
  } finally {
    try { fs.unlinkSync(guard); } catch { /* best effort */ }
  }
}

function releaseFile(file, nonce) {
  try {
    const h = readHolder(file);
    if (h?.holder?.nonce === nonce) fs.unlinkSync(file);
  } catch { /* already gone: nothing to release */ }
}

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const [file, h] of HELD) releaseFile(file, h.nonce);
    HELD.clear();
  });
}

/**
 * Take the lock and return its release function. Blocks (synchronously) up to `waitMs`.
 *
 * @param {string} root   the workspace root, the directory holding `_handoffs/`
 * @param {object} [o]
 * @param {number} [o.waitMs]           how long to wait for a live holder, default WAIT_MS
 * @param {(line:string)=>void} [o.log] where the one BROKEN line goes, default stderr
 * @returns {() => void}  release; idempotent
 * @throws  {LockError} code LOCK_HELD naming the holder, after the wait; code LOCK_NO_STATE when
 *          there is no state directory to lock
 */
export function acquireLock(root, { waitMs = WAIT_MS, log = (l) => console.error(l) } = {}) {
  const file = lockPath(root);
  const mine = HELD.get(file);
  if (mine) {
    mine.depth++;
    let done = false;
    return () => { if (!done) { done = true; mine.depth--; } };
  }
  if (!fs.existsSync(lockDir(root))) {
    const e = /** @type {LockError} */ (new Error(`lock REFUSED — ${lockDir(root)} does not exist, so there is no router state here to lock. Nothing was written.`));
    e.code = 'LOCK_NO_STATE';
    throw e;
  }

  const nonce = crypto.randomBytes(8).toString('hex');
  const body = JSON.stringify({ pid: process.pid, host: HOST, at: new Date().toISOString(), by: path.basename(process.argv[1] ?? 'node'), nonce });
  const deadline = Date.now() + waitMs;
  let last = null;
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeSync(fd, body); } finally { fs.closeSync(fd); }
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const h = readHolder(file);
    if (h) {
      last = h;
      const why = staleReason(h);
      if (why && tryBreak(root, h, why, log)) continue;
    }
    if (Date.now() >= deadline) {
      const who = last ? describe(last) : 'a holder that released and was re-taken on every poll';
      const e = /** @type {LockError} */ (new Error(
        `lock REFUSED — the router's state lock ${path.relative(root, file)} is held by ${who}.`
        + `\n  Waited ${Math.round(waitMs / 1000)}s. That holder is ALIVE, so the lock was not broken, and nothing was written.`
        + `\n  Re-run when it finishes. If it is hung, stop that process; never delete the lock file while its holder is alive.`
        + `\n  A lock older than ${STALE_MS / 1000}s is broken automatically, whoever holds it.`,
      ));
      e.code = 'LOCK_HELD';
      e.holder = last?.holder ?? null;
      throw e;
    }
    sleepSync(POLL_MS + Math.floor(Math.random() * POLL_MS));
  }

  const entry = { nonce, depth: 1 };
  HELD.set(file, entry);
  installExitHook();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    entry.depth--;
    if (entry.depth > 0) return;
    HELD.delete(file);
    releaseFile(file, nonce);
  };
}

/**
 * Run `fn` holding the lock, release in `finally`, return what `fn` returned.
 * `fn` must be synchronous; see the header.
 */
export function withLock(root, fn, opts = {}) {
  const release = acquireLock(root, opts);
  let out;
  try {
    out = fn();
  } finally {
    release();
  }
  if (out && typeof out.then === 'function') {
    throw new Error('withLock: the locked section returned a promise, so it ran partly unlocked. Locked sections must be synchronous.');
  }
  return out;
}

/** Does this process hold the lock for `root` right now? */
export function holdsLock(root) {
  return HELD.has(lockPath(root));
}

/**
 * Replace a state file's whole content, atomically, and only while holding the lock.
 *
 * The refusal is the enforcement of "every write goes through the lock": a write path somebody adds
 * later without a `withLock` around it throws the first time it runs, rather than working until two
 * dispatchers happen to collide.
 */
export function writeStateFile(root, file, text) {
  if (!holdsLock(root)) {
    throw new Error(`writeStateFile REFUSED — ${file} is router state and this process does not hold ${lockPath(root)}. Wrap the write in withLock.`);
  }
  const r = replaceFromIndex({
    files: [file],
    readStaged: () => Buffer.from(text, 'utf8'),
    statTarget: (f) => { try { return fs.statSync(f); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } },
    writeTmp: (tmp, bytes, mode) => fs.writeFileSync(tmp, bytes, { mode }),
    rename: (tmp, f) => fs.renameSync(tmp, f),
    unlink: (tmp) => fs.unlinkSync(tmp),
  });
  if (!r.ok) throw new Error(`writeStateFile: ${r.why}`);
}
