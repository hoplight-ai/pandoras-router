// side-files-gate-test.mjs — the fixture suite for lib/side-files-gate.mjs.
// No filesystem writes, no git, no network.
//
// It throws on failure rather than calling process.exit(), so a runner that imports several of
// these files cannot mask a red with its own later exit call.

import assert from 'node:assert/strict';
import { sideFileAllowed, noSideFilesVerdict, extractBriefTitle, sideFileAttributable } from '../src/lib/side-files-gate.mjs';

const tests = [];
const T = (name, fn) => tests.push({ name, fn });

const WINDOW = { start: '2026-09-06T10:00:00.000Z', end: '2026-09-06T18:00:00.000Z' };
const NOT_ALLOWED = { value: false, reason: null };
const LANE = 'lambda1';

T('sideFileAllowed is false with no header line', () => {
  assert.equal(sideFileAllowed('Lane: yankee2\nTouches: src/lib/close.mjs\n').value, false);
});

T('sideFileAllowed reads the header line and its reason after a hyphen', () => {
  const r = sideFileAllowed('Lane: yankee2\nSide-file: allowed - one-off audit, cleared with the owner in session\n');
  assert.equal(r.value, true);
  assert.equal(r.reason, 'one-off audit, cleared with the owner in session');
});

T('sideFileAllowed reads a reason after a colon too', () => {
  const r = sideFileAllowed('Side-file: allowed: pre-existing reference doc, not new prose\n');
  assert.equal(r.value, true);
  assert.equal(r.reason, 'pre-existing reference doc, not new prose');
});

T('sideFileAllowed is true with no reason given at all', () => {
  const r = sideFileAllowed('Side-file: allowed\n');
  assert.equal(r.value, true);
  assert.equal(r.reason, null);
});

T('a REFERENCE file created in-window and attributable by body fails the gate', () => {
  const files = [{ name: 'REFERENCE-2026-09-06-some-audit.md', mtimeIso: '2026-09-06T12:00:00.000Z', body: `Read-only discovery for the ${LANE} lane.` }];
  const v = noSideFilesVerdict({ files, window: WINDOW, allowed: NOT_ALLOWED, laneId: LANE });
  assert.equal(v.value, 'no');
  assert.deepEqual(v.offenders, ['REFERENCE-2026-09-06-some-audit.md']);
});

T('a SWEEP file created in-window and attributable by body fails the gate', () => {
  const files = [{ name: 'SWEEP-2026-09-06-lanes.md', mtimeIso: '2026-09-06T11:00:00.000Z', body: `filed by ${LANE}` }];
  const v = noSideFilesVerdict({ files, window: WINDOW, allowed: NOT_ALLOWED, laneId: LANE });
  assert.equal(v.value, 'no');
});

T('a TRIAGE file created in-window and attributable by body fails the gate', () => {
  const files = [{ name: 'TRIAGE-2026-09-06-open-loops.md', mtimeIso: '2026-09-06T11:30:00.000Z', body: `written by ${LANE}` }];
  const v = noSideFilesVerdict({ files, window: WINDOW, allowed: NOT_ALLOWED, laneId: LANE });
  assert.equal(v.value, 'no');
});

T('the same file with Side-file: allowed on the brief passes as n/a instead', () => {
  const files = [{ name: 'REFERENCE-2026-09-06-some-audit.md', mtimeIso: '2026-09-06T12:00:00.000Z', body: `filed by ${LANE}` }];
  const v = noSideFilesVerdict({ files, window: WINDOW, allowed: { value: true, reason: 'cleared with the owner' }, laneId: LANE });
  assert.equal(v.value, 'n/a');
});

// ---- Window-only attribution punished the wrong lane: one lane's own dry run failed on a
// REFERENCE file a DIFFERENT lane had written while both were open. These three are the
// failing-tests-first for the fix: attribution, not window membership alone, decides the verdict.

T('an in-window file naming another lane passes with a WARN line, not a fail', () => {
  const files = [{
    name: 'REFERENCE-2026-09-06-web-frames-discovery.md',
    mtimeIso: '2026-09-06T12:00:00.000Z',
    body: 'Read-only discovery for lane frames2, 2026-09-06. Scope: the frame machinery gap.',
  }];
  const v = noSideFilesVerdict({ files, window: WINDOW, allowed: NOT_ALLOWED, laneId: LANE, briefTitle: 'a refused close leaves the brief alone' });
  assert.equal(v.value, 'yes');
  assert.deepEqual(v.offenders, []);
  assert.deepEqual(v.warnings, ['WARN side file in window, not attributed: REFERENCE-2026-09-06-web-frames-discovery.md']);
  assert.match(v.note, /WARN side file in window, not attributed: REFERENCE-2026-09-06-web-frames-discovery\.md/);
});

