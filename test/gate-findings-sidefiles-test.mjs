// gate-findings-sidefiles-test.mjs — proves gates 9 (findings) and 10 (no-side-files) are wired
// into gradeGates/classifyPartialKind, not just computed and printed on the side. Written and run
// RED before lib/close.mjs's gradeGates knew about `g.findings` / `g.noSideFiles` (Gov YANKEE2,
// 2026-09-06) — see the done-file for the observed failure. No filesystem, no git, no network.

import assert from 'node:assert/strict';
import { gradeGates, classifyPartialKind } from '../src/lib/close.mjs';

const tests = [];
const T = (name, fn) => tests.push({ name, fn });

const PASSING = { merged: 'yes', green: 'yes', live: 'yes', renamed: 'yes', reportFree: 'yes', ownerWay: 'n/a', inScope: 'n/a', roadmap: 'yes' };

T('gradeGates: a complete pass with findings and no-side-files both yes is still DONE', () => {
  const g = gradeGates({ ...PASSING, findings: 'yes', noSideFiles: 'yes' });
  assert.equal(g.status, 'DONE');
  assert.deepEqual(g.failed, []);
});

T('gradeGates: findings=no fails gate 9 by name and grades PARTIAL', () => {
  const g = gradeGates({ ...PASSING, findings: 'no', noSideFiles: 'yes' });
  assert.equal(g.status, 'PARTIAL');
  assert.ok(g.failed.some((f) => f.gate === 'findings'), `expected a "findings" failure, got: ${JSON.stringify(g.failed)}`);
});

T('gradeGates: noSideFiles=no fails gate 10 by name and grades PARTIAL', () => {
  const g = gradeGates({ ...PASSING, findings: 'yes', noSideFiles: 'no' });
  assert.equal(g.status, 'PARTIAL');
  assert.ok(g.failed.some((f) => f.gate === 'no-side-files'), `expected a "no-side-files" failure, got: ${JSON.stringify(g.failed)}`);
});

T('gradeGates: omitting findings/noSideFiles reads n/a, so every pre-gate-9/10 caller still passes', () => {
  const g = gradeGates({ ...PASSING });
  assert.equal(g.status, 'DONE');
});

T('classifyPartialKind: a findings failure classifies as scope, not clerical', () => {
  const k = classifyPartialKind({ failed: [{ gate: 'findings', value: 'no' }] });
  assert.equal(k.kind, 'scope');
});

T('classifyPartialKind: a no-side-files failure classifies as scope, not clerical', () => {
  const k = classifyPartialKind({ failed: [{ gate: 'no-side-files', value: 'no' }] });
  assert.equal(k.kind, 'scope');
});

// ---------------------------------------------------------------- run

let pass = 0;
const fails = [];
for (const t of tests) {
  try { t.fn(); pass++; } catch (e) { fails.push({ name: t.name, message: e.message }); }
}
for (const f of fails) console.log(`FAIL  ${f.name}\n      ${String(f.message).split('\n')[0]}`);
console.log(`GATE 9/10 WIRING UNIT ASSERTIONS  ${pass}/${tests.length} pass, ${fails.length} fail`);
if (fails.length) {
  throw new Error(`gate-findings-sidefiles-test.mjs: ${fails.length}/${tests.length} assertion(s) failed — see FAIL lines above. `
    + 'Thrown (not process.exit) so this cannot be masked by router-test.mjs\'s own later process.exit() call.');
}
