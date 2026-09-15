// @ts-check
// atomic.mjs — the pure half of scripts/apply-atomic.mjs, so the replacement order can be tested
// without a git repository, a patch, or a single byte written to disk.
//
// WHY IT WAS SPLIT OUT, 2026-09-03. apply-atomic.mjs used to do this inside one loop:
//
//     const staged = git show :<file>
//     fs.writeFileSync(tmp, staged, { mode: fs.statSync(abs).mode });
//     fs.renameSync(tmp, abs);
//
// `git apply --cached` stages into the index and deliberately leaves the working tree alone, so a
// patch that ADDS a file has no target on disk when that `fs.statSync(abs)` runs. It throws ENOENT
// — in the middle of the loop, after every file ahead of the new one has already been renamed over.
// That is the exact state the script exists to prevent: half the close path replaced, half not, and
// a lane whose close starts in that window loading a new lane-close.mjs against an old close.mjs.
//
// The repair is ORDER, not a try/catch. Every temporary sibling is written first; renames happen
// only once all of them exist. A failure during the write phase therefore renames nothing at all,
// and the temporary files written before it are cleaned up. Renames themselves are the one thing
// that cannot be made all-or-nothing on a single filesystem, so they are kept to the end where the
// only remaining work is the rename syscall itself.
//
// Every side effect is injected, which is what makes the order testable: the test drives it with
// counters and never touches a disk.

/** A file the patch CREATES has no target to copy a mode from. 0644 is git's own default for a new blob. */
export const DEFAULT_NEW_MODE = 0o644;
export const TMP_SUFFIX = '.atomic-tmp';

/**
 * The mode a temporary sibling should carry: the target's own if the target exists, otherwise the
 * default. `stat` is whatever the caller's stat function returned, and `null` means "not on disk",
 * never "stat failed silently" — the caller distinguishes those.
 */
export function modeForTarget(stat) {
  return stat && typeof stat.mode === 'number' ? stat.mode : DEFAULT_NEW_MODE;
}

/**
 * Replace every file in `files` with its staged bytes, in two phases.
 *
 * @param {object} p
 * @param {string[]} p.files        paths, relative to the repo, from `git diff --cached --name-only`
 * @param {(f:string)=>Buffer} p.readStaged   the staged blob for one path (`git show :<path>`)
 * @param {(f:string)=>({mode:number}|null)} p.statTarget  the target's stat, or null if not on disk
 * @param {(tmp:string, bytes:Buffer, mode:number)=>void} p.writeTmp
 * @param {(tmp:string, f:string)=>void} p.rename
 * @param {(tmp:string)=>void} [p.unlink]     best-effort cleanup of a temporary sibling
 * @returns {{ok:boolean, replaced:Array<{file:string,tmp:string,bytes:number,mode:number}>, why:string|null}}
 */
export function replaceFromIndex({ files, readStaged, statTarget, writeTmp, rename, unlink = () => {} }) {
  const staged = [];
  // ---- phase 1: write every temporary sibling. Nothing is replaced yet.
  try {
    for (const file of files) {
      const bytes = readStaged(file);
      const mode = modeForTarget(statTarget(file));
      const tmp = `${file}${TMP_SUFFIX}`;
      writeTmp(tmp, bytes, mode);
      staged.push({ file, tmp, bytes: bytes.length, mode });
    }
  } catch (e) {
    for (const s of staged) { try { unlink(s.tmp); } catch { /* cleanup is best effort */ } }
    return {
      ok: false,
      replaced: [],
      why: `REFUSED: could not stage every replacement, so NOTHING was replaced. ${String(e.message).split('\n')[0]}. ${staged.length} temporary file(s) written before the failure were removed; the git index is still staged, so nothing is lost — fix the cause and run this again.`,
    };
  }
  // ---- phase 2: rename. Every source file already exists, so the only work left is the syscall.
  const replaced = [];
  for (const s of staged) {
    rename(s.tmp, s.file);
    replaced.push(s);
  }
  return { ok: true, replaced, why: null };
}
