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
import {
  probeLiveness, gradeLiveness, livenessHeaders, LIVE_YES, LIVE_NO, LIVE_SKIPPED,
  parseVerifyHeader, parseVerifyWithHeader, gradeHeaderEcho, probeHeaderEcho,
} from '../src/lib/liveness.mjs';
import { parseLiveness, parseVerify } from '../src/lib/policy.mjs';
import { liveStringVerdict, liveShaVerdict } from '../src/lib/close.mjs';

const tests = [];
const T = (name, fn) => tests.push({ name, fn });

const CONFIG = { repo: 'web', url: 'https://example.test/', expect: 'build-abc123', auth: null, timeoutMs: 5000 };

/**
 * A fetch stand-in. Records what it was called with, answers what the test says. `headers` is a
 * plain object of response headers; `bodyReads` counts every time a probe touched the body, so a
 * form that must read only headers can be caught reading the body.
 */
function fakeFetch({ status = 200, body = '', headers = {}, throws = null } = {}) {
  const calls = [];
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (throws) throw new Error(throws);
    return {
      status,
      headers: { get: (name) => lower[String(name).toLowerCase()] ?? null },
      text: async () => { fn.bodyReads++; return body; },
    };
  };
  fn.calls = calls;
  fn.bodyReads = 0;
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

// ---------------------------------------------------------------- a verdict names its own strength
//
// The sha form (a deployment echoing its own commit) is the only proof that cannot pass on stale
// bytes. The string form can be satisfied by a cached response, a stale build that happens to carry
// the string, or an unrelated route. The comments said so; reviewers asked that the VERDICT say so,
// where a reader grades. The value never changes — yes stays yes — only the sentence beside it.

T('the string form\'s yes labels itself best-effort evidence and names what it did not prove', () => {
  const carried = gradeLiveness({ status: 200, body: 'build-abc123', expect: 'build-abc123', url: 'https://example.test/' });
  assert.equal(carried.value, LIVE_YES, 'the value is untouched');
  assert.match(carried.why, /best-effort evidence/);
  assert.match(carried.why, /does not prove that the served build is the merged commit/);
  assert.match(carried.why, /carried "build-abc123"/, 'the old sentence survives inside the new one');
  const bare = gradeLiveness({ status: 200, body: 'anything', expect: null, url: 'https://example.test/' });
  assert.equal(bare.value, LIVE_YES);
  assert.match(bare.why, /best-effort evidence/);
  assert.match(bare.why, /does not prove that the served build is the merged commit/);
});

T('the close\'s string verdict yes carries the same best-effort label', () => {
  const r = liveStringVerdict({ results: [{ url: 'https://x/b.mjs', status: 200, hasProof: true }], proof: 'p', mode: 'files' });
  assert.equal(r.value, 'yes');
  assert.match(r.why, /best-effort evidence/);
  assert.match(r.why, /does not prove that the served build is the merged commit/);
  assert.match(r.why, /a string this branch introduced/, 'the novelty sentence survives');
});

T('the sha form\'s yes says deployment identity, on both the exact and the ancestry branch', () => {
  const exact = liveShaVerdict({ served: 'abc1234567', sha: 'abc1234567', isAncestor: false, servedKnown: null });
  assert.equal(exact.value, 'yes');
  assert.match(exact.why, /deployment identity/);
  const anc = liveShaVerdict({ served: 'def4567890', sha: 'abc1234567', isAncestor: true, servedKnown: true });
  assert.equal(anc.value, 'yes');
  assert.match(anc.why, /deployment identity/);
  assert.match(anc.why, /CONTAINS/, 'the ancestry sentence survives');
});

T('RED-PROOF the string label never leaks onto a no or a skip, and the sha label never onto a string yes', () => {
  assert.doesNotMatch(gradeLiveness({ status: 200, body: 'old', expect: 'new', url: 'u' }).why, /best-effort evidence/);
  assert.doesNotMatch(gradeLiveness({ status: 0, body: '', expect: 'x', url: 'u', error: 'boom' }).why, /best-effort evidence/);
  assert.doesNotMatch(gradeLiveness({ status: 200, body: 'x', expect: 'x', url: 'u' }).why, /deployment identity/);
  assert.doesNotMatch(liveShaVerdict({ served: 'old4567890', sha: 'abc1234567', isAncestor: false, servedKnown: true }).why, /deployment identity/);
});

// ---------------------------------------------------------------- the header echo form
//
// `verify: header:<path>:<header-name>` — GET url+path, read ONE response header, pass when its
// value contains the lane's merge commit. It is the sha form for deployments that name their
// release in a header instead of a JSON body, and it carries the sha form's strength: a stale
// build does not know a commit it does not contain. The body is never read, so a body that happens
// to carry the sha counts for nothing here; the fourth assertion below holds that in place.

