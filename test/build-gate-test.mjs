// build-gate-test.mjs: the `green` gate, end to end, against fake npm executables.
//
// WHY END TO END. The close runs a lane's own `npm run build` on the dispatcher's machine and grades
// it. For a long time nothing tested that at all: the gate was a private function in the driver, and
// the only assertion near it checked how the grader treats the word `yes`. What a reviewer listed as
// unproven is all about the child process, not the grade: the right checkout, a captured failure, a
// missing npm, a hung build, a killed build, unbounded output, and a green build on a base that
// predates a neighbour's landing. None of that is visible to a unit test of a pure function, so each
// assertion here builds a throwaway workspace from examples/, writes a fake npm entry point, runs
// src/bin/close.mjs as a child process, and reads the `green` row it printed.
//
// THE FAKE NPM (WIN1, 2026-09-14). The build gate runs npm as `node <npm-cli.js> run build`, finding
// the entry point through `npm_execpath` first (src/lib/build.mjs resolveNpm). So the fake is a small
// Node script, `fake-npm.cjs`, and the close is started with npm_execpath naming it. No shell script,
// no PATH trick: the same fake runs on macOS, Linux and Windows, and so does every assertion here,
// including the one that the hung build's grandchild is gone after the kill.
//
// NO NPM AT ALL. One case needs a Node with no npm anywhere near it: that close runs on a hard link
// (or copy) of this Node binary in a temp directory, with npm_execpath unset and, on POSIX, a PATH
// holding no npm (a symlink to git beside it keeps the repository readable).
//
// Nothing here touches a real repository or the network. Every workspace lives in the OS temp
// directory and is removed afterwards.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
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

const WIN = process.platform === 'win32';
const isExe = (p) => {
  try { return fs.statSync(p).isFile() && (fs.accessSync(p, fs.constants.X_OK), true); } catch { return false; }
};
const PATH_DIRS = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
const REAL_GIT = WIN ? null : PATH_DIRS.map((d) => path.join(d, 'git')).find(isExe) ?? null;
/** POSIX only: a PATH of the given bin first, then every entry that holds no npm of its own. */
const pathFor = (bin) => [bin, ...PATH_DIRS.filter((d) => !isExe(path.join(d, 'npm')))].join(path.delimiter);
const real = (p) => fs.realpathSync.native(p);
/** The environment every child gets: this one, minus anything that would pick an npm for it. */
const baseEnv = () => {
  /** @type {Record<string, string|undefined>} */
  const e = { ...process.env };
  delete e.npm_execpath;
  delete e.PANDORAS_BUILD_TIMEOUT_MS;
  return e;
};

// ---------------------------------------------------------------- the throwaway workspace
//
// `web` is a real git repository whose main holds a package.json with a `build` script. The lane
// branch lives in its own worktree, `web-lane`, beside the repo and apart from the workspace root
// the close is started in, so "which directory did the build run in" has three distinct answers.
// `stale: true` lands a neighbour's commit on main after the branch was cut.
const g = (dir, args) => execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function makeWorkspace({ stale = false } = {}) {
  const ws = real(fs.mkdtempSync(path.join(os.tmpdir(), 'pandoras-build-')));
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
  return { ws, web, lane, bin, neighbour, npm: /** @type {string|null} */ (null), out: path.join(ws, 'fake-npm-ran.json') };
}

/** Write the fake npm entry point, `fake-npm.cjs`, which the child is pointed at via npm_execpath. */
function fakeNpm(w, body) {
  const script = path.join(w.bin, 'fake-npm.cjs');
  fs.writeFileSync(script, `const fs = require('node:fs');\nconst OUT = ${JSON.stringify(w.out)};\nfs.writeFileSync(OUT, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), pid: process.pid }));\n${body}\n`);
  w.npm = script;
}

/**
 * A Node binary with no npm beside it: a hard link to this one in `dir`, or a copy when the link
 * cannot be made (another volume). Returns its path.
 */
function lonelyNode(dir) {
  const target = path.join(dir, path.basename(process.execPath));
  try { fs.linkSync(process.execPath, target); } catch { fs.copyFileSync(process.execPath, target); }
  return target;
}

