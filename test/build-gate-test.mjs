// build-gate-test.mjs: the `green` gate, end to end, against fake npm executables.
//
// WHY END TO END. The close runs a lane's own `npm run build` on the dispatcher's machine and grades
// it. For a long time nothing tested that at all: the gate was a private function in the driver, and
// the only assertion near it checked how the grader treats the word `yes`. What a reviewer listed as
// unproven is all about the child process, not the grade: the right checkout, a captured failure, a
// missing npm, a hung build, a killed build, unbounded output, and a green build on a base that
// predates a neighbour's landing. None of that is visible to a unit test of a pure function, so each
// assertion here builds a throwaway workspace from examples/, writes a fake `npm` into a directory
// placed first on PATH, runs src/bin/close.mjs as a child process, and reads the `green` row it
// printed.
//
// THE FAKE NPM. A two-line POSIX shell script that execs this Node binary on a small script written
// beside it. PATH for the close is that directory plus every PATH entry that holds no `npm` of its
// own, and a symlink to the real `git` sits beside the fake, so the close still reads the repository
// while the only npm it can find is the one the test wrote. POSIX only: on Windows the whole suite
// prints why and runs nothing.
//
// Nothing here touches a real repository or the network. Every workspace lives in the OS temp
// directory and is removed afterwards.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const EXAMPLES = path.join(REPO, 'examples');
const CLOSE = path.join(REPO, 'src', 'bin', 'close.mjs');

const tests = [];
const T = (name, fn) => tests.push({ name, fn });

const LANE = 'green1probe';
const BRANCH = 'lane-green1probe';

// ---------------------------------------------------------------- PATH

const isExe = (p) => {
  try { return fs.statSync(p).isFile() && (fs.accessSync(p, fs.constants.X_OK), true); } catch { return false; }
};
const PATH_DIRS = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
const REAL_GIT = PATH_DIRS.map((d) => path.join(d, 'git')).find(isExe) ?? null;
/** The close's PATH: the fake bin first, then every entry that holds no npm of its own. */
const pathFor = (bin) => [bin, ...PATH_DIRS.filter((d) => !isExe(path.join(d, 'npm')))].join(path.delimiter);

// ---------------------------------------------------------------- the throwaway workspace
//
// `web` is a real git repository whose main holds a package.json with a `build` script. The lane
// branch lives in its own worktree, `web-lane`, beside the repo and apart from the workspace root
// the close is started in, so "which directory did the build run in" has three distinct answers.
// `stale: true` lands a neighbour's commit on main after the branch was cut.
const g = (dir, args) => execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function makeWorkspace({ stale = false } = {}) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pandoras-build-')));
  const lanes = path.join(ws, '_handoffs', '_lanes');
  fs.mkdirSync(lanes, { recursive: true });
  for (const f of ['PREFIXES.md', 'CLAIMS.md', 'LANES.md']) fs.copyFileSync(path.join(EXAMPLES, f), path.join(lanes, f));
  const row = '| `web` | 1 | 3 | product | 5173 | push | `sha:/api/status:release` | https://web.example.com |';
  const src = fs.readFileSync(path.join(EXAMPLES, 'POLICY.md'), 'utf8');
  assert.ok(src.includes(row), 'premise: the example policy row for web is still spelled as this suite expects');
  // verify `none`: the live gate sends no request, so this suite never reaches the network.
  fs.writeFileSync(path.join(lanes, 'POLICY.md'), src.replace(row, '| `web` | 1 | 3 | product | 5173 | push | `none` | https://web.example.com |'));

  const web = path.join(ws, 'web');
  fs.mkdirSync(web);
  g(web, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(web, 'package.json'), JSON.stringify({ name: 'web', private: true, scripts: { build: 'echo the fake npm answers instead' } }, null, 2));
  fs.writeFileSync(path.join(web, '.gitignore'), 'node_modules\n');
  g(web, ['add', '-A']);
  g(web, ['commit', '-q', '-m', 'base']);
  const base = g(web, ['rev-parse', 'HEAD']);
  g(web, ['branch', BRANCH]);
  const lane = path.join(ws, 'web-lane');
  g(web, ['worktree', 'add', '-q', lane, BRANCH]);
  fs.writeFileSync(path.join(lane, 'page.txt'), 'this lane\n');
  g(lane, ['add', '-A']);
  g(lane, ['commit', '-q', '-m', 'the lane']);
  fs.mkdirSync(path.join(lane, 'node_modules'));

  let neighbour = null;
  if (stale) {
    fs.writeFileSync(path.join(web, 'neighbour.txt'), 'a neighbour landed this\n');
    g(web, ['add', '-A']);
    g(web, ['commit', '-q', '-m', 'a neighbour landed']);
    neighbour = g(web, ['rev-parse', 'HEAD']);
  }

  fs.appendFileSync(path.join(lanes, 'LANES.md'), `OPEN | ${LANE} | web | ${BRANCH} | web-lane | - | - | . | test-session | 2026-09-14T00:00:00.000Z | ${base}\n`);

  const bin = path.join(ws, 'fakebin');
  fs.mkdirSync(bin);
  if (REAL_GIT) fs.symlinkSync(REAL_GIT, path.join(bin, 'git'));
  return { ws, web, lane, bin, neighbour, out: path.join(ws, 'fake-npm-ran.json') };
}

