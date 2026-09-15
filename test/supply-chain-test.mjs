// supply-chain-test.mjs — what this repository is allowed to fetch, and from where.
//
// Two defects sat here until 2026-09-15, and neither was the kind a unit suite normally catches,
// because neither is a wrong answer. They are a wrong ACQUISITION:
//
//   1. `npm run typecheck` ran `npx --yes --package=typescript@... --package=@types/node@...` on
//      every invocation. No lockfile existed, install scripts were enabled, and the pins were
//      version numbers rather than content hashes, so `npm test` on a clean clone executed
//      whatever the registry served that minute.
//   2. The workflow used `actions/checkout@v7` and `actions/setup-node@v7`. A tag is a pointer its
//      owner can move, and those two actions run with a checkout of this repository on every push.
//
// Both are fixed. These assertions exist so neither comes back quietly: the rules are read off the
// real `package.json`, `package-lock.json` and `ci.yml`, not off a fixture, and each checker is
// additionally fed the exact text this repository used to ship so the refusal itself is proved.
//
// No network. Nothing is installed or run; three files are read and matched.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tests = [];
const T = (name, fn) => tests.push({ name, fn });

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const workflow = read(path.join('.github', 'workflows', 'ci.yml'));

// ---------------------------------------------------------------- the checkers, as pure functions

/**
 * Does this npm script reach the network for a PACKAGE while it runs? `npx` and the package
 * managers' equivalents all resolve and execute something the lockfile never saw.
 * @param {string} command
 * @returns {boolean}
 */
export function fetchesAtRunTime(command) {
  return /(^|[\s;&|(])(npx|pnpx|pnpm\s+dlx|yarn\s+dlx|bunx)([\s;&|)]|$)/.test(String(command ?? ''));
}

/** An action reference is pinned only when what follows the `@` is a 40-character commit sha. */
export function actionIsPinned(ref) {
  return /@[0-9a-f]{40}(\s|$)/.test(String(ref ?? ''));
}

/** Exactly one version, no range operator, no tag, no URL. */
export function isExactVersion(spec) {
  return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(String(spec ?? ''));
}

// ---------------------------------------------------------------- npm scripts

T('RED-PROOF no npm script fetches a package at run time', () => {
  for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    assert.equal(fetchesAtRunTime(command), false,
      `the "${name}" script fetches a package while it runs (${command}); vendor it as an exact-pinned devDependency in the lockfile instead`);
  }
});

T('RED-PROOF the same check refuses the exact typecheck script this repository used to ship', () => {
  // Quoted verbatim from package.json before 2026-09-15. If this ever stops being refused, the
  // check above has been weakened and the assertion above would have gone quiet instead of red.
  const historical = 'npx --yes --package=typescript@6.0.3 --package=@types/node@22.20.2 -- node test/typecheck.mjs';
  assert.equal(fetchesAtRunTime(historical), true, 'the check no longer recognises the defect it was written for');
});

// ---------------------------------------------------------------- dependencies

T('dependencies is empty: the runtime cost of this tool is Node built-ins and git', () => {
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
});

T('RED-PROOF every devDependency is an exact version, never a range', () => {
  const dev = Object.entries(pkg.devDependencies ?? {});
  assert.ok(dev.length, 'there are devDependencies to check');
  for (const [name, spec] of dev) {
    assert.equal(isExactVersion(spec), true,
      `devDependency "${name}" is "${spec}"; a range lets an install pick a version nobody reviewed`);
  }
});

T('RED-PROOF the lockfile is committed and records an integrity hash for every package it resolves', () => {
  assert.equal(lock.lockfileVersion, 3);
  const entries = Object.entries(lock.packages ?? {}).filter(([p]) => p !== '');
  assert.ok(entries.length, 'the lockfile resolves at least one package');
  for (const [p, rec] of entries) {
    assert.match(String(rec.resolved ?? ''), /^https:\/\//, `${p} has no resolved URL in the lockfile`);
    assert.match(String(rec.integrity ?? ''), /^sha(512|256|1)-/, `${p} has no integrity hash in the lockfile`);
  }
});

T('the manifest and the lockfile agree on every devDependency, so npm ci cannot fail on drift', () => {
  for (const [name, spec] of Object.entries(pkg.devDependencies ?? {})) {
    const rec = lock.packages?.[`node_modules/${name}`];
    assert.ok(rec, `${name} is in the manifest and not in the lockfile`);
    assert.equal(rec.version, spec, `${name} is ${spec} in the manifest and ${rec.version} in the lockfile`);
  }
});

// ---------------------------------------------------------------- the workflow

T('CI installs from the lockfile with install scripts disabled', () => {
  assert.match(workflow, /npm ci --ignore-scripts/,
    'the install step must be a real `npm ci --ignore-scripts`; it was once a placeholder echo');
});

T('RED-PROOF every action the workflow uses is pinned to a commit sha, not a tag', () => {
  const uses = workflow.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- uses:'));
  assert.ok(uses.length >= 2, 'the workflow uses at least the checkout and setup-node actions');
  for (const line of uses) {
    assert.equal(actionIsPinned(line), true,
      `${line.replace(/^- uses:\s*/, '')} is not pinned to a commit sha; a tag is a pointer its owner can move`);
  }
});

T('RED-PROOF the same check refuses the exact action references this repository used to ship', () => {
  assert.equal(actionIsPinned('- uses: actions/checkout@v7'), false);
  assert.equal(actionIsPinned('- uses: actions/setup-node@v7'), false);
  // A sha that is too short must not pass for a full one.
  assert.equal(actionIsPinned('- uses: actions/checkout@3d3c42e'), false);
});

T('each pinned action keeps its release readable in a trailing comment', () => {
  for (const line of workflow.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- uses:'))) {
    assert.match(line, /#\s*\S+$/, `${line} pins a sha with no trailing comment saying which release it is`);
  }
});

// ---------------------------------------------------------------- run

let pass = 0;
const fails = [];
for (const t of tests) {
  try { t.fn(); pass++; } catch (e) { fails.push({ name: t.name, message: e.message }); }
}
for (const f of fails) console.log(`FAIL  ${f.name}\n      ${String(f.message).split('\n')[0]}`);
console.log('');
console.log(`SUPPLY CHAIN ASSERTIONS  ${pass}/${tests.length} pass, ${fails.length} fail`);
console.log('  5 of them are RED-PROOF: two feed the checkers the exact text this repository used to ship, so a');
console.log('  weakened checker goes red here rather than going quiet on the manifest.');
if (fails.length) {
  throw new Error(`supply-chain-test.mjs: ${fails.length}/${tests.length} assertion(s) failed — see FAIL lines above.`);
}
