// guards-test.mjs — the two shell refusal guards, driven with synthetic hook payloads.
//
// WHAT A GUARD IS WORTH IS WHAT IT REFUSES. Every RED-PROOF below feeds a guard the exact input
// that once walked past it and asserts the deny JSON comes back. The ALLOW cases are load-bearing
// too: a guard that fires on ordinary work gets muted within a week, so each one pins a routine
// command the guard must stay out of.
//
// No payload carries a session id, so no guard-log.jsonl line is ever written by this suite.
// No payload carries a transcript path unless the assertion is about the unlock phrase, in which
// case the transcript is a temp file this suite writes and removes.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// PANDORAS_GUARDS_DIR points the same payloads at another copy of the guards (a fork, an installed
// copy), so an adopter can prove their copy refuses what this one refuses.
const GUARDS = process.env.PANDORAS_GUARDS_DIR ? path.resolve(process.env.PANDORAS_GUARDS_DIR) : path.join(HERE, '..', 'hooks');
const IRREVERSIBLE = path.join(GUARDS, 'guard-irreversible.sh');
const OVERWRITE = path.join(GUARDS, 'guard-report-overwrite.sh');
const BASH = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';

const tests = [];
const T = (name, fn) => tests.push({ name, fn });

/** Run a guard with one hook payload. Returns the permission decision, or `allow` on silence. */
function run(script, payload, { env = {} } = {}) {
  const r = spawnSync(BASH, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  const out = String(r.stdout ?? '').trim();
  if (!out) return { decision: 'allow', reason: '', status: r.status };
  try {
    const j = JSON.parse(out);
    return { decision: j.hookSpecificOutput.permissionDecision, reason: j.hookSpecificOutput.permissionDecisionReason, status: r.status };
  } catch {
    return { decision: `unparseable: ${out.slice(0, 120)}`, reason: out, status: r.status };
  }
}

const bash = (command, extra = {}) => ({ tool_name: 'Bash', tool_input: { command }, ...extra });
const sql = (query) => ({ tool_name: 'mcp__demo__execute_sql', tool_input: { query } });
const write = (file_path) => ({ tool_name: 'Write', tool_input: { file_path } });

const deny = (script, payload, opts) => {
  const r = run(script, payload, opts);
  assert.equal(r.decision, 'deny', `expected a refusal, got "${r.decision}" for ${JSON.stringify(payload.tool_input)}`);
  return r;
};
const allow = (script, payload, opts) => {
  const r = run(script, payload, opts);
  assert.equal(r.decision, 'allow', `expected silence, got "${r.decision}": ${r.reason.slice(0, 160)} for ${JSON.stringify(payload.tool_input)}`);
  return r;
};

// ---------------------------------------------------------------- controls
T('RED-PROOF control: a plain force-push is refused', () => deny(IRREVERSIBLE, bash('git push --force origin main')));
T('RED-PROOF control: a DELETE with no WHERE is refused', () => deny(IRREVERSIBLE, sql('DELETE FROM users')));
T('control: an ordinary push is not gated', () => allow(IRREVERSIBLE, bash('git push origin main')));
T('control: a SELECT is never gated', () => allow(IRREVERSIBLE, sql('SELECT count(*) FROM users')));
T('control: a commit whose MESSAGE names a dangerous command is not gated', () =>
  allow(IRREVERSIBLE, bash('git commit -am "fix: close no longer runs git worktree remove on its own cwd"')));
T('RED-PROOF control: a dangerous command inside `bash -c "..."` is still caught', () =>
  deny(IRREVERSIBLE, bash('bash -c "git push --force origin main"')));
T('control: an unrelated tool is not gated', () => allow(IRREVERSIBLE, { tool_name: 'Read', tool_input: { file_path: '/x' } }));

// ---------------------------------------------------------------- B1: global options between git and the verb
T('RED-PROOF B1: `git -C <dir> push --force` is refused', () => deny(IRREVERSIBLE, bash('git -C web push --force origin main')));
T('RED-PROOF B1: `git --no-pager push -f` is refused', () => deny(IRREVERSIBLE, bash('git --no-pager push -f origin main')));
T('RED-PROOF B1: `git -c k=v reset --hard` is refused', () => deny(IRREVERSIBLE, bash('git -c core.pager=cat reset --hard HEAD~1')));
T('RED-PROOF B1: `git -C <dir> branch -D` and `git -C <dir> worktree remove` are refused', () => {
  deny(IRREVERSIBLE, bash('git -C web branch -D feature-x'));
  deny(IRREVERSIBLE, bash('git -C web worktree remove ../web-x1'));
});
T('B1: `git -C <dir> status` and `git -C <dir> push` stay ungated', () => {
  allow(IRREVERSIBLE, bash('git -C web status --porcelain'));
  allow(IRREVERSIBLE, bash('git -C web push origin main'));
});

// ---------------------------------------------------------------- B2: command substitution in a message
T('RED-PROOF B2: a `$(...)` hidden in a commit message is refused', () =>
  deny(IRREVERSIBLE, bash('git commit --allow-empty -m "$(git push --force origin main)"')));
T('RED-PROOF B2: a backtick substitution in a commit message is refused', () =>
  deny(IRREVERSIBLE, bash('git commit -m "`git push --force origin main`"')));

// ---------------------------------------------------------------- B3: rm spellings
T('RED-PROOF B3: `rm -Rf`, `rm -r -f` and `rm --recursive --force` are all refused', () => {
  deny(IRREVERSIBLE, bash('rm -Rf build-output'));
  deny(IRREVERSIBLE, bash('rm -r -f build-output'));
  deny(IRREVERSIBLE, bash('rm --recursive --force build-output'));
  deny(IRREVERSIBLE, bash('rm -rf build-output'));
  deny(IRREVERSIBLE, bash('rm -fr build-output'));
});
T('RED-PROOF B3: an rm inside `bash -c "..."`, behind a path, or after `&&` is still an rm', () => {
  deny(IRREVERSIBLE, bash('bash -c "rm -rf /tmp/x"'));
  deny(IRREVERSIBLE, bash('/bin/rm -rf build-output'));
  deny(IRREVERSIBLE, bash('npm run build && rm -rf dist'));
});
T('B3: `rm -f one-file` and `rm -r dir` (no force) stay ungated', () => {
  allow(IRREVERSIBLE, bash('rm -f dist/bundle.js'));
  allow(IRREVERSIBLE, bash('rm -r build-output'));
});

// ---------------------------------------------------------------- B4: other force-push spellings
T('RED-PROOF B4: `git push origin +main` is refused', () => deny(IRREVERSIBLE, bash('git push origin +main')));
T('RED-PROOF B4: `git push -fu origin main` is refused', () => deny(IRREVERSIBLE, bash('git push -fu origin main')));
T('B4: a branch name containing `-f` is not a force flag', () => {
  allow(IRREVERSIBLE, bash('git push origin feature-fix'));
  allow(IRREVERSIBLE, bash('git push -u origin fix-flaky-test'));
});

// ---------------------------------------------------------------- B5: branch deletion spellings
T('RED-PROOF B5: `--delete`, `-fd` and `-dr` are refused', () => {
  deny(IRREVERSIBLE, bash('git branch --delete feature-x'));
  deny(IRREVERSIBLE, bash('git branch -fd feature-x'));
  deny(IRREVERSIBLE, bash('git branch -dr origin/feature-x'));
  deny(IRREVERSIBLE, bash('git branch -d feature-x'));
  deny(IRREVERSIBLE, bash('git branch -D feature-x'));
});
T('B5: creating, listing and renaming a branch stay ungated', () => {
  allow(IRREVERSIBLE, bash('git branch feature-dev'));
  allow(IRREVERSIBLE, bash('git branch --list'));
  allow(IRREVERSIBLE, bash('git branch -m old new'));
  allow(IRREVERSIBLE, bash('git branch --sort=-committerdate'));
});

// ---------------------------------------------------------------- B6: psql case
T('RED-PROOF B6: `psql -c "drop table users"` is refused whatever the case', () => {
  deny(IRREVERSIBLE, bash('psql -c "drop table users"'));
  deny(IRREVERSIBLE, bash('psql "$DB" -c "delete from users"'));
});

// ---------------------------------------------------------------- B7: SQL across lines, comments, and a WHERE that is not one
T('RED-PROOF B7a: a newline between DELETE and FROM is still a DELETE', () => deny(IRREVERSIBLE, sql('DELETE\nFROM users')));
T('RED-PROOF B7a: a newline between CREATE and TABLE is still a CREATE', () => deny(IRREVERSIBLE, sql('CREATE\nTABLE t (id int)')));
T('RED-PROOF B7a: a block comment between the words is ignored', () => deny(IRREVERSIBLE, sql('DELETE /*x*/ FROM users')));
T('RED-PROOF B7a: a line comment between the words is ignored', () => deny(IRREVERSIBLE, sql('DELETE -- note\nFROM users')));
T('RED-PROOF B7b: `WHERE true` and `WHERE 1=1` are not a WHERE', () => {
  deny(IRREVERSIBLE, sql('DELETE FROM users WHERE true'));
  deny(IRREVERSIBLE, sql('DELETE FROM users WHERE 1=1'));
  deny(IRREVERSIBLE, sql('UPDATE users SET a = 1 WHERE 1 = 1'));
});
T('B7b: a narrow WHERE keeps DELETE and UPDATE ungated', () => {
  allow(IRREVERSIBLE, sql('DELETE FROM users WHERE id = 3'));
  allow(IRREVERSIBLE, sql('UPDATE users SET a = 1 WHERE id = 3'));
});

// ---------------------------------------------------------------- B8: the subcommand the CLI actually has
T('RED-PROOF B8: `supabase projects delete` and `supabase branches delete` are refused', () => {
  deny(IRREVERSIBLE, bash('supabase projects delete abcdefgh'));
  deny(IRREVERSIBLE, bash('supabase branches delete abcdefgh'));
  deny(IRREVERSIBLE, bash('supabase db push'));
});

// ---------------------------------------------------------------- B9: an alias defined and invoked on one line
T('RED-PROOF B9: `git config alias.x "push --force"; git x` is refused', () =>
  deny(IRREVERSIBLE, bash("git config alias.yolo 'push --force origin main'; git yolo")));

// ---------------------------------------------------------------- B10: no python3 must FAIL CLOSED
T('RED-PROOF B10: with no python3 on PATH the guard refuses rather than allowing', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-nopy-'));
  try {
    for (const tool of ['grep', 'cat', 'dirname', 'basename', 'sed', 'tr', 'sh']) {
      const where = spawnSync('which', [tool], { encoding: 'utf8' }).stdout.trim();
      if (where) fs.symlinkSync(where, path.join(bin, tool));
    }
    const r = run(IRREVERSIBLE, bash('git push --force origin main'), { env: { PATH: bin } });
    assert.equal(r.decision, 'deny', `a guard that cannot parse its input must refuse, got "${r.decision}"`);
    assert.match(r.reason, /python3/);
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- F8: the unlock phrase is a whole message or a line
function withTranscript(records, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-transcript-'));
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  try { return fn(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const user = (text, extra = {}) => ({ type: 'user', message: { role: 'user', content: text }, ...extra });
const PHRASE = 'flyingfish';

T('unlock: the phrase as the whole message unlocks', () => withTranscript([user('hello'), user(PHRASE)], (t) =>
  allow(IRREVERSIBLE, bash('git push --force origin main', { transcript_path: t }))));
T('unlock: the phrase on a line by itself unlocks', () => withTranscript([user(`go ahead\n${PHRASE}\nthanks`)], (t) =>
  allow(IRREVERSIBLE, bash('git push --force origin main', { transcript_path: t }))));
T('RED-PROOF unlock: the phrase inside a sentence does NOT unlock', () => withTranscript([user(`we might ${PHRASE} later, not now`)], (t) =>
  deny(IRREVERSIBLE, bash('git push --force origin main', { transcript_path: t }))));
T('RED-PROOF unlock: a harness-injected (isMeta) message carrying the phrase does NOT unlock', () => withTranscript([user(PHRASE, { isMeta: true })], (t) =>
  deny(IRREVERSIBLE, bash('git push --force origin main', { transcript_path: t }))));
T('RED-PROOF unlock: an assistant message carrying the phrase does NOT unlock', () =>
  withTranscript([{ type: 'assistant', message: { role: 'assistant', content: PHRASE } }], (t) =>
    deny(IRREVERSIBLE, bash('git push --force origin main', { transcript_path: t }))));
T('RED-PROOF unlock: an emphatic go-ahead that is not the phrase unlocks nothing', () => withTranscript([user('GO AHEAD'), user('yes, do it')], (t) =>
  deny(IRREVERSIBLE, bash('git push --force origin main', { transcript_path: t }))));
T('unlock: $PANDORAS_UNLOCK_PHRASE replaces the default, whole-message rule included', () => withTranscript([user('yes really')], (t) => {
  allow(IRREVERSIBLE, bash('git push --force origin main', { transcript_path: t }), { env: { PANDORAS_UNLOCK_PHRASE: 'yes really' } });
  deny(IRREVERSIBLE, bash('git push --force origin main', { transcript_path: t }), { env: { PANDORAS_UNLOCK_PHRASE: 'something else' } });
}));
T('RED-PROOF unlock: the refusal reason names the phrase the operator must type', () => {
  const r = deny(IRREVERSIBLE, bash('git push --force origin main'));
  assert.match(r.reason, /flyingfish/);
});

// ---------------------------------------------------------------- the report-overwrite guard
function withBridge(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-bridge-'));
  const bridge = path.join(dir, '_handoffs');
  fs.mkdirSync(path.join(bridge, '_lanes'), { recursive: true });
  fs.writeFileSync(path.join(bridge, 'done-2026-01-01-web-x1-thing.md'), '# report\n');
  fs.writeFileSync(path.join(bridge, 'README.md'), '# bridge\n');
  fs.writeFileSync(path.join(bridge, '_STANDING_ORDERS.md'), '# orders\n');
  fs.writeFileSync(path.join(bridge, 'Notes.md'), '# notes\n');
  fs.writeFileSync(path.join(bridge, '_lanes', 'LANES.md'), '');
  try { return fn(bridge); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

T('RED-PROOF overwrite: a Write onto an existing report is refused and names the -2 slot', () => withBridge((b) => {
  const r = deny(OVERWRITE, write(path.join(b, 'done-2026-01-01-web-x1-thing.md')));
  assert.match(r.reason, /done-2026-01-01-web-x1-thing-2\.md/);
}));
T('overwrite: creating a new report, editing a subdirectory file, and a non-.md file are all free', () => withBridge((b) => {
  allow(OVERWRITE, write(path.join(b, 'done-2026-01-01-web-x2-new.md')));
  allow(OVERWRITE, write(path.join(b, '_lanes', 'LANES.md')));
  allow(OVERWRITE, write(path.join(b, 'notes.txt')));
}));
T('overwrite: the default furniture (README.md, _STANDING_ORDERS.md) is edited in place', () => withBridge((b) => {
  allow(OVERWRITE, write(path.join(b, 'README.md')));
  allow(OVERWRITE, write(path.join(b, '_STANDING_ORDERS.md')));
}));
T('overwrite: $PANDORAS_BRIDGE_FURNITURE adds a workspace\'s own in-place files', () => withBridge((b) => {
  deny(OVERWRITE, write(path.join(b, 'Notes.md')));
  allow(OVERWRITE, write(path.join(b, 'Notes.md')), { env: { PANDORAS_BRIDGE_FURNITURE: 'README.md Notes.md' } });
}));
T('RED-PROOF B15a: a `/./` segment in the path does not slip past the bridge check', () => withBridge((b) =>
  deny(OVERWRITE, write(path.join(b, '.', 'done-2026-01-01-web-x1-thing.md').replace(`${path.sep}done-`, `${path.sep}.${path.sep}done-`)))));
T('RED-PROOF B15a: a `..` segment that resolves back onto the bridge is refused too', () => withBridge((b) =>
  deny(OVERWRITE, write(`${b}/_lanes/../done-2026-01-01-web-x1-thing.md`))));
T('RED-PROOF B15b: an uppercase .MD lands on the same file on a case-insensitive disk and is refused', () => withBridge((b) => {
  const upper = path.join(b, 'done-2026-01-01-web-x1-thing.MD');
  if (fs.existsSync(upper)) deny(OVERWRITE, write(upper));
  else allow(OVERWRITE, write(upper)); // a case-sensitive disk would create a new file, which is the free case
}));

// ---------------------------------------------------------------- run
let pass = 0;
const fails = [];
for (const t of tests) {
  try { t.fn(); pass++; } catch (e) { fails.push({ name: t.name, message: e.message }); }
}
for (const f of fails) console.log(`FAIL  ${f.name}\n      ${String(f.message).split('\n')[0]}`);
const red = tests.filter((t) => t.name.startsWith('RED-PROOF')).length;
console.log(`GUARD ASSERTIONS  ${pass}/${tests.length} pass, ${fails.length} fail`);
console.log(`  ${red} of them are RED-PROOF: each feeds a guard an input that once walked past it and asserts the refusal.`);
if (fails.length) throw new Error(`guards-test.mjs: ${fails.length}/${tests.length} assertion(s) failed.`);
