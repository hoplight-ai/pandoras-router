// env-copy-test.mjs — Router ENV1: a per-repo allowlist narrows what `lane-open` copies into a
// fresh worktree's `.env.local`, instead of always copying the whole file. Written and run RED
// before `copyEnvFile` took an `envKeys` argument — see the done-file for the observed failure.
//
// No real `.env*` file is ever read: every fixture lives under a fresh os.tmpdir() directory and is
// deleted at the end of the run. No network, no git.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyEnvFile, envCopyPlan, filterEnvLines } from '../src/bin/lane-open.mjs';
import { loadPolicy, repoPolicy } from '../src/lib/policy.mjs';

const tests = [];
const T = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------- fixtures

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Five keys and one comment, deliberately not in the alphabetical order a naive sort would
// produce, so a test that asserts "original order" actually proves something.
const FIXTURE_ENV = [
  '# a credential file, fixture only',
  'GAMMA_KEY=three',
  'ALPHA_KEY=one',
  'DELTA_KEY=four',
  'BETA_KEY=two',
  'EPSILON_KEY=five',
  '',
].join('\n');

function withCapturedLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

// Windows has no POSIX permission bits: a chmod there can only toggle read-only, and stat reports
// 0o666 for any writable file. So the mode 600 assertion holds on macOS and Linux, and on Windows the
// same test asserts the content only.
const POSIX_MODES = process.platform !== 'win32';
function modeOf(p) {
  return fs.statSync(p).mode & 0o777;
}

// ── THE WINDOW BETWEEN CREATING A CREDENTIAL FILE AND MAKING IT PRIVATE ────────────────────────
//
// A final mode of 600 does not prove the file was never readable. Creating it at the process
// umask and chmodding it afterwards leaves a window — short, but a window — in which every account
// on the machine can read a credential. The final-mode assertions below cannot see that window:
// they pass either way.
//
// So this records the mode the file has the FIRST MOMENT IT EXISTS, by wrapping every fs call that
// can create it and stat-ing the path as soon as that call returns. `modes[0]` is what any other
// process would have seen. It must already be 0o600; a later chmod cannot un-ring that bell.
//
// The umask is forced to the common 0o022 for the duration, so "created at the umask" is 0o644
// here on any machine, rather than accidentally being 0o600 on an operator whose umask is 0o077.
const CREATING_CALLS = ['openSync', 'writeFileSync', 'copyFileSync', 'chmodSync'];
function modesWhileCreating(destPath, fn) {
  const modes = [];
  const originals = new Map();
  const prevUmask = POSIX_MODES ? process.umask(0o022) : null;
  for (const name of CREATING_CALLS) {
    const original = fs[name];
    originals.set(name, original);
    fs[name] = (...args) => {
      const r = original(...args);
      try { if (fs.existsSync(destPath)) modes.push(modeOf(destPath)); } catch { /* not yet there */ }
      return r;
    };
  }
  try {
    fn();
  } finally {
    for (const [name, original] of originals) fs[name] = original;
    if (prevUmask !== null) process.umask(prevUmask);
  }
  return modes;
}

// ---------------------------------------------------------------- filterEnvLines (pure)

T('filterEnvLines keeps only listed keys, drops comments and blanks, preserves file order', () => {
  const { lines, found, missing } = filterEnvLines(FIXTURE_ENV, ['BETA_KEY', 'ALPHA_KEY']);
  // The allowlist is given BETA-then-ALPHA; the source file has ALPHA before BETA. The result must
  // follow the SOURCE's order, not the allowlist's.
  assert.deepEqual(lines, ['ALPHA_KEY=one', 'BETA_KEY=two']);
  assert.deepEqual(found.sort(), ['ALPHA_KEY', 'BETA_KEY']);
  assert.deepEqual(missing, []);
});

T('filterEnvLines reports a listed key the source lacks as missing, and invents nothing for it', () => {
  const { lines, found, missing } = filterEnvLines(FIXTURE_ENV, ['ALPHA_KEY', 'ZETA_KEY']);
  assert.deepEqual(lines, ['ALPHA_KEY=one']);
  assert.deepEqual(found, ['ALPHA_KEY']);
  assert.deepEqual(missing, ['ZETA_KEY']);
});

// ---------------------------------------------------------------- copyEnvFile end to end

