#!/usr/bin/env node
// run.mjs — the whole suite, one process, one summary.
//
// Each file registers its own assertions and THROWS on failure rather than calling process.exit(),
// so importing them in sequence cannot let one file's exit code mask another's red. The last two
// lines are the ones to watch: the total, and how many of those assertions are RED-PROOF.
//
//   npm test

// Every `*-test.mjs` beside this file is a suite. Discovered, not listed: a fixed list is a shared
// registry that every lane adding a suite has to edit, and two lanes editing one line is exactly
// the collision this tool exists to refuse. `router-test.mjs` still runs first because it is the
// largest and its failures are the ones to read first; the rest run in name order.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILES = fs.readdirSync(HERE)
  .filter((f) => f.endsWith('-test.mjs'))
  .sort((a, b) => (a === 'router-test.mjs' ? -1 : b === 'router-test.mjs' ? 1 : a.localeCompare(b)))
  .map((f) => `./${f}`);

let failed = 0;
for (const f of FILES) {
  try {
    await import(f);
  } catch (e) {
    failed++;
    console.log(`SUITE FAILED  ${f}\n  ${String(e.message).split('\n')[0]}`);
  }
}
console.log(failed ? `\n${failed} suite(s) red.` : '\nAll suites green.');
process.exit(failed ? 1 : 0);
