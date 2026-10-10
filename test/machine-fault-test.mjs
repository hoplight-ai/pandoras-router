// @ts-check
// machine-fault-test.mjs: a broken machine is told apart from broken code, and only one exact
// breakage is ever retried.
//
// WHY. One build-gate assertion ("no npm anywhere") runs the close on a hard link of this Node
// binary in a temp directory. A Node built with its runtime in a shared library (Homebrew's macOS
// build: `@rpath/libnode.N.dylib`, looked for at `@loader_path/../lib`) cannot always find that
// library from the temp directory, and the child dies inside the dynamic loader before a line of
// the close has run. The suite then went red on such a machine (two runs in five on one day, one in
// ten on another), for a reason that had nothing to do with the code under test.
//
// THE RULE these assertions hold. Exactly one failure shape is a machine fault: the child was
// aborted (SIGABRT) by the dynamic loader, printed nothing on stdout, and its first stderr line is
// `dyld[<pid>]: Library not loaded: <library>`. That shape, and only that shape, is retried, and
// only once. The same fault twice is a SKIP that names the missing library, never a pass. Every
// other failure, including a fault followed by anything else, is handed back untouched on the
// attempt it happened, so the assertion that reads it fails the suite exactly as before.
//
// Every runner here is a stub returning a fixed child result. Nothing is spawned.

import assert from 'node:assert/strict';
import { machineFault, retryOnMachineFault } from './machine-fault.mjs';

const tests = [];
const T = (name, fn) => tests.push({ name, fn });

// The failure as macOS printed it for the close started on the hard-linked Node (Homebrew Node 25 on
// macOS, 2026-10-09), with the temp directory shortened. The first line is the one `npm test`
// printed when the assertion went red; the two below it are the rest of the same loader message,
// captured by starting a fresh hard link the same way. The child was ended by SIGABRT and printed
// nothing on stdout.
const TMP = '/private/var/folders/xx/T/pandoras-build-a1B2c3/lonely-node';
const CAPTURED_STDERR = [
  'dyld[17623]: Library not loaded: @rpath/libnode.141.dylib',
  `  Referenced from: <2696E65B-CBAC-3B8A-A004-F2914164CA8D> ${TMP}/node`,
  `  Reason: tried: '${TMP}/libnode.141.dylib' (no such file), '${TMP}/../lib/libnode.141.dylib' (no such file), '${TMP}/libnode.141.dylib' (no such file), '${TMP}/../lib/libnode.141.dylib' (no such file)`,
  '',
].join('\n');

/** @returns {import('./machine-fault.mjs').ChildResult} */
const captured = () => ({ status: null, signal: 'SIGABRT', stdout: '', stderr: CAPTURED_STDERR, killed: false });

/** A stub runner that hands back the given results in order and counts its calls. */
function stub(...results) {
  let calls = 0;
  const step = async () => {
    const r = results[Math.min(calls, results.length - 1)];
    calls++;
    return r;
  };
  return { step, calls: () => calls };
}

const GREEN_SKIP = { status: 0, signal: null, stdout: '  green  skip  npm not found (ENOENT)\n', stderr: '', killed: false };

// ---------------------------------------------------------------- the one shape that is retried

T('RED-PROOF the captured fault is recognised, and names the library the loader could not find', () => {
  const f = machineFault(captured());
  assert.ok(f, 'the captured dyld failure was not recognised as a machine fault');
  assert.equal(f.library, '@rpath/libnode.141.dylib');
  assert.match(f.line, /^dyld\[17623\]: Library not loaded: @rpath\/libnode\.141\.dylib$/);
});

T('RED-PROOF the captured fault twice: retried exactly once, then a SKIP naming the missing library, never a pass', async () => {
  const s = stub(captured(), captured());
  const out = await retryOnMachineFault(s.step);
  assert.equal(s.calls(), 2, `the step ran ${s.calls()} time(s); the fault must be retried exactly once`);
  assert.equal(out.attempts, 2);
  assert.ok(out.skip, 'two identical machine faults were not reported as a skip');
  assert.ok(out.skip.includes('@rpath/libnode.141.dylib'), `the skip does not name the missing library: ${out.skip}`);
  assert.match(out.skip, /not a pass/i, `the skip does not say it is not a pass: ${out.skip}`);
  assert.match(out.skip, /machine|this computer/i, `the skip does not say the fault is the machine's: ${out.skip}`);
  assert.equal(out.result.signal, 'SIGABRT', 'the second attempt\'s own result is not the one handed back');
});

T('RED-PROOF the captured fault once, then a real run: the real run is graded as it stands, and the retry is recorded', async () => {
  const s = stub(captured(), GREEN_SKIP);
  const out = await retryOnMachineFault(s.step);
  assert.equal(s.calls(), 2, `the step ran ${s.calls()} time(s); the fault must be retried exactly once`);
  assert.equal(out.skip, null, 'a run that succeeded on the retry was reported as a skip');
  assert.equal(out.result, GREEN_SKIP, 'the retried run\'s result was not the one handed back');
  assert.ok(out.retried && out.retried.includes('@rpath/libnode.141.dylib'), `the retry is not recorded with the library: ${out.retried}`);
});