const SHA = 'abc1234567abc1234567abc1234567abc1234567';
const HDR = { url: 'https://example.test', verify: { kind: 'header', path: '/api/status', header: 'x-release' }, auth: null, timeoutMs: 5000 };

T('header parser: `header:<path>:<header-name>` reads path and header, and lowercases the header name', () => {
  assert.deepEqual(parseVerifyHeader('web', 'header:/api/status:X-Release'), { kind: 'header', path: '/api/status', header: 'x-release' });
  assert.deepEqual(parseVerifyHeader('web', '  header:/:etag  '), { kind: 'header', path: '/', header: 'etag' });
  assert.equal(parseVerifyHeader('web', 'sha:/api/status:release'), null, 'a form this parser does not own falls through');
  assert.equal(parseVerifyHeader('web', 'string'), null);
});

T('RED-PROOF header parser refuses a malformed form rather than guessing a path or a header', () => {
  for (const bad of ['header:', 'header:/api/status', 'header:api/status:X-Release', 'header:/api/status:', 'header:/api/status:Bad Name', 'header::x']) {
    assert.throws(() => parseVerifyHeader('web', bad), /must be header:<path>:<header-name>/, `expected a refusal for "${bad}"`);
  }
});

T('header parser adapter: the one-line adapter accepts the header form and delegates every other form to the policy parser', () => {
  assert.equal(parseVerifyWithHeader('web', 'header:/api/status:X-Release', parseVerify).kind, 'header');
  assert.deepEqual(parseVerifyWithHeader('web', 'sha:/api/status:release', parseVerify), { kind: 'sha', path: '/api/status', field: 'release' });
  assert.deepEqual(parseVerifyWithHeader('web', 'string', parseVerify), { kind: 'string' });
  assert.throws(() => parseVerifyWithHeader('web', 'bogus', parseVerify), /must be sha:<path>:<field>/);
});

