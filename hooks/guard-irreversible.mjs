#!/usr/bin/env node
// ── WHAT THIS IS ──────────────────────────────────────────────────────────────────────────────
// WHAT IT CHECKS: a command or a database statement that cannot be undone by a later commit, and
//                 refuses it unless the operator has typed the unlock phrase in this session.
// LOG:            guard-log.jsonl beside this file, one line per refusal, never on a pass.
//                 (The log is generated at runtime and is not part of the repository.)
// RUNTIME:        Node built-ins only. No bash, no python3, no dependencies. It was a Bash script
//                 that piped its input through inline Python; the verdicts are unchanged and the
//                 assertion suite in test/guards-test.mjs feeds both the same inputs.
// ──────────────────────────────────────────────────────────────────────────────────────────────
//
// THE UNLOCK PHRASE IS A HUMAN-CONFIRMATION PROTOCOL, AND IT HAS NO DEFAULT. Set
// $PANDORAS_UNLOCK_PHRASE to whatever your team says out loud when it means it. With the variable
// unset (or blank), nothing can unlock this guard in that session: every gated command is refused
// and the refusal says why. The phrase must be typed by a real USER in this session's transcript,
// as the WHOLE message or as a line by itself: a phrase quoted inside a sentence, a pasted log that
// happens to carry it, or a brief that mentions the rule does not unlock anything. An agent cannot
// unlock itself by writing the words, which is the entire point of reading the transcript rather
// than a flag. Once typed, the unlock holds for the rest of that session; pick a phrase that is
// not ordinary English.
//
// Said plainly: the phrase is not a secret and it is not a security boundary against a determined
// evasion. It is the mechanism by which a person, not an agent, says "yes, that one" before an
// action that no commit can undo. A published default phrase would let any adopter's agent read
// the word off the internet; that is why there is none.
//
// WHAT IS DELIBERATELY NOT GATED. An ordinary `git push` and an ordinary production deploy. They
// are reversible by a commit and they are how a lane finishes its work. Gating them costs a human
// interruption on every routine deploy and buys nothing a build gate has not already bought — and
// a guard that fires on ordinary work gets muted within a week.
//
// STILL GATED, and deliberately so: none of these are undone by a commit.
//   force-push (every spelling: --force, -f, -fu, +refspec, --force-with-lease, --delete)
//   branch deletion (local or remote, -d/-D/--delete and combined flags), worktree removal
//   history rewrites (reset --hard, rebase, filter-branch, filter-repo, BFG)
//   clean -f, rm with any recursive AND any force flag, a git alias defined on the command line
//   anything that writes schema to a live database, or deletes/updates rows with no narrow WHERE
//
// THE CEILING OF A PATTERN GUARD, stated rather than discovered: a command hidden inside a script
// file, a `sh -c "$(cat x)"`, or SQL sent through a file or a stored procedure walks past this.
// It refuses what it can see. It fails CLOSED when it cannot see: input that does not parse as a
// JSON object gives no verdict, and no verdict means deny.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = 'guard-irreversible';

// One line per refusal. A logging failure must never change a verdict, hence the try/catch.
// A call with no chat id attached is a synthetic one from the assertion suite, not a real refusal,
// and is not logged: one test run would otherwise add twenty-odd refusals that never happened and
// drown the real ones. The harness always supplies a chat id on a live call.
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

// The shell version printed each field with Python's print(), so a missing field was an empty
// string. Same here: a string is itself, nothing is '', anything else is its string form.
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let input;
try { input = JSON.parse(raw); } catch { input = undefined; }
if (!input || typeof input !== 'object' || Array.isArray(input)) {
  deny(`${HOOK} could not read its input as a JSON object and refuses rather than guess. ` +
    'The harness sends one JSON object on stdin; check what invoked this hook and retry.');
}

const SESSION = str(input.session_id);
const TOOL = str(input.tool_name);
const TI = (input.tool_input && typeof input.tool_input === 'object') ? input.tool_input : {};
let CMD = str(TI.command);
const TRANSCRIPT = str(input.transcript_path);
let SQL = str(TI.query);
const UNLOCK = process.env.PANDORAS_UNLOCK_PHRASE;
const UNLOCKABLE = typeof UNLOCK === 'string' && UNLOCK.trim() !== '';

