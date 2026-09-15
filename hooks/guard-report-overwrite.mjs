#!/usr/bin/env node
// @ts-check
// ── WHAT THIS IS ──────────────────────────────────────────────────────────────────────────────
// WHAT IT CHECKS: a whole-file Write aimed at a report that already exists on the handoff bridge,
//                 and refuses it so a second agent cannot erase the first one's report.
// LOG:            guard-log.jsonl beside this file, one line per refusal, never on a pass.
//                 (The log is generated at runtime and is not part of the repository.)
// RUNTIME:        Node built-ins only. No bash, no python3, no dependencies. It was a Bash script
//                 that piped its input through inline Python; the verdicts are unchanged and the
//                 assertion suite in test/guards-test.mjs feeds both the same inputs.
// ──────────────────────────────────────────────────────────────────────────────────────────────
// Refuses a Write that would land on top of an existing report on the handoff bridge.
//
// WHY THIS EXISTS. Two sessions once ran one brief at the same time. The brief named one exact
// output filename, so the second session to finish wrote its report to that name and landed on top
// of the first session's report. That report's receipts, its defect list with owners, its
// escalations and its record of what it deliberately left untouched were gone and were never
// recovered. The bridge is not under version control, so there was no copy. The only warning anyone
// got was the Write tool answering "has been updated successfully" instead of "created", which is
// far too quiet for what it means.
//
// The other half of the fix is in lib/naming.mjs: a derived report filename carries the LANE, so
// two sessions of one brief cannot produce the same name in the first place. This hook is the
// backstop for every path that does not go through it.
//
// WHAT IT GUARDS. Write (whole-file replace) to an existing .md at the ROOT of _handoffs/. That is
// where reports and briefs live and where the collision happened. The path is normalised first, so
// `_handoffs/./x.md` and `_handoffs/_lanes/../x.md` are the same file as `_handoffs/x.md`, and the
// extension is matched in any case, because on a case-insensitive disk `x.MD` lands on `x.md`.
// The hook reads only the file path; the matcher in the settings file is what scopes it to Write.
//
// WHAT IT DELIBERATELY DOES NOT GUARD, so it stays worth having:
//   - Edit. A targeted edit is not a silent replace; it fails loudly if its anchor is missing.
//   - Files that do not exist yet. Creating is the normal case and must stay frictionless.
//   - Anything in a subdirectory of _handoffs/ (assets, _lanes, archive) or outside the bridge.
//   - The bridge's own furniture, edited in place by design: `README.md` and `_STANDING_ORDERS.md`
//     by default; set $PANDORAS_BRIDGE_FURNITURE to a space-separated list to name your own.
// A guard that fires on ordinary work gets muted within a week, and a muted guard protects nothing.
//
// It fails CLOSED when it cannot see: input that does not parse as a JSON object gives no verdict,
// and no verdict means deny.
//
// The refusal names the -2 variant rather than only saying no, because the lane on the other end of
// it has a finished report in hand and needs somewhere to put it in the next ten seconds.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = 'guard-report-overwrite';

// One line per refusal. A logging failure must never change a verdict, hence the try/catch.
// A call with no chat id attached is a synthetic one from the assertion suite, not a real refusal,
// and is not logged: one test run would otherwise add refusals that never happened and drown the
// real ones. The harness always supplies a chat id on a live call.
function guardLog(verdict, reason, session) {
  if (!session) return;
  try {
    const p = path.join(path.dirname(fileURLToPath(import.meta.url)), 'guard-log.jsonl');
    fs.appendFileSync(p, JSON.stringify({
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      hook: HOOK, verdict, reason: reason.slice(0, 200), session,
    }) + '\n');
  } catch { /* never block on logging */ }
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }) + '\n');
  process.exit(0);
}

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let input;
try { input = JSON.parse(raw); } catch { input = undefined; }
if (!input || typeof input !== 'object' || Array.isArray(input)) {
  deny(`${HOOK} could not read its input as a JSON object and refuses rather than guess. ` +
    'The harness sends one JSON object on stdin; check what invoked this hook and retry.');
}

const SESSION = str(input.session_id);
const TI = (input.tool_input && typeof input.tool_input === 'object') ? input.tool_input : {};
let FILE = str(TI.file_path);
if (!FILE) process.exit(0);
// Normalise `.` and `..` segments so the directory test below sees the real parent.
FILE = path.normalize(FILE);
if (!FILE) process.exit(0);
if (!isFile(FILE)) process.exit(0);

const DIR = path.dirname(FILE);
const BASE = path.basename(FILE);

// The shell matched `*/_handoffs`; a directory NAMED _handoffs is the same test, and it also holds
// for a relative path (`_handoffs/x.md`), which the glob let past. Refuses more, never less.
if (path.basename(DIR) !== '_handoffs') process.exit(0);
if (!/\.md$/i.test(BASE)) process.exit(0);

// The bridge's own furniture is edited in place by design and is not a lane's report. The variable
// is split on whitespace the way the shell's word splitting did; unset or empty means the default.
const furnitureEnv = process.env.PANDORAS_BRIDGE_FURNITURE;
const FURNITURE = (furnitureEnv === undefined || furnitureEnv === '')
  ? ['README.md', '_STANDING_ORDERS.md']
  : furnitureEnv.split(/\s+/).filter(Boolean);
if (FURNITURE.includes(BASE)) process.exit(0);

const STEM = BASE.replace(/\.md$/i, '');
let n = 2;
let SUGGEST = path.join(DIR, `${STEM}-${n}.md`);
while (isFile(SUGGEST)) {
  n += 1;
  SUGGEST = path.join(DIR, `${STEM}-${n}.md`);
}

guardLog('deny', `report already on the bridge, whole-file Write refused: ${BASE}`, SESSION);

deny(
  `Refused: '${BASE}' already exists on the handoff bridge and Write would replace it whole.\n\n` +
  'This is the guard for the incident where a second session running the same brief silently ' +
  'overwrote the first session\'s finished report and its receipts were never recovered. If a ' +
  'file is already at the name your brief told you to use, YOU ARE THE SECOND SESSION.\n\n' +
  'Do this instead:\n' +
  `  1. Read '${BASE}' first. If it is another lane's report, do not touch it.\n` +
  `  2. Write yours to: ${SUGGEST}\n` +
  '  3. Record the collision in your incident log, naming both sessions.\n\n' +
  'If you genuinely mean to revise your OWN report, use Edit rather than Write — a targeted edit ' +
  'cannot silently erase a report you have not read.'
);
