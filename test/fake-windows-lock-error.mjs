// fake-windows-lock-error.mjs — a `--import` preload that injects a non-EEXIST error into the
// lock's exclusive-create, so concurrency-test.mjs can reproduce CONCFLAKE1's Windows race without
// a Windows box: two windows-latest/Node 24 CI runs each lost one concurrency assertion, a
// different one each time, and both shapes trace to the same line — `fs.openSync(lockPath, 'wx')`
// in lib/lock.mjs — throwing something other than EEXIST that the caller did not expect.
//
// A live Windows runner would show us the real code and timing directly; this Mac cannot produce
// Windows's own sharing-violation behavior, so instead of guessing at lib/lock.mjs's fix from the
// hypothesis alone, this fakes the SHAPE of that behavior (a non-EEXIST error out of the exclusive-
// create, on the Nth attempt) and lets the real code run against it. Controlled entirely by env:
//
//   FAKE_LOCK_ERROR_CODE   the error code to throw, e.g. "EPERM", "EBUSY", "EACCES". Default EPERM.
//   FAKE_LOCK_ERROR_CALLS  comma-separated attempt numbers (1-based, per process) to fail on.
//                          Default "1" — only the very first exclusive-create in this process fails,
//                          then it behaves normally, modelling a one-off transient sharing violation
//                          rather than a permanently broken filesystem.
//
// Not loaded by anything unless a test passes `--import` pointing at it; a normal run of any bin
// script or the router itself never sees this file.
import fs from 'node:fs';
import path from 'node:path';

/** @typedef {Error & {code?: string, errno?: number, syscall?: string, path?: string}} FsError */

const CODE = process.env.FAKE_LOCK_ERROR_CODE || 'EPERM';
const FAIL_ON = new Set(String(process.env.FAKE_LOCK_ERROR_CALLS || '1').split(',').map(Number));

const original = fs.openSync;
let calls = 0;
fs.openSync = function fakeOpenSync(target, flags, ...rest) {
  if (flags === 'wx' && String(target).endsWith(path.join('_lanes', '.lock'))) {
    calls += 1;
    if (FAIL_ON.has(calls)) {
      const e = /** @type {FsError} */ (new Error(`${CODE}: simulated Windows create-exclusive contention, open '${target}'`));
      e.code = CODE;
      e.errno = -1;
      e.syscall = 'open';
      e.path = String(target);
      throw e;
    }
  }
  return original.call(fs, target, flags, ...rest);
};
