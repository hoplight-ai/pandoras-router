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
// The measurement behind it, all counted from one fleet's transcripts over one day, plus the
// threshold probe in this file's test:
//   - about three quarters of everything the fleet pays to re-read is tool RESULTS
//   - Read alone is 41% of that total
//   - Bash is called several times MORE often and costs a fraction per call
//   - most Reads named no range at all, and those carry 85% of all Read tokens
// So the cost is not chattiness and not call frequency. It is whole-file reads that then sit in
// the transcript and get re-sent on every later turn.
//
// ── WHY A GATE AND NOT A RULE ─────────────────────────────────────────────────────────────────
// Rules are not how things happen. A paragraph in an instructions file asking agents to read
// narrowly is a note that costs tokens on every turn and changes nothing. This is the mechanism.
//
// ── THE THRESHOLD, AND WHY THIS NUMBER ────────────────────────────────────────────────────────
// 12,000 bytes, roughly 3,000 tokens. Measured trade-off across one fleet-day of Reads:
//   T=1,000 tok  refuses 36.9% of Reads, covering 80.5% of Read tokens   <- too much friction
//   T=3,000 tok  refuses 20.7% of Reads, covering 64.4% of Read tokens   <- chosen
//   T=5,000 tok  refuses 11.7% of Reads, covering 45.4% of Read tokens
//   T=8,000 tok  refuses  2.8% of Reads, covering 15.8% of Read tokens   <- barely worth wiring
// Past 3,000 the curve flattens: you give up a third of the benefit to save 9% of the friction.
// Half the median read (p50 is 836 tokens) is nowhere near this and never sees the gate at all.
//
// ── WHAT THIS DOES NOT DO, STATED PLAINLY ─────────────────────────────────────────────────────
// A refusal does not delete those tokens. The caller re-issues with a range and still pays for
// what it takes. The saving is the difference between a whole file and the part that was wanted,
// and it is NOT the 64.4% above — that figure is the tokens the gate gets a say over, not the
// tokens it removes. Anyone quoting 64.4% as a saving is quoting it wrong. The real number can
// only be measured after the fact, from transcripts on either side of the day it was wired.
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
  `is charged again on every turn for the rest of the session. Measured across one fleet-day: reads ` +
  `with no range carry 85% of all Read tokens.\n\n` +
  `Do one of these instead:\n` +
  `  - Grep for what you need and read only around the hits\n` +
  `  - Read with offset and limit for the section you actually want\n` +
  `  - If you genuinely need the whole file, re-issue with an explicit limit (e.g. limit: 2000). ` +
  `That is allowed. The point is that it be on purpose rather than by default.\n\n` +
  `This never truncates anything and it is not a permission problem — you can still have every ` +
  `byte. Threshold is ${limitBytes} bytes; CLAUDE_WIDE_READ_BYTES retunes it, 0 disables it.`,
  input.session_id
);
