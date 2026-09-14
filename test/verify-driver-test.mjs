// verify-driver-test.mjs: the close driver runs the proof the policy's `verify` column names.
//
// WHY END TO END. The library has three ways to prove a deploy (a body string, a JSON field echoing
// the commit, a response header echoing it) and they are all unit-tested. The defect this suite
// holds shut was one level up: the shipped driver never read the `verify` column, so a repo whose
// policy said `sha:` was graded by the string probe, and a yes that called itself "best-effort" was
// all anyone got. A unit test cannot see that, because every unit is correct. So each assertion here
// builds a throwaway workspace from examples/, starts a local HTTP server in this process, and runs
// src/bin/close.mjs as a child process against it, then reads the `live` row the driver printed.
//
// THE FALLBACK TRAP. The server answers 200 with the liveness row's expect string on `/` in every
// test. A driver that quietly falls back to the string probe when the sha or header probe cannot
// reach its endpoint would read `yes` there, and the no-fallback assertions catch exactly that.
//
// No live site is ever asked. Every URL is 127.0.0.1.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const EXAMPLES = path.join(REPO, 'examples');
const CLOSE = path.join(REPO, 'src', 'bin', 'close.mjs');

const tests = [];
const T = (name, fn) => tests.push({ name, fn });

const MARKER = 'web-marker-served-on-root';
const LANE = 'verify1probe';
const BRANCH = 'lane-verify1probe';

// ---------------------------------------------------------------- the local server
//
// One server for the whole suite. `state` says what each route answers; a test sets it, runs the
// close, and reads the verdict. `/` always answers 200 with MARKER, which is the string form's bait.
const state = { routes: {} };
const server = http.createServer((req, res) => {
  const route = state.routes[req.url.split('?')[0]];
  if (req.url === '/' && !route) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><body>${MARKER}</body></html>`);
    return;
  }
  if (!route) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(route.status ?? 200, route.headers ?? { 'content-type': 'application/json' });
  res.end(route.body ?? '');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
const BASE = `http://127.0.0.1:${PORT}`;

// A port that answers nothing: bind one, note it, close it.
const deadPort = await new Promise((resolve) => {
  const s = http.createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = /** @type {import('node:net').AddressInfo} */ (s.address()).port;
    s.close(() => resolve(p));
  });
});

// ---------------------------------------------------------------- the throwaway workspace
//
// `_handoffs/_lanes/` from examples/, with the `web` repo's verify form and url rewritten to point
// here. `web` is a real git repository: a stale commit on main, a lane branch with one commit, and a
// merge of that branch into main, so "a later deploy on top" has a real commit to name.
const g = (dir, args) => execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function makeWorkspace({ verify, repoUrl = BASE, livenessUrl = `${BASE}/`, scripts = null }) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pandoras-verify-'));
  const lanes = path.join(ws, '_handoffs', '_lanes');
  fs.mkdirSync(lanes, { recursive: true });
  for (const f of ['PREFIXES.md', 'CLAIMS.md', 'LANES.md']) fs.copyFileSync(path.join(EXAMPLES, f), path.join(lanes, f));

  const policy = fs.readFileSync(path.join(EXAMPLES, 'POLICY.md'), 'utf8')
    .replace('| `web` | 1 | 3 | product | 5173 | push | `sha:/api/status:release` | https://web.example.com |',
      `| \`web\` | 1 | 3 | product | 5173 | push | \`${verify}\` | ${repoUrl} |`)
    .replace('| `web` | https://web.example.com/ | - | - | - |',
      `| \`web\` | ${livenessUrl} | \`${MARKER}\` | - | 2000 |`);
  assert.ok(policy.includes(`\`${verify}\``) && policy.includes(livenessUrl), 'premise: the example policy rows this suite rewrites are still spelled as expected');
  fs.writeFileSync(path.join(lanes, 'POLICY.md'), policy);

  const web = path.join(ws, 'web');
  fs.mkdirSync(web);
  g(web, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(web, 'README.md'), 'stale\n');
  if (scripts) fs.writeFileSync(path.join(web, 'package.json'), JSON.stringify({ name: 'web', private: true, scripts }, null, 2));
  g(web, ['add', '-A']);
  g(web, ['commit', '-q', '-m', 'stale']);
  const stale = g(web, ['rev-parse', 'HEAD']);
  g(web, ['checkout', '-q', '-b', BRANCH]);
  fs.writeFileSync(path.join(web, 'page.txt'), 'this lane\n');
  g(web, ['add', '-A']);
  g(web, ['commit', '-q', '-m', 'the lane']);
  const tip = g(web, ['rev-parse', 'HEAD']);
  g(web, ['checkout', '-q', 'main']);
  g(web, ['merge', '-q', '--no-ff', '-m', 'land the lane', BRANCH]);
  const onTop = g(web, ['rev-parse', 'HEAD']);

  fs.appendFileSync(path.join(lanes, 'LANES.md'), `OPEN | ${LANE} | web | ${BRANCH} | - | - | - | . | test-session | 2026-09-14T00:00:00.000Z | ${stale}\n`);
  return { ws, stale, tip, onTop };
}

