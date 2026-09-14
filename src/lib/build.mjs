// @ts-check
// build.mjs — the `green` gate's build: a pure plan, and a bounded run of it.
//
// THE CLOSE RUNS REPOSITORY-CONTROLLED CODE. `npm run build` in a lane's checkout executes whatever
// that branch's package.json says, on the dispatcher's machine. So the run is held to three limits a
// branch cannot talk its way past: a time limit, after which the whole process group is killed; a
// cap on how much output is kept, so a build that prints forever cannot exhaust the close's memory;
// and no shell, so the command is an argument array, never a string a shell re-parses.
//
// NPM WITHOUT A SHELL, ON EVERY OS (WIN1, 2026-09-14). On Windows `npm` is `npm.cmd`, a batch file,
// and Node refuses to spawn a batch file without a shell (the 2024 batch-file argument fix). A shell
// would reopen the injection risk the no-shell design removed. So npm is resolved to its JavaScript
// entry point and run by this same Node binary: `node <npm-cli.js> run build`, shell false. The order
// (resolveNpm): `npm_execpath` when it names an existing .js or .cjs file; else npm-cli.js beside the
// running Node (Windows `<node dir>\node_modules\npm\bin\npm-cli.js`, POSIX
// `<node dir>/../lib/node_modules/npm/bin/npm-cli.js`); else, on POSIX only, the bare `npm` command
// looked up on PATH. When nothing resolves the gate is `skip` with every path tried named.
//
// A BUILD THAT NEVER FINISHED IS NOT GREEN. A timeout is `no`, and so is a build killed by any
// signal. A build that could not start at all, because npm cannot be found or cannot be executed, is
// `skip`: nothing was measured, and a skip is not a pass. Only an exit code of 0, inside the limit,
// with no signal, is `yes`.
//
// THE LIMITS. The time limit defaults to 15 minutes, the limit the close has always used, and
// PANDORAS_BUILD_TIMEOUT_MS overrides it. There is no policy column for it. The output cap is the
// last 64 KB of combined stdout and stderr; the earliest bytes are dropped first, because a failing
// build's reason is almost always at the end.

import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import fs from 'node:fs';
import nodePath from 'node:path';

export const BUILD_TIMEOUT_MS = 15 * 60_000;
export const BUILD_MAX_OUTPUT_BYTES = 64 * 1024;
/** How long a build has to exit after SIGTERM before its process group gets SIGKILL. */
export const BUILD_KILL_GRACE_MS = 2000;

/**
 * The time limit from the environment, or the default with the reason a value was not used.
 * @param {Record<string, string|undefined>} env
 * @returns {{timeoutMs:number, note:string|null}}
 */
export function buildTimeoutFrom(env) {
  const raw = env?.PANDORAS_BUILD_TIMEOUT_MS;
  if (raw === undefined || String(raw).trim() === '') return { timeoutMs: BUILD_TIMEOUT_MS, note: null };
  const n = Number(String(raw).trim());
  if (Number.isInteger(n) && n > 0) return { timeoutMs: n, note: null };
  return { timeoutMs: BUILD_TIMEOUT_MS, note: `PANDORAS_BUILD_TIMEOUT_MS="${raw}" is not a positive whole number of milliseconds, so the default ${formatMs(BUILD_TIMEOUT_MS)} limit was used` };
}

