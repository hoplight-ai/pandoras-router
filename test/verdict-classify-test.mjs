#!/usr/bin/env node
// verdict-classify-test.mjs — Gov DELTA1 step 4, failing-test-first for classifyPartialKind.
//
// THE RULE UNDER TEST: a PARTIAL is `scope` (the work itself is unfinished or unsafe) or
// `clerical` (a measurement/paperwork gap, nothing confirmed wrong with the work). The word
// PARTIAL never changes — this only qualifies it. See lib/close.mjs's classifyPartialKind for the
// two lists and the reasoning behind each line.
//
// Run:  node test/verdict-classify-test.mjs
// Exit 0 = every assertion holds. Exit 1 = at least one does not.

import assert from 'node:assert/strict';
import { classifyPartialKind, partialStatusLabel } from '../src/lib/close.mjs';

let pass = 0;
let fail = 0;
const T = (name, fn) => {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${String(e.message).split('\n')[0]}`); }
};

console.log('\nVERDICT-CLASSIFY — scope vs clerical\n');

T('in-scope=no is scope, never folded into clerical', () => {
  const r = classifyPartialKind({ failed: [{ gate: 'in-scope', value: 'no' }] });
  assert.equal(r.kind, 'scope');
  assert.deepEqual(r.scope, ['in-scope=no']);
});
T('RED-PROOF in-scope=skip (unmeasured) is clerical, not scope', () => {
  const r = classifyPartialKind({ failed: [{ gate: 'in-scope', value: 'skip' }] });
  assert.equal(r.kind, 'clerical');
});
T('roadmap=no alone is clerical', () => {
  const r = classifyPartialKind({ failed: [{ gate: 'roadmap', value: 'no' }] });
  assert.equal(r.kind, 'clerical');
  assert.deepEqual(r.clerical, ['roadmap=no']);
});
T('renamed=no alone is clerical', () => {
  assert.equal(classifyPartialKind({ failed: [{ gate: 'renamed', value: 'no' }] }).kind, 'clerical');
});
T('RED-PROOF green=no (a build that actually went red) is scope, not clerical', () => {
  const r = classifyPartialKind({ failed: [{ gate: 'green', value: 'no' }] });
  assert.equal(r.kind, 'scope');
  assert.deepEqual(r.scope, ['green=no']);
});
T('green=skip (never run, or this checkout cannot run one) is clerical', () => {
  assert.equal(classifyPartialKind({ failed: [{ gate: 'green', value: 'skip' }] }).kind, 'clerical');
});
T('merged=no and live=no are both scope', () => {
  assert.equal(classifyPartialKind({ failed: [{ gate: 'merged', value: 'no' }] }).kind, 'scope');
  assert.equal(classifyPartialKind({ failed: [{ gate: 'live', value: 'no' }] }).kind, 'scope');
});
T('RED-PROOF one scope signal beats any number of clerical ones', () => {
  const r = classifyPartialKind({
    failed: [{ gate: 'roadmap', value: 'no' }, { gate: 'renamed', value: 'no' }, { gate: 'in-scope', value: 'no' }],
  });
  assert.equal(r.kind, 'scope');
  assert.equal(r.clerical.length, 2);
  assert.equal(r.scope.length, 1);
});
T('roadmap=no and renamed=no together, nothing else failed, is clerical', () => {
  const r = classifyPartialKind({ failed: [{ gate: 'roadmap', value: 'no' }, { gate: 'renamed', value: 'no' }] });
  assert.equal(r.kind, 'clerical');
  assert.equal(r.clerical.length, 2);
});
T('RED-PROOF an unlisted gate (owner-way-in, report-free) defaults to scope, never silently clerical', () => {
  assert.equal(classifyPartialKind({ failed: [{ gate: 'owner-way-in', value: 'no' }] }).kind, 'scope');
  assert.equal(classifyPartialKind({ failed: [{ gate: 'report-free', value: 'no' }] }).kind, 'scope');
});
T('report says PARTIAL is a scope signal even with every gate passing', () => {
  const r = classifyPartialKind({ failed: [], reportStatusWord: 'PARTIAL' });
  assert.equal(r.kind, 'scope');
  assert.match(r.scope[0], /report says PARTIAL/);
});
T('report says BLOCKED is a scope signal', () => {
  assert.equal(classifyPartialKind({ failed: [], reportStatusWord: 'BLOCKED' }).kind, 'scope');
});
T('done-without-evidence and done-honest-unaddressed are both scope signals', () => {
  assert.equal(classifyPartialKind({ failed: [], doneWithoutEvidence: true }).kind, 'scope');
  assert.equal(classifyPartialKind({ failed: [], doneHonestUnaddressed: true }).kind, 'scope');
});
T('RED-PROOF nothing failed and no report signal gives no kind at all — DONE is not qualified', () => {
  const r = classifyPartialKind({ failed: [] });
  assert.equal(r.kind, null);
});
T('partialStatusLabel renders PARTIAL (scope) / PARTIAL (clerical), and leaves DONE/BLOCKED alone', () => {
  assert.equal(partialStatusLabel('PARTIAL', 'scope'), 'PARTIAL (scope)');
  assert.equal(partialStatusLabel('PARTIAL', 'clerical'), 'PARTIAL (clerical)');
  assert.equal(partialStatusLabel('DONE', null), 'DONE');
  assert.equal(partialStatusLabel('BLOCKED', null), 'BLOCKED');
});

console.log(`\nVERDICT-CLASSIFY ASSERTIONS  ${pass}/${pass + fail} pass, ${fail} fail`);
console.log('  6 of them assert a REFUSAL/RED-PROOF, so weakening the rule turns them red.\n');
if (fail) throw new Error(`verdict-classify-test.mjs: ${fail}/${pass + fail} assertion(s) failed.`);
