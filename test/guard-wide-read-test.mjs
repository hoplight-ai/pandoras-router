#!/usr/bin/env node
// guard-wide-read-test.mjs — assertions for hooks/guard-wide-read.mjs.
//
//   node test/guard-wide-read-test.mjs
//
// ── WHY THIS FILE IS HERE AND NOT NEXT TO THE HOOK ────────────────────────────────────────────
// A hooks directory is typically outside version control, so nothing in it is recoverable by a
// commit. This file lives in the repository so the assertions survive even when the thing they
// test does not — and so a hook that goes missing turns the suite red instead of quiet.
//
// ── WHAT THESE PROTECT ────────────────────────────────────────────────────────────────────────
// This gate's danger is not that it fails open. It is that it fails NOISY: a read guard that
// refuses something the caller cannot re-issue stops a lane dead, and the lane reasonably
// concludes it cannot read files at all. That is the guard-irreversible failure of 2026-08-22 in
// a new costume. So every ALLOW case below is load-bearing, and the DENY cases exist so a future
// widening of the allow-list cannot quietly remove the only refusal that does any work.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'guard-wide-read.mjs');
if (!fs.existsSync(HOOK)) {
  console.log(`guard-wide-read-test: ${HOOK} is missing.`);
  console.log('Nothing was asserted. A skip is not a pass.');
  throw new Error('guard-wide-read-test.mjs: the hook is missing. Nothing was asserted, and a skip is not a pass.');
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wideread-'));
const big = path.join(dir, 'big.md');
const small = path.join(dir, 'small.md');
const bigPng = path.join(dir, 'shot.png');
const bigJson = path.join(dir, 'data.json');
fs.writeFileSync(big, 'x'.repeat(40000));
fs.writeFileSync(small, 'x'.repeat(500));
fs.writeFileSync(bigPng, 'x'.repeat(40000));
fs.writeFileSync(bigJson, 'x'.repeat(40000));

let pass = 0;
const failures = [];

// verdict(payload, env) -> 'allow' | 'deny'
function verdict(payload, env = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return (r.stdout || '').includes('"permissionDecision":"deny"') ? 'deny' : 'allow';
}

function check(expect, name, payload, env) {
  const got = verdict(payload, env);
  if (got === expect) pass++;
  else failures.push(`[${name}] expected ${expect}, got ${got}`);
}

const read = (input) => ({ tool_name: 'Read', tool_input: input });

// ── THE ONE REFUSAL THAT DOES THE WORK ────────────────────────────────────────────────────────
check('deny', 'a whole-file Read of a large file is refused', read({ file_path: big }));
check('deny', 'still refused when other unrelated keys are present',
  read({ file_path: big, some_future_key: true }));

// ── EVERY WAY A CALLER CAN SATISFY IT ─────────────────────────────────────────────────────────
// If any of these ever turns to deny, a lane has been handed a refusal it cannot act on.
check('allow', 'offset alone names a range', read({ file_path: big, offset: 100 }));
check('allow', 'limit alone names a range', read({ file_path: big, limit: 200 }));
check('allow', 'offset and limit together', read({ file_path: big, offset: 10, limit: 50 }));
check('allow', 'an explicit limit is the documented escape hatch',
  read({ file_path: big, limit: 2000 }));
check('allow', 'a limit of 0 is still an explicit range, not an absence',
  read({ file_path: big, limit: 0 }));

// ── THINGS THE GATE MUST NEVER TOUCH ──────────────────────────────────────────────────────────
check('allow', 'a small file is never gated', read({ file_path: small }));
check('allow', 'an image is never gated — offset/limit are meaningless for it',
  read({ file_path: bigPng }));
check('allow', 'a PDF page range satisfies it', { tool_name: 'Read', tool_input: { file_path: big, pages: '1-5' } });
check('allow', 'a file that does not exist is left for Read to report',
  read({ file_path: path.join(dir, 'nope.md') }));
check('allow', 'a directory is left for Read to report', read({ file_path: dir }));
check('allow', 'another tool is not this gate\'s business',
  { tool_name: 'Grep', tool_input: { pattern: 'x', path: big } });
check('allow', 'Write to the same large path is not a read',
  { tool_name: 'Write', tool_input: { file_path: big, content: 'x' } });
check('allow', 'no file_path at all', read({}));
check('allow', 'a non-string file_path', read({ file_path: 42 }));

// ── FAIL-OPEN ON ANYTHING UNPARSEABLE ─────────────────────────────────────────────────────────
// A read guard that fails CLOSED on a payload change stops every session on this machine at once.
{
  const r = spawnSync(process.execPath, [HOOK], { input: 'not json at all', encoding: 'utf8' });
  const got = (r.stdout || '').includes('"permissionDecision":"deny"') ? 'deny' : 'allow';
  if (got === 'allow') pass++; else failures.push('[malformed payload] expected allow, got deny');
}
{
  const r = spawnSync(process.execPath, [HOOK], { input: '', encoding: 'utf8' });
  const got = (r.stdout || '').includes('"permissionDecision":"deny"') ? 'deny' : 'allow';
  if (got === 'allow') pass++; else failures.push('[empty payload] expected allow, got deny');
}

// ── THE ESCAPE HATCHES, WHICH ARE THE REASON THIS IS SAFE TO SHIP ─────────────────────────────
check('allow', 'CLAUDE_WIDE_READ_BYTES=0 disables the gate entirely',
  read({ file_path: big }), { CLAUDE_WIDE_READ_BYTES: '0' });
check('allow', 'a raised threshold lets a large file through',
  read({ file_path: big }), { CLAUDE_WIDE_READ_BYTES: '999999' });
check('deny', 'a lowered threshold catches a file that would otherwise pass',
  read({ file_path: small }), { CLAUDE_WIDE_READ_BYTES: '100' });
check('allow', 'a non-numeric threshold disables rather than crashing',
  read({ file_path: big }), { CLAUDE_WIDE_READ_BYTES: 'banana' });

// ── THE REFUSAL MUST BE ACTIONABLE ────────────────────────────────────────────────────────────
// A deny whose text does not say how to proceed is how a lane concludes it cannot read at all.
{
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(read({ file_path: big })), encoding: 'utf8' });
  const reason = (() => { try { return JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason; } catch { return ''; } })();
  const needs = ['Grep', 'offset', 'limit', 'CLAUDE_WIDE_READ_BYTES'];
  const missing = needs.filter((n) => !reason.includes(n));
  if (!missing.length) pass++;
  else failures.push(`[refusal text] does not name: ${missing.join(', ')}`);
  if (reason.includes('KB') && /\d/.test(reason)) pass++;
  else failures.push('[refusal text] does not state the file size, so a reader cannot judge it');
}

