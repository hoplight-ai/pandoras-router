#!/usr/bin/env node
// concurrency-test.mjs — two real processes racing the router's state files, written before the
// lock existed and watched red against the unlocked code. No network, no secrets, no model calls.
//
//   node test/concurrency-test.mjs
//
// THE DEFECT, as three independent reviewers of the public repo read it off the code. Every write to
// `_handoffs/_lanes/LANES.md` and `_handoffs/_lanes/CLAIMS.md` was read, concatenate, writeFileSync,
// with nothing between the read and the write. Two dispatchers running `alloc` then `open` at the
// same moment therefore both read an empty board, both prove their scopes clear, and both write —
// two claims, two OPEN rows, two writers in one repo, which is the one thing this router exists to
// refuse. The ledger append had the same shape, so two appends landing together lost one of them.
//
// WHAT THIS FILE PROVES, each against a throwaway workspace built from `examples/`:
//
//   1. DOUBLE-OPEN. Two child processes each open a lane whose declared scope intersects the
//      other's. Exactly one succeeds; the other is refused and the refusal NAMES the winner. The
//      test holds the state lock itself while both children start. lane-open's preview read is
//      unlocked, so both children read the empty board and find their card firing, then both queue
//      on the lock to write — the exact interleaving the reviewers described, forced rather than
//      hoped for. Only the compare-and-set inside the lock can separate them: with it switched off
//      (watched, temporarily) both succeed again. Before the fix there was no lock to hold, so the
//      children simply raced, and both succeeded (watched: "2 did (A exit 0, B exit 0). Claims now
//      active: 2; OPEN rows for ceiling1: 2").
//   2. LEDGER APPEND. Two child processes each append twenty NOTE rows as fast as they can, released
//      on the same instant by a go-file. Every one of the forty rows is intact and present.
//   3. CRASHED HOLDER. A child takes the lock and is SIGKILLed so no exit handler can release it.
//      The next caller breaks the lock, runs, and prints ONE line naming whose lock it was.
//
// And the two properties a lock must have or it is worse than none: a LIVE holder is never broken
// (the caller is refused, by name, after a bounded wait), and a lock older than the stale bound is
// broken whoever holds it. Plus the compare-and-set inside `open`, driven in-process so the exact
// refusal wording is asserted, and the close's release of the claim under the same lock.
//
// `lib/lock.mjs` is loaded dynamically so that its absence is named FAIL rows, not a crash with no
// test names in it — the same shape apply-atomic-test.mjs uses.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const EXAMPLES = path.join(REPO, 'examples');
const LANE_OPEN = path.join(REPO, 'src', 'bin', 'lane-open.mjs');
const CLAIM = path.join(REPO, 'src', 'bin', 'claim.mjs');
const CLOSE = path.join(REPO, 'src', 'bin', 'close.mjs');
const LANES_MJS = pathToFileURL(path.join(REPO, 'src', 'lib', 'lanes.mjs')).href;
const LOCK_MJS = pathToFileURL(path.join(REPO, 'src', 'lib', 'lock.mjs')).href;
const BRIEF = 'Web-CEILING1-Raise-The-Per-Provider-Cap.md';
// `--import` takes a module SPECIFIER, not a filesystem path: on Windows a raw `D:\a\...\x.mjs`
// does not start with `/`, `./` or `../`, so Node's loader reads it as a bare specifier (a package
// name) and fails with an unrelated-looking `node:internal/modules/esm/load` error rather than
// loading the file. A `file://` URL resolves identically on every platform.
const FAKE_LOCK_PRELOAD = pathToFileURL(path.join(HERE, 'fake-windows-lock-error.mjs')).href;

import { parseClaims } from '../src/lib/claims.mjs';
import { parseLanes } from '../src/lib/lanes.mjs';

let lock = null;
let loadError = null;
try {
  lock = await import('../src/lib/lock.mjs');
} catch (e) {
  loadError = String(e.message).split('\n')[0];
}

