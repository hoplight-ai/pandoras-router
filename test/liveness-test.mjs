// liveness-test.mjs — the deploy-liveness gate, with no socket.
//
// WHY THIS SUITE MATTERS MORE THAN ITS SIZE SUGGESTS. The liveness gate is the one check that
// leaves the repository and asks the deployed surface a question, and it is the one nobody else
// runs. A gate like that is only worth having if its SKIP is unmistakable: a skip that reads as a
// pass is worse than no gate, because it manufactures confidence. So more than half of these
// assertions are about the difference between "measured and fine", "measured and broken", and
// "nothing was measured".
//
// The network call is injected, so every branch here runs in microseconds with no port open.

import assert from 'node:assert/strict';
import { probeLiveness, gradeLiveness, livenessHeaders, LIVE_YES, LIVE_NO, LIVE_SKIPPED } from '../src/lib/liveness.mjs';
import { parseLiveness } from '../src/lib/policy.mjs';

const tests = [];
const T = (name, fn) => tests.push({ name, fn });

const CONFIG = { repo: 'web', url: 'https://example.test/', expect: 'build-abc123', auth: null, timeoutMs: 5000 };

/** A fetch stand-in. Records what it was called with, answers what the test says. */
function fakeFetch({ status = 200, body = '', throws = null } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (throws) throw new Error(throws);
    return { status, text: async () => body };
  };
  fn.calls = calls;
  return fn;
}

const run = (p) => probeLiveness(p);

// ---------------------------------------------------------------- the four the brief asks for