T('header form PASSES on containment: the named header carries the merge commit, and the verdict says deployment identity', async () => {
  const f = fakeFetch({ status: 200, headers: { 'X-Release': `build-${SHA}-us-east-1` }, body: 'nothing relevant' });
  const v = await probeHeaderEcho({ config: HDR, sha: SHA, fetchImpl: f });
  assert.equal(v.value, LIVE_YES);
  assert.match(v.why, /deployment identity/);
  assert.match(v.why, /x-release/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://example.test/api/status', 'the probe is url+path, never the bare url');
});

T('RED-PROOF header form FAILS on a missing header: a 200 that cannot name its build is a no, not a pass', async () => {
  const f = fakeFetch({ status: 200, headers: { 'content-type': 'text/html' }, body: 'ok' });
  const v = await probeHeaderEcho({ config: HDR, sha: SHA, fetchImpl: f });
  assert.equal(v.value, LIVE_NO);
  assert.match(v.why, /no `x-release` header/);
  assert.match(v.why, /cannot identify itself/);
});

T('RED-PROOF header form FAILS on a wrong value: another commit in the header is a stale or foreign build', async () => {
  const f = fakeFetch({ status: 200, headers: { 'x-release': 'old9999999old9999999old9999999old9999999' } });
  const v = await probeHeaderEcho({ config: HDR, sha: SHA, fetchImpl: f });
  assert.equal(v.value, LIVE_NO);
  assert.match(v.why, /does NOT contain/);
  assert.match(v.why, /abc12345/);
});

T('RED-PROOF header form reads ONLY the header: a body carrying the sha while the header does not is a no, and the body is never read', async () => {
  const f = fakeFetch({ status: 200, headers: { 'x-release': 'old9999999' }, body: `{"release":"${SHA}"}` });
  const v = await probeHeaderEcho({ config: HDR, sha: SHA, fetchImpl: f });
  assert.equal(v.value, LIVE_NO, 'a sha in the body must not rescue a header that names another build');
  assert.equal(f.bodyReads, 0, 'the header form must not touch the body at all');
  const absent = fakeFetch({ status: 200, headers: {}, body: `{"release":"${SHA}"}` });
  const w = await probeHeaderEcho({ config: HDR, sha: SHA, fetchImpl: absent });
  assert.equal(w.value, LIVE_NO, 'a sha in the body must not stand in for a missing header');
  assert.equal(absent.bodyReads, 0);
});

T('header form containment is case-insensitive on the hex and accepts a short prefix of the commit when the header abbreviates it', async () => {
  const upper = fakeFetch({ status: 200, headers: { 'x-release': SHA.toUpperCase() } });
  assert.equal((await probeHeaderEcho({ config: HDR, sha: SHA, fetchImpl: upper })).value, LIVE_YES);
  const short = fakeFetch({ status: 200, headers: { 'x-release': 'v2.3.1+abc1234' } });
  const v = await probeHeaderEcho({ config: HDR, sha: SHA, fetchImpl: short });
  assert.equal(v.value, LIVE_YES);
  assert.match(v.why, /abbreviated/);
  const tooShort = fakeFetch({ status: 200, headers: { 'x-release': 'abc12' } });
  assert.equal((await probeHeaderEcho({ config: HDR, sha: SHA, fetchImpl: tooShort })).value, LIVE_NO, 'five hex characters are not an identity');
});

T('RED-PROOF header form: a non-200 is a no, an unreachable surface is a skip, and a missing merge commit is a skip', async () => {
  assert.equal((await probeHeaderEcho({ config: HDR, sha: SHA, fetchImpl: fakeFetch({ status: 404 }) })).value, LIVE_NO);
  const dead = await probeHeaderEcho({ config: HDR, sha: SHA, fetchImpl: fakeFetch({ throws: 'ECONNREFUSED' }) });
  assert.equal(dead.value, LIVE_SKIPPED);
  assert.match(dead.why, /a skip is not a pass/);
  const f = fakeFetch({ status: 200, headers: { 'x-release': SHA } });
  const noSha = await probeHeaderEcho({ config: HDR, sha: '', fetchImpl: f });
  assert.equal(noSha.value, LIVE_SKIPPED);
  assert.equal(f.calls.length, 0, 'with nothing to compare against there is nothing to ask');
  assert.match(noSha.why, /a skip is not a pass/);
});

T('RED-PROOF header form: the credential rules are the liveness probe\'s — prefix, no bare send, no redirect, no leak', async () => {
  const outside = { ...HDR, auth: { kind: 'header', header: 'X-Token', envVar: 'AWS_SECRET_ACCESS_KEY' } };
  const f1 = fakeFetch({ status: 200, headers: { 'x-release': SHA } });
  const a = await probeHeaderEcho({ config: outside, sha: SHA, fetchImpl: f1, env: { AWS_SECRET_ACCESS_KEY: 'AKIA-SUPERSECRET' } });
  assert.equal(a.value, LIVE_SKIPPED);
  assert.equal(f1.calls.length, 0);
  assert.doesNotMatch(a.why, /AKIA-SUPERSECRET/);

  const named = { ...HDR, auth: { kind: 'cookie', envVar: 'PANDORAS_WEB_COOKIE' } };
  const f2 = fakeFetch({ status: 200, headers: { 'x-release': SHA } });
  const b = await probeHeaderEcho({ config: named, sha: SHA, fetchImpl: f2, env: {} });
  assert.equal(b.value, LIVE_SKIPPED);
  assert.equal(f2.calls.length, 0, 'never sent bare');

  const f3 = fakeFetch({ status: 302, headers: { location: 'https://elsewhere.test/' } });
  const c = await probeHeaderEcho({ config: named, sha: SHA, fetchImpl: f3, env: { PANDORAS_WEB_COOKIE: 'session=SUPERSECRET' } });
  assert.equal(f3.calls[0].init.redirect, 'manual');
  assert.equal(f3.calls[0].init.headers.cookie, 'session=SUPERSECRET');
  assert.equal(c.value, LIVE_NO);
  assert.match(c.why, /302/);
  assert.doesNotMatch(c.why, /SUPERSECRET/);

  const bare = fakeFetch({ status: 200, headers: { 'x-release': SHA } });
  await probeHeaderEcho({ config: HDR, sha: SHA, fetchImpl: bare });
  assert.equal(bare.calls[0].init.redirect, 'follow', 'a bare probe may follow, there is nothing to leak');
});

T('gradeHeaderEcho is pure, and a header value that is an array or a number is read as its string', () => {
  assert.equal(gradeHeaderEcho({ status: 200, headerValue: [SHA], header: 'x-release', sha: SHA, url: 'u' }).value, LIVE_YES);
  assert.equal(gradeHeaderEcho({ status: 200, headerValue: null, header: 'x-release', sha: SHA, url: 'u' }).value, LIVE_NO);
  assert.equal(gradeHeaderEcho({ status: 500, headerValue: SHA, header: 'x-release', sha: SHA, url: 'u' }).value, LIVE_NO);
  assert.equal(gradeHeaderEcho({ status: 0, headerValue: null, header: 'x-release', sha: SHA, url: 'u', error: 'boom' }).value, LIVE_SKIPPED);
  assert.doesNotMatch(gradeHeaderEcho({ status: 200, headerValue: SHA, header: 'x-release', sha: SHA, url: 'u' }).why, /best-effort/);
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