const tests = [];
const T = (name, fn) => tests.push({ name, fn });
const rx = (s) => new RegExp(String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the throwaway workspace
//
// `_handoffs/_lanes/` from examples/, three repos as PLAIN directories. Plain on purpose: a target
// that is not a git repository opens IN PLACE (see lib/open.mjs), so nothing but the router's own
// records stands between two opens — git's ref locks, which incidentally serialize two worktree
// adds of one branch, are out of the picture and the hole is visible in its purest form.
function makeWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pandoras-conc-'));
  const lanes = path.join(ws, '_handoffs', '_lanes');
  fs.mkdirSync(lanes, { recursive: true });
  for (const f of ['POLICY.md', 'PREFIXES.md', 'CLAIMS.md', 'LANES.md']) {
    fs.copyFileSync(path.join(EXAMPLES, f), path.join(lanes, f));
  }
  for (const repo of ['web', 'repo-a', 'docs']) fs.mkdirSync(path.join(ws, repo));
  fs.copyFileSync(path.join(EXAMPLES, BRIEF), path.join(ws, '_handoffs', BRIEF));
  return ws;
}

const claimsOf = (ws) => fs.readFileSync(path.join(ws, '_handoffs', '_lanes', 'CLAIMS.md'), 'utf8');
const lanesOf = (ws) => fs.readFileSync(path.join(ws, '_handoffs', '_lanes', 'LANES.md'), 'utf8');
const lockFileOf = (ws) => path.join(ws, '_handoffs', '_lanes', '.lock');
const activeClaims = (ws) => parseClaims(claimsOf(ws)).rows.filter((r) => !r.malformed && !r.stale);
const openRows = (ws, lane) => lanesOf(ws).split('\n').filter((l) => l.startsWith(`OPEN | ${lane} |`));

/** Run one child to completion. Resolves, never rejects: the exit code is the assertion's business. */
function run(args, ws, { timeoutMs = 30_000, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: ws,
      env: { ...process.env, PANDORAS_ROOT: ws, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (status, signal) => {
      clearTimeout(killer);
      resolve({ status, signal, stdout, stderr, pid: child.pid });
    });
  });
}

const inline = (script, ws, args) => run(['--input-type=module', '-e', script, '--', ...args], ws);

// ---------------------------------------------------------------- premise
T('premise: lib/lock.mjs loads and exports withLock and acquireLock', () => {
  assert.equal(loadError, null, `lib/lock.mjs did not load: ${loadError}`);
  assert.equal(typeof lock.withLock, 'function');
  assert.equal(typeof lock.acquireLock, 'function');
});

