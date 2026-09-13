#!/usr/bin/env node
// apply-atomic-test.mjs — the failing test for the half-apply defect in src/bin/apply-atomic.mjs,
// written before the fix. No network, no secrets, no git, no writes.
//
//   node test/apply-atomic-test.mjs
//
// THE DEFECT, as a sibling review found it and as this file pins it.
//
// apply-atomic.mjs stages a patch into the git index with `git apply --cached`, which leaves the
// WORKING TREE untouched on purpose, and then walks the staged file list writing each file's new
// bytes to `<path>.atomic-tmp` and renaming that over the target. The mode of the temporary file
// was taken from the target itself:
//
//     fs.writeFileSync(tmp, staged, { mode: fs.statSync(abs).mode });
//
// A patch that ADDS a file has no target on disk yet, because `--cached` never created one, so
// `fs.statSync` throws ENOENT. The throw lands in the MIDDLE of the rename loop, after the files
// ahead of the new one have already been renamed over. The result is exactly the state the whole
// script exists to prevent: some close-path files replaced, some not, the index still staged, and
// no message saying which. A lane's close loading its driver in that window reads a new driver
// against an old `lib/close.mjs`.
//
// THE FIX this test asks for: two phases. Write every temporary file first, rename only once all
// of them exist, and give a file that is not on disk yet a default mode instead of stat-ing it.
// A failure during phase one then renames nothing at all.
//
// Both RED-PROOF rows fail before the fix: the first reads the script's own source, the second
// asks for the module that does not exist yet.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = fs.readFileSync(path.join(HERE, '..', 'src', 'bin', 'apply-atomic.mjs'), 'utf8');

const tests = [];
const T = (name, fn) => tests.push({ name, fn });

// `lib/atomic.mjs` is the module the fix introduces. Loaded dynamically so that its absence is
// two named FAIL rows rather than a crash with no test names in it.
let atomic = null;
let loadError = null;
try {
  atomic = await import('../src/lib/atomic.mjs');
} catch (e) {
  loadError = String(e.message).split('\n')[0];
}

// ---------------------------------------------------------------- premise: what --cached leaves
T('premise: `git apply --cached` is documented here as leaving the working tree untouched', () => {
  assert.match(SOURCE, /--cached/, 'the script stages into the index');
  assert.match(SOURCE, /index only, the\n\/\/ working tree is untouched|working tree is untouched/i,
    'the script says in its own header that the working tree is not written by the stage step');
});

T('premise: the script renames a temporary sibling over each target', () => {
  assert.match(SOURCE, /atomic-tmp/, 'a temporary sibling name is used');
  assert.match(SOURCE, /renameSync/, 'the replacement is a rename, not an in-place write');
});

// ---------------------------------------------------------------- THE RED
T('RED-PROOF apply-atomic never stats a target it may have to CREATE, so an added file cannot throw mid-loop', () => {
  assert.equal(
    /fs\.statSync\(abs\)/.test(SOURCE),
    false,
    'apply-atomic.mjs still calls fs.statSync(abs) on a path `git apply --cached` did not create; a patch that ADDS a file throws ENOENT after earlier files have already been renamed',
  );
});

T('RED-PROOF lib/atomic.mjs replaces in two phases, so a failure part-way renames nothing', () => {
  assert.equal(loadError, null, `lib/atomic.mjs did not load: ${loadError}`);
  const { replaceFromIndex, modeForTarget, DEFAULT_NEW_MODE, TMP_SUFFIX } = atomic;
  assert.equal(typeof replaceFromIndex, 'function');
  assert.equal(typeof modeForTarget, 'function');

  // A file that is not on disk gets the default mode instead of a stat call.
  assert.equal(modeForTarget(null), DEFAULT_NEW_MODE);
  assert.equal(modeForTarget({ mode: 0o755 }), 0o755);

  // THE DEFECT ITSELF, driven with fakes: two files, the SECOND is new (no target on disk) and its
  // staged read throws. Under the old single-phase loop the first file was already renamed. Under
  // two phases nothing is renamed at all.
  const renamed = [];
  const written = [];
  const unlinked = [];
  const r = replaceFromIndex({
    files: ['lib/close.mjs', 'lib/atomic.mjs'],
    readStaged: (f) => {
      if (f === 'lib/atomic.mjs') throw new Error('fatal: path lib/atomic.mjs exists on disk, but not in the index');
      return Buffer.from('new bytes');
    },
    statTarget: () => null,
    writeTmp: (tmp, bytes, mode) => written.push({ tmp, bytes: bytes.length, mode }),
    rename: (tmp, f) => renamed.push(f),
    unlink: (tmp) => unlinked.push(tmp),
  });
  assert.equal(r.ok, false, 'a failure in phase one is reported, not thrown past the caller');
  assert.deepEqual(renamed, [], 'NOTHING may be renamed when any file failed — this is the half-apply');
  assert.deepEqual(written.map((w) => w.tmp), [`lib/close.mjs${TMP_SUFFIX}`]);
  assert.deepEqual(unlinked, [`lib/close.mjs${TMP_SUFFIX}`], 'the temporary sibling written before the failure is cleaned up');
  assert.match(r.why, /lib\/atomic\.mjs/, 'the refusal names the file that failed');
});

T('RED-PROOF a patch that only ADDS files still replaces every one of them', () => {
  assert.equal(loadError, null, `lib/atomic.mjs did not load: ${loadError}`);
  const { replaceFromIndex, DEFAULT_NEW_MODE } = atomic;
  const renamed = [];
  const written = [];
  const r = replaceFromIndex({
    files: ['close-done-refusal-test.mjs', 'lib/atomic.mjs'],
    readStaged: () => Buffer.from('brand new file'),
    statTarget: () => null, // neither target exists yet: this is the ENOENT case
    writeTmp: (tmp, bytes, mode) => written.push({ tmp, mode }),
    rename: (tmp, f) => renamed.push(f),
  });
  assert.equal(r.ok, true, 'adding files is the normal case for a patch and must not refuse');
  assert.deepEqual(renamed, ['close-done-refusal-test.mjs', 'lib/atomic.mjs']);
  assert.deepEqual(written.map((w) => w.mode), [DEFAULT_NEW_MODE, DEFAULT_NEW_MODE]);
  assert.equal(r.replaced.length, 2);
});

T('an existing target keeps its own mode, so an executable script stays executable', () => {
  assert.equal(loadError, null, `lib/atomic.mjs did not load: ${loadError}`);
  const { replaceFromIndex } = atomic;
  const written = [];
  const r = replaceFromIndex({
    files: ['backup-conversations.sh'],
    readStaged: () => Buffer.from('#!/bin/sh\n'),
    statTarget: () => ({ mode: 0o755 }),
    writeTmp: (tmp, bytes, mode) => written.push(mode),
    rename: () => {},
  });
  assert.equal(r.ok, true);
  assert.deepEqual(written, [0o755]);
});

// ---------------------------------------------------------------- run
let pass = 0;
const fails = [];
for (const t of tests) {
  try { t.fn(); pass++; } catch (e) { fails.push({ name: t.name, message: e.message }); }
}
for (const f of fails) console.log(`FAIL  ${f.name}\n      ${String(f.message).split('\n')[0]}`);
console.log('');
console.log(`APPLY-ATOMIC ASSERTIONS  ${pass}/${tests.length} pass, ${fails.length} fail`);
if (fails.length) throw new Error(`apply-atomic-test.mjs: ${fails.length}/${tests.length} assertion(s) failed.`);
