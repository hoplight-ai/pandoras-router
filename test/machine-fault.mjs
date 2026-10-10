// @ts-check
// machine-fault.mjs — tells a broken machine apart from broken code, for one test step only.
//
// THE STEP. build-gate-test.mjs's "no npm anywhere" assertion runs the close on a hard link of this
// Node binary in a temp directory, so that no npm sits anywhere near the Node that runs it. A Node
// whose runtime lives in a shared library (Homebrew's macOS build loads `@rpath/libnode.N.dylib`
// from `@loader_path/../lib`) may not find that library from there, and then the child is aborted
// by the dynamic loader before one line of the close has run. Measured on macOS with Homebrew's
// Node 25: 34 of 40 fresh hard links died that way when nothing else was done about it.
//
// THE SIGNATURE, exactly as captured. All four must hold, or it is not this fault:
//   - the child was ended by SIGABRT (no exit code),
//   - it printed nothing at all on stdout, so the code under test never ran,
//   - the first line of its stderr is `dyld[<pid>]: Library not loaded: <library>`,
//   - the test's own time limit did not kill it.
//
// THE RULE. That signature, and nothing else, is retried, and only once. The same fault again (the
// same missing library) comes back as a skip whose reason says, in plain words, that the machine
// could not start Node and that this is not a pass. Any other result, on either attempt, is handed
// back untouched, so the assertion that reads it fails the suite exactly as it did before.
//
// machine-fault-test.mjs holds this file to that rule with stub runners; nothing there spawns.

/** @typedef {{ status: number|null, signal?: string|null, stdout: string, stderr: string, killed?: boolean }} ChildResult */

const LOADER_LINE = /^dyld\[\d+\]: Library not loaded: (\S+)$/;

/**
 * The machine-fault signature, or null for anything else.
 * @param {ChildResult} r
 * @returns {{ library: string, line: string } | null}
 */
export function machineFault(r) {
  if (!r || r.killed) return null;
  if (r.status !== null || r.signal !== 'SIGABRT') return null;
  if (r.stdout !== '') return null;
  const line = String(r.stderr ?? '').split('\n')[0].trimEnd();
  const m = LOADER_LINE.exec(line);
  return m ? { library: m[1], line } : null;
}

/**
 * Run `step`. If its result is the machine fault, run it exactly once more. Never a third time.
 *
 * - `result` is the last attempt's own result, always.
 * - `retried` names the library when a retry happened, else null.
 * - `skip` is set only when both attempts hit the fault with the same missing library: a plain-words
 *   reason, to be reported as a skip and never counted as a pass. Otherwise null, and `result` is
 *   graded as it stands.
 *
 * @template {ChildResult} R
 * @param {() => Promise<R>} step
 * @returns {Promise<{ result: R, attempts: number, retried: string|null, skip: string|null }>}
 */
export async function retryOnMachineFault(step) {
  const first = await step();
  const fault = machineFault(first);
  if (!fault) return { result: first, attempts: 1, retried: null, skip: null };
  const second = await step();
  const again = machineFault(second);
  if (again && again.library === fault.library) {
    return {
      result: second,
      attempts: 2,
      retried: fault.library,
      skip: `this computer could not start the copy of Node this step runs on: the system loader could not find the shared library ${fault.library} ("${again.line}"), twice in a row. The code under test never ran, so nothing was measured. This is a skip, not a pass.`,
    };
  }
  return { result: second, attempts: 2, retried: fault.library, skip: null };
}