// NORMALISE BEFORE MATCHING. The shell version's grep was line-based, so `DELETE⏎FROM` never
// matched `delete +from`, and a `/* comment */` or a `-- comment` between the words hid them too.
// Comments are stripped and every run of whitespace becomes one space, so the patterns below see
// one line. A `--` inside a string literal is stripped along with the rest of its line, which can
// only make the guard refuse MORE, never less. A backslash-newline in a shell command is a
// continuation and joins; any other newline is a command boundary and becomes ` ; `.
function normSql(s) {
  s = s.replace(/--[^\n]*/g, ' ');
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');     // Python re.S: `.` crossed newlines; [\s\S] does here
  return s.replace(/\s+/g, ' ');
}
function normCmd(s) {
  s = s.replace(/\\\n/g, ' ');
  return s.replace(/[\r\n]+/g, ' ; ');
}
// The shell only replaced the value when the normalised form was non-empty; the same guard here.
{ const n = normSql(SQL); if (n) SQL = n; }
{ const n = normCmd(CMD); if (n) CMD = n; }

// `\W` is exactly the shell's `[^_[:alnum:]]`: anything that is not a letter, digit or underscore.
// `WHERE true` and `WHERE 1=1` are the shape of a WHERE with none of the narrowing.
function hasNarrowWhere(s) {
  if (!/\Wwhere\W/i.test(s)) return false;
  if (/\Wwhere +(true|1 *= *1)(\W|$)/i.test(s)) return false;
  return true;
}

// Any git global option may sit between `git` and the verb: `-C <dir>`, `--no-pager`, `-c k=v`,
// `--git-dir=…`. Every git pattern below starts with this so none of them can be skipped that way.
const G = 'git( +-[^ ]+( +[^- ][^ ]*)?)*';
const git = (tail) => new RegExp(`${G} +${tail}`);