const FAKE = {
  ok: "console.log('FAKE-BUILD-OK'); process.exit(0);",
  fail: "console.log('compiling 3 files'); console.error('FAKE-BUILD-FAILED src/app.ts(3,7): error TS2322'); process.exit(1);",
  // Starts a grandchild that holds the output pipes open, records both pids, and never exits.
  // On Windows the grandchild is detached. Every Node process there puts its ordinary children in a
  // job object that ends them when that Node process dies, so a Node fake's grandchild would die with
  // a leader-only kill and prove nothing. A detached grandchild sits outside that job, like a build
  // tool that is not a Node child, and only the tree kill (taskkill /T) reaches it.
  hang: `const { spawn } = require('node:child_process');
const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit', detached: process.platform === 'win32', windowsHide: true });
fs.writeFileSync(OUT + '.pids', JSON.stringify({ child: process.pid, grandchild: gc.pid }));
console.log('FAKE-BUILD-HANGING');
setInterval(() => {}, 1000);`,
  // 1 MB between a head marker and a tail marker, then a failing exit so the close prints the tail.
  flood: `const line = 'x'.repeat(99) + '\\n';
process.stdout.write('HEAD-MARKER-FIRST-LINE\\n' + line.repeat(10_240) + 'TAIL-MARKER-LAST-LINE\\n');
process.exitCode = 1;`,
};

/** Run the close as a child process. Resolves, never rejects: the exit code is the assertion's business. */
function close(w, { env = {}, killAfterMs = 60_000, node = process.execPath } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    /** @type {Record<string, string|undefined>} */
    const childEnv = { ...baseEnv(), PANDORAS_ROOT: w.ws, ...(w.npm ? { npm_execpath: w.npm } : {}), ...env };
    const child = spawn(node, [CLOSE, LANE], { cwd: w.ws, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
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

/**
 * Remove a temp directory without letting the cleanup's own error replace the assertion's. On
 * Windows a just-killed process can hold its working directory for a moment (EPERM, EBUSY), so the
 * removal retries; a directory that still cannot go is left in the OS temp directory.
 */
function removeTemp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* left for the OS temp cleaner */ }
}

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
    removeTemp(w.ws);
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
    assert.equal(real(ran.cwd), real(w.lane), `the build ran in ${ran.cwd}`);
    assert.notEqual(real(ran.cwd), real(w.ws), 'the build ran in the dispatcher\'s cwd');
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
    assert.match(green.note, /exit(ed)? (with )?(code )?1\b/, 'the verdict does not name the exit code');
  });
});