fs.rmSync(dir, { recursive: true, force: true });

for (const f of failures) console.log(`FAIL  ${f}`);
console.log(`\nWIDE-READ GATE ASSERTIONS  ${pass}/${pass + failures.length} pass, ${failures.length} fail`);
console.log('  DENY assertions: 3 — each asserts a REFUSAL, so removing the guard turns them red.');
console.log('  ALLOW assertions: the rest — each asserts the gate stays OUT of the way, so');
console.log('  widening the refusal turns them red. Both directions are load-bearing.');

// ══════════════════════════════════════════════════════════════════════════════════════════════
// THE MEASUREMENT BEHIND THE THRESHOLD: hooks/measure-wide-read.mjs
//
// The hook's threshold table is quoted from this script's output. If the script drifts, the table
// becomes a memory again, so the script is asserted here against a fixture transcript of known
// sizes: three Reads with results (2,000 bytes, 8,000 bytes, and 20,000 bytes with a range named),
// one Grep result it must ignore, one Read with no result, one Read outside the window, one whole
// transcript file older than the window, and a prompt line whose text must never be printed.
// ══════════════════════════════════════════════════════════════════════════════════════════════

const MEASURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'measure-wide-read.mjs');
if (!fs.existsSync(MEASURE)) {
  throw new Error('guard-wide-read-test.mjs: hooks/measure-wide-read.mjs is missing. The threshold table has no measurement behind it.');
}

let mpass = 0;
const mfail = [];
function mcheck(cond, name) { if (cond) mpass++; else mfail.push(name); }

const mroot = fs.mkdtempSync(path.join(os.tmpdir(), 'wideread-measure-'));
const project = path.join(mroot, 'project-folder-name-that-must-not-print');
fs.mkdirSync(project);
const SECRET_PATHS = ['/fixture/secret-alpha.md', '/fixture/secret-beta.md', '/fixture/secret-gamma.md'];
const PROMPT = 'FIXTURE PROMPT TEXT THAT MUST NEVER BE PRINTED';
const recent = new Date(Date.now() - 3600 * 1000).toISOString();
const ancient = '2001-01-01T00:00:00.000Z';

const use = (id, input, ts) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input }] } });
const result = (id, content, ts) => JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });

