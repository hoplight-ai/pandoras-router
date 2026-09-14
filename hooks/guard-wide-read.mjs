#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════════════════════════
// LIVE. Wired in .claude/settings.json as a PreToolUse matcher on `Read`.
//
// WHAT IT DOES: refuses a whole-file Read of a LARGE file and tells the caller to name a range or
// grep first. It never truncates anything. The caller can still have every byte it asks for; it
// just has to ask on purpose.
//
// ── WHY ───────────────────────────────────────────────────────────────────────────────────────
// The cost of running many agents at once is not chattiness. It is reading and re-reading. The
// tempting fix — cap tool output — is the wrong one, because truncation silently changes what the
// agent believes. This refuses instead, and the caller can still have every byte.
//
// The measurement behind it. The first three lines were counted once, from one fleet's transcripts
// over one day, across every tool; hooks/measure-wide-read.mjs measures Reads only, so it does not
// reproduce them and they stand as that day's count. The fourth line it does reproduce, and the
// threshold section below is its output.
//   - about three quarters of everything the fleet pays to re-read is tool RESULTS
//   - Read alone is 41% of that total
//   - Bash is called several times MORE often and costs a fraction per call
//   - before this gate was wired, 61% of Reads named no range and those carried 77% of Read bytes
// So the cost is not chattiness and not call frequency. It is whole-file reads that then sit in
// the transcript and get re-sent on every later turn.
//
// ── WHY A GATE AND NOT A RULE ─────────────────────────────────────────────────────────────────
// Rules are not how things happen. A paragraph in an instructions file asking agents to read
// narrowly is a note that costs tokens on every turn and changes nothing. This is the mechanism.
//
// ── THE THRESHOLD, AND WHY THIS NUMBER ────────────────────────────────────────────────────────
// 12,000 bytes, roughly 3,000 tokens. The tables below are the output of hooks/measure-wide-read.mjs,
// run 2026-09-14 on this machine's own transcripts. Two windows, because this machine wired the gate
// on 2026-09-03 (the first refusal in its guard log), and a window on each side of that day is the
// only honest way to show both why the number was chosen and what it changed.
//
// Seven days BEFORE the gate (--since 2026-08-27 --until 2026-09-03): 3,232 reads, p50 1,400 tokens,
// p90 6,424 tokens; 61.1% of reads named no range and those carried 77.3% of read bytes.
//   threshold        refused (no range and over)   covered (share of read bytes)   all reads over T
//   T=1,000 tok       43.0% of reads               75.2%                           60.6%   <- too much friction
//   T=3,000 tok       22.6% of reads               59.8%                           27.1%   <- chosen
//   T=5,000 tok       14.0% of reads               46.2%                           15.7%
//   T=8,000 tok        5.0% of reads               23.4%                            5.7%   <- barely worth wiring
// Past 3,000 the curve flattens: going to 5,000 gives up a quarter of the coverage to save nine
// points of friction. The median read is a fifth of the threshold and never sees the gate at all.
//
// Seven days AFTER, gate live (--days 7, run 2026-09-14): 6,579 reads, p50 743 tokens, p90 3,231
// tokens; 36.1% of reads named no range and those carried 22.9% of read bytes.
//   T=1,000 tok       11.9% of reads               18.6%                           40.9%
//   T=3,000 tok        1.0% of reads                4.6%                           11.2%
//   T=5,000 tok        0.4% of reads                3.2%                            5.4%
//   T=8,000 tok        0.3% of reads                2.8%                            2.4%
// Read them together: reads over 3,000 tokens fell from 27.1% to 11.2% of all reads, and nearly
// every big read that remains now arrives with a range named (11.2% over, 1.0% refused). That is
// the gate doing what it was wired to do. It is also why a post-gate window on its own cannot
// reproduce the table that justified the threshold; anyone re-measuring must bound the window.
//
// Rerun: node hooks/measure-wide-read.mjs [transcripts-dir] --days 7  (--since and --until bound a window)
//
// ── WHAT THIS DOES NOT DO, STATED PLAINLY ─────────────────────────────────────────────────────
// A refusal does not delete those tokens. The caller re-issues with a range and still pays for
// what it takes. The saving is the difference between a whole file and the part that was wanted,
// and it is NOT the 59.8% above — that figure is the tokens the gate gets a say over, not the
// tokens it removes. Anyone quoting 59.8% as a saving is quoting it wrong. The before-and-after
// tables show what shifted; they still do not put a token count on the saving, because the reads
// that were refused and the ranged reads that replaced them are not paired in any transcript.
//
// ── FAILURE MODES, ACCEPTED ───────────────────────────────────────────────────────────────────
// 1. A caller that genuinely needs a whole large file pays one extra round trip to say so.
//    That is the intended cost: it makes a whole-file read deliberate instead of the default.
// 2. A file that grew past the threshold since a session last read it will start refusing.
//    Correct behaviour, but it will look like a new failure. Hence the reason text names the size.
// 3. This cannot tell a good wide read from a lazy one. It only knows the file is big. A gate that
//    guessed intent would be worse than one that is honest about not knowing.
//
// ESCAPE: set CLAUDE_WIDE_READ_BYTES=0 to disable, or to any byte count to retune. A caller that
// truly wants everything passes an explicit `limit`, which satisfies the gate by being deliberate.
// ══════════════════════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_BYTES = 12000;