/** 900000 -> "15 min", 1000 -> "1000 ms". */
export function formatMs(ms) {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${ms} ms`;
}

/** @param {string} p */
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/**
 * @typedef {{command:string|null, args:string[], via:'npm_execpath'|'beside-node'|'path'|null, cli:string|null, tried:string[]}} NpmResolution
 *   command and args are what to spawn before npm's own arguments (`run build`); command is null when
 *   nothing resolved, and `tried` names every candidate that was looked at, in order.
 */

/**
 * How to run npm with no shell. Reads the file system only to ask whether a candidate file exists.
 *
 * @param {object} [o]
 * @param {Record<string, string|undefined>} [o.env]   where npm_execpath is read from
 * @param {string} [o.execPath]                        the running Node binary
 * @param {string} [o.platform]                        process.platform, or another to plan for
 * @param {(p: string) => boolean} [o.exists]          whether a path is an existing file
 * @returns {NpmResolution}
 */
export function resolveNpm({ env = process.env, execPath = process.execPath, platform = process.platform, exists = isFile } = {}) {
  const win = platform === 'win32';
  const P = win ? nodePath.win32 : nodePath.posix;
  /** @type {string[]} */
  const tried = [];
  const viaNode = (/** @type {'npm_execpath'|'beside-node'} */ via, /** @type {string} */ cli) => ({ command: execPath, args: [cli], via, cli, tried });

  const fromEnv = env?.npm_execpath ? String(env.npm_execpath) : '';
  if (fromEnv) {
    tried.push(`npm_execpath=${fromEnv}`);
    if (/\.c?js$/i.test(fromEnv) && exists(fromEnv)) return viaNode('npm_execpath', fromEnv);
  }
  const nodeDir = P.dirname(execPath);
  const beside = win
    ? P.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : P.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  tried.push(beside);
  if (exists(beside)) return viaNode('beside-node', beside);
  // POSIX only: npm there is a real executable (a script with a shebang), which spawn can run with
  // no shell. On Windows the bare name finds npm.cmd, which Node will not start without one.
  if (!win) {
    tried.push('npm on PATH');
    return { command: 'npm', args: [], via: 'path', cli: null, tried };
  }
  return { command: null, args: [], via: null, cli: null, tried };
}

/**
 * What the build gate would run in this checkout, or why it runs nothing. Pure except for the npm
 * resolver, which only asks whether files exist and which a caller or test may replace.
 *
 * A checkout with no `build` script has nothing to build: n/a, which is a pass and means nothing
 * was left unmeasured. A checkout with a build script and no node_modules cannot run it: skip. npm
 * that resolves to nothing runnable without a shell: skip, with the paths tried. Otherwise the plan
 * names the command, the directory and the limits, and runBuild runs exactly that.
 *
 * @param {object} o
 * @param {string} o.checkout                  the lane's own checkout, where the build must run
 * @param {any} o.pkg                          the checkout's parsed package.json, or null when absent or unreadable
 * @param {boolean} [o.nodeModules]            whether the checkout has node_modules; omitted means not checked
 * @param {Record<string, string|undefined>} [o.env]  where PANDORAS_BUILD_TIMEOUT_MS and npm_execpath are read from
 * @param {(o: {env: Record<string, string|undefined>}) => NpmResolution} [o.resolve]  the npm resolver; resolveNpm by default
 * @returns {{verdict:'n/a'|'skip'|null, why:string, command:string|null, args:string[], label:string, npm:NpmResolution|null, cwd:string, timeoutMs:number, maxOutputBytes:number}}
 */
export function buildPlan({ checkout, pkg, nodeModules, env = {}, resolve = resolveNpm }) {
  const limit = buildTimeoutFrom(env);
  /** @type {{verdict:'n/a'|'skip'|null, why:string, command:string|null, args:string[], label:string, npm:NpmResolution|null, cwd:string, timeoutMs:number, maxOutputBytes:number}} */
  const plan = { verdict: null, why: '', command: null, args: [], label: 'npm run build', npm: null, cwd: checkout, timeoutMs: limit.timeoutMs, maxOutputBytes: BUILD_MAX_OUTPUT_BYTES };
  const script = pkg && typeof pkg === 'object' ? pkg.scripts?.build : null;
  if (!script) {
    return { ...plan, verdict: 'n/a', why: `${checkout} has no \`build\` script, so there is no build to run. Recorded as N/A, not as a skip: nothing was left unmeasured.` };
  }
  if (nodeModules === false) {
    return { ...plan, verdict: 'skip', why: `SKIP: ${checkout} has no node_modules, so the build could not run. Install first (\`npm --prefix <checkout> ci\`, or open the lane with --install). A skip is not a pass.` };
  }
  const npm = resolve({ env });
  if (!npm.command) {
    return { ...plan, npm, verdict: 'skip', why: `SKIP: npm was not found as a JavaScript entry point this Node can run without a shell, so \`npm run build\` never started in ${checkout}. Tried: ${npm.tried.join('; ')}. Nothing was measured, and a skip is not a pass.` };
  }
  const how = npm.cli ? ` (node ${npm.cli}, from ${npm.via})` : ' (npm on PATH)';
  return { ...plan, npm, command: npm.command, args: [...npm.args, 'run', 'build'], why: `npm run build${how} in ${checkout}, limit ${formatMs(limit.timeoutMs)}, last ${plan.maxOutputBytes} bytes of output kept${limit.note ? `; ${limit.note}` : ''}` };
}