// ---------------------------------------------------------------- everything else is the code's

/** Each is a failure the code could produce. None may be retried or turned into a skip. */
const GENUINE = {
  'the close exits 1 with a stack trace': { status: 1, signal: null, stdout: '', stderr: 'TypeError: plan.args is not iterable\n    at runBuild (src/lib/build.mjs:120:5)\n', killed: false },
  'the close prints no green row and exits 0': { status: 0, signal: null, stdout: 'close green1probe\n', stderr: '', killed: false },
  'SIGABRT with no loader message (the code aborted)': { status: null, signal: 'SIGABRT', stdout: '', stderr: 'node: assertion failed in the code under test\n', killed: false },
  'the loader message, but the close had already printed (it ran)': { status: null, signal: 'SIGABRT', stdout: 'close green1probe\n', stderr: CAPTURED_STDERR, killed: false },
  'the loader message, but the close exited 1 rather than being aborted': { status: 1, signal: null, stdout: '', stderr: CAPTURED_STDERR, killed: false },
  'the loader message after something else on stderr': { status: null, signal: 'SIGABRT', stdout: '', stderr: `warning: something first\n${CAPTURED_STDERR}`, killed: false },
  'a different loader failure (a missing symbol, not a missing library)': { status: null, signal: 'SIGABRT', stdout: '', stderr: 'dyld[17623]: Symbol not found: _uv_loop_init\n  Referenced from: <x> /n/node\n', killed: false },
  'killed by the test\'s own time limit': { status: null, signal: 'SIGKILL', stdout: '', stderr: CAPTURED_STDERR, killed: true },
};

T('RED-PROOF a genuine failure from the code is handed back on the first try: never retried, never a skip', async () => {
  for (const [label, r] of Object.entries(GENUINE)) {
    assert.equal(machineFault(r), null, `${label}: read as a machine fault`);
    const s = stub(r, GREEN_SKIP);
    const out = await retryOnMachineFault(s.step);
    assert.equal(s.calls(), 1, `${label}: the step ran ${s.calls()} times; a genuine failure must not be retried`);
    assert.equal(out.result, r, `${label}: the result handed back is not the failure that happened`);
    assert.equal(out.skip, null, `${label}: a genuine failure was turned into a skip`);
    assert.equal(out.retried, null, `${label}: a retry was recorded for a genuine failure`);
  }
});

T('RED-PROOF the fault, then a genuine failure: the genuine failure is handed back, not a skip', async () => {
  const genuine = GENUINE['the close exits 1 with a stack trace'];
  const s = stub(captured(), genuine);
  const out = await retryOnMachineFault(s.step);
  assert.equal(s.calls(), 2, `the step ran ${s.calls()} time(s); the fault must be retried exactly once`);
  assert.equal(out.result, genuine, 'the genuine failure on the retry is not the result handed back');
  assert.equal(out.skip, null, 'a genuine failure on the retry was hidden behind a skip');
});

T('RED-PROOF the fault, then a different missing library: not identical, so handed back, not a skip', async () => {
  const other = { ...captured(), stderr: CAPTURED_STDERR.replace('Library not loaded: @rpath/libnode.141.dylib', 'Library not loaded: /opt/homebrew/opt/icu4c@78/lib/libicuuc.78.dylib') };
  const s = stub(captured(), other);
  const out = await retryOnMachineFault(s.step);
  assert.equal(s.calls(), 2, `the step ran ${s.calls()} time(s); the first fault earns one retry and nothing more`);
  assert.equal(out.result, other);
  assert.equal(out.skip, null, 'two different faults were folded into one skip');
});

T('a clean first run is handed back untouched, with one attempt', async () => {
  const s = stub(GREEN_SKIP);
  const out = await retryOnMachineFault(s.step);
  assert.equal(s.calls(), 1);
  assert.deepEqual([out.result, out.attempts, out.retried, out.skip], [GREEN_SKIP, 1, null, null]);
});

// ---------------------------------------------------------------- run

let pass = 0;
const fails = [];
for (const t of tests) {
  try { await t.fn(); pass++; } catch (e) { fails.push({ name: t.name, message: e.message }); }
}
for (const f of fails) console.log(`FAIL  ${f.name}\n      ${String(f.message).split('\n')[0]}`);
const red = tests.filter((t) => t.name.startsWith('RED-PROOF')).length;
console.log(`MACHINE FAULT ASSERTIONS  ${pass}/${tests.length} pass, ${fails.length} fail`);
console.log(`  ${red} of them are RED-PROOF: each feeds the retry a failure and asserts it is retried only when it is the loader's missing library, once, and that a second one is a skip and never a pass.`);
if (fails.length) throw new Error(`machine-fault-test.mjs: ${fails.length}/${tests.length} assertion(s) failed.`);
