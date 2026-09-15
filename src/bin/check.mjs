#!/usr/bin/env node
// @ts-check
// check.mjs — `pandoras-router check`: validate the workspace before anything fires.
//
// IT WRITES NOTHING. No ledger record, no claim, no file of any kind — this command only reads
// and prints. A command named `check` that writes is a trap: a reader running it to ask "is my
// setup right?" must never find out the answer changed something.
//
// It prints one line per problem, grouped by file, then a final count. Exit 0 when there are no
// problems, non-zero when there are any — so `pandoras-router check && pandoras-router alloc` is a
// safe chain.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWorkspace } from '../lib/check.mjs';

// THE WORKSPACE ROOT is the directory holding `_handoffs/` and your repos. It is NEVER the
// package's own install location, so it comes from $PANDORAS_ROOT or the current directory.
const ROOT = path.resolve(process.env.PANDORAS_ROOT || process.cwd());

export function render(root, { problems, counts }) {
  const L = [`pandoras-router check — ${root}`];
  if (!problems.length) {
    L.push(`OK — read ${counts.reposChecked} repo(s), ${counts.bridgeFilesChecked} bridge file(s), ${counts.claimLinesChecked} claim line(s), ${counts.laneRecordsChecked} lane record(s). Nothing wrong found.`);
    return L.join('\n');
  }

  const byFile = new Map();
  for (const p of problems) byFile.set(p.file, [...(byFile.get(p.file) ?? []), p]);
  for (const [file, ps] of byFile) {
    L.push(`\n${file}`);
    for (const p of ps) L.push(`  [${p.severity}] ${p.message}`);
  }
  const errors = problems.filter((p) => p.severity === 'error').length;
  const warnings = problems.filter((p) => p.severity === 'warning').length;
  L.push(`\n${problems.length} problem(s): ${errors} error(s), ${warnings} warning(s).`);
  return L.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  if (args.length) {
    console.error(`usage: pandoras-router check  (takes no arguments; got ${args.join(' ')})`);
    process.exit(2);
  }
  const result = checkWorkspace(ROOT);
  console.log(render(ROOT, result));
  process.exit(result.problems.length ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