T('PASSES when the expected content string is present in a 200', async () => {
  const f = fakeFetch({ status: 200, body: '<html>…build-abc123…</html>' });
  const v = await run({ config: CONFIG, fetchImpl: f });
  assert.equal(v.value, LIVE_YES);
  assert.match(v.why, /carried "build-abc123"/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://example.test/');
});

T('RED-PROOF FAILS when the expected content string is absent from a 200', async () => {
  const v = await run({ config: CONFIG, fetchImpl: fakeFetch({ status: 200, body: '<html>old build</html>' }) });
  assert.equal(v.value, LIVE_NO);
  assert.match(v.why, /did NOT carry "build-abc123"/);
});

T('RED-PROOF FAILS on a non-200, and says the surface is reachable', async () => {
  const v = await run({ config: CONFIG, fetchImpl: fakeFetch({ status: 404, body: '' }) });
  assert.equal(v.value, LIVE_NO);
  assert.match(v.why, /answered 404, not 200/);
});

T('RED-PROOF SKIPS when the repo is unconfigured, and a skip is never a pass', async () => {
  const v = await run({ config: null, repo: 'web', fetchImpl: fakeFetch() });
  assert.equal(v.value, LIVE_SKIPPED);
  assert.notEqual(v.value, LIVE_YES);
  assert.match(v.why, /^SKIPPED:/);
  assert.match(v.why, /no row in POLICY\.md's liveness table/);
  assert.match(v.why, /a skip is not a pass/);
});

// ---------------------------------------------------------------- skip is a word, not a shrug

T('RED-PROOF an unreachable surface SKIPS rather than failing — a dead socket is not a red deploy', async () => {
  const v = await run({ config: CONFIG, fetchImpl: fakeFetch({ throws: 'ECONNREFUSED' }) });
  assert.equal(v.value, LIVE_SKIPPED);
  assert.match(v.why, /could not be reached \(ECONNREFUSED\)/);
  assert.match(v.why, /a skip is not a pass/);
});

T('RED-PROOF a missing credential SKIPS and the probe is NOT sent bare', async () => {
  const cfg = { ...CONFIG, auth: { kind: 'basic', envVar: 'PANDORAS_WEB_PROBE_AUTH' } };
  const f = fakeFetch({ status: 200, body: 'build-abc123' });
  const v = await run({ config: cfg, fetchImpl: f, env: {} });
  assert.equal(v.value, LIVE_SKIPPED);
  assert.equal(f.calls.length, 0, 'sending it bare would grade the credential, not the deployment');
  assert.match(v.why, /\$PANDORAS_WEB_PROBE_AUTH/);
  assert.match(v.why, /a skip is not a pass/);
});

T('an empty-string credential counts as missing, not as a credential', async () => {
  const cfg = { ...CONFIG, auth: { kind: 'basic', envVar: 'PANDORAS_WEB_PROBE_AUTH' } };
  const v = await run({ config: cfg, fetchImpl: fakeFetch(), env: { PANDORAS_WEB_PROBE_AUTH: '   ' } });
  assert.equal(v.value, LIVE_SKIPPED);
});

T('a runtime with no fetch SKIPS by name rather than throwing', async () => {
  const v = await run({ config: CONFIG, fetchImpl: null });
  assert.equal(v.value, LIVE_SKIPPED);
  assert.match(v.why, /no fetch implementation/);
});

// ---------------------------------------------------------------- what the config lets you say

T('no expect string means a 200 alone passes, because that is what the policy asked for', async () => {
  const cfg = { ...CONFIG, expect: null };
  const v = await run({ config: cfg, fetchImpl: fakeFetch({ status: 200, body: 'anything at all' }) });
  assert.equal(v.value, LIVE_YES);
  assert.match(v.why, /nothing more than a 200/);
});

T('basic auth is sent as an Authorization header, base64 of the env value', async () => {
  const cfg = { ...CONFIG, auth: { kind: 'basic', envVar: 'PANDORAS_WEB_PROBE_AUTH' } };
  const f = fakeFetch({ status: 200, body: 'build-abc123' });
  await run({ config: cfg, fetchImpl: f, env: { PANDORAS_WEB_PROBE_AUTH: 'user:hunter2' } });
  assert.equal(f.calls[0].init.headers.authorization, `Basic ${Buffer.from('user:hunter2').toString('base64')}`);
});

T('an already-encoded Basic value is passed through, never double-encoded', () => {
  const { headers } = livenessHeaders({ kind: 'basic', envVar: 'PANDORAS_A' }, { PANDORAS_A: 'Basic dXNlcjpwdw==' });
  assert.equal(headers.authorization, 'Basic dXNlcjpwdw==');
});

T('cookie and custom-header auth send the value on the named header', () => {
  assert.equal(livenessHeaders({ kind: 'cookie', envVar: 'PANDORAS_C' }, { PANDORAS_C: 'session=abc' }).headers.cookie, 'session=abc');
  const h = livenessHeaders({ kind: 'header', header: 'X-Deploy-Token', envVar: 'PANDORAS_T' }, { PANDORAS_T: 'tok' }).headers;
  assert.equal(h['x-deploy-token'], 'tok');
});

T('RED-PROOF a credential VALUE never appears in any verdict string', async () => {
  const cfg = { ...CONFIG, auth: { kind: 'cookie', envVar: 'PANDORAS_C' } };
  const v = await run({ config: cfg, fetchImpl: fakeFetch({ status: 403 }), env: { PANDORAS_C: 'session=SUPERSECRET' } });
  assert.doesNotMatch(v.why, /SUPERSECRET/);
});

T('a 401 or 403 is a RED, not a skip — something answered and it was not this build', async () => {
  for (const status of [401, 403]) {
    const v = await run({ config: CONFIG, fetchImpl: fakeFetch({ status }) });
    assert.equal(v.value, LIVE_NO, `${status} must not read as unmeasured`);
    assert.match(v.why, /credential is wrong or the surface is not serving/);
  }
});

// ---------------------------------------------------------------- the policy row itself

T('parseLiveness reads a full row, and a credential is a NAME rather than a value', () => {
  const c = parseLiveness('web', { url: 'https://example.test/health', expect: 'ok', auth: 'basic:PANDORAS_WEB_PROBE_AUTH', timeout: '2500' });
  assert.deepEqual(c, {
    repo: 'web',
    url: 'https://example.test/health',
    expect: 'ok',
    auth: { kind: 'basic', envVar: 'PANDORAS_WEB_PROBE_AUTH' },
    timeoutMs: 2500,
  });
});

T('parseLiveness treats "-" as "not set" for expect, auth and timeout', () => {
  const c = parseLiveness('web', { url: 'https://example.test/', expect: '-', auth: '-', timeout: '-' });
  assert.equal(c.expect, null);
  assert.equal(c.auth, null);
  assert.equal(c.timeoutMs, 10000);
});

T('RED-PROOF parseLiveness refuses a relative URL rather than guessing a host', () => {
  assert.throws(() => parseLiveness('web', { url: '/health' }), /must be an absolute http\(s\) URL/);
});

T('RED-PROOF parseLiveness refuses an auth form it does not understand', () => {
  assert.throws(() => parseLiveness('web', { url: 'https://x.test/', auth: 'bearer' }), /must be one of/);
  assert.throws(() => parseLiveness('web', { url: 'https://x.test/', auth: 'basic:' }), /must be one of/);
  assert.throws(() => parseLiveness('web', { url: 'https://x.test/', auth: 'header:X-Tok' }), /must be one of/);
});

T('RED-PROOF parseLiveness refuses a non-numeric timeout instead of falling back silently', () => {
  assert.throws(() => parseLiveness('web', { url: 'https://x.test/', timeout: 'soon' }), /positive integer of milliseconds/);
});

// ---------------------------------------------------------------- where a credential may go
//
// POLICY.md is trusted, and still: a row naming an arbitrary environment variable against an
// arbitrary URL would send that variable's value wherever the row says. So the variable NAME must
// carry the probe prefix, a redirect is never followed with a credential attached, and the body is
// read to a cap. Each of these was watched red before the probe learned it.

T('RED-PROOF credential routing: an env var outside the PANDORAS_ prefix is never read or sent', async () => {
  const cfg = { ...CONFIG, auth: { kind: 'header', header: 'X-Token', envVar: 'AWS_SECRET_ACCESS_KEY' } };
  const f = fakeFetch({ status: 200, body: 'build-abc123' });
  const v = await run({ config: cfg, fetchImpl: f, env: { AWS_SECRET_ACCESS_KEY: 'AKIA-SUPERSECRET' } });
  assert.equal(f.calls.length, 0, 'the probe must not be sent with a variable the prefix rule refuses');
  assert.equal(v.value, LIVE_SKIPPED);
  assert.match(v.why, /PANDORAS_/);
  assert.doesNotMatch(v.why, /AKIA-SUPERSECRET/);
});

T('credential routing: a PANDORAS_-prefixed variable is read and sent', async () => {
  const cfg = { ...CONFIG, auth: { kind: 'header', header: 'X-Token', envVar: 'PANDORAS_WEB_TOKEN' } };
  const f = fakeFetch({ status: 200, body: 'build-abc123' });
  const v = await run({ config: cfg, fetchImpl: f, env: { PANDORAS_WEB_TOKEN: 'tok' } });
  assert.equal(v.value, LIVE_YES);
  assert.equal(f.calls[0].init.headers['x-token'], 'tok');
});

T('credential routing: the prefix is configurable, and a bare probe needs no prefix at all', async () => {
  const cfg = { ...CONFIG, auth: { kind: 'cookie', envVar: 'ACME_PROBE_COOKIE' } };
  const f = fakeFetch({ status: 200, body: 'build-abc123' });
  const v = await run({ config: cfg, fetchImpl: f, env: { ACME_PROBE_COOKIE: 'c=1' }, envPrefix: 'ACME_' });
  assert.equal(v.value, LIVE_YES);
  const bare = await run({ config: CONFIG, fetchImpl: fakeFetch({ status: 200, body: 'build-abc123' }), env: {} });
  assert.equal(bare.value, LIVE_YES);
});

T('RED-PROOF redirects: with a credential attached the probe does NOT follow, and a 3xx grades `no`', async () => {
  const cfg = { ...CONFIG, auth: { kind: 'cookie', envVar: 'PANDORAS_WEB_COOKIE' } };
  const f = fakeFetch({ status: 302, body: '' });
  const v = await run({ config: cfg, fetchImpl: f, env: { PANDORAS_WEB_COOKIE: 'session=SUPERSECRET' } });
  assert.equal(f.calls[0].init.redirect, 'manual', 'a credentialed probe must never follow a redirect to a host the policy did not name');
  assert.equal(v.value, LIVE_NO);
  assert.match(v.why, /302/);
  assert.match(v.why, /redirect/i);
  assert.doesNotMatch(v.why, /SUPERSECRET/);
});

T('redirects: a bare probe may still follow, because there is nothing to leak', async () => {
  const f = fakeFetch({ status: 200, body: 'build-abc123' });
  await run({ config: CONFIG, fetchImpl: f });
  assert.equal(f.calls[0].init.redirect, 'follow');
});

T('RED-PROOF body cap: a response larger than the cap is read to the cap, not to exhaustion', async () => {
  const huge = 'x'.repeat(3 * 1024 * 1024) + 'build-abc123';
  const v = await run({ config: CONFIG, fetchImpl: fakeFetch({ status: 200, body: huge }) });
  assert.equal(v.value, LIVE_NO, 'the marker sits past the 1 MB cap, so the capped read does not see it');
  assert.match(v.why, /did NOT carry/);
  const inside = 'y'.repeat(1000) + 'build-abc123';
  const ok = await run({ config: CONFIG, fetchImpl: fakeFetch({ status: 200, body: inside }) });
  assert.equal(ok.value, LIVE_YES);
});

T('gradeLiveness is pure and can be asserted with no probe at all', () => {
  assert.equal(gradeLiveness({ status: 200, body: 'x', expect: 'x', url: 'u' }).value, LIVE_YES);
  assert.equal(gradeLiveness({ status: 200, body: 'y', expect: 'x', url: 'u' }).value, LIVE_NO);
  assert.equal(gradeLiveness({ status: 500, body: '', expect: null, url: 'u' }).value, LIVE_NO);
  assert.equal(gradeLiveness({ status: 0, body: '', expect: null, url: 'u', error: 'boom' }).value, LIVE_SKIPPED);
});

// ---------------------------------------------------------------- run

let pass = 0;
const fails = [];
for (const t of tests) {
  try { await t.fn(); pass++; } catch (e) { fails.push({ name: t.name, message: e.message }); }
}
for (const f of fails) console.log(`FAIL  ${f.name}\n      ${String(f.message).split('\n')[0]}`);
const red = tests.filter((t) => t.name.startsWith('RED-PROOF')).length;
console.log(`LIVENESS GATE ASSERTIONS  ${pass}/${tests.length} pass, ${fails.length} fail`);
console.log(`  ${red} of them are RED-PROOF: each asserts a refusal or a skip, so weakening the gate turns them red.`);
if (fails.length) throw new Error(`liveness-test.mjs: ${fails.length}/${tests.length} assertion(s) failed.`);