T('RED-PROOF copyEnvFile with an allowlist writes exactly those keys, in file order, comment gone, mode 600', () => {
  const repoDir = mkTmp('env-copy-repo-');
  const checkoutDir = mkTmp('env-copy-checkout-');
  try {
    fs.writeFileSync(path.join(repoDir, '.env.local'), FIXTURE_ENV);
    // Allowlist order deliberately reversed from the source file's order (see above).
    const r = copyEnvFile({ repoDir, checkoutDir, inPlace: false, envKeys: ['BETA_KEY', 'ALPHA_KEY'] });
    assert.equal(r.copied, true);
    const worktreeEnvPath = path.join(checkoutDir, '.env.local');
    const written = fs.readFileSync(worktreeEnvPath, 'utf8');
    assert.equal(written, 'ALPHA_KEY=one\nBETA_KEY=two\n', 'exactly the two named keys, source order, no comment');
    if (POSIX_MODES) assert.equal(modeOf(worktreeEnvPath), 0o600);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(checkoutDir, { recursive: true, force: true });
  }
});

// ── A REPOSITORY WITH NO `env` ROW GETS NOTHING ───────────────────────────────────────────────
//
// The default used to be copy-everything: a repo whose policy said nothing about credentials had
// its whole `.env.local` multiplied into every worktree the router created. The allowlist work
// narrowed WHAT was copied where a row existed; it never changed the default. These three
// assertions pin the flipped default, and the first two are the ones that go red if anybody
// restores it.

T('RED-PROOF envCopyPlan copies nothing when the policy names no keys for this repo', () => {
  const plan = envCopyPlan({ inPlace: false, repoEnvExists: true, worktreeEnvExists: false, envKeys: null });
  assert.equal(plan.copy, false,
    `a repo with no env row must be copied nothing; the plan said copy because "${plan.why}"`);
  assert.match(plan.why, /policy|env table|no env row/i, 'the reason names the policy, so a reader knows where to turn it on');
});

T('RED-PROOF a repo with no env row gets no credential file at all, and is told in one sentence how to turn copying on', () => {
  const repoDir = mkTmp('env-copy-repo-');
  const checkoutDir = mkTmp('env-copy-checkout-');
  try {
    fs.writeFileSync(path.join(repoDir, '.env.local'), FIXTURE_ENV);
    /** @type {ReturnType<typeof copyEnvFile>} assigned inside the captured callback, which runs synchronously */
    let r;
    const log = withCapturedLog(() => {
      r = copyEnvFile({ repoDir, checkoutDir, inPlace: false, envKeys: null });
    });
    assert.equal(r.copied, false, 'nothing is copied without an env row');
    assert.equal(fs.existsSync(path.join(checkoutDir, '.env.local')), false,
      'the whole credential file was copied into the checkout even though the policy named no keys');
    assert.ok(log.some((l) => /env table/i.test(l) && /POLICY\.md/i.test(l)),
      `open must print one plain sentence naming the env table in POLICY.md as the way to switch copying on; got: ${JSON.stringify(log)}`);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(checkoutDir, { recursive: true, force: true });
  }
});

T('an empty key list is the same as no row: nothing is copied', () => {
  const repoDir = mkTmp('env-copy-repo-');
  const checkoutDir = mkTmp('env-copy-checkout-');
  try {
    fs.writeFileSync(path.join(repoDir, '.env.local'), FIXTURE_ENV);
    /** @type {ReturnType<typeof copyEnvFile>} assigned inside the captured callback, which runs synchronously */
    let r;
    withCapturedLog(() => {
      r = copyEnvFile({ repoDir, checkoutDir, inPlace: false, envKeys: [] });
    });
    assert.equal(r.copied, false);
    assert.equal(fs.existsSync(path.join(checkoutDir, '.env.local')), false);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(checkoutDir, { recursive: true, force: true });
  }
});

