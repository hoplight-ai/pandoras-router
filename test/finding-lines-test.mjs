// finding-lines-test.mjs — the fixture suite for lib/finding-lines.mjs.
// No filesystem writes, no git, no network.
//
// It throws on failure rather than calling process.exit(), so a runner that imports several of
// these files cannot mask a red with its own later exit call.

import assert from 'node:assert/strict';
import {
  parseFindingLine, parseFindingLines, findingsGateVerdict, ownerToProduct, mintFindingId,
  findingRow, FINDING_QUADRANT, ownerDecisionLines, findingRefusal, reportLaneAndRepo,
  selectFindings, OWNER_TOKEN, setOwnerToken, isOwnerToken,
} from '../src/lib/finding-lines.mjs';

const tests = [];
const T = (name, fn) => tests.push({ name, fn });

// The alias map is INJECTED now, so the suite supplies its own instead of reaching for a private
// product table. Two entries is enough to prove the lookup and the fallthrough.
const ALIASES = { api: 'service-api', web: 'web-frontend' };

T('parseFindingLine reads a complete line', () => {
  const f = parseFindingLine('FINDING: the migration is unapplied | fix: run it by hand | size: small | owner: owner');
  assert.equal(f.ok, true);
  assert.equal(f.what, 'the migration is unapplied');
  assert.equal(f.fix, 'run it by hand');
  assert.equal(f.size, 'small');
  assert.equal(f.owner, 'owner');
  assert.deepEqual(f.missing, []);
});

T('parseFindingLine accepts a leading bullet marker', () => {
  const f = parseFindingLine('- FINDING: x | fix: y | size: medium | owner: web');
  assert.equal(f.ok, true);
  assert.equal(f.what, 'x');
});

T('parseFindingLine flags a missing fix', () => {
  const f = parseFindingLine('FINDING: the migration is unapplied | size: small | owner: owner');
  assert.equal(f.ok, false);
  assert.deepEqual(f.missing, ['fix']);
});

T('parseFindingLine flags an invalid size the same as a missing one', () => {
  const f = parseFindingLine('FINDING: x | fix: y | size: gigantic | owner: owner');
  assert.equal(f.ok, false);
  assert.deepEqual(f.missing, ['size']);
});

T('parseFindingLine flags a missing owner', () => {
  const f = parseFindingLine('FINDING: x | fix: y | size: small');
  assert.equal(f.ok, false);
  assert.deepEqual(f.missing, ['owner']);
});

T('parseFindingLine can flag more than one missing field at once', () => {
  const f = parseFindingLine('FINDING: x');
  assert.equal(f.ok, false);
  assert.deepEqual(f.missing, ['fix', 'size', 'owner']);
});

T('parseFindingLine returns null for a line that is not a FINDING line', () => {
  assert.equal(parseFindingLine('- some other bullet'), null);
});

T('parseFindingLines splits complete from incomplete across a whole report', () => {
  const text = [
    'STATUS: PARTIAL',
    '- counted, 3 rows',
    'FINDING: dead code in api/x.js | fix: remove it | size: small | owner: ops',
    'FINDING: missing coverage | fix: write a test | size: large',
  ].join('\n');
  const { complete, incomplete } = parseFindingLines(text);
  assert.equal(complete.length, 1);
  assert.equal(incomplete.length, 1);
  assert.deepEqual(incomplete[0].missing, ['owner']);
});

// ONLY AN UPPER-CASE FINDING LINE IS A FINDING. The pattern once carried an `i` flag, so ordinary
// wrapped prose that happened to begin a line with the word "finding:" was read as a FINDING line
// with no fix, no size and no owner — and the gate refused the close over a sentence that was never
// a finding at all. Observed twice in one day on the sibling tree this module came from. The
// documented format, in this module's own header, is upper-case only.
T('RED-PROOF wrapped lower-case prose beginning "finding:" is not a FINDING line', () => {
  const text = [
    'STATUS: PARTIAL',
    'finding: if the pool-size override is ever set to something that is not a number, the ceiling',
    'would silently stop applying and every request would go through uncapped.',
    'FINDING: the retry loop has no backoff | fix: add exponential backoff | size: small | owner: ops',
  ].join('\n');
  const { complete, incomplete } = parseFindingLines(text);
  assert.equal(incomplete.length, 0, 'prose that merely starts with the word must not be graded as a finding');
  assert.equal(complete.length, 1);
});

