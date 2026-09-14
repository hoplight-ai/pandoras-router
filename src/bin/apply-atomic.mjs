#!/usr/bin/env node
// @ts-check
// apply-atomic.mjs — apply a git patch to this repo so that every target file is replaced by ONE
// rename and is never truncated in place.
//
// WHY THIS EXISTS. The close path's own modules are loaded at process start by every lane's close.
// `git apply` and `git checkout` rewrite a file in place, so a close that starts during the write
// reads a half-file and dies with a syntax error. The conservative rule — only edit the close path
// when no lane is running — is unusable on a board that is never quiet, so the alternative is
// atomic file replacement. A rename inside one directory is atomic on the common filesystems: a
// process opening the path sees the old bytes or the new bytes, never a mixture.
//
// WHAT IT DOES. `git apply --check`, refuse on any failure. `git apply --cached` (index only, the
// working tree is untouched). For every path in the index diff: read the staged blob and write it
// to `<path>.atomic-tmp` beside the target; then, once EVERY temporary sibling exists, rename each
// one over its target. The index stays staged, so the commit that follows is `git commit` with no
// `add`.
//
// THE TWO PHASES ARE NOT DECORATION. An earlier version stat'd the target inside the rename loop
// to copy its mode. `git apply --cached` never creates a working-tree file, so a patch that ADDS
// one had nothing to stat: `fs.statSync` threw ENOENT part-way through, after the files ahead of
// the new one had already been renamed over. Half the close path replaced, half not, and no
// message saying which. A file that is not on disk now takes a default mode instead of a stat
// call, and no rename happens until every replacement has been written. See lib/atomic.mjs for the
// decision and test/apply-atomic-test.mjs for the assertions.
//
// Usage:   pandoras-router apply <patch path, relative to the repo being patched>
//
// The repo being patched is $PANDORAS_REPO, or the current directory.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { replaceFromIndex } from '../lib/atomic.mjs';

const repo = path.resolve(process.env.PANDORAS_REPO || process.cwd());
const patch = process.argv[2];
if (!patch) {
  console.error('usage: pandoras-router apply <patch path, relative to the repo being patched>');
  process.exit(1);
}
const git = (args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

try {
  git(['apply', '--check', patch]);
} catch (e) {
  console.error(`REFUSED: the patch does not apply cleanly, nothing was written.\n${String(e.stderr ?? e.message).trim()}`);
  process.exit(2);
}
// Untracked files (`??`) are not a reason to refuse: this tool and its patch are themselves untracked
// until the commit that follows. Nor is a modified tracked file the patch does not touch — a change
// often lands as "new files plus a close-path patch" in one commit, and files nothing loads
// mid-run are edited directly. Only a modified file that the patch TARGETS is refused, because
// then the rename would replace edits git has not recorded.
const targets = new Set(
  fs.readFileSync(path.join(repo, patch), 'utf8').split('\n')
    .filter((l) => l.startsWith('diff --git '))
    .map((l) => l.split(' ')[2].replace(/^a\//, '')),
);
const dirtyBefore = git(['status', '--porcelain']).split('\n').filter(Boolean)
  .filter((l) => !l.startsWith('??'))
  .filter((l) => targets.has(l.slice(3).trim()));
if (dirtyBefore.length) {
  console.error(`REFUSED: ${dirtyBefore.length} file(s) this patch targets carry uncommitted edits. Commit or stash them first, so the rename replaces exactly what git thinks is there.\n${dirtyBefore.join('\n')}`);
  process.exit(2);
}
git(['apply', '--cached', patch]);
const files = git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
const abs = (f) => path.join(repo, f);
const result = replaceFromIndex({
  files,
  readStaged: (f) => execFileSync('git', ['-C', repo, 'show', `:${f}`], { encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'] }),
  // null, not a throw: a path the patch ADDS has no target yet, and that is the normal case.
  statTarget: (f) => { try { return fs.statSync(abs(f)); } catch { return null; } },
  writeTmp: (tmp, bytes, mode) => fs.writeFileSync(abs(tmp), bytes, { mode }),
  rename: (tmp, f) => fs.renameSync(abs(tmp), abs(f)),
  unlink: (tmp) => fs.unlinkSync(abs(tmp)),
});
if (!result.ok) {
  console.error(result.why);
  process.exit(2);
}
for (const r of result.replaced) console.log(`replaced by rename: ${r.file} (${r.bytes} bytes, mode ${r.mode.toString(8)})`);
console.log(`${result.replaced.length} file(s) replaced atomically; the index is staged, so the next step is a git commit with no add.`);
