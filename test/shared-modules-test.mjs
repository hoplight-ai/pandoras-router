// shared-modules-test.mjs — the drift check for the four modules that are supposed to hold the
// same statements as the private tree this package was extracted from.
//
//   npm run shared:check                       # says out loud that it compared nothing
//   PANDORAS_SIBLING_LIB=/path/to/lib npm run shared:check
//
// It also runs inside `npm test`, because the point of a check like this is that its skip is
// visible on every single run rather than the one day somebody remembers to invoke it.
//
// ── THIS IS A REPORT, NEVER A SYNC ───────────────────────────────────────────────────────────────
//
// Nothing here copies a file, and nothing may be added that does. Five modules in `src/lib/` are
// forked on purpose and four have no counterpart at all (docs/adr/0001-shared-and-forked-modules.md
// names every one). A script that copied files between the two trees would quietly undo a
// deliberate fork and carry private material into a public repository in the same pass. This prints
// a difference. A person decides what it means.
//
// ── WHAT IT COMPARES, AND WHY NOT BYTES ──────────────────────────────────────────────────────────
//
// Statements, not prose. The public copies of these files are deliberately reworded: private product
// names, incident narratives and one machine's layout are stripped on the way out, and a
// `// @ts-check` line is added because this package type-checks and the private tree does not. A
// byte comparison would therefore report all four as differing forever, and a check that fires on
// every run is silenced within a week — which leaves the real drift invisible again, one step
// further down.
//
// The comment strip is line-level and deliberately crude: a line whose first non-space characters
// are `//`, `*`, `/*` or `*/` is dropped, along with every blank line. It does NOT understand a
// trailing comment on a code line, so moving a comment onto the end of a statement reads here as a
// difference. That is the safe direction to be wrong in. A real tokenizer that mishandles one regex
// literal reports a difference that is not there, and a check nobody believes is worth nothing.
//
// ── WHAT A SKIP MEANS ────────────────────────────────────────────────────────────────────────────
//
// With `PANDORAS_SIBLING_LIB` unset this prints one line saying it compared nothing, and exits zero.
// A skip is not a pass. It is never reported as one, and the line says the count it did not check.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OURS = path.join(HERE, '..', 'src', 'lib');

/** Group 1 of docs/adr/0001-shared-and-forked-modules.md. Every other module is out of scope here,
 *  and adding one to this list without moving it in that record is how the record starts lying. */
export const SHARED_VERBATIM = ['atomic.mjs', 'prefixes.mjs', 'verdict.mjs', 'side-files-gate.mjs'];

/** Statements only: whole-line comments and blank lines removed, every line trimmed. */
export function statementsOf(source) {
  return String(source)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*') && l !== '*/')
    .join('\n');
}

/**
 * @param {string} siblingLib  the other tree's library folder
 * @returns {{file:string, state:'same'|'differs'|'absent-here'|'absent-there', detail:string}[]}
 */
export function compareShared(siblingLib) {
  return SHARED_VERBATIM.map((file) => {
    const ours = path.join(OURS, file);
    const theirs = path.join(siblingLib, file);
    if (!fs.existsSync(ours)) return { file, state: 'absent-here', detail: `${ours} does not exist` };
    if (!fs.existsSync(theirs)) return { file, state: 'absent-there', detail: `${theirs} does not exist` };
    const a = statementsOf(fs.readFileSync(ours, 'utf8'));
    const b = statementsOf(fs.readFileSync(theirs, 'utf8'));
    if (a === b) return { file, state: 'same', detail: `${a.split('\n').length} statements match` };
    const al = a.split('\n');
    const bl = b.split('\n');
    const at = al.findIndex((l, i) => l !== bl[i]);
    const where = at < 0 ? `${al.length} statements here, ${bl.length} there` : `first difference at statement ${at + 1}: here "${al[at] ?? '(end)'}", there "${bl[at] ?? '(end)'}"`;
    return { file, state: 'differs', detail: where };
  });
}

const sibling = process.env.PANDORAS_SIBLING_LIB;

console.log('\nSHARED MODULE DRIFT CHECK — a report, never a sync. Nothing here copies a file.');

if (!sibling) {
  console.log(`  SKIP: PANDORAS_SIBLING_LIB is unset, so this compared 0 of ${SHARED_VERBATIM.length} shared modules.`);
  console.log('  A skip is not a pass. To run it: PANDORAS_SIBLING_LIB=/path/to/the/other/lib npm run shared:check');
} else if (!fs.existsSync(sibling)) {
  console.log(`  SKIP: PANDORAS_SIBLING_LIB points at ${sibling}, which does not exist, so this compared 0 of ${SHARED_VERBATIM.length} shared modules.`);
  console.log('  A skip is not a pass. Point it at the other tree\'s library folder and run it again.');
} else {
  const rows = compareShared(sibling);
  for (const r of rows) console.log(`  ${r.state === 'same' ? 'ok  ' : 'DIFF'}  ${r.file.padEnd(22)} ${r.detail}`);
  const bad = rows.filter((r) => r.state !== 'same');
  console.log(`  compared ${rows.length} shared modules against ${sibling}: ${rows.length - bad.length} match, ${bad.length} differ.`);
  if (bad.length) {
    console.log('  What to do: read both sides and decide. Do not copy a file across — see docs/adr/0001-shared-and-forked-modules.md.');
    throw new Error(`shared-modules-test.mjs: ${bad.length} shared module(s) differ from the sibling tree: ${bad.map((r) => r.file).join(', ')}. `
      + 'This is a report: read both sides and decide what it means. Nothing is copied.');
  }
}