T('RED-PROOF a mixed-case marker is not a FINDING line either', () => {
  assert.equal(parseFindingLine('Finding: the cache is cold on a first request'), null);
  assert.equal(parseFindingLine('- finding: the cache is cold on a first request'), null);
});

T('the upper-case marker still parses with a leading bullet and leading whitespace', () => {
  assert.equal(parseFindingLine('  FINDING: x | fix: y | size: small | owner: ops').ok, true);
  assert.equal(parseFindingLine('* FINDING: x | fix: y | size: small | owner: ops').ok, true);
});

T('findingsGateVerdict is n/a with no report text yet', () => {
  assert.equal(findingsGateVerdict(null).value, 'n/a');
});

T('findingsGateVerdict is yes with zero FINDING lines — nothing found is fine', () => {
  const v = findingsGateVerdict(parseFindingLines('STATUS: DONE\n- shipped it\n'));
  assert.equal(v.value, 'yes');
});

T('findingsGateVerdict is no when any FINDING line is missing a field, and quotes it', () => {
  const parsed = parseFindingLines('STATUS: PARTIAL\nFINDING: x | fix: y\n');
  const v = findingsGateVerdict(parsed);
  assert.equal(v.value, 'no');
  assert.match(v.note, /FINDING: x \| fix: y/);
});

T('findingsGateVerdict is yes when every FINDING line is complete', () => {
  const parsed = parseFindingLines('STATUS: PARTIAL\nFINDING: x | fix: y | size: medium | owner: owner\n');
  const v = findingsGateVerdict(parsed);
  assert.equal(v.value, 'yes');
  assert.equal(v.rows.length, 1);
});

// ---------------------------------------------------------------- the owner token
//
// The word that means "the human who decides" is CONFIGURABLE, because it is a name. These pin
// that it is one token in one place, and that matching it is case-insensitive.

T('the owner token defaults to "owner" and matches case-insensitively', () => {
  assert.equal(OWNER_TOKEN, 'owner');
  assert.equal(isOwnerToken('owner'), true);
  assert.equal(isOwnerToken('OWNER'), true);
  assert.equal(isOwnerToken('  Owner '), true);
  assert.equal(isOwnerToken('ops'), false);
  assert.equal(isOwnerToken(''), false);
});