const sessionFile = path.join(project, 'session-file-name-that-must-not-print.jsonl');
fs.writeFileSync(sessionFile, [
  JSON.stringify({ type: 'user', timestamp: recent, message: { role: 'user', content: PROMPT } }),
  use('ru1', { file_path: SECRET_PATHS[0] }, recent),
  result('ru1', 'a'.repeat(2000), recent),
  'this line is not json and must be skipped',
  use('ru2', { file_path: SECRET_PATHS[1] }, recent),
  result('ru2', [{ type: 'text', text: 'b'.repeat(8000) }], recent),
  use('ru3', { file_path: SECRET_PATHS[2], offset: 1 }, recent),
  result('ru3', 'c'.repeat(20000), recent),
  JSON.stringify({ type: 'assistant', timestamp: recent, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'g1', name: 'Grep', input: { pattern: 'x' } }] } }),
  result('g1', 'g'.repeat(50000), recent),
  use('ru4-never-answered', { file_path: SECRET_PATHS[0] }, recent),
  use('ru5', { file_path: SECRET_PATHS[1] }, ancient),
  result('ru5', 'z'.repeat(999999), ancient),
  '',
].join('\n'));

const oldFile = path.join(project, 'older-than-the-window.jsonl');
fs.writeFileSync(oldFile, [use('old1', { file_path: SECRET_PATHS[0] }, ancient), result('old1', 'q', ancient), ''].join('\n'));
fs.utimesSync(oldFile, new Date(ancient), new Date(ancient));

function measure(args) {
  const r = spawnSync(process.execPath, [MEASURE, ...args], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

{
  const { code, out } = measure([mroot, '--days', '7']);
  mcheck(code === 0, '[measure --days 7] exits 0');
  mcheck(out.includes('transcript files: 1 scanned, 1 skipped as last written before the window'),
    '[measure --days 7] counts one file scanned and one skipped by mtime');
  mcheck(out.includes('reads with a result: 3 over 1 calendar day (UTC), 1 more found but outside the window'),
    '[measure --days 7] counts exactly three reads with results, and one outside the window');
  mcheck(out.includes('no range named: 2 of those reads (66.7%), carrying 33.3% of read bytes'),
    '[measure --days 7] the no-range share and its byte share');
  mcheck(out.includes('p50 8,000 bytes (about 2,000 tokens), p90 20,000 bytes (about 5,000 tokens)'),
    '[measure --days 7] p50 is the middle read and tokens are bytes/4');
  mcheck(/T=1,000 tok\s+33\.3% of reads\s+26\.7%\s+66\.7%/.test(out),
    '[measure --days 7] at T=1,000: one of three refused, 8,000 of 30,000 bytes covered, two of three over');
  mcheck(/T=3,000 tok\s+0\.0% of reads\s+0\.0%\s+33\.3%/.test(out),
    '[measure --days 7] RED-PROOF at T=3,000: the 20,000-byte read named a range, so nothing is refused');
  mcheck(out.includes('covered is not saved'), '[measure --days 7] prints the covered-is-not-saved disclaimer');
  const leaked = [...SECRET_PATHS, 'project-folder-name-that-must-not-print', 'session-file-name-that-must-not-print']
    .filter((s) => out.includes(s));
  mcheck(!leaked.length, `[measure --days 7] RED-PROOF prints no transcript path or project name (leaked: ${leaked.join(', ')})`);
  mcheck(!out.includes(PROMPT), '[measure --days 7] RED-PROOF prints no prompt text');
}
{
  const { code, out } = measure([mroot, '--since', '2000-01-01']);
  mcheck(code === 0 && out.includes('reads with a result: 5 over 2 calendar days (UTC)') && out.includes('transcript files: 2 scanned'),
    '[measure --since 2000-01-01] widens the window to the two 2001 reads, one in each file');
}
{
  const { code, out } = measure([mroot, '--since', '2000-01-01', '--until', '2020-01-01']);
  mcheck(code === 0 && out.includes('reads with a result: 2 over 1 calendar day (UTC), 3 more found but outside the window'),
    '[measure --since --until] a bounded window keeps only the two 2001 reads and reports the three recent ones as outside it');
}
{
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'wideread-empty-'));
  const { code, out } = measure([empty, '--days', '7']);
  mcheck(code === 0 && out.includes('reads with a result: 0') && out.includes('no Read results to measure'),
    '[measure on an empty directory] says so plainly and invents no numbers');
  fs.rmSync(empty, { recursive: true, force: true });
}
{
  const { code, out } = measure([path.join(mroot, 'does-not-exist'), '--days', '7']);
  mcheck(code === 2 && out.includes('missing or unreadable'),
    '[measure on a missing directory] exits 2 and says the directory is missing');
}

fs.rmSync(mroot, { recursive: true, force: true });

for (const f of mfail) console.log(`FAIL  ${f}`);
console.log(`WIDE-READ MEASUREMENT ASSERTIONS  ${mpass}/${mpass + mfail.length} pass, ${mfail.length} fail`);
console.log('  3 of them are RED-PROOF: a ranged read is never refused, and no path, project name or prompt text is printed.');

if (failures.length || mfail.length) {
  throw new Error(`guard-wide-read-test.mjs: ${failures.length + mfail.length} assertion(s) failed.`);
}