/** Run the close as a child process. Resolves, never rejects: the exit code is the assertion's business. */
function close(ws, extra = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLOSE, LANE, '--no-build', ...extra], {
      cwd: ws,
      env: { ...process.env, PANDORAS_ROOT: ws },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const killer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (status) => {
      clearTimeout(killer);
      const m = /^\s+live\s+(\S+)\s+(.*)$/m.exec(stdout);
      resolve({ status, stdout, stderr, live: m ? { value: m[1], note: m[2] } : null });
    });
  });
}

async function withWorkspace(opts, fn) {
  const w = makeWorkspace(opts);
  try {
    await fn(w);
  } finally {
    state.routes = {};
    fs.rmSync(w.ws, { recursive: true, force: true });
  }
}

const liveOf = (r) => {
  assert.ok(r.live, `the close printed no live row (exit ${r.status}): ${r.stderr.split('\n')[0] || r.stdout.slice(0, 300)}`);
  return r.live;
};
const notString = (note) => {
  assert.doesNotMatch(note, /best-effort/, 'the string probe ran: its best-effort caveat is on this verdict');
  assert.doesNotMatch(note, new RegExp(MARKER), 'the string probe ran: the root marker is named in this verdict');
};

// ---------------------------------------------------------------- sha
T('sha form: a deployment serving a commit that contains the lane passes, and the verdict names the sha proof', async () => {
  await withWorkspace({ verify: 'sha:/api/status:release' }, async ({ ws, onTop }) => {
    state.routes['/api/status'] = { body: JSON.stringify({ release: onTop }) };
    const live = liveOf(await close(ws));
    assert.equal(live.value, 'yes', live.note);
    assert.match(live.note, /sha form/);
    assert.match(live.note, /deployment identity/);
    notString(live.note);
  });
});

T('RED-PROOF sha form: a deployment serving a stale commit fails, even though the root page carries the string', async () => {
  await withWorkspace({ verify: 'sha:/api/status:release' }, async ({ ws, stale }) => {
    state.routes['/api/status'] = { body: JSON.stringify({ release: stale }) };
    const live = liveOf(await close(ws));
    assert.equal(live.value, 'no', live.note);
    assert.match(live.note, /sha form/);
    notString(live.note);
  });
});

T('RED-PROOF sha form, no fallback: an endpoint that 404s does not pass and the string probe never runs', async () => {
  await withWorkspace({ verify: 'sha:/api/status:release' }, async ({ ws }) => {
    const live = liveOf(await close(ws));
    assert.notEqual(live.value, 'yes', `a 404 sha endpoint passed: ${live.note}`);
    assert.ok(['no', 'skip'].includes(live.value), live.note);
    assert.match(live.note, /sha form/);
    assert.match(live.note, /404/);
    notString(live.note);
  });
});

T('RED-PROOF sha form, no fallback: an unreachable endpoint skips with the reason while the liveness url is serving the string', async () => {
  await withWorkspace({ verify: 'sha:/api/status:release', repoUrl: `http://127.0.0.1:${deadPort}` }, async ({ ws }) => {
    const live = liveOf(await close(ws));
    assert.equal(live.value, 'skip', live.note);
    assert.match(live.note, /sha form/);
    assert.match(live.note, /could not be reached/);
    notString(live.note);
  });
});

// ---------------------------------------------------------------- header
T('header form: a header naming a commit that contains the lane passes, and the verdict names the header proof', async () => {
  await withWorkspace({ verify: 'header:/api/status:X-Release' }, async ({ ws, onTop }) => {
    state.routes['/api/status'] = { headers: { 'x-release': onTop }, body: 'ok' };
    const live = liveOf(await close(ws));
    assert.equal(live.value, 'yes', live.note);
    assert.match(live.note, /header form/);
    assert.match(live.note, /deployment identity/);
    notString(live.note);
  });
});

T('header form: a header naming the lane commit itself passes', async () => {
  await withWorkspace({ verify: 'header:/api/status:X-Release' }, async ({ ws, tip }) => {
    state.routes['/api/status'] = { headers: { 'x-release': tip }, body: 'ok' };
    const live = liveOf(await close(ws));
    assert.equal(live.value, 'yes', live.note);
    assert.match(live.note, /header form/);
  });
});

