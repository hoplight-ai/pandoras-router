// check-test.mjs — Router CHECK1: `pandoras-router check` validates the workspace before anything
// fires. Written and run RED before src/lib/check.mjs and src/bin/check.mjs existed — see the
// done-file for the observed failure (both files did not exist, so the import itself failed).
//
// Every fixture lives under a fresh os.tmpdir() directory, built from the real examples/ files so
// this suite breaks the moment the canonical examples drift from what loadPolicy/loadPrefixes
// actually accept. Nothing here reads or writes the live bridge.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkWorkspace } from '../src/lib/check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES = path.join(HERE, '..', 'examples');
const BIN = path.join(HERE, '..', 'src', 'bin', 'check.mjs');

const tests = [];
const T = (name, fn) => tests.push({ name, fn });

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pandoras-check-'));
}

/** A clean workspace: the four _lanes files copied verbatim from examples/, plus one live brief. */
function mkCleanWorkspace() {
  const root = mkTmp();
  const lanesDir = path.join(root, '_handoffs', '_lanes');
  fs.mkdirSync(lanesDir, { recursive: true });
  for (const name of ['POLICY.md', 'PREFIXES.md', 'CLAIMS.md', 'LANES.md']) {
    fs.copyFileSync(path.join(EXAMPLES, name), path.join(lanesDir, name));
  }
  fs.copyFileSync(
    path.join(EXAMPLES, 'Web-CEILING1-Raise-The-Per-Provider-Cap.md'),
    path.join(root, '_handoffs', 'Web-CEILING1-Raise-The-Per-Provider-Cap.md'),
  );
  return root;
}

function run(root) {
  return spawnSync(process.execPath, [BIN], { env: { ...process.env, PANDORAS_ROOT: root }, encoding: 'utf8' });
}

// ---------------------------------------------------------------- clean workspace

T('a clean workspace built from examples/ returns no problems, and the driver exits 0', () => {
  const root = mkCleanWorkspace();
  const { problems } = checkWorkspace(root);
  assert.deepEqual(problems, [], `expected no problems, got: ${JSON.stringify(problems)}`);

  const r = run(root);
  assert.equal(r.status, 0, `driver should exit 0 on a clean workspace; stdout was:\n${r.stdout}\nstderr:\n${r.stderr}`);
});

// ---------------------------------------------------------------- POLICY.md

T('a POLICY.md with one repo listed twice returns exactly one problem naming that repo', () => {
  const root = mkCleanWorkspace();
  const policyPath = path.join(root, '_handoffs', '_lanes', 'POLICY.md');
  const text = fs.readFileSync(policyPath, 'utf8');
  const dupRow = '| `web` | 1 | 3 | product | 5173 | push | `sha:/api/status:release` | https://web.example.com |';
  assert.ok(text.includes(dupRow), 'fixture setup: the web row was not found to duplicate — examples/POLICY.md changed shape');
  fs.writeFileSync(policyPath, text.replace(dupRow, `${dupRow}\n${dupRow}`));

  const { problems } = checkWorkspace(root);
  assert.equal(problems.length, 1, `expected exactly one problem, got: ${JSON.stringify(problems)}`);
  assert.match(problems[0].message, /"web"/, 'the problem must name the repo');
  assert.match(problems[0].file, /POLICY\.md$/);
  assert.equal(problems[0].severity, 'error');

  const r = run(root);
  assert.notEqual(r.status, 0, 'the driver must exit non-zero');
});

// ---------------------------------------------------------------- PREFIXES.md

T('a PREFIXES-refused filename on the bridge is named with the word it should have been', () => {
  const root = mkCleanWorkspace();
  fs.writeFileSync(path.join(root, '_handoffs', 'finished-Something.md'), '# fixture, not a real brief\n');

  const { problems } = checkWorkspace(root);
  const hit = problems.find((p) => p.file === '_handoffs/finished-Something.md');
  assert.ok(hit, `expected a problem naming _handoffs/finished-Something.md, got: ${JSON.stringify(problems)}`);
  assert.match(hit.message, /done-/, 'the problem must name the word it should have been');

  const r = run(root);
  assert.notEqual(r.status, 0, 'the driver must exit non-zero');
});