// Formats Read handles as something other than lines of text. offset/limit are meaningless for
// them, so refusing would be a refusal the caller cannot satisfy — the worst kind of gate.
const NON_TEXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico',
  '.pdf', '.ipynb', '.zip', '.gz', '.tgz', '.mp4', '.mov', '.mp3', '.wav',
]);

function allow() { process.exit(0); }

function deny(reason, session) {
  log('deny', reason, session);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

// One line per refusal, never on a pass, in the same log the other guards use. A logging failure
// must never change a verdict. A call with no session id is the assertion suite, not a real
// refusal, and is not logged — otherwise one test run buries the real entries.
function log(verdict, reason, session) {
  if (!session) return;
  try {
    const p = path.join(path.dirname(fileURLToPath(import.meta.url)), 'guard-log.jsonl');
    fs.appendFileSync(p, JSON.stringify({
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      hook: 'guard-wide-read', verdict, reason: reason.slice(0, 200), session,
    }) + '\n');
  } catch { /* never block on logging */ }
}

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let input;
try { input = JSON.parse(raw); } catch { allow(); }

// Anything this gate cannot confidently parse is allowed through. A read guard that fails closed
// on a malformed payload would stop every session dead over a formatting change.
if (input?.tool_name !== 'Read') allow();

const limitBytes = Number(process.env.CLAUDE_WIDE_READ_BYTES ?? DEFAULT_BYTES);
if (!Number.isFinite(limitBytes) || limitBytes <= 0) allow();   // 0 disables the gate

const ti = input.tool_input || {};
if (ti.offset !== undefined || ti.limit !== undefined) allow();  // a range was named: deliberate
if (ti.pages !== undefined) allow();                              // PDF page range, same intent

const file = ti.file_path;
if (typeof file !== 'string' || !file) allow();
if (NON_TEXT.has(path.extname(file).toLowerCase())) allow();

let size;
try { size = fs.statSync(file).size; } catch { allow(); }  // missing file: let Read report it
if (size <= limitBytes) allow();

const kb = (size / 1024).toFixed(0);
const tok = Math.round(size / 4);
deny(
  `Whole-file Read of ${file} (${kb} KB, roughly ${tok.toLocaleString('en-US')} tokens). ` +
  `A tool result stays in the conversation and is re-sent on every later turn, so this one file ` +
  `is charged again on every turn for the rest of the session. Measured before this gate was wired ` +
  `(hooks/measure-wide-read.mjs): reads with no range carried 77% of all Read bytes.\n\n` +
  `Do one of these instead:\n` +
  `  - Grep for what you need and read only around the hits\n` +
  `  - Read with offset and limit for the section you actually want\n` +
  `  - If you genuinely need the whole file, re-issue with an explicit limit (e.g. limit: 2000). ` +
  `That is allowed. The point is that it be on purpose rather than by default.\n\n` +
  `This never truncates anything and it is not a permission problem — you can still have every ` +
  `byte. Threshold is ${limitBytes} bytes; CLAUDE_WIDE_READ_BYTES retunes it, 0 disables it.`,
  input.session_id
);