/**
 * The last `max` bytes of everything appended, and how many bytes were seen in total.
 * @param {number} max
 */
export function tailBuffer(max) {
  /** @type {Buffer[]} */
  let chunks = [];
  let kept = 0;
  let seen = 0;
  return {
    /** @param {Buffer|string} chunk */
    push(chunk) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      seen += b.length;
      chunks.push(b);
      kept += b.length;
      while (chunks.length > 1 && kept - chunks[0].length >= max) kept -= /** @type {Buffer} */ (chunks.shift()).length;
      if (kept > max * 2) {
        const joined = Buffer.concat(chunks).subarray(kept - max);
        chunks = [joined];
        kept = joined.length;
      }
    },
    get seen() { return seen; },
    text() {
      const all = Buffer.concat(chunks);
      return all.subarray(Math.max(0, all.length - max)).toString('utf8');
    },
  };
}

/**
 * The Windows tree kill, as an argument array: `taskkill /pid <pid> /T /F`. /T takes every process
 * the build started, /F does not ask. taskkill.exe is named by its full path under SystemRoot when
 * that exists, so a PATH entry cannot stand in for it.
 * @param {number} pid
 * @param {Record<string, string|undefined>} [env]
 * @param {(p: string) => boolean} [exists]
 * @returns {{command:string, args:string[]}}
 */
export function treeKillCommand(pid, env = process.env, exists = isFile) {
  const root = env?.SystemRoot || env?.SYSTEMROOT || env?.windir || '';
  const full = root ? nodePath.win32.join(root, 'System32', 'taskkill.exe') : '';
  return { command: full && exists(full) ? full : 'taskkill.exe', args: ['/pid', String(pid), '/T', '/F'] };
}

/**
 * Run a plan from buildPlan. Resolves, never rejects.
 *
 * The child is spawned without a shell. The time limit kills the build and everything it started,
 * and the way differs by OS:
 *   POSIX    the child leads its own process group (detached), so the group gets SIGTERM, then
 *            SIGKILL after BUILD_KILL_GRACE_MS.
 *   Windows  there are no process groups to signal, and child.kill() ends only the one process, so
 *            its children would live on holding the output pipes. Instead `taskkill /pid <pid> /T /F`
 *            runs through spawnSync with an argument array and no shell, ending the whole tree at
 *            once; there is no graceful first step, because a console build ignores the polite form.
 * Either way the run grades no. If the close itself is interrupted while the build runs, the same
 * kill runs first (SIGTERM to the group on POSIX, the tree kill on Windows), so a Ctrl-C does not
 * leave an orphaned build behind.
 *
 * @param {{verdict?:string|null, why?:string, command:string|null, args:string[], label?:string, cwd:string, timeoutMs?:number, maxOutputBytes?:number}} plan
 * @param {{timeoutMs?:number, maxOutputBytes?:number, spawn?:typeof nodeSpawn, spawnSync?:typeof nodeSpawnSync, env?:Record<string, string|undefined>, killGraceMs?:number}} [opts]
 * @returns {Promise<{verdict:'yes'|'no'|'skip'|'n/a', why:string, exitCode:number|null, signal:string|null, durationMs:number, tail:string}>}
 */