// ---------------------------------------------------------------- CLAIMS.md

T('a CLAIMS.md line with two fields instead of four is named by line number', () => {
  const root = mkCleanWorkspace();
  const claimsPath = path.join(root, '_handoffs', '_lanes', 'CLAIMS.md');
  const before = fs.readFileSync(claimsPath, 'utf8');
  fs.writeFileSync(claimsPath, `${before}\nweb | broken-claim\n`);
  const after = fs.readFileSync(claimsPath, 'utf8');
  const lineNo = after.split('\n').findIndex((l) => l.trim() === 'web | broken-claim') + 1;
  assert.ok(lineNo > 0, 'fixture setup: could not find the malformed line back in the file');

  const { problems } = checkWorkspace(root);
  const hit = problems.find((p) => p.file.endsWith('CLAIMS.md') && p.message.includes(`line ${lineNo}`));
  assert.ok(hit, `expected a problem naming line ${lineNo}, got: ${JSON.stringify(problems)}`);

  const r = run(root);
  assert.notEqual(r.status, 0, 'the driver must exit non-zero');
});

// ---------------------------------------------------------------- LANES.md

T('a LANES.md OPEN record with no CLOSE, stamped three days back, is named as an open lane', () => {
  const root = mkCleanWorkspace();
  const lanesPath = path.join(root, '_handoffs', '_lanes', 'LANES.md');
  const before = fs.readFileSync(lanesPath, 'utf8');
  const stamp = new Date(Date.now() - 3 * 24 * 3_600_000).toISOString();
  const openLine = `OPEN | oldlane1 | web | oldlane1-branch | /tmp/wt-oldlane1 | 5173 | done-oldlane1.md | . | dispatch-lane-oldlane1 | ${stamp} | abc1234`;
  fs.writeFileSync(lanesPath, `${before}\n${openLine}\n`);

  const { problems } = checkWorkspace(root);
  const hit = problems.find((p) => p.file.endsWith('LANES.md') && p.message.includes('oldlane1') && p.message.includes('open lane'));
  assert.ok(hit, `expected a problem naming lane "oldlane1" as an open lane, got: ${JSON.stringify(problems)}`);

  const r = run(root);
  assert.notEqual(r.status, 0, 'the driver must exit non-zero');
});

// ---------------------------------------------------------------- workspace shape

T('a workspace missing _handoffs/_lanes/ is named, with no exception thrown', () => {
  const root = mkTmp();
  fs.mkdirSync(path.join(root, '_handoffs'), { recursive: true });

  let threw = null;
  let result = { problems: /** @type {Array<{file:string,severity:string,message:string}>} */ ([]), counts: {} };
  try {
    result = checkWorkspace(root);
  } catch (e) {
    threw = e;
  }
  assert.equal(threw, null, `checkWorkspace must not throw; it threw: ${threw}`);
  const hit = result.problems.find((p) => p.file === '_handoffs/_lanes/');
  assert.ok(hit, `expected a problem naming _handoffs/_lanes/, got: ${JSON.stringify(result.problems)}`);

  const r = run(root);
  assert.notEqual(r.status, 0, 'the driver must exit non-zero');
  assert.doesNotMatch(r.stderr, /Error|throw/i, `the driver must not crash; stderr was:\n${r.stderr}`);
});

let fails = 0;
for (const t of tests) {
  try { await t.fn(); } catch (e) { fails++; console.log(`FAIL  ${t.name}\n      ${String(e.message).split('\n')[0]}`); }
}
console.log(`CHECK ASSERTIONS  ${tests.length - fails}/${tests.length} pass, ${fails} fail`);
console.log('  1 of them is RED-PROOF: a workspace missing _handoffs/_lanes/ is asserted to produce a named problem and a non-zero exit rather than a thrown exception, so a defect that turns the shape check back into a crash turns this suite red.');
if (fails) throw new Error(`check-test.mjs: ${fails}/${tests.length} assertion(s) failed.`);