/** The hung fake's child and grandchild are both gone within a few seconds. Every OS. */
async function assertTreeGone(w) {
  const pids = JSON.parse(fs.readFileSync(`${w.out}.pids`, 'utf8'));
  const deadline = Date.now() + 3000;
  while ((alive(pids.child) || alive(pids.grandchild)) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
  assert.ok(!alive(pids.child), `the fake npm (pid ${pids.child}) is still running after the kill`);
  assert.ok(!alive(pids.grandchild), `the build's own child (pid ${pids.grandchild}) survived: only the leader was killed, not the ${WIN ? 'process tree' : 'process group'}`);
  return pids;
}

T(`RED-PROOF hung build: past PANDORAS_BUILD_TIMEOUT_MS the build grades no, is killed with its ${WIN ? 'process tree' : 'process group'} (the grandchild is gone), and the close returns in bounded time`, async () => {
  await withWorkspace({}, async (w) => {
    fakeNpm(w, FAKE.hang);
    const r = await close(w, { env: { PANDORAS_BUILD_TIMEOUT_MS: '1000' }, killAfterMs: 30_000 });
    const green = greenOf(r);
    assert.equal(green.value, 'no', green.note);
    assert.match(green.note, /1000 ?ms|1 ?s(econd)?/, 'the verdict does not name the time limit');
    assert.match(green.note, /kill/i, 'the verdict does not say the build was killed');
    if (WIN) assert.match(green.note, /taskkill \/T \/F/, 'on Windows the verdict does not name the tree kill');
    assert.ok(r.ms < 20_000, `the close took ${r.ms} ms against a 1 s build limit`);
    const pids = await assertTreeGone(w);
    console.log(`  hung build on ${process.platform}: fake npm pid ${pids.child} and its grandchild pid ${pids.grandchild} are both gone after the kill`);
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

T('RED-PROOF no npm anywhere: the gate records skip with the reason, never yes and never no', async () => {
  await withWorkspace({}, async (w) => {
    const nodeDir = path.join(w.ws, 'lonely-node');
    fs.mkdirSync(nodeDir);
    const node = lonelyNode(nodeDir);
    /** @type {Record<string, string|undefined>} */
    const env = {};
    if (!WIN) {
      // POSIX falls back to `npm` on PATH, so PATH holds no npm; git is linked in beside the fake bin.
      assert.ok(REAL_GIT, 'premise: git is on PATH');
      fs.symlinkSync(REAL_GIT, path.join(w.bin, 'git'));
      env.PATH = pathFor(w.bin);
    }
    const green = greenOf(await close(w, { node, env }));
    assert.equal(green.value, 'skip', green.note);
    assert.match(green.note, /npm/);
    assert.match(green.note, /not found|ENOENT/i, 'the skip does not say npm was not found');
    if (WIN) assert.ok(green.note.includes(path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')), `the skip does not name the path tried beside Node: ${green.note}`);
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

// ---------------------------------------------------------------- the library, called directly
//
// The same fake npm, handed to runBuild through the plan's npm_execpath, so the returned record
// (duration, signal, exit code, tail) is asserted field by field rather than read back off a
// printed line.

const { buildPlan, runBuild, buildTimeoutFrom, tailBuffer, resolveNpm, resolveOnPath, treeKillCommand, BUILD_TIMEOUT_MS, BUILD_MAX_OUTPUT_BYTES } = await import('../src/lib/build.mjs');
const { freshBaseFromRevList } = await import('../src/lib/close.mjs');

/** A resolver that always answers `cli` beside a fixed node, for plans whose command is asserted. */
const fixedResolver = (cli) => () => ({ command: '/n/node', args: [cli], via: /** @type {const} */ ('npm_execpath'), cli, tried: [`npm_execpath=${cli}`] });

T('buildPlan: no build script is n/a, a missing node_modules is skip, otherwise node on npm-cli.js run build in the checkout with the default limits', () => {
  assert.equal(buildPlan({ checkout: '/c', pkg: null }).verdict, 'n/a');
  assert.equal(buildPlan({ checkout: '/c', pkg: { scripts: { test: 'x' } } }).verdict, 'n/a');
  assert.equal(buildPlan({ checkout: '/c', pkg: { scripts: { build: 'x' } }, nodeModules: false }).verdict, 'skip');
  const p = buildPlan({ checkout: '/c', pkg: { scripts: { build: 'x' } }, nodeModules: true, resolve: fixedResolver('/n/npm-cli.js') });
  assert.equal(p.verdict, null);
  assert.equal(p.command, '/n/node');
  assert.deepEqual(p.args, ['/n/npm-cli.js', 'run', 'build']);
  assert.equal(p.npm?.via, 'npm_execpath');
  assert.equal(p.label, 'npm run build');
  assert.equal(p.cwd, '/c');
  assert.equal(p.timeoutMs, 15 * 60_000);
  assert.equal(p.maxOutputBytes, 64 * 1024);
  assert.equal(BUILD_TIMEOUT_MS, 15 * 60_000);
  assert.equal(BUILD_MAX_OUTPUT_BYTES, 64 * 1024);
});

T('RED-PROOF limits: PANDORAS_BUILD_TIMEOUT_MS overrides the time limit, and a value that is not a positive whole number is refused with the reason, never read as zero', () => {
  assert.equal(buildTimeoutFrom({ PANDORAS_BUILD_TIMEOUT_MS: '2500' }).timeoutMs, 2500);
  for (const bad of ['0', '-5', 'ten', '1.5']) {
    const t = buildTimeoutFrom({ PANDORAS_BUILD_TIMEOUT_MS: bad });
    assert.equal(t.timeoutMs, BUILD_TIMEOUT_MS, `"${bad}" changed the limit`);
    assert.match(t.note ?? '', /not a positive whole number/);
  }
  assert.equal(buildPlan({ checkout: '/c', pkg: { scripts: { build: 'x' } }, env: { PANDORAS_BUILD_TIMEOUT_MS: '1000' } }).timeoutMs, 1000);
});

T('tailBuffer: keeps exactly the last N bytes across many small and one huge chunk', () => {
  const t = tailBuffer(10);
  for (const c of ['abc', 'defg', 'hijklmnop', 'qrs']) t.push(c);
  assert.equal(t.text(), 'jklmnopqrs');
  t.push('Z'.repeat(1000) + 'END');
  assert.equal(t.text(), 'ZZZZZZZEND');
  assert.equal(t.seen, 19 + 1003);
});

T('RED-PROOF resolveNpm: npm_execpath naming an existing .js or .cjs wins; anything else falls through, in the documented order', () => {
  const has = (...files) => (p) => files.includes(p);
  // 1. npm_execpath, when it names an existing .js / .cjs file.
  const e = resolveNpm({ env: { npm_execpath: '/x/npm-cli.js' }, execPath: '/usr/bin/node', platform: 'linux', exists: has('/x/npm-cli.js') });
  assert.deepEqual([e.command, e.args, e.via], ['/usr/bin/node', ['/x/npm-cli.js'], 'npm_execpath']);
  assert.equal(resolveNpm({ env: { npm_execpath: '/x/pnpm.cjs' }, execPath: '/n', platform: 'linux', exists: has('/x/pnpm.cjs') }).via, 'npm_execpath');
  // npm_execpath naming a missing file, or a file that is not JavaScript (npm.cmd), is not used.
  for (const bad of ['/x/missing.js', 'C:\\n\\npm.cmd']) {
    const r = resolveNpm({ env: { npm_execpath: bad }, execPath: '/usr/bin/node', platform: 'linux', exists: has('C:\\n\\npm.cmd') });
    assert.notEqual(r.via, 'npm_execpath', `npm_execpath=${bad} was used`);
    assert.equal(r.tried[0], `npm_execpath=${bad}`);
  }
  // 2. npm-cli.js beside the running Node: POSIX ../lib/node_modules, Windows node_modules.
  const posixCli = '/opt/node/lib/node_modules/npm/bin/npm-cli.js';
  const p = resolveNpm({ env: {}, execPath: '/opt/node/bin/node', platform: 'darwin', exists: has(posixCli) });
  assert.deepEqual([p.command, p.args, p.via], ['/opt/node/bin/node', [posixCli], 'beside-node']);
  const winCli = 'C:\\node\\node_modules\\npm\\bin\\npm-cli.js';
  const w = resolveNpm({ env: {}, execPath: 'C:\\node\\node.exe', platform: 'win32', exists: has(winCli) });
  assert.deepEqual([w.command, w.args, w.via], ['C:\\node\\node.exe', [winCli], 'beside-node']);
  // 3. POSIX only: the bare npm command on PATH.
  const bare = resolveNpm({ env: {}, execPath: '/opt/node/bin/node', platform: 'linux', exists: has() });
  assert.deepEqual([bare.command, bare.args, bare.via], ['npm', [], 'path']);
  assert.deepEqual(bare.tried, [posixCli, 'npm on PATH']);
  // Windows with nothing: no command at all, never the bare name (npm.cmd will not start without a shell).
  const none = resolveNpm({ env: { npm_execpath: 'C:\\n\\npm.cmd' }, execPath: 'C:\\node\\node.exe', platform: 'win32', exists: has() });
  assert.equal(none.command, null);
  assert.deepEqual(none.tried, ['npm_execpath=C:\\n\\npm.cmd', winCli]);
});

T('RED-PROOF buildPlan: npm that resolves to nothing is skip with every path tried named, and runBuild spawns nothing', async () => {
  const nothing = () => ({ command: null, args: [], via: null, cli: null, tried: ['npm_execpath=C:\\n\\npm.cmd', 'C:\\node\\node_modules\\npm\\bin\\npm-cli.js'] });
  const p = buildPlan({ checkout: 'C:\\c', pkg: { scripts: { build: 'x' } }, nodeModules: true, resolve: nothing });
  assert.equal(p.verdict, 'skip');
  assert.match(p.why, /not found/);
  assert.ok(p.why.includes('C:\\node\\node_modules\\npm\\bin\\npm-cli.js'), p.why);
  assert.ok(p.why.includes('npm_execpath=C:\\n\\npm.cmd'), p.why);
  let called = false;
  const r = await runBuild(p, { spawn: /** @type {any} */ (() => { called = true; throw new Error('must not spawn'); }) });
  assert.equal(r.verdict, 'skip');
  assert.equal(called, false);
});

T('treeKillCommand: taskkill by full path under SystemRoot with /pid <pid> /T /F as separate arguments', () => {
  const full = 'C:\\Windows\\System32\\taskkill.exe';
  assert.deepEqual(treeKillCommand(4242, { SystemRoot: 'C:\\Windows' }, (p) => p === full), { command: full, args: ['/pid', '4242', '/T', '/F'] });
  assert.equal(treeKillCommand(1, {}, () => false).command, 'taskkill.exe');
});

T('the real resolver on this runner: under npm test npm_execpath resolves, and with it unset npm still resolves to something runnable with no shell', () => {
  const underNpm = resolveNpm({ env: process.env });
  const bare = resolveNpm({ env: {} });
  console.log(`  npm on ${process.platform} (node ${process.version}): under npm test via ${underNpm.via} ${underNpm.cli ?? underNpm.command}; with npm_execpath unset via ${bare.via} ${bare.cli ?? bare.command}`);
  if (process.env.npm_execpath && /\.c?js$/i.test(process.env.npm_execpath)) assert.equal(underNpm.via, 'npm_execpath');
  if (WIN) {
    assert.ok(bare.command, `on Windows npm-cli.js beside Node was not found: tried ${bare.tried.join('; ')}`);
    assert.equal(bare.via, 'beside-node');
  } else {
    assert.ok(bare.command);
  }
});

/** A bare temp directory for runBuild with the fake npm in it: no git, no workspace. */
async function withBin(body, fn) {
  const dir = real(fs.mkdtempSync(path.join(os.tmpdir(), 'pandoras-runbuild-')));
  const w = { bin: path.join(dir, 'bin'), out: path.join(dir, 'ran.json'), dir, npm: /** @type {string|null} */ (null) };
  fs.mkdirSync(w.bin);
  if (body) fakeNpm(w, body);
  try {
    await fn(w, { ...baseEnv(), ...(w.npm ? { npm_execpath: w.npm } : {}) });
  } finally {
    try {
      const pids = JSON.parse(fs.readFileSync(`${w.out}.pids`, 'utf8'));
      for (const pid of [pids.child, pids.grandchild]) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    } catch { /* no pids file */ }
    removeTemp(dir);
  }
}
const planIn = (cwd, env) => buildPlan({ checkout: cwd, pkg: { scripts: { build: 'x' } }, nodeModules: true, env });

T('runBuild: exit 0 is yes with exit code 0, no signal, and the output kept; the plan is node on the fake entry point', async () => {
  await withBin(FAKE.ok, async (w, env) => {
    const plan = planIn(w.dir, env);
    assert.equal(plan.command, process.execPath);
    assert.deepEqual(plan.args, [w.npm, 'run', 'build']);
    const r = await runBuild(plan, { env });
    assert.equal(r.verdict, 'yes', r.why);
    assert.equal(r.exitCode, 0);
    assert.equal(r.signal, null);
    assert.match(r.tail, /FAKE-BUILD-OK/);
    const ran = JSON.parse(fs.readFileSync(w.out, 'utf8'));
    assert.equal(real(ran.cwd), w.dir);
    assert.deepEqual(ran.argv, ['run', 'build']);
  });
});

T('RED-PROOF runBuild: exit 1 is no, with exit code 1 and stderr in the tail', async () => {
  await withBin(FAKE.fail, async (w, env) => {
    const r = await runBuild(planIn(w.dir, env), { env });
    assert.equal(r.verdict, 'no');
    assert.equal(r.exitCode, 1);
    assert.match(r.tail, /compiling 3 files[\s\S]*FAKE-BUILD-FAILED/);
  });
});

T(`RED-PROOF runBuild: a 1 s limit on a build that never exits is no, ${WIN ? 'names the tree kill' : 'carries the kill signal'}, leaves no grandchild, and returns within the limit plus the kill grace`, async () => {
  await withBin(FAKE.hang, async (w, env) => {
    const r = await runBuild(planIn(w.dir, env), { env, timeoutMs: 1000, killGraceMs: 500 });
    assert.equal(r.verdict, 'no', r.why);
    assert.match(r.why, /1000 ms limit/);
    assert.ok(r.durationMs >= 1000, `graded after ${r.durationMs} ms, before the limit`);
    assert.ok(r.durationMs < 1000 + 500 + 1000 + 1500, `graded after ${r.durationMs} ms`);
    // The tree first, so a kill that reaches only the leader reads as a surviving grandchild.
    await assertTreeGone(w);
    if (WIN) {
      // TerminateProcess leaves an exit code, never a signal name.
      assert.match(r.why, /process tree was killed \(taskkill \/T \/F\)/);
      assert.ok(r.signal === null && r.exitCode !== 0, `exit ${r.exitCode} signal ${r.signal}`);
    } else {
      assert.ok(r.signal === 'SIGTERM' || r.signal === 'SIGKILL', `signal was ${r.signal}`);
    }
    assert.match(r.tail, /FAKE-BUILD-HANGING/);
  });
});

T('RED-PROOF runBuild: 1 MB of output on a passing build is still yes, and the tail is capped at the limit and ends at the last line', async () => {
  const body = FAKE.flood.replace('process.exitCode = 1;', 'process.exitCode = 0;');
  await withBin(body, async (w, env) => {
    const r = await runBuild(planIn(w.dir, env), { env });
    assert.equal(r.verdict, 'yes', r.why);
    assert.ok(Buffer.byteLength(r.tail) <= 64 * 1024, `tail is ${Buffer.byteLength(r.tail)} bytes`);
    assert.ok(Buffer.byteLength(r.tail) > 60 * 1024, 'the tail kept far less than the cap');
    assert.match(r.tail, /TAIL-MARKER-LAST-LINE\n$/);
    assert.doesNotMatch(r.tail, /HEAD-MARKER/);
  });
});

T('RED-PROOF runBuild: the bare npm fallback with no npm on PATH is skip with ENOENT named, never yes and never no', async () => {
  await withBin(null, async (w, env) => {
    const bareNpm = () => ({ command: 'npm', args: [], via: /** @type {const} */ ('path'), cli: null, tried: ['npm on PATH'] });
    const plan = buildPlan({ checkout: w.dir, pkg: { scripts: { build: 'x' } }, nodeModules: true, env, resolve: bareNpm });
    // POSIX: a PATH with no npm on it. Windows: spawn with no shell never finds npm.cmd by the bare name.
    const r = await runBuild(plan, { env: WIN ? env : { ...env, PATH: pathFor(w.bin) } });
    assert.equal(r.verdict, 'skip', r.why);
    assert.match(r.why, /not found on PATH \(ENOENT\)/);
    assert.equal(r.exitCode, null);
  });
});

T('runBuild: a plan that already carries a verdict runs nothing and returns that verdict', async () => {
  let called = false;
  const spy = /** @type {any} */ (() => { called = true; throw new Error('must not spawn'); });
  const r = await runBuild(buildPlan({ checkout: '/c', pkg: null }), { spawn: spy });
  assert.equal(r.verdict, 'n/a');
  assert.equal(called, false);
});

T('RED-PROOF freshBaseFromRevList: a neighbour commit is not fresh and is named; an empty list is fresh; the lane\'s own landing merge is excused; git failure is unmeasured', () => {
  const stale = freshBaseFromRevList({ listed: 'abcdef1234567890 1111111111111111\n', isInBranch: () => false, base: 'main' });
  assert.equal(stale.fresh, false);
  assert.deepEqual(stale.missing, ['abcdef1234567890']);
  assert.match(stale.why, /abcdef12/);
  assert.doesNotMatch(stale.why, /origin\/main/, 'the reason names a ref this repo does not use');
  assert.equal(freshBaseFromRevList({ listed: '', isInBranch: () => false }).fresh, true);
  const landed = freshBaseFromRevList({ listed: 'L M0 T', land: { tip: 'T', merge: 'L' }, isInBranch: (s) => s === 'T' });
  assert.equal(landed.fresh, true, landed.why);
  assert.equal(freshBaseFromRevList({ listed: null, isInBranch: () => true }).fresh, null);
});

// ---------------------------------------------------------------- a declared build command
//
// BUILDCMD1, 2026-09-15. A repository built by something other than npm used to get a skip, and a
// skip is not a pass. The policy's `build` column names its build command as an argument array, and
// the run has to keep every limit the npm path already had. These assertions hold each limit
// SEPARATELY, because the failure worth catching is a declared command that works while quietly
// running under a shell, under its own time limit, or under no kill at all.
//
// The declared command in the running cases is `node`, resolved on PATH by the real lookup, so the
// same assertions run on macOS, Linux and Windows against a real child process.

/**
 * A declaration in the shape parseBuild returns, built here so these cases do not re-test the parser.
 * @param {string} command
 * @param {...string} args
 */
const decl = (command, ...args) => ({ command, args, label: [command, ...args].join(' ') });
/**
 * A PATH lookup that answers one fixed executable, for plans whose resolved command is asserted.
 * @param {string} abs
 * @returns {(name: string, o: {env: Record<string, string|undefined>}) => {command:string|null, tried:string[], shellOnly:string|null, searched:number}}
 */
const foundAt = (abs) => () => ({ command: abs, tried: [abs], shellOnly: null, searched: 1 });

T('buildPlan: a declared command plans as an argument array on the PATH-resolved executable, in the lane checkout, and needs neither a package.json nor node_modules', () => {
  const p = buildPlan({ checkout: '/c', pkg: null, nodeModules: false, build: decl('cargo', 'build', '--release'), lookup: foundAt('/usr/bin/cargo') });
  assert.equal(p.verdict, null, `a declared command must not be ${p.verdict}: ${p.why}`);
  assert.equal(p.command, '/usr/bin/cargo');
  assert.deepEqual(p.args, ['build', '--release']);
  assert.equal(p.label, 'cargo build --release');
  assert.equal(p.cwd, '/c');
  assert.equal(p.npm, null, 'a declared command must not resolve npm');
  assert.match(p.why, /cargo build --release/);
  assert.match(p.why, /\/usr\/bin\/cargo/, 'the plan does not name the executable it resolved');
});

T('buildPlan: a repository that declares nothing takes the npm path, byte for byte the plan it took before the column existed', () => {
  const args = { checkout: '/c', pkg: { scripts: { build: 'x' } }, nodeModules: true, resolve: fixedResolver('/n/npm-cli.js') };
  assert.deepEqual(buildPlan({ ...args, build: null }), buildPlan(args));
  assert.deepEqual(buildPlan({ ...args, build: undefined }), buildPlan(args));
  assert.equal(buildPlan({ ...args, build: null }).label, 'npm run build');
  // And the npm-only verdicts stay npm-only: no build script is still n/a, no node_modules still skip.
  assert.equal(buildPlan({ checkout: '/c', pkg: null, build: null }).verdict, 'n/a');
  assert.equal(buildPlan({ checkout: '/c', pkg: { scripts: { build: 'x' } }, nodeModules: false, build: null }).verdict, 'skip');
});

T('RED-PROOF buildPlan: the time limit and the output cap are the dispatcher\'s, and a declaration carrying its own cannot lengthen either', () => {
  const base = { checkout: '/c', pkg: null, lookup: foundAt('/usr/bin/make') };
  assert.equal(buildPlan({ ...base, build: decl('make', 'build'), env: {} }).timeoutMs, BUILD_TIMEOUT_MS);
  assert.equal(buildPlan({ ...base, build: decl('make', 'build'), env: {} }).maxOutputBytes, BUILD_MAX_OUTPUT_BYTES);
  // The environment override is the dispatcher's own and still works.
  assert.equal(buildPlan({ ...base, build: decl('make', 'build'), env: { PANDORAS_BUILD_TIMEOUT_MS: '1000' } }).timeoutMs, 1000);
  // A declaration that grew extra fields — the shape a per-repository limit would arrive in — changes nothing.
  const sneaky = { ...decl('make', 'build'), timeoutMs: 99 * 60_000, maxOutputBytes: 1, shell: true };
  const p = buildPlan({ ...base, build: sneaky, env: {} });
  assert.equal(p.timeoutMs, BUILD_TIMEOUT_MS, 'a policy declaration lengthened the build time limit');
  assert.equal(p.maxOutputBytes, BUILD_MAX_OUTPUT_BYTES, 'a policy declaration changed the output cap');
  assert.equal(/** @type {any} */ (p).shell, undefined, 'a policy declaration reached the spawn options');
});

T('RED-PROOF resolveOnPath: only absolute PATH entries are searched, so the checkout the build runs in can never supply the executable', () => {
  /** @type {string[]} */
  const seen = [];
  const r = resolveOnPath('build', {
    env: { PATH: ['.', '', 'rel/dir', '/usr/bin'].join(':') },
    platform: 'linux',
    exists: (p) => { seen.push(p); return false; },
  });
  assert.deepEqual(seen, ['/usr/bin/build'], 'a relative PATH entry was searched, which resolves against the repository being built');
  assert.equal(r.command, null);
  const hit = resolveOnPath('cargo', { env: { PATH: '/nope:/usr/bin' }, platform: 'linux', exists: (p) => p === '/usr/bin/cargo' });
  assert.equal(hit.command, '/usr/bin/cargo');
  assert.deepEqual(hit.tried, ['/nope/cargo', '/usr/bin/cargo']);
});

T('RED-PROOF resolveOnPath on Windows: an .exe is found, and a command that exists only as a batch file is NOT run, because that would need a shell', () => {
  const win = { platform: 'win32', env: { PATH: 'C:\\bin;C:\\tools' } };
  const exe = resolveOnPath('cargo', { ...win, exists: (p) => p === 'C:\\tools\\cargo.exe' });
  assert.equal(exe.command, 'C:\\tools\\cargo.exe');
  const batch = resolveOnPath('pnpm', { ...win, exists: (p) => p === 'C:\\bin\\pnpm.cmd' });
  assert.equal(batch.command, null, 'a .cmd was spawned without a shell, which Node refuses and a shell would re-parse');
  assert.equal(batch.shellOnly, 'C:\\bin\\pnpm.cmd');
});

T('RED-PROOF buildPlan: a declared command that is not on PATH is a skip naming it, and runBuild spawns nothing', async () => {
  const missing = 'pandoras-no-such-build-tool-9f3c';
  const p = buildPlan({ checkout: '/c', pkg: null, build: decl(missing, 'build'), env: baseEnv() });
  assert.equal(p.verdict, 'skip', p.why);
  assert.ok(p.why.includes(missing), `the skip does not name the command: ${p.why}`);
  assert.match(p.why, /PATH/);
  assert.match(p.why, /skip is not a pass/);
  let called = false;
  const r = await runBuild(p, { spawn: /** @type {any} */ (() => { called = true; throw new Error('must not spawn'); }) });
  assert.equal(r.verdict, 'skip');
  assert.equal(called, false);
});

T('RED-PROOF runBuild: a declared command is spawned as an argument array with shell false, detached only where the process group is, in the lane checkout', async () => {
  /** @type {any} */
  let call = null;
  const spawn = /** @type {any} */ ((command, args, opts) => {
    call = { command, args, opts };
    const c = new EventEmitter();
    Object.assign(c, { pid: 4242, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
    setImmediate(() => { c.emit('spawn'); c.emit('exit', 0, null); c.emit('close', 0, null); });
    return c;
  });
  const plan = buildPlan({ checkout: '/c', pkg: null, build: decl('cargo', 'build', '--release'), lookup: foundAt('/usr/bin/cargo') });
  const r = await runBuild(plan, { spawn });
  assert.equal(r.verdict, 'yes', r.why);
  assert.match(r.why, /cargo build --release/, 'the verdict does not name the command that ran');
  assert.equal(call.command, '/usr/bin/cargo');
  assert.deepEqual(call.args, ['build', '--release'], 'the arguments did not reach spawn as an array');
  assert.equal(call.opts.shell, false, 'a declared command was spawned through a shell');
  assert.equal(call.opts.cwd, '/c');
  assert.equal(call.opts.detached, process.platform !== 'win32');
});

T('runBuild: a declared command really runs, exits 0, and the verdict and the record name it', async () => {
  await withBin(null, async (w, env) => {
    const script = path.join(w.bin, 'declared-build.cjs');
    fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(w.out)}, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }));\nconsole.log('DECLARED-BUILD-OK');\n`);
    const plan = buildPlan({ checkout: w.dir, pkg: null, build: decl('node', script), env });
    assert.equal(plan.verdict, null, plan.why);
    const r = await runBuild(plan, { env });
    assert.equal(r.verdict, 'yes', r.why);
    assert.equal(r.exitCode, 0);
    assert.match(r.tail, /DECLARED-BUILD-OK/);
    assert.ok(r.why.includes('node'), `the verdict does not name the command: ${r.why}`);
    assert.equal(real(JSON.parse(fs.readFileSync(w.out, 'utf8')).cwd), w.dir, 'the declared build did not run in the lane checkout');
  });
});

T('RED-PROOF runBuild: a declared command that exits non-zero is no, with its exit code and its output', async () => {
  await withBin(null, async (w, env) => {
    const script = path.join(w.bin, 'declared-build-fail.cjs');
    fs.writeFileSync(script, `console.error('DECLARED-BUILD-FAILED');\nprocess.exit(2);\n`);
    const r = await runBuild(buildPlan({ checkout: w.dir, pkg: null, build: decl('node', script), env }), { env });
    assert.equal(r.verdict, 'no', r.why);
    assert.equal(r.exitCode, 2);
    assert.match(r.tail, /DECLARED-BUILD-FAILED/);
  });
});

T(`RED-PROOF runBuild: a declared command that never exits is killed at the dispatcher's limit with its whole ${WIN ? 'process tree' : 'process group'}, and grades no`, async () => {
  await withBin(null, async (w, env) => {
    const script = path.join(w.bin, 'declared-build-hang.cjs');
    fs.writeFileSync(script, `const fs = require('node:fs');\nconst OUT = ${JSON.stringify(w.out)};\nfs.writeFileSync(OUT, '{}');\n${FAKE.hang}\n`);
    const plan = buildPlan({ checkout: w.dir, pkg: null, build: decl('node', script), env });
    const r = await runBuild(plan, { env, timeoutMs: 1000, killGraceMs: 500 });
    assert.equal(r.verdict, 'no', r.why);
    assert.match(r.why, /1000 ms limit/);
    assert.ok(r.durationMs >= 1000, `graded after ${r.durationMs} ms, before the limit`);
    await assertTreeGone(w);
    if (WIN) assert.match(r.why, /process tree was killed \(taskkill \/T \/F\)/);
    else assert.ok(r.signal === 'SIGTERM' || r.signal === 'SIGKILL', `signal was ${r.signal}`);
  });
});

// ---------------------------------------------------------------- run

let pass = 0;
const fails = [];
for (const t of tests) {
  try { await t.fn(); pass++; } catch (e) { fails.push({ name: t.name, message: e.message }); }
}
for (const f of fails) console.log(`FAIL  ${f.name}\n      ${String(f.message).split('\n')[0]}`);
const red = tests.filter((t) => t.name.startsWith('RED-PROOF')).length;
console.log(`BUILD GATE ASSERTIONS  ${pass}/${tests.length} pass, ${fails.length} fail (on ${process.platform})`);
console.log(`  ${red} of them are RED-PROOF: each asserts a no, a skip or a refused limit that a weaker gate would read as a pass or never return; the first eight run the real close driver against a fake npm.`);
if (fails.length) throw new Error(`build-gate-test.mjs: ${fails.length}/${tests.length} assertion(s) failed.`);
