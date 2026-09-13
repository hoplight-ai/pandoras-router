#!/usr/bin/env node
// run.mjs — the whole suite, one process, one summary.
//
// Each file registers its own assertions and THROWS on failure rather than calling process.exit(),
// so importing them in sequence cannot let one file's exit code mask another's red. The last two
// lines are the ones to watch: the total, and how many of those assertions are RED-PROOF.
//
//   npm test

const FILES = [
  './router-test.mjs',
  './liveness-test.mjs',
  './finding-lines-test.mjs',
  './side-files-gate-test.mjs',
  './gate-findings-sidefiles-test.mjs',
  './verdict-classify-test.mjs',
  './apply-atomic-test.mjs',
  './guard-wide-read-test.mjs',
  './guards-test.mjs',
];

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