T('an in-window file whose body names this lane fails', () => {
  const files = [{
    name: 'SWEEP-2026-09-06-other.md',
    mtimeIso: '2026-09-06T12:00:00.000Z',
    body: `Filed while closing lane ${LANE}.`,
  }];
  const v = noSideFilesVerdict({ files, window: WINDOW, allowed: NOT_ALLOWED, laneId: LANE });
  assert.equal(v.value, 'no');
  assert.deepEqual(v.offenders, ['SWEEP-2026-09-06-other.md']);
  assert.deepEqual(v.warnings, []);
});

T('an in-window file named in the done-file fails, even with an unrelated body', () => {
  const files = [{
    name: 'TRIAGE-2026-09-06-unrelated-name.md',
    mtimeIso: '2026-09-06T12:00:00.000Z',
    body: 'Nothing here names the closing lane at all.',
  }];
  const doneFileText = 'Evidence: see TRIAGE-2026-09-06-unrelated-name.md for the full list.';
  const v = noSideFilesVerdict({ files, window: WINDOW, allowed: NOT_ALLOWED, laneId: LANE, doneFileText });
  assert.equal(v.value, 'no');
  assert.deepEqual(v.offenders, ['TRIAGE-2026-09-06-unrelated-name.md']);
});

T('a file under the lane\'s own worktree diff is attributable even with an unrelated body', () => {
  const files = [{ name: 'REFERENCE-2026-09-06-copied-in.md', mtimeIso: '2026-09-06T12:00:00.000Z', body: 'unrelated prose' }];
  const v = noSideFilesVerdict({ files, window: WINDOW, allowed: NOT_ALLOWED, laneId: LANE, worktreeDiffPaths: ['_handoffs/REFERENCE-2026-09-06-copied-in.md'] });
  assert.equal(v.value, 'no');
});

T('extractBriefTitle reads the first markdown heading', () => {
  assert.equal(extractBriefTitle('# Gov `LAMBDA1`: a refused close leaves the brief alone\n\nFiled: 2026-09-06\n'), 'Gov `LAMBDA1`: a refused close leaves the brief alone');
  assert.equal(extractBriefTitle(''), null);
  assert.equal(extractBriefTitle(null), null);
});

T('sideFileAttributable matches on the brief title when the codename is absent from the body', () => {
  const file = { name: 'SWEEP-2026-09-06-x.md', body: 'this covers a refused close leaves the brief alone in detail' };
  assert.equal(sideFileAttributable(file, { laneId: 'lambda1', briefTitle: 'a refused close leaves the brief alone' }), true);
});

T('no matching files created at all passes clean', () => {
  const files = [
    { name: 'done-2026-09-06-repo-a-yankee2.md', mtimeIso: '2026-09-06T12:00:00.000Z' },
    { name: 'REFERENCE-2026-08-01-old-audit.md', mtimeIso: '2026-08-01T09:00:00.000Z' }, // outside the window
  ];
  const v = noSideFilesVerdict({ files, window: WINDOW, allowed: NOT_ALLOWED });
  assert.equal(v.value, 'yes');
  assert.deepEqual(v.offenders, []);
});

T('a file with no readable mtime is never counted as an offender', () => {
  const files = [{ name: 'REFERENCE-2026-09-06-x.md', mtimeIso: null }];
  const v = noSideFilesVerdict({ files, window: WINDOW, allowed: NOT_ALLOWED });
  assert.equal(v.value, 'yes');
});

T('no recorded open time is a skip, never a guessed pass', () => {
  const v = noSideFilesVerdict({ files: [], window: { start: null, end: WINDOW.end }, allowed: NOT_ALLOWED });
  assert.equal(v.value, 'skip');
});

// ---------------------------------------------------------------- run

let pass = 0;
const fails = [];
for (const t of tests) {
  try { t.fn(); pass++; } catch (e) { fails.push({ name: t.name, message: e.message }); }
}
for (const f of fails) console.log(`FAIL  ${f.name}\n      ${String(f.message).split('\n')[0]}`);
console.log(`SIDE FILES GATE UNIT ASSERTIONS  ${pass}/${tests.length} pass, ${fails.length} fail`);
if (fails.length) {
  throw new Error(`side-files-gate-test.mjs: ${fails.length}/${tests.length} assertion(s) failed — see FAIL lines above. `
    + 'Thrown (not process.exit) so this cannot be masked by router-test.mjs\'s own later process.exit() call.');
}