T('a listed key the source file lacks is printed by name as missing, and the copy holds only what was found', () => {
  const repoDir = mkTmp('env-copy-repo-');
  const checkoutDir = mkTmp('env-copy-checkout-');
  try {
    fs.writeFileSync(path.join(repoDir, '.env.local'), FIXTURE_ENV);
    /** @type {ReturnType<typeof copyEnvFile>} assigned inside the captured callback, which runs synchronously */
    let r;
    const log = withCapturedLog(() => {
      r = copyEnvFile({ repoDir, checkoutDir, inPlace: false, envKeys: ['ALPHA_KEY', 'ZETA_KEY'] });
    });
    assert.equal(r.copied, true);
    const worktreeEnvPath = path.join(checkoutDir, '.env.local');
    assert.equal(fs.readFileSync(worktreeEnvPath, 'utf8'), 'ALPHA_KEY=one\n', 'ZETA_KEY is missing, not invented as an empty line');
    assert.ok(log.some((l) => l.includes('ZETA_KEY')), `expected the printed env line to name ZETA_KEY as missing; got: ${JSON.stringify(log)}`);
    assert.ok(log.some((l) => /1 of 2/.test(l)), `expected the printed env line to count "1 of 2"; got: ${JSON.stringify(log)}`);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(checkoutDir, { recursive: true, force: true });
  }
});

T('RED-PROOF the allowlisted copy is CREATED private: mode 600 the first moment it exists, not chmodded afterwards', () => {
  if (!POSIX_MODES) return;
  const repoDir = mkTmp('env-copy-repo-');
  const checkoutDir = mkTmp('env-copy-checkout-');
  try {
    fs.writeFileSync(path.join(repoDir, '.env.local'), FIXTURE_ENV);
    const worktreeEnvPath = path.join(checkoutDir, '.env.local');
    let seen = [];
    withCapturedLog(() => {
      seen = modesWhileCreating(worktreeEnvPath, () => {
        copyEnvFile({ repoDir, checkoutDir, inPlace: false, envKeys: ['ALPHA_KEY', 'BETA_KEY'] });
      });
    });
    assert.ok(seen.length, 'the copy was never created, so there is nothing to measure');
    assert.equal(seen[0].toString(8), '600',
      `the allowlisted credential copy first existed at mode ${seen[0].toString(8)}, readable by every account on the machine until a later chmod; create it with mode 600 instead`);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(checkoutDir, { recursive: true, force: true });
  }
});

// The companion assertion on the whole-file copy path was removed with the path itself: since the
// default flipped, no argument to copyEnvFile writes a whole credential file, so there is nothing
// left to measure. The allowlisted write above is now the only way a file is created here.

T('copyEnvFile never overwrites a worktree .env.local that already exists, allowlist or not', () => {
  const repoDir = mkTmp('env-copy-repo-');
  const checkoutDir = mkTmp('env-copy-checkout-');
  try {
    fs.writeFileSync(path.join(repoDir, '.env.local'), FIXTURE_ENV);
    fs.writeFileSync(path.join(checkoutDir, '.env.local'), 'PRIOR_KEY=kept\n');
    const r = copyEnvFile({ repoDir, checkoutDir, inPlace: false, envKeys: ['ALPHA_KEY'] });
    assert.equal(r.copy, false);
    assert.equal(r.copied, false);
    assert.equal(fs.readFileSync(path.join(checkoutDir, '.env.local'), 'utf8'), 'PRIOR_KEY=kept\n');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(checkoutDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- POLICY.md's `env` table

T('loadPolicy parses the optional env table into repoPolicy(...).env, space-separated keys', () => {
  const root = mkTmp('env-copy-policy-');
  try {
    fs.mkdirSync(path.join(root, '_handoffs', '_lanes'), { recursive: true });
    const text = [
      '<!-- table: repos -->',
      '',
      '| repo | tier | writers | dispatch | port | deploy | verify | url |',
      '|---|---|---|---|---|---|---|---|',
      '| demo | 1 | 1 | anyone | - | none | none | - |',
      '| other | 1 | 1 | anyone | - | none | none | - |',
      '',
      '<!-- table: env -->',
      '',
      '| repo | keys |',
      '|---|---|',
      '| demo | ALPHA_KEY BETA_KEY |',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(root, '_handoffs', '_lanes', 'POLICY.md'), text);
    const policy = loadPolicy(root);
    assert.deepEqual(repoPolicy(policy, 'demo').env, ['ALPHA_KEY', 'BETA_KEY']);
    // "other" has no row in the env table. Absence is null, and null now means "copy nothing" —
    // it used to mean "copy the whole file", which is the default this lane flipped.
    assert.equal(repoPolicy(policy, 'other').env, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
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
console.log(`ENV-COPY ALLOWLIST ASSERTIONS  ${pass}/${tests.length} pass, ${fails.length} fail`);
if (fails.length) {
  throw new Error(`env-copy-test.mjs: ${fails.length}/${tests.length} assertion(s) failed — see FAIL lines above.`);
}
