// @ts-check
// build.mjs — the `green` gate's build: a pure plan, and a bounded run of it.
//
// THE CLOSE RUNS REPOSITORY-CONTROLLED CODE. `npm run build` in a lane's checkout executes whatever
// that branch's package.json says, on the dispatcher's machine. So the run is held to three limits a
// branch cannot talk its way past: a time limit, after which the whole process group is killed; a
// cap on how much output is kept, so a build that prints forever cannot exhaust the close's memory;
// and no shell, so the command is `npm` with two arguments, never a string a shell re-parses.
//
// A BUILD THAT NEVER FINISHED IS NOT GREEN. A timeout is `no`, and so is a build killed by any
// signal. A build that could not start at all, because npm is not on PATH or cannot be executed, is
// `skip`: nothing was measured, and a skip is not a pass. Only an exit code of 0, inside the limit,
// with no signal, is `yes`.
//
// THE LIMITS. The time limit defaults to 15 minutes, the limit the close has always used, and
// PANDORAS_BUILD_TIMEOUT_MS overrides it. There is no policy column for it. The output cap is the
// last 64 KB of combined stdout and stderr; the earliest bytes are dropped first, because a failing
// build's reason is almost always at the end.

import { spawn as nodeSpawn } from 'node:child_process';

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

/**
 * PURE. What the build gate would run in this checkout, or why it runs nothing.
 *
 * A checkout with no `build` script has nothing to build: n/a, which is a pass and means nothing
 * was left unmeasured. A checkout with a build script and no node_modules cannot run it: skip.
 * Otherwise the plan names the command, the directory and the limits, and runBuild runs exactly that.
 *
 * @param {object} o
 * @param {string} o.checkout                  the lane's own checkout, where the build must run
 * @param {any} o.pkg                          the checkout's parsed package.json, or null when absent or unreadable
 * @param {boolean} [o.nodeModules]            whether the checkout has node_modules; omitted means not checked
 * @param {Record<string, string|undefined>} [o.env]  where PANDORAS_BUILD_TIMEOUT_MS is read from
 * @returns {{verdict:'n/a'|'skip'|null, why:string, command:string, args:string[], cwd:string, timeoutMs:number, maxOutputBytes:number}}
 */
export function buildPlan({ checkout, pkg, nodeModules, env = {} }) {
  const limit = buildTimeoutFrom(env);
  const plan = { verdict: null, why: '', command: 'npm', args: ['run', 'build'], cwd: checkout, timeoutMs: limit.timeoutMs, maxOutputBytes: BUILD_MAX_OUTPUT_BYTES };
  const script = pkg && typeof pkg === 'object' ? pkg.scripts?.build : null;
  if (!script) {
    return { ...plan, verdict: 'n/a', why: `${checkout} has no \`build\` script, so there is no build to run. Recorded as N/A, not as a skip: nothing was left unmeasured.` };
  }
  if (nodeModules === false) {
    return { ...plan, verdict: 'skip', why: `SKIP: ${checkout} has no node_modules, so the build could not run. Install first (\`npm --prefix <checkout> ci\`, or open the lane with --install). A skip is not a pass.` };
  }
  return { ...plan, why: `npm run build in ${checkout}, limit ${formatMs(limit.timeoutMs)}, last ${plan.maxOutputBytes} bytes of output kept${limit.note ? `; ${limit.note}` : ''}` };
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
 * Run a plan from buildPlan. Resolves, never rejects.
 *
 * The child is spawned without a shell and, off Windows, as the leader of its own process group, so
 * the time limit kills the build and everything it started: SIGTERM to the group, then SIGKILL after
 * BUILD_KILL_GRACE_MS. If the close itself is interrupted while the build runs, the group is sent
 * SIGTERM first, so a Ctrl-C does not leave an orphaned build behind.
 *
 * @param {{verdict?:string|null, why?:string, command:string, args:string[], cwd:string, timeoutMs?:number, maxOutputBytes?:number}} plan
 * @param {{timeoutMs?:number, maxOutputBytes?:number, spawn?:typeof nodeSpawn, env?:Record<string, string|undefined>, killGraceMs?:number}} [opts]
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
  const posix = process.platform !== 'win32';
  const cmd = `${plan.command} ${plan.args.join(' ')}`;
  const started = Date.now();
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
      child = spawnFn(plan.command, plan.args, {
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

    const killGroup = (sig) => {
      try {
        if (posix && child.pid) process.kill(-child.pid, sig);
        else child.kill(/** @type {NodeJS.Signals} */ (sig));
      } catch { /* already gone */ }
    };

    function notStarted(e) {
      const code = e?.code ? String(e.code) : '';
      const why = code === 'ENOENT'
        ? `SKIP: \`${plan.command}\` was not found on PATH (ENOENT), so \`${cmd}\` never started in ${plan.cwd}. Nothing was measured, and a skip is not a pass.`
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
        return { verdict: /** @type {'no'} */ ('no'), why: `\`${cmd}\` did not finish within its ${formatMs(timeoutMs)} limit, so its process group was killed (SIGTERM, then SIGKILL after ${grace} ms). A build that never finished is not green.${dropped}`, exitCode, signal, durationMs, tail: text };
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

    /** @type {{code:number|null, signal:string|null}|null} */
    let exited = null;
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
      killTimer = setTimeout(() => killGroup('SIGKILL'), grace);
      // A descendant that left the process group can hold the output pipes open forever. The verdict
      // does not wait for it: shortly after SIGKILL the run is graded on what was seen.
      hardTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(graded(exited?.code ?? null, exited?.signal ?? null));
      }, grace + 1000);
    }, timeoutMs);

    // The close interrupted mid-build: stop the build's group, then let the signal do what it would
    // have done. The exit listener covers a close that ends any other way.
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const fn = () => {
        killGroup('SIGTERM');
        cleanup();
        process.kill(process.pid, sig);
      };
      process.on(sig, fn);
      listeners.push([sig, fn]);
    }
    const onExit = () => killGroup('SIGKILL');
    process.on('exit', onExit);
    listeners.push(['exit', onExit]);
  });
}