export function runBuild(plan, opts = {}) {
  if (plan.verdict) {
    return Promise.resolve({ verdict: /** @type {any} */ (plan.verdict), why: plan.why ?? '', exitCode: null, signal: null, durationMs: 0, tail: '' });
  }
  const timeoutMs = opts.timeoutMs ?? plan.timeoutMs ?? BUILD_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? plan.maxOutputBytes ?? BUILD_MAX_OUTPUT_BYTES;
  const grace = opts.killGraceMs ?? BUILD_KILL_GRACE_MS;
  const spawnFn = opts.spawn ?? nodeSpawn;
  const spawnSyncFn = opts.spawnSync ?? nodeSpawnSync;
  const posix = process.platform !== 'win32';
  const cmd = plan.label ?? `${plan.command} ${plan.args.join(' ')}`;
  const killHow = posix ? `its process group was killed (SIGTERM, then SIGKILL after ${grace} ms)` : 'its process tree was killed (taskkill /T /F)';
  const started = Date.now();
  if (!plan.command) {
    return Promise.resolve({ verdict: /** @type {'skip'} */ ('skip'), why: `SKIP: the plan names no command, so \`${cmd}\` never started in ${plan.cwd}. Nothing was measured, and a skip is not a pass.`, exitCode: null, signal: null, durationMs: 0, tail: '' });
  }
  const command = plan.command;
  const tail = tailBuffer(maxOutputBytes);

  return new Promise((resolve) => {
    let settled = false;
    let spawned = false;
    let timedOut = false;
    /** @type {NodeJS.Timeout|null} */ let limitTimer = null;
    /** @type {NodeJS.Timeout|null} */ let killTimer = null;
    /** @type {NodeJS.Timeout|null} */ let hardTimer = null;
    /** @type {Array<[string, (...a: any[]) => void]>} */ const listeners = [];

    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawnFn(command, plan.args, {
        cwd: plan.cwd,
        env: /** @type {NodeJS.ProcessEnv} */ (opts.env ?? process.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: posix,
        shell: false,
        windowsHide: true,
      });
    } catch (e) {
      resolve(notStarted(e));
      return;
    }

    // POSIX: signal the whole process group (a negative pid). Windows: one synchronous tree kill,
    // `taskkill /pid <pid> /T /F` with an argument array and no shell, and only while the child is
    // still running: once it has exited its pid may already belong to an unrelated process, and /T on
    // a dead parent finds nothing anyway. A second call (the SIGKILL step) has nothing left to do.
    let treeKilled = false;
    /** @type {{code:number|null, signal:string|null}|null} */
    let exited = null;
    const killGroup = (sig) => {
      try {
        if (posix) {
          if (child.pid) process.kill(-child.pid, sig);
          else child.kill(/** @type {NodeJS.Signals} */ (sig));
          return;
        }
        if (treeKilled || !child.pid || exited) return;
        treeKilled = true;
        const tk = treeKillCommand(child.pid, process.env);
        const r = spawnSyncFn(tk.command, tk.args, { stdio: 'ignore', shell: false, windowsHide: true, timeout: 30_000 });
        if (r.error || r.status !== 0) child.kill('SIGKILL');
      } catch { /* already gone */ }
    };

    function notStarted(e) {
      const code = e?.code ? String(e.code) : '';
      const why = code === 'ENOENT'
        ? `SKIP: \`${command}\` was not found${command === 'npm' ? ' on PATH' : ''} (ENOENT), so \`${cmd}\` never started in ${plan.cwd}. Nothing was measured, and a skip is not a pass.`
        : `SKIP: \`${cmd}\` could not be started in ${plan.cwd} (${code || String(e?.message ?? e)}). Nothing was measured, and a skip is not a pass.`;
      return { verdict: /** @type {'skip'} */ ('skip'), why, exitCode: null, signal: null, durationMs: Date.now() - started, tail: '' };
    }

    const cleanup = () => {
      for (const t of [limitTimer, killTimer, hardTimer]) if (t) clearTimeout(t);
      for (const [ev, fn] of listeners) process.removeListener(ev, fn);
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    /** @param {number|null} exitCode @param {string|null} signal */
    const graded = (exitCode, signal) => {
      const durationMs = Date.now() - started;
      const text = tail.text();
      const dropped = tail.seen > maxOutputBytes ? ` (output ${tail.seen} bytes, last ${maxOutputBytes} kept)` : '';
      if (timedOut) {
        return { verdict: /** @type {'no'} */ ('no'), why: `\`${cmd}\` did not finish within its ${formatMs(timeoutMs)} limit, so ${killHow}. A build that never finished is not green.${dropped}`, exitCode, signal, durationMs, tail: text };
      }
      if (signal) {
        return { verdict: /** @type {'no'} */ ('no'), why: `\`${cmd}\` was killed by ${signal} after ${durationMs} ms. A build that never finished is not green.${dropped}`, exitCode, signal, durationMs, tail: text };
      }
      if (exitCode === 0) {
        return { verdict: /** @type {'yes'} */ ('yes'), why: `${cmd} exited 0 in ${durationMs} ms`, exitCode, signal, durationMs, tail: text };
      }
      return { verdict: /** @type {'no'} */ ('no'), why: `\`${cmd}\` exited with code ${exitCode} after ${durationMs} ms.${dropped}`, exitCode, signal, durationMs, tail: text };
    };

    let spawnError = null;
    child.on('spawn', () => { spawned = true; });
    child.on('error', (e) => {
      // An error before the child ever started is a build that was not run. After it started, the
      // error is about signalling it, and the exit or close event still grades the run.
      if (!spawned && !child.pid) { spawnError = e; finish(notStarted(e)); }
    });
    child.stdout?.on('data', (d) => tail.push(d));
    child.stderr?.on('data', (d) => tail.push(d));

    child.on('exit', (code, signal) => { exited = { code, signal }; });
    child.on('close', (code, signal) => {
      // Never started: whichever of error and close arrives first, the answer is the same skip.
      if (!spawned && !child.pid) { setImmediate(() => finish(notStarted(spawnError ?? { message: 'the process never started' }))); return; }
      const e = exited ?? { code, signal };
      finish(graded(e.code, e.signal));
    });

    limitTimer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      // The SIGKILL step is POSIX's; on Windows the tree kill above was already forceful.
      if (posix) killTimer = setTimeout(() => killGroup('SIGKILL'), grace);
      // A descendant that left the process group (or, on Windows, escaped the tree) can hold the
      // output pipes open forever. The verdict does not wait for it: shortly after the kill the run
      // is graded on what was seen.
      hardTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(graded(exited?.code ?? null, exited?.signal ?? null));
      }, grace + 1000);
    }, timeoutMs);

    // The close interrupted mid-build: stop the build's group (the tree, on Windows), then let the
    // signal do what it would have done. The exit listener covers a close that ends any other way.
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const fn = () => {
        killGroup('SIGTERM');
        cleanup();
        // Windows cannot send itself every signal it can receive (SIGHUP among them); exit instead.
        try { process.kill(process.pid, sig); } catch { process.exit(1); }
      };
      process.on(sig, fn);
      listeners.push([sig, fn]);
    }
    const onExit = () => killGroup('SIGKILL');
    process.on('exit', onExit);
    listeners.push(['exit', onExit]);
  });
}