T('RED-PROOF header form: a header naming a stale commit fails, even though the root page carries the string', async () => {
  await withWorkspace({ verify: 'header:/api/status:X-Release' }, async ({ ws, stale }) => {
    state.routes['/api/status'] = { headers: { 'x-release': stale }, body: 'ok' };
    const live = liveOf(await close(ws));
    assert.equal(live.value, 'no', live.note);
    assert.match(live.note, /header form/);
    notString(live.note);
  });
});

T('RED-PROOF header form, no fallback: an endpoint that 404s does not pass and the string probe never runs', async () => {
  await withWorkspace({ verify: 'header:/api/status:X-Release' }, async ({ ws }) => {
    const live = liveOf(await close(ws));
    assert.notEqual(live.value, 'yes', `a 404 header endpoint passed: ${live.note}`);
    assert.match(live.note, /header form/);
    assert.match(live.note, /404/);
    notString(live.note);
  });
});

// ---------------------------------------------------------------- string, script, none
T('string form: the driver runs today\'s probe against the liveness row, and its yes keeps the best-effort label', async () => {
  await withWorkspace({ verify: 'string' }, async ({ ws }) => {
    const live = liveOf(await close(ws));
    assert.equal(live.value, 'yes', live.note);
    assert.match(live.note, /string form/);
    assert.match(live.note, /best-effort/);
  });
});

T('RED-PROOF string form: --proof still replaces the expect string, and a string the page does not carry fails', async () => {
  await withWorkspace({ verify: 'string' }, async ({ ws }) => {
    const live = liveOf(await close(ws, ['--proof', 'a-string-nobody-served']));
    assert.equal(live.value, 'no', live.note);
    assert.match(live.note, /string form/);
  });
});

T('RED-PROOF script form: the named npm script runs in the lane checkout and its exit code is the grade, both ways', async () => {
  await withWorkspace({ verify: 'script:proof', scripts: { proof: 'node -e "process.exit(0)"' } }, async ({ ws }) => {
    const live = liveOf(await close(ws));
    assert.equal(live.value, 'yes', live.note);
    assert.match(live.note, /script form/);
    assert.match(live.note, /exit code/);
    notString(live.note);
  });
  await withWorkspace({ verify: 'script:proof', scripts: { proof: 'node -e "process.exit(3)"' } }, async ({ ws }) => {
    const live = liveOf(await close(ws));
    assert.equal(live.value, 'no', live.note);
    assert.match(live.note, /script form/);
    assert.match(live.note, /exited 3/);
    notString(live.note);
  });
});

T('RED-PROOF script form: a script the checkout does not declare is a skip naming it, never a pass and never the string probe', async () => {
  await withWorkspace({ verify: 'script:proof', scripts: { other: 'node -e "process.exit(0)"' } }, async ({ ws }) => {
    const live = liveOf(await close(ws));
    assert.equal(live.value, 'skip', live.note);
    assert.match(live.note, /script form/);
    assert.match(live.note, /proof/);
    notString(live.note);
  });
});

T('RED-PROOF none form: the gate records n/a and says the policy asked for no proof; no probe is sent', async () => {
  await withWorkspace({ verify: 'none' }, async ({ ws }) => {
    const live = liveOf(await close(ws));
    assert.equal(live.value, 'n/a', live.note);
    assert.match(live.note, /none/);
    notString(live.note);
  });
});

// ---------------------------------------------------------------- unknown
T('RED-PROOF an unknown verify form refuses at load, and the refusal lists every valid form', async () => {
  await withWorkspace({ verify: 'etag:/api/status' }, async ({ ws }) => {
    const r = await close(ws);
    assert.notEqual(r.status, 0, 'the close ran on a policy with an unknown verify form');
    assert.equal(r.live, null, 'a live row was printed for a policy that should not have loaded');
    for (const form of ['sha:<path>:<jsonField>', 'header:<path>:<headerName>', 'string', 'script:<name>', 'none']) {
      assert.ok(r.stderr.includes(form), `the refusal does not name the valid form ${form}: ${r.stderr.split('\n')[0]}`);
    }
  });
});

// ---------------------------------------------------------------- run

let pass = 0;
const fails = [];
try {
  for (const t of tests) {
    try { await t.fn(); pass++; } catch (e) { fails.push({ name: t.name, message: e.message }); }
  }
} finally {
  await new Promise((r) => server.close(r));
}
for (const f of fails) console.log(`FAIL  ${f.name}\n      ${String(f.message).split('\n')[0]}`);
const red = tests.filter((t) => t.name.startsWith('RED-PROOF')).length;
console.log(`VERIFY DRIVER ASSERTIONS  ${pass}/${tests.length} pass, ${fails.length} fail`);
console.log(`  ${red} of them are RED-PROOF: each runs the real close driver against a local server and asserts the proof the policy named, not the string probe.`);
if (fails.length) throw new Error(`verify-driver-test.mjs: ${fails.length}/${tests.length} assertion(s) failed.`);