T('RED-PROOF setOwnerToken moves the special case, and nothing else still hardcodes a name', () => {
  try {
    setOwnerToken('captain');
    assert.equal(isOwnerToken('captain'), true);
    assert.equal(isOwnerToken('owner'), false, 'the old token must stop being special the moment it is replaced');
    // findingRefusal must follow the token, not a compiled-in name.
    const f = parseFindingLine('FINDING: x | fix: y | size: small | owner: captain');
    assert.match(findingRefusal(f), /never the decider's/);
    assert.equal(findingRefusal(parseFindingLine('FINDING: x | fix: y | size: small | owner: owner')), null);
  } finally {
    setOwnerToken('owner');
  }
});

T('ownerToProduct passes the owner token through unchanged, in any case', () => {
  assert.equal(ownerToProduct('owner', ALIASES), 'owner');
  assert.equal(ownerToProduct('OWNER', ALIASES), 'owner');
});

T('ownerToProduct applies the INJECTED alias map', () => {
  assert.equal(ownerToProduct('api', ALIASES), 'service-api');
  assert.equal(ownerToProduct('web', ALIASES), 'web-frontend');
});

T('ownerToProduct passes an unaliased seat name through lower-cased', () => {
  assert.equal(ownerToProduct('Ops', ALIASES), 'ops');
});

T('ownerToProduct needs no alias map at all — the parameter is optional', () => {
  assert.equal(ownerToProduct('Ops'), 'ops');
  assert.equal(ownerToProduct(''), null);
});

T('mintFindingId is scoped to the lane and a counter', () => {
  assert.equal(mintFindingId('gov-yankee2', 1), 'finding_gov-yankee2_1');
  assert.equal(mintFindingId('gov-yankee2', 2), 'finding_gov-yankee2_2');
});

T('findingRow builds a complete tracker row shape', () => {
  const f = parseFindingLine('FINDING: dead code in api/x.js | fix: remove it | size: small | owner: ops');
  const row = findingRow(f, { lane: 'gov-yankee2', n: 1, today: '2026-09-06', repo: 'repo-a', aliases: ALIASES });
  assert.deepEqual(row, {
    id: 'finding_gov-yankee2_1',
    title: 'dead code in api/x.js',
    project: 'repo-a',
    quadrant: FINDING_QUADRANT,
    context: 'fix: remove it | size: small',
    executor: 'ops',
    product: 'ops',
    completed: false,
    parked: false,
    first_seen: '2026-09-06',
    last_seen: '2026-09-06',
  });
});

// EVERY FIELD IS ALWAYS WRITTEN. An earlier version omitted two fields that the destination
// declared NOT NULL, so every row it built was rejected and printed as a skipped write while the
// close carried on. The mechanism therefore never once persisted a row. These are the assertions
// the old suite could not make, because it asserted the broken shape as complete — writing the
// defect into the gate.
T('findingRow always carries the two columns a strict destination requires', () => {
  const f = parseFindingLine('FINDING: x | fix: y | size: small | owner: ops');
  const withRepo = findingRow(f, { lane: 'l', n: 1, today: '2026-09-07', repo: 'repo-b' });
  assert.equal(withRepo.project, 'repo-b', 'project must carry the lane repo');
  assert.ok(withRepo.quadrant, 'quadrant must never be absent');

  // A caller that does not know the repo still must not produce a row the destination refuses.
  const noRepo = findingRow(f, { lane: 'l', n: 1, today: '2026-09-07' });
  assert.ok(noRepo.project, 'project must fall back rather than be undefined');
  assert.ok(noRepo.quadrant, 'quadrant must fall back rather than be undefined');
});

// ---------------------------------------------------------------- the review gate
//
// A finding is a yes/no put in front of the owner and nowhere else; the filing driver runs only on
// a yes. The two failure modes this pins against are "filed silently" and "held in a document".

T('ownerDecisionLines is one yes/no per finding, worded for a chat, never a holding notice', () => {
  const rows = parseFindingLines('FINDING: the manifest lists four skills | fix: reconcile it | size: medium | owner: ops\nFINDING: b | fix: y | size: large | owner: web').complete;
  const lines = ownerDecisionLines({ rows, report: 'partial-2026-09-07-repo-a-tau1-cut-the-opening.md' });
  assert.match(lines[0], /NOT filed, NOT held/);
  assert.match(lines[0], /in front of the owner now/);
  // Bold, in markdown, because the line is pasted into a chat rather than read in a terminal.
  assert.match(lines[1], /^ {4}\*\*ASK OWNER 1: the manifest lists four skills\. Fix: reconcile it \(medium, ops\)\. Yes puts it on the board, no drops it\.\*\*$/);
  assert.match(lines[2], /^ {4}\*\*ASK OWNER 2: b\./);
  assert.match(lines[3], /npm run findings -- _handoffs\/partial-2026-09-07-repo-a-tau1-cut-the-opening\.md --only/);
  assert.match(lines[4], /on a no: {3}nothing/);
  assert.doesNotMatch(lines.join('\n'), /FINDINGS HELD|stay in|reviews first/);
});

T('ownerDecisionLines names whatever owner it is given', () => {
  const rows = parseFindingLines('FINDING: a | fix: x | size: medium | owner: ops').complete;
  const lines = ownerDecisionLines({ rows, report: 'x.md', owner: 'captain' });
  assert.match(lines[0], /in front of the captain now/);
  assert.match(lines[1], /\*\*ASK CAPTAIN 1: a\./);
});

T('ownerDecisionLines is silent with zero findings', () => {
  assert.deepEqual(ownerDecisionLines({ rows: [], report: 'x.md' }), []);
});

T('findingRefusal refuses a small finding owned by the owner — the dead-symlink case', () => {
  const f = parseFindingLine('FINDING: skills/velocity is a dead symlink | fix: remove it | size: small | owner: owner');
  assert.match(findingRefusal(f), /never the decider's/);
  assert.equal(findingRefusal(parseFindingLine('FINDING: x | fix: y | size: small | owner: ops')), null);
  assert.equal(findingRefusal(parseFindingLine('FINDING: x | fix: y | size: medium | owner: owner')), null);
});

T('findingsGateVerdict is no when a complete line is refused, and says why', () => {
  const v = findingsGateVerdict(parseFindingLines('FINDING: dead symlink | fix: remove it | size: small | owner: owner'));
  assert.equal(v.value, 'no');
  assert.match(v.note, /size small with owner owner/);
  assert.equal(v.rows.length, 0);
});

T('reportLaneAndRepo reads repo and lane off a graded report name', () => {
  assert.deepEqual(reportLaneAndRepo('partial-2026-09-07-repo-a-tau1-cut-the-opening.md'), { repo: 'repo-a', lane: 'tau1' });
  assert.deepEqual(reportLaneAndRepo('done-2026-09-06-web-api-yankee2-write-the-loop.md'), { repo: 'web-api', lane: 'yankee2' });
  assert.deepEqual(reportLaneAndRepo('_handoffs/blocked-2026-08-21-code-l1-burn-down.md'), { repo: 'code', lane: 'l1' });
});

T('reportLaneAndRepo returns nulls for a name that is not a graded report', () => {
  assert.deepEqual(reportLaneAndRepo('Ops-TAU1-Cut-The-Opening-Block.md'), { repo: null, lane: null });
  assert.deepEqual(reportLaneAndRepo('REFERENCE-2026-09-03-something.md'), { repo: null, lane: null });
});

T('selectFindings takes all when --only is absent, keeps 1-based numbering', () => {
  const complete = parseFindingLines('FINDING: a | fix: x | size: small | owner: ops\nFINDING: b | fix: y | size: small | owner: ops').complete;
  const { picked, bad } = selectFindings(complete, null);
  assert.deepEqual(picked.map((p) => [p.n, p.f.what]), [[1, 'a'], [2, 'b']]);
  assert.deepEqual(bad, []);
});

T('selectFindings honours --only and reports an index outside the list instead of dropping it', () => {
  const complete = parseFindingLines('FINDING: a | fix: x | size: small | owner: ops\nFINDING: b | fix: y | size: small | owner: ops\nFINDING: c | fix: z | size: small | owner: ops').complete;
  const ok = selectFindings(complete, '1,3');
  assert.deepEqual(ok.picked.map((p) => [p.n, p.f.what]), [[1, 'a'], [3, 'c']]);
  assert.deepEqual(ok.bad, []);
  const notOk = selectFindings(complete, '2,7');
  assert.deepEqual(notOk.bad, [7]);
  assert.deepEqual(notOk.picked.map((p) => p.n), [2]);
});

// ---------------------------------------------------------------- run

let pass = 0;
const fails = [];
for (const t of tests) {
  try { t.fn(); pass++; } catch (e) { fails.push({ name: t.name, message: e.message }); }
}
for (const f of fails) console.log(`FAIL  ${f.name}\n      ${String(f.message).split('\n')[0]}`);
console.log(`FINDING LINES UNIT ASSERTIONS  ${pass}/${tests.length} pass, ${fails.length} fail`);
if (fails.length) {
  throw new Error(`finding-lines-test.mjs: ${fails.length}/${tests.length} assertion(s) failed — see FAIL lines above.`);
}