let DANGER = false;
if (TOOL.includes('apply_migration')) {
  DANGER = true;
} else if (TOOL.includes('execute_sql')) {
  // An `execute_sql` tool is commonly auto-approved in a settings file, and this database may hold
  // everything the operator runs, so the statement classes below want the unlock phrase rather
  // than a click.
  //
  // READS ARE NOT GATED and must not be: SELECT against this database is how a lane
  // measures anything, and gating it would push sessions toward guessing instead.
  //
  // schema, privileges, and the two statements that quietly destroy rows
  if (/(^|\W)(drop|truncate|alter|grant|revoke)(\W|$)/i.test(SQL)) DANGER = true;
  if (/(^|\W)create +(or +replace +)?(table|view|function|trigger|policy|index|schema|type)/i.test(SQL)) DANGER = true;
  // DELETE / UPDATE are only safe with a narrow WHERE
  if (/(^|\W)delete +from/i.test(SQL) && !hasNarrowWhere(SQL)) DANGER = true;
  if (/(^|\W)update +[a-z_."]+ +set/i.test(SQL) && !hasNarrowWhere(SQL)) DANGER = true;
} else if (TOOL === 'Bash') {
  // AMENDED. DESCRIBING a dangerous command is not RUNNING one.
  //
  // This gate matches the whole command string, so a commit message that named the bug it was
  // fixing tripped it: `git commit -am "...close ran git worktree remove..."` was refused as
  // an irreversible operation. The cost is not the interruption — a lane that hits
  // "irreversible operation blocked" on a plain commit reasonably concludes it cannot commit at
  // all and stops. It is also self-defeating: a workspace that requires commit messages to
  // explain the failure being fixed finds the failures worth fixing are exactly these words.
  //
  // So the VALUE of a message-carrying flag is blanked before matching. NARROWLY, and never
  // quoted text in general: `bash -c "git push --force"` must still be caught, and the test
  // suite asserts that it is. A git commit message is never executed; a -c argument is. That
  // difference is the whole basis for this being safe — with ONE exception the scrubber checks
  // first: a `$(...)` or a backtick inside the quoted value IS executed by the shell before git
  // ever sees the message, so a value carrying either is DANGER before anything is blanked.
  //
  // Only these flags, only their quoted value, quote-type aware, backslash-escape aware. The
  // pattern is the Python one unchanged: JS has the lookbehind, the backreference inside the
  // negative lookahead, and (via the `s` flag) the dot-matches-newline that re.S gave it.
  const scrub = /(?:(?<=\s)|^)(-m|-am|--message|--body|--title)(=|\s+)(["'])(?:\\.|(?!\3).)*\3/gs;
  for (const m of CMD.matchAll(scrub)) {
    if (m[0].includes('$(') || m[0].includes('`')) DANGER = true;
  }
  CMD = CMD.replace(scrub, (_, flag, sep, q) => flag + sep + q + q);
  // history rewrites / force pushes / deletions
  if (git('push[^|;&]*(--force|--force-with-lease|--delete| :|( |^)-[a-zA-Z]*f[a-zA-Z]*( |$)| \\+[^ ])').test(CMD)) DANGER = true;
  if (git('(reset +--hard|rebase|filter-branch|filter-repo|reflog +(delete|expire))').test(CMD)) DANGER = true;
  if (git('branch( +[^|;&]*)? +(--delete|-[a-zA-Z]*[dD][a-zA-Z]*)( |$)').test(CMD)) DANGER = true;
  if (git('worktree +remove').test(CMD)) DANGER = true;
  if (git('clean +[^|;&]*-[a-z]*f').test(CMD)) DANGER = true;
  if (git('config +[^|;&]*alias\\.').test(CMD)) DANGER = true;
  if (/bfg|--strip-blobs|--replace-text/.test(CMD)) DANGER = true;
  // destructive filesystem: any recursive flag AND any force flag on one rm, in any spelling
  // `rm` counts wherever it is not the tail of another word: at the start, after `;`, `&&`, `|`,
  // a quote (`bash -c "rm -rf x"`) or a path (`/bin/rm`).
  //
  // The shell collected every rm segment with `grep -o` and tested the recursive flag and the
  // force flag against the whole collection, so `rm -r a && rm -f b` is refused as well as
  // `rm -rf a`. Kept as it was: it can only refuse more, and the port promises identical verdicts.
  const rmSegs = [...CMD.matchAll(/(^|[^A-Za-z0-9_-])rm +[^|;&]*/g)].map((m) => m[0]);
  if (rmSegs.length
      && rmSegs.some((s) => /( |^)(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)( |$)/.test(s))
      && rmSegs.some((s) => /( |^)(-[a-zA-Z]*f[a-zA-Z]*|--force)( |$)/.test(s))) DANGER = true;
  // schema against a live database
  if (/(db push|db reset|migration up|migrate deploy|(projects|branches) +(delete|rm))/.test(CMD)) DANGER = true;
  if (/psql[^|;&]*(drop|truncate|delete +from)/i.test(CMD)) DANGER = true;
}
if (!DANGER) process.exit(0);

// THE TRANSCRIPT RULE. The phrase counts only as the WHOLE trimmed text of a user message, or as a
// line by itself inside one: never a substring of a sentence. Harness-injected (isMeta) records and
// assistant records are not a person typing. A record that does not parse is skipped, as before.
// Python's str.splitlines() split on more than \n and \r; the same set is used here so a phrase
// on its own line is found in exactly the same places. The two Unicode separators (U+2028 and
// U+2029) are built from char codes because a literal one inside a regex is a line break in JS
// source and breaks the file.
const LINE_BREAK = new RegExp('\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85' + String.fromCharCode(0x2028, 0x2029) + ']');
function transcriptUnlocks(file, phrase) {
  let text;
  try {
    if (!fs.statSync(file).isFile()) return false;
    text = fs.readFileSync(file, 'utf8');          // invalid bytes become U+FFFD, as errors="replace" did
  } catch { return false; }
  if (!text.includes(phrase)) return false;          // the cheap prefilter grep -l used to be
  for (const line of text.split('\n')) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== 'object' || o.type !== 'user' || o.isMeta) continue;
    const c = (o.message && typeof o.message === 'object') ? o.message.content : undefined;
    let txt = '';
    if (typeof c === 'string') txt = c;
    else if (Array.isArray(c)) {
      txt = c.map((b) => (b && typeof b === 'object' && !Array.isArray(b) ? str(b.text) : '')).join(' ');
    }
    if (txt.trim() === phrase) return true;
    if (txt.split(LINE_BREAK).some((l) => l.trim() === phrase)) return true;
  }
  return false;
}

if (UNLOCKABLE && TRANSCRIPT && transcriptUnlocks(TRANSCRIPT, UNLOCK)) process.exit(0);

const what = CMD || SQL;
const head = 'Irreversible operation blocked (force-push, history rewrite, deletion, or live schema change): ';
if (!UNLOCKABLE) {
  guardLog('deny', `irreversible, no unlock phrase configured (PANDORAS_UNLOCK_PHRASE unset): ${what}`, SESSION);
  deny(head +
    'this session cannot be unlocked at all because PANDORAS_UNLOCK_PHRASE is not set, so an ' +
    'operator must choose a phrase and set that variable in the environment this hook runs in ' +
    'before any gated command can proceed.');
}
guardLog('deny', `irreversible, unlock phrase not in this session: ${what}`, SESSION);
deny(head +
  `nobody has typed "${UNLOCK}" as a message of its own in this session. Ask the operator, then ` +
  'retry once they have.');
