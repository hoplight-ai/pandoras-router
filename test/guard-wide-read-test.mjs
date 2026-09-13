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
if (failures.length) throw new Error(`guard-wide-read-test.mjs: ${failures.length} assertion(s) failed.`);