/** Write `npm` into the fake bin: a shell script that execs this Node on `body`. */
function fakeNpm(w, body) {
  const script = path.join(w.bin, 'fake-npm.cjs');
  fs.writeFileSync(script, `const fs = require('node:fs');\nconst OUT = ${JSON.stringify(w.out)};\nfs.writeFileSync(OUT, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), pid: process.pid }));\n${body}\n`);
  fs.writeFileSync(path.join(w.bin, 'npm'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
}

const FAKE = {
  ok: "console.log('FAKE-BUILD-OK'); process.exit(0);",
  fail: "console.log('compiling 3 files'); console.error('FAKE-BUILD-FAILED src/app.ts(3,7): error TS2322'); process.exit(1);",
  // Starts a grandchild that holds the output pipes open, records both pids, and never exits.
  hang: `const { spawn } = require('node:child_process');
const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
fs.writeFileSync(OUT + '.pids', JSON.stringify({ child: process.pid, grandchild: gc.pid }));
console.log('FAKE-BUILD-HANGING');
setInterval(() => {}, 1000);`,
  // 1 MB between a head marker and a tail marker, then a failing exit so the close prints the tail.
  flood: `const line = 'x'.repeat(99) + '\\n';
process.stdout.write('HEAD-MARKER-FIRST-LINE\\n' + line.repeat(10_240) + 'TAIL-MARKER-LAST-LINE\\n');
process.exitCode = 1;`,
};

/** Run the close as a child process. Resolves, never rejects: the exit code is the assertion's business. */
function close(w, { env = {}, killAfterMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const childEnv = { ...process.env, PANDORAS_ROOT: w.ws, PATH: pathFor(w.bin), ...env };
    if (!('PANDORAS_BUILD_TIMEOUT_MS' in env)) delete childEnv.PANDORAS_BUILD_TIMEOUT_MS;
    const child = spawn(process.execPath, [CLOSE, LANE], { cwd: w.ws, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killed = false;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const killer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, killAfterMs);
    child.on('close', (status) => {
      clearTimeout(killer);
      const m = /^\s+green\s+(\S+)\s+(.*)$/m.exec(stdout);
      resolve({ status, stdout, stderr, killed, ms: Date.now() - started, green: m ? { value: m[1], note: m[2] } : null });
    });
  });
}

const greenOf = (r) => {
  assert.ok(r.green, `the close printed no green row (exit ${r.status}${r.killed ? ', killed by the test after its time limit' : ''}): ${r.stderr.split('\n')[0] || r.stdout.slice(0, 300)}`);
  return r.green;
};

async function withWorkspace(opts, fn) {
  const w = makeWorkspace(opts);
  try {
    await fn(w);
  } finally {
    // A hung fake left behind by a close that was itself killed must not outlive the test.
    try {
      const pids = JSON.parse(fs.readFileSync(`${w.out}.pids`, 'utf8'));
      for (const pid of [pids.child, pids.grandchild]) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    } catch { /* no pids file */ }
    fs.rmSync(w.ws, { recursive: true, force: true });
  }
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

// ---------------------------------------------------------------- the six build cases

T('exit 0: the build grades yes', async () => {
  await withWorkspace({}, async (w) => {
    fakeNpm(w, FAKE.ok);
    const green = greenOf(await close(w));
    assert.equal(green.value, 'yes', green.note);
    assert.ok(fs.existsSync(w.out), 'premise: the fake npm ran');
  });
});

T('the build runs in the lane checkout, not the dispatcher\'s cwd and not the repo\'s own working copy', async () => {
  await withWorkspace({}, async (w) => {
    fakeNpm(w, FAKE.ok);
    greenOf(await close(w));
    const ran = JSON.parse(fs.readFileSync(w.out, 'utf8'));
    assert.equal(fs.realpathSync(ran.cwd), fs.realpathSync(w.lane), `the build ran in ${ran.cwd}`);
    assert.notEqual(fs.realpathSync(ran.cwd), fs.realpathSync(w.ws), 'the build ran in the dispatcher\'s cwd');
    assert.deepEqual(ran.argv, ['run', 'build']);
  });
});

T('RED-PROOF exit 1: the build grades no and the close prints the failing output', async () => {
  await withWorkspace({}, async (w) => {
    fakeNpm(w, FAKE.fail);
    const r = await close(w);
    const green = greenOf(r);
    assert.equal(green.value, 'no', green.note);
    assert.match(r.stdout, /FAKE-BUILD-FAILED src\/app\.ts\(3,7\): error TS2322/, 'the close did not print the build\'s failing output');
    assert.match(green.note, /exit(ed)? (code )?1/, 'the verdict does not name the exit code');
  });
});

T('RED-PROOF hung build: past PANDORAS_BUILD_TIMEOUT_MS the build grades no, is killed with its process group, and the close returns in bounded time', async () => {
  await withWorkspace({}, async (w) => {
    fakeNpm(w, FAKE.hang);
    const r = await close(w, { env: { PANDORAS_BUILD_TIMEOUT_MS: '1000' }, killAfterMs: 30_000 });
    const green = greenOf(r);
    assert.equal(green.value, 'no', green.note);
    assert.match(green.note, /1000 ?ms|1 ?s(econd)?/, 'the verdict does not name the time limit');
    assert.match(green.note, /kill/i, 'the verdict does not say the build was killed');
    assert.ok(r.ms < 20_000, `the close took ${r.ms} ms against a 1 s build limit`);
    if (process.platform === 'win32') {
      console.log('  note: the process-group kill assertion does not apply on Windows, which has no POSIX process groups');
      return;
    }
    const pids = JSON.parse(fs.readFileSync(`${w.out}.pids`, 'utf8'));
    const deadline = Date.now() + 3000;
    while ((alive(pids.child) || alive(pids.grandchild)) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
    assert.ok(!alive(pids.child), `the fake npm (pid ${pids.child}) is still running after the close returned`);
    assert.ok(!alive(pids.grandchild), `the build's own child (pid ${pids.grandchild}) survived: only the leader was killed, not the process group`);
  });
});

T('RED-PROOF 1 MB of output: the close prints only the capped tail, ending at the build\'s last line', async () => {
  await withWorkspace({}, async (w) => {
    fakeNpm(w, FAKE.flood);
    const r = await close(w);
    const green = greenOf(r);
    assert.equal(green.value, 'no', green.note);
    assert.match(r.stdout, /TAIL-MARKER-LAST-LINE/, 'the last line of the build output was not printed');
    assert.doesNotMatch(r.stdout, /HEAD-MARKER-FIRST-LINE/, 'the first line of 1 MB of output was printed, so the output was not capped');
    const xs = (r.stdout.match(/x{99}/g) ?? []).length;
    assert.ok(xs > 0 && xs * 100 <= 64 * 1024, `the close printed ${xs} 100-byte lines of build output; the cap is 64 KB`);
  });
});

T('RED-PROOF no npm on PATH: the gate records skip with the reason, never yes and never no', async () => {
  await withWorkspace({}, async (w) => {
    assert.ok(REAL_GIT, 'premise: git is on PATH');
    const green = greenOf(await close(w));
    assert.equal(green.value, 'skip', green.note);
    assert.match(green.note, /npm/);
    assert.match(green.note, /not found|ENOENT/i, 'the skip does not say npm was not found');
  });
});

// ---------------------------------------------------------------- the fresh-base rule

T('RED-PROOF stale base: a branch cut before a neighbour landed on main grades no, names the missing commit, and the build never runs', async () => {
  await withWorkspace({ stale: true }, async (w) => {
    fakeNpm(w, FAKE.ok);
    const green = greenOf(await close(w));
    assert.equal(green.value, 'no', green.note);
    assert.ok(green.note.includes(w.neighbour.slice(0, 8)), `the verdict does not name the missing commit ${w.neighbour.slice(0, 8)}: ${green.note}`);
    assert.ok(!fs.existsSync(w.out), 'the build ran on a stale base');
  });
});

T('fresh base: the same branch after merging main grades on its build', async () => {
  await withWorkspace({ stale: true }, async (w) => {
    g(w.lane, ['merge', '-q', '--no-edit', 'main']);
    fakeNpm(w, FAKE.ok);
    const green = greenOf(await close(w));
    assert.equal(green.value, 'yes', green.note);
    assert.ok(fs.existsSync(w.out), 'the build did not run after main was merged in');
    fakeNpm(w, FAKE.fail);
    fs.rmSync(w.out);
    const red = greenOf(await close(w));
    assert.equal(red.value, 'no', `a failing build on a fresh base must grade no: ${red.note}`);
  });
});

// ---------------------------------------------------------------- run

if (process.platform === 'win32') {
  console.log('BUILD GATE ASSERTIONS  0 run: the fake npm executables are POSIX shell scripts and the process-group kill is POSIX, so this suite runs on macOS and Linux only.');
} else {
  let pass = 0;
  const fails = [];
  for (const t of tests) {
    try { await t.fn(); pass++; } catch (e) { fails.push({ name: t.name, message: e.message }); }
  }
  for (const f of fails) console.log(`FAIL  ${f.name}\n      ${String(f.message).split('\n')[0]}`);
  const red = tests.filter((t) => t.name.startsWith('RED-PROOF')).length;
  console.log(`BUILD GATE ASSERTIONS  ${pass}/${tests.length} pass, ${fails.length} fail`);
  console.log(`  ${red} of them are RED-PROOF: each runs the real close driver against a fake npm and asserts a no or a skip that a weaker gate would read as a pass or never return.`);
  if (fails.length) throw new Error(`build-gate-test.mjs: ${fails.length}/${tests.length} assertion(s) failed.`);
}