// ---------------------------------------------------------------- RACE 1: double-open
T('RED-PROOF double-open: two processes open lanes with intersecting scopes — exactly one succeeds, the other is refused naming the winner', async () => {
  const ws = makeWorkspace();
  try {
    const chatA = 'Web CEILING1 (dispatch A)';
    const chatB = 'Web CEILING1 (dispatch B)';
    // Hold the state lock while both children start, read the board and queue on the lock to write;
    // three seconds covers two node start-ups and two allocator reads with room to spare. Without the
    // lock module there is nothing to hold and the children simply race.
    const release = lock ? lock.acquireLock(ws) : null;
    const pa = run([LANE_OPEN, BRIEF, '--chat', chatA], ws);
    const pb = run([LANE_OPEN, BRIEF, '--chat', chatB], ws);
    if (release) { await sleep(3000); release(); }
    const [ra, rb] = await Promise.all([pa, pb]);
    const both = [{ ...ra, chat: chatA }, { ...rb, chat: chatB }];
    const ok = both.filter((r) => r.status === 0);
    const refused = both.filter((r) => r.status !== 0);
    assert.equal(
      ok.length, 1,
      `exactly one open may succeed; ${ok.length} did (A exit ${ra.status}, B exit ${rb.status}). `
      + `Claims now active: ${activeClaims(ws).length}; OPEN rows for ceiling1: ${openRows(ws, 'ceiling1').length}`,
    );
    assert.equal(refused.length, 1);
    assert.match(ok[0].stdout, /lane-open OK — ceiling1/);
    // Refused BY NAME: the loser's refusal carries the winner's chat title, not a bare "queued".
    assert.match(refused[0].stderr, /lane-open REFUSED/);
    assert.match(refused[0].stderr, rx(ok[0].chat), `the refusal must name the holder "${ok[0].chat}"`);
    // And the disk agrees: one active claim, one OPEN row, both the winner's.
    const claims = activeClaims(ws);
    assert.equal(claims.length, 1, `one active claim, got ${claims.length}`);
    assert.equal(claims[0].chat, ok[0].chat);
    assert.equal(openRows(ws, 'ceiling1').length, 1, 'one OPEN row for the lane');
    assert.ok(!fs.existsSync(lockFileOf(ws)), 'no lock left behind');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------- CONCFLAKE1: Windows create-exclusive
// Reproduces the two shapes CI actually lost on windows-latest/Node 24, 2026-09-15, by faking a
// non-EEXIST error out of `fs.openSync(lockPath, 'wx')` via fake-windows-lock-error.mjs (see that
// file's header) — the shape a Windows sharing violation would surface as, which this Mac cannot
// produce for real. Both races below are the SAME two tests above, run with the fault injected;
// the assertions are identical to double-open's and claim-take's, so this proves the fix handles
// the fault without loosening either original assertion.
T('RED-PROOF windows contention (double-open shape): one child hits a non-EEXIST error from the exclusive-create on its first attempt — exactly one open still succeeds, the other is still refused by name', async () => {
  const ws = makeWorkspace();
  try {
    const chatA = 'Web CEILING1 (dispatch A)';
    const chatB = 'Web CEILING1 (dispatch B)';
    const release = lock ? lock.acquireLock(ws) : null;
    const pa = run(['--import', FAKE_LOCK_PRELOAD, LANE_OPEN, BRIEF, '--chat', chatA], ws, {
      env: { FAKE_LOCK_ERROR_CODE: 'EPERM', FAKE_LOCK_ERROR_CALLS: '1' },
    });
    const pb = run([LANE_OPEN, BRIEF, '--chat', chatB], ws);
    if (release) { await sleep(3000); release(); }
    const [ra, rb] = await Promise.all([pa, pb]);
    const both = [{ ...ra, chat: chatA }, { ...rb, chat: chatB }];
    const ok = both.filter((r) => r.status === 0);
    const refused = both.filter((r) => r.status !== 0);
    assert.equal(
      ok.length, 1,
      `exactly one open may succeed; ${ok.length} did (A exit ${ra.status}, B exit ${rb.status}). `
      + `A stderr: ${ra.stderr.split('\n')[0]}`,
    );
    assert.equal(refused.length, 1);
    assert.match(refused[0].stderr, /lane-open REFUSED/, `the refused side must print a refusal, not crash uncaught — got: ${refused[0].stderr.split('\n')[0]}`);
    assert.match(refused[0].stderr, rx(ok[0].chat));
    assert.ok(!fs.existsSync(lockFileOf(ws)), 'no lock left behind');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

T('RED-PROOF windows contention (claim-take shape): BOTH children hit a non-EEXIST error from the exclusive-create on their first attempt — exactly one claim is still TAKEN, not zero', async () => {
  const ws = makeWorkspace();
  try {
    const release = lock ? lock.acquireLock(ws) : null;
    const pa = run(['--import', FAKE_LOCK_PRELOAD, CLAIM, 'take', 'repo-a', '--as', 'Direct A', '--why', 'racing'], ws, {
      env: { FAKE_LOCK_ERROR_CODE: 'EBUSY', FAKE_LOCK_ERROR_CALLS: '1' },
    });
    const pb = run(['--import', FAKE_LOCK_PRELOAD, CLAIM, 'take', 'repo-a', '--as', 'Direct B', '--why', 'racing'], ws, {
      env: { FAKE_LOCK_ERROR_CODE: 'EBUSY', FAKE_LOCK_ERROR_CALLS: '1' },
    });
    if (release) { await sleep(800); release(); }
    const [ra, rb] = await Promise.all([pa, pb]);
    const taken = [ra, rb].filter((r) => /claim TAKEN/.test(r.stdout));
    const refused = [ra, rb].filter((r) => /writer cap/.test(r.stderr));
    assert.equal(taken.length, 1, `exactly one TAKEN; got ${taken.length} (A exit ${ra.status}, B exit ${rb.status}); A stderr: ${ra.stderr.split('\n')[0]}; B stderr: ${rb.stderr.split('\n')[0]}; active claims on disk: ${activeClaims(ws).length}`);
    assert.equal(refused.length, 1, `the other must be refused at the writer cap, not crash uncaught; A stderr: ${ra.stderr.split('\n')[0]}; B stderr: ${rb.stderr.split('\n')[0]}`);
    assert.equal(activeClaims(ws).length, 1);
    assert.ok(!fs.existsSync(lockFileOf(ws)), 'no lock left behind');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- RACE 2: ledger append
T('RED-PROOF ledger append: two processes x twenty appends, released together — forty intact rows, none lost', async () => {
  const ws = makeWorkspace();
  try {
    // A ledger with history in it, the size a working board reaches in a few weeks. On the example's
    // near-empty ledger each unlocked append is a few microseconds, and the two children could finish
    // all twenty without ever overlapping: watched once, the race passed on the unlocked code by luck
    // of timing. With history the read-to-write window is wide enough that the unlocked code loses
    // rows every run, which is what makes this a proof rather than a coin toss.
    const history = Array.from({ length: 6000 }, (_, i) => `NOTE | history${i} | an older record kept for its bytes | 2026-09-01T00:00:00.000Z`).join('\n');
    fs.appendFileSync(path.join(ws, '_handoffs', '_lanes', 'LANES.md'), `\n${history}\n`);
    const go = path.join(ws, 'go');
    const script = `
      import fs from 'node:fs';
      import { recordNote } from ${JSON.stringify(LANES_MJS)};
      const [root, who, go] = process.argv.slice(1);
      fs.writeFileSync(root + '/ready-' + who, '');
      const until = Date.now() + 10_000;
      while (!fs.existsSync(go) && Date.now() < until) { /* spin: a sleep here would stagger the two starts */ }
      for (let i = 0; i < 20; i++) recordNote(root, 'lane-' + who, 'append ' + who + ' ' + i);
    `;
    const pa = inline(script, ws, [ws, 'A', go]);
    const pb = inline(script, ws, [ws, 'B', go]);
    // Wait until both children are spinning on the go-file, then release them on one instant.
    const until = Date.now() + 10_000;
    while (!(fs.existsSync(path.join(ws, 'ready-A')) && fs.existsSync(path.join(ws, 'ready-B'))) && Date.now() < until) await sleep(5);
    fs.writeFileSync(go, '');
    const [ra, rb] = await Promise.all([pa, pb]);
    assert.equal(ra.status, 0, `child A failed: ${ra.stderr}`);
    assert.equal(rb.status, 0, `child B failed: ${rb.stderr}`);

    const text = lanesOf(ws);
    const survived = (p) => text.split('\n').filter((l) => l.startsWith(p)).length;
    assert.ok(
      text.startsWith('# LANES'),
      `the header is intact — it is not: the ledger was truncated under a reader and written back; `
      + `${survived('NOTE | history')} of 6000 history rows and ${survived('NOTE | lane-')} of 40 new rows survive`,
    );
    assert.equal(text.split('\n').filter((l) => l.startsWith('NOTE | history')).length, 6000, 'every history row survived as well');
    const rows = text.split('\n').filter((l) => l.startsWith('NOTE | lane-'));
    const shape = /^NOTE \| lane-([AB]) \| append \1 (\d+) \| \d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
    const bad = rows.filter((l) => !shape.test(l));
    assert.deepEqual(bad, [], `every NOTE row must be intact; ${bad.length} torn: ${bad.slice(0, 3).join(' / ')}`);
    const seen = new Set(rows.map((l) => `${shape.exec(l)[1]}${shape.exec(l)[2]}`));
    assert.equal(rows.length, 40, `40 appends were made and ${rows.length} rows survive — ${40 - rows.length} lost to the read-then-write race`);
    assert.equal(seen.size, 40, 'all forty (process, index) pairs are present');
    assert.ok(!fs.existsSync(lockFileOf(ws)), 'no lock left behind');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- RACE 3: crashed holder
T('RED-PROOF crashed holder: a lock left by a SIGKILLed process is broken by the next caller, with one printed line naming it', async () => {
  assert.equal(loadError, null, `lib/lock.mjs did not load: ${loadError}`);
  const ws = makeWorkspace();
  try {
    const script = `
      import { acquireLock } from ${JSON.stringify(LOCK_MJS)};
      acquireLock(process.argv[1]);
      process.kill(process.pid, 'SIGKILL'); // no exit handler runs; the lock file stays behind
    `;
    const r = await inline(script, ws, [ws]);
    // Windows has no signals to die by: process.kill(pid, 'SIGKILL') is TerminateProcess, which ends
    // the child just as abruptly (no exit handler runs) and reports exit code 1 with no signal.
    if (process.platform === 'win32') assert.ok(r.signal === null && r.status !== 0, `the child was meant to be terminated, got exit ${r.status} signal ${r.signal} ${r.stderr}`);
    else assert.equal(r.signal, 'SIGKILL', `the child was meant to die by signal, got exit ${r.status} ${r.stderr}`);
    assert.ok(fs.existsSync(lockFileOf(ws)), 'the crashed child left its lock behind (the premise of this test)');
    const holder = JSON.parse(fs.readFileSync(lockFileOf(ws), 'utf8'));
    assert.equal(holder.pid, r.pid, 'the lock names the pid that took it');

    const printed = [];
    let ran = false;
    const out = lock.withLock(ws, () => { ran = true; return 'ran'; }, { log: (l) => printed.push(l) });
    assert.equal(out, 'ran');
    assert.ok(ran, 'the next caller ran its section');
    assert.equal(printed.length, 1, `exactly one printed line, got ${printed.length}: ${printed.join(' // ')}`);
    assert.match(printed[0], rx(`pid ${r.pid}`), 'the line names whose lock it was');
    assert.match(printed[0], /not alive/, 'and why it was broken');
    assert.ok(!fs.existsSync(lockFileOf(ws)), 'released cleanly after');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- a LIVE holder is never broken
T('RED-PROOF live holder: a lock held by a running process is NOT broken — the caller is refused by name after the bounded wait, then runs once it is released', async () => {
  assert.equal(loadError, null, `lib/lock.mjs did not load: ${loadError}`);
  const ws = makeWorkspace();
  try {
    const script = `
      import fs from 'node:fs';
      import { acquireLock } from ${JSON.stringify(LOCK_MJS)};
      const release = acquireLock(process.argv[1]);
      fs.writeFileSync(process.argv[1] + '/holding', '');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
      release();
    `;
    const p = inline(script, ws, [ws]);
    const until = Date.now() + 5000;
    while (!fs.existsSync(path.join(ws, 'holding')) && Date.now() < until) await sleep(5);
    assert.ok(fs.existsSync(lockFileOf(ws)), 'the child holds the lock');

    let refusal = null;
    const printed = [];
    try {
      lock.withLock(ws, () => { throw new Error('the section must NOT run while a live process holds the lock'); }, { waitMs: 400, log: (l) => printed.push(l) });
    } catch (e) {
      refusal = e;
    }
    assert.ok(refusal, 'a refusal was thrown');
    assert.equal(refusal.code, 'LOCK_HELD');
    assert.match(refusal.message, /REFUSED/);
    const r = await p;
    assert.match(refusal.message, rx(`pid ${r.pid}`), 'the refusal names the holder');
    assert.deepEqual(printed, [], 'nothing was broken');
    assert.equal(r.status, 0, `the holder exited clean: ${r.stderr}`);
    assert.ok(!fs.existsSync(lockFileOf(ws)), 'the holder released its own lock on the way out');
    let ran = false;
    lock.withLock(ws, () => { ran = true; }, { log: (l) => printed.push(l) });
    assert.ok(ran, 'once released, the same caller runs');
    assert.deepEqual(printed, [], 'and still nothing was broken');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the age bound, and re-entrancy
T('RED-PROOF stale by age: a lock older than the stale bound is broken whoever holds it, and the line says how old it was', () => {
  assert.equal(loadError, null, `lib/lock.mjs did not load: ${loadError}`);
  const ws = makeWorkspace();
  try {
    const old = new Date(Date.now() - lock.STALE_MS - 5 * 60_000).toISOString();
    // A live pid on another host: the pid means nothing here, so only the age can break it.
    fs.writeFileSync(lockFileOf(ws), JSON.stringify({ pid: process.pid, host: 'some-other-host', at: old, by: 'lane-open.mjs', nonce: 'x' }));
    const printed = [];
    let ran = false;
    lock.withLock(ws, () => { ran = true; }, { log: (l) => printed.push(l) });
    assert.ok(ran);
    assert.equal(printed.length, 1);
    assert.match(printed[0], /some-other-host/);
    assert.match(printed[0], /old/);
    assert.ok(!fs.existsSync(lockFileOf(ws)));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

T('re-entrant: a locked section that locks again runs inline, and the outer release is the one that lets go', () => {
  assert.equal(loadError, null, `lib/lock.mjs did not load: ${loadError}`);
  const ws = makeWorkspace();
  try {
    const out = lock.withLock(ws, () => {
      assert.ok(fs.existsSync(lockFileOf(ws)), 'held by the outer section');
      const inner = lock.withLock(ws, () => 'inner');
      assert.ok(fs.existsSync(lockFileOf(ws)), 'the inner release did not drop the outer lock');
      return inner;
    });
    assert.equal(out, 'inner');
    assert.ok(!fs.existsSync(lockFileOf(ws)), 'released once the outer section ends');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the compare-and-set, in-process
T('RED-PROOF open is a compare-and-set: a lane that opened between the allocator read and the write refuses in the allocator\'s own words, and writes nothing', async () => {
  const ws = makeWorkspace();
  try {
    const { gather, decide } = await import('../src/bin/lane-alloc.mjs');
    const { openCasVerdict } = await import('../src/lib/open.mjs');
    const { appendClaim } = await import('../src/lib/claims.mjs');
    const { recordOpen } = await import('../src/lib/lanes.mjs');
    assert.equal(typeof decide, 'function', 'lane-alloc exports decide(), the re-read half of gather()');
    assert.equal(typeof openCasVerdict, 'function', 'lib/open.mjs exports openCasVerdict()');

    const r = gather({ root: ws, limit: 999 });
    const card = r.cards.find((c) => c.brief === BRIEF);
    assert.ok(card, 'the brief is carded');
    assert.equal(card.firesAfter, null, 'and fires now on an empty board');

    // The world moves: another dispatcher opened a lane whose scope overlaps ours.
    const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    appendClaim(ws, { repo: 'web', chat: 'Web POOL2 (someone else)', stamp, session: 'dispatch-lane-pool2' });
    recordOpen(ws, { lane: 'pool2', repo: 'web', branch: '-', worktree: '-', port: null, report: 'done-x-web-pool2.md', scope: ['src/providers/pool.ts'], session: 'dispatch-lane-pool2', stamp, base: null });

    const fresh = decide(r);
    const freshCard = fresh.cards.find((c) => c.brief === BRIEF);
    const cas = openCasVerdict({ card, freshCard, queued: false });
    assert.equal(cas.ok, false, 'the re-check under the lock refuses');
    assert.match(cas.why, /Web POOL2 \(someone else\)/, 'and names the holder');
    assert.match(cas.why, /scopes overlap at src\/providers\/pool\.ts/, 'in the allocator\'s own words');
    assert.equal(cas.blockedBy?.session, 'dispatch-lane-pool2');

    // Unmoved world: the same card re-read passes. --queued past the SAME reason passes; past a NEW one does not.
    assert.equal(openCasVerdict({ card, freshCard: card, queued: false }).ok, true);
    const queuedCard = { ...card, firesAfter: freshCard.firesAfter };
    assert.equal(openCasVerdict({ card: queuedCard, freshCard, queued: true }).ok, true, '--queued overrides the reason the dispatcher was shown');
    assert.equal(openCasVerdict({ card, freshCard, queued: true }).ok, false, '--queued does not override a reason that appeared after the card was printed');
    assert.equal(openCasVerdict({ card, freshCard: null, queued: true }).ok, false, 'a card that vanished refuses');
    assert.equal(activeClaims(ws).length, 1, 'nothing was written by the verdict itself');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- direct claims race the same way
T('RED-PROOF claim take: two processes take a writers:1 repo at once — exactly one is TAKEN, the other refused at the cap', async () => {
  const ws = makeWorkspace();
  try {
    const release = lock ? lock.acquireLock(ws) : null;
    const pa = run([CLAIM, 'take', 'repo-a', '--as', 'Direct A', '--why', 'racing'], ws);
    const pb = run([CLAIM, 'take', 'repo-a', '--as', 'Direct B', '--why', 'racing'], ws);
    if (release) { await sleep(800); release(); }
    const [ra, rb] = await Promise.all([pa, pb]);
    const taken = [ra, rb].filter((r) => /claim TAKEN/.test(r.stdout));
    const refused = [ra, rb].filter((r) => /writer cap/.test(r.stderr));
    assert.equal(taken.length, 1, `exactly one TAKEN; got ${taken.length} (A exit ${ra.status}, B exit ${rb.status}); active claims on disk: ${activeClaims(ws).length}`);
    assert.equal(refused.length, 1, 'the other is refused at the writer cap');
    assert.equal(activeClaims(ws).length, 1);
    assert.equal(activeClaims(ws)[0].repo, 'repo-a');
    assert.ok(!fs.existsSync(lockFileOf(ws)), 'no lock left behind');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- close: CLOSE row + release, one section
T('close --apply records the CLOSE row and releases the lane\'s claim, under the lock, and leaves no lock behind', async () => {
  const ws = makeWorkspace();
  try {
    fs.writeFileSync(path.join(ws, '_handoffs', 'Docs-NOTE1-Tidy-The-Index.md'), [
      '# NOTE1 — tidy the index', '', '## RUN THIS IN', '', '- **Folder:** `docs`', '- **Touches:** `README.md`', '- **Priority:** 1', '',
    ].join('\n'));
    const opened = await run([LANE_OPEN, 'Docs-NOTE1-Tidy-The-Index.md', '--chat', 'Docs NOTE1'], ws);
    assert.equal(opened.status, 0, `open failed: ${opened.stderr}`);
    assert.equal(activeClaims(ws).filter((c) => c.repo === 'docs').length, 1, 'the open wrote its claim');
    assert.equal(openRows(ws, 'note1').length, 1, 'and its OPEN row');

    const closed = await run([CLOSE, 'note1', '--apply', '--no-build'], ws);
    assert.equal(closed.status, 0, `close failed: ${closed.stderr}\n${closed.stdout}`);
    assert.match(closed.stdout, /recorded\s+a CLOSE row/);
    assert.match(closed.stdout, /released/);
    const lanes = parseLanes(lanesOf(ws)).find((l) => l.lane === 'note1');
    assert.ok(lanes && lanes.status !== 'OPEN', 'the ledger folds a CLOSE onto the lane');
    assert.equal(activeClaims(ws).filter((c) => c.repo === 'docs').length, 0, 'the claim is released');
    assert.match(claimsOf(ws), /# RELEASED .*`dispatch-lane-note1`/, 'as commented history, never deleted');
    assert.ok(!fs.existsSync(lockFileOf(ws)), 'no lock left behind');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- run
let pass = 0;
const fails = [];
for (const t of tests) {
  try { await t.fn(); pass++; } catch (e) { fails.push({ name: t.name, message: e.message }); }
}
for (const f of fails) console.log(`FAIL  ${f.name}\n      ${String(f.message).split('\n')[0]}`);
console.log('');
console.log(`CONCURRENCY ASSERTIONS  ${pass}/${tests.length} pass, ${fails.length} fail`);
console.log(`  ${tests.filter((t) => t.name.startsWith('RED-PROOF')).length} of them are RED-PROOF: each races two real processes or asserts a refusal, so removing the lock turns them red.`);
if (fails.length) throw new Error(`concurrency-test.mjs: ${fails.length}/${tests.length} assertion(s) failed.`);
