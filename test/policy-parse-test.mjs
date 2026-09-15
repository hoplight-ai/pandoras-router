// policy-parse-test.mjs — what POLICY.md's repos table is allowed to say.
//
// THE GAP THIS OPENED WITH. Every other URL the router reads is checked at parse time: the
// liveness parser refuses anything that is not an absolute http or https URL, and says so naming
// the repo and the value. The repos table's own `url` column was taken verbatim, so a row saying
// `example.com/app`, `/app` or `javascript:...` parsed clean and travelled as far as whatever
// later used it. A policy file is trusted input, and a trusted file still gets to be wrong; the
// cheap place to find out is the line that reads it.
//
// No network, no git. Every fixture is a POLICY.md under a fresh os.tmpdir() directory, removed at
// the end of the run.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPolicy, repoPolicy } from '../src/lib/policy.mjs';

const tests = [];
const T = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------- fixtures

/**
 * Write a workspace holding one repos table whose single row carries `url`, and load it.
 * @param {string} url
 * @returns {ReturnType<typeof loadPolicy>}
 */
function policyWithRepoUrl(url) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-parse-'));
  try {
    fs.mkdirSync(path.join(root, '_handoffs', '_lanes'), { recursive: true });
    const text = [
      '<!-- table: repos -->',
      '',
      '| repo | tier | writers | dispatch | port | deploy | verify | url |',
      '|---|---|---|---|---|---|---|---|',
      `| demo | 1 | 1 | anyone | - | none | none | ${url} |`,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(root, '_handoffs', '_lanes', 'POLICY.md'), text);
    return loadPolicy(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- the url column

T('an absolute https url in the repos table is kept verbatim', () => {
  const policy = policyWithRepoUrl('https://demo.example.test/app');
  assert.equal(repoPolicy(policy, 'demo').url, 'https://demo.example.test/app');
});

T('an absolute http url is accepted too, the same as the liveness parser accepts one', () => {
  const policy = policyWithRepoUrl('http://localhost:3000');
  assert.equal(repoPolicy(policy, 'demo').url, 'http://localhost:3000');
});

T('"-" still means the repo declares no url', () => {
  const policy = policyWithRepoUrl('-');
  assert.equal(repoPolicy(policy, 'demo').url, null);
});

T('RED-PROOF a repos-table url with no scheme is refused at parse time, naming the repo and the value', () => {
  assert.throws(
    () => policyWithRepoUrl('demo.example.test/app'),
    /policy: repo "demo" has url "demo\.example\.test\/app"; must be an absolute http\(s\) URL/,
    'a host with no scheme parsed clean; the repos table must be held to the same rule as the liveness table',
  );
});

T('RED-PROOF a relative repos-table url is refused rather than guessing a host', () => {
  assert.throws(() => policyWithRepoUrl('/app'), /must be an absolute http\(s\) URL/);
});

T('RED-PROOF a repos-table url on a scheme that is not http or https is refused', () => {
  assert.throws(() => policyWithRepoUrl('javascript:alert(1)'), /must be an absolute http\(s\) URL/);
  assert.throws(() => policyWithRepoUrl('file:///etc/passwd'), /must be an absolute http\(s\) URL/);
});

// ---------------------------------------------------------------- run

let pass = 0;
const fails = [];
for (const t of tests) {
  try { t.fn(); pass++; } catch (e) { fails.push({ name: t.name, message: e.message }); }
}
for (const f of fails) console.log(`FAIL  ${f.name}\n      ${String(f.message).split('\n')[0]}`);
console.log('');
console.log(`POLICY PARSE ASSERTIONS  ${pass}/${tests.length} pass, ${fails.length} fail`);
console.log('  3 of them are RED-PROOF: each asserts a refusal, so dropping the check turns them red.');
if (fails.length) {
  throw new Error(`policy-parse-test.mjs: ${fails.length}/${tests.length} assertion(s) failed — see FAIL lines above.`);
}
