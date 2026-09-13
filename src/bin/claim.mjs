#!/usr/bin/env node
// claim.mjs — take and release a claim WITHOUT opening a lane.
//
// WHY THIS EXISTS. Every claim in CLAIMS.md was written by `lane-open`, which means a dispatch that
// finds unbriefed work and just does it never passes through the code that writes a claim. The claim
// is skipped by construction, not by forgetfulness, and no reminder in a governing file can fix a
// path that is never executed.
//
// The receipt: one dispatcher wrote to three repos in an 18-minute window while holding no line in
// the claims file. A sweep found the gap a minute before it closed and was right about it. Nothing
// collided, because the board's 60-minute fresh-commit heuristic happened to cover a window that
// took 18 — luck of timing, not a guard. The fix is a claim helper that does not require a lane,
// rather than another prose reminder nobody executes.
//
//   pandoras-router claim take <repo> --as "<session title>" --why "<one line>"
//   pandoras-router claim release --id <session id>
//   pandoras-router claim list
//
// `--why` is REQUIRED and it is not ceremony. A lane's claim is explained by its brief; a direct
// claim has no brief, so if the line does not carry its own reason then nobody arriving later can
// tell a live writer from a crashed one, and every hand-release becomes a guess.
//
// WHAT THIS DELIBERATELY DOES NOT DO: it never offers to delete somebody else's claim line. A
// refusal that hands you a removal remedy is the defect Ops-BETA2 exists to fix; building a second
// copy of it here would be building the bug on purpose.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicy, repoPolicy } from '../lib/policy.mjs';
import {
  readClaims,
  activeWriters,
  activeSweeps,
  appendClaim,
  releaseClaim,
  CLAIM_ACTIVE_HOURS,
} from '../lib/claims.mjs';
import { localDate } from '../lib/naming.mjs';

// THE WORKSPACE ROOT is the directory holding `_handoffs/` and your repos. It is NEVER the
// package's own install location, so it comes from $PANDORAS_ROOT or the current directory.
const ROOT = path.resolve(process.env.PANDORAS_ROOT || process.cwd());

function arg(args, name, dflt = null) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
}

function die(lines) {
  for (const l of lines) console.error(l);
  process.exit(2);
}

/**
 * A session-unique-ish id that is NOT derived from a lane. `dispatch-lane-<lane>` is lane-derived,
 * so two sessions of one lane produce byte-identical lines and no comparison can separate them —
 * measured, and it is the whole subject of Ops-BETA2. This one carries the wall clock, so two
 * direct claims a second apart are already distinguishable.
 */
function directId(chat, now) {
  const slug = String(chat)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32) || 'dispatch';
  const t = now.toISOString().slice(11, 19).replace(/:/g, '');
  return `direct-${slug}-${t}`;
}

// ------------------------------------------------------------------ take

function take(args) {
  const repo = args.find((a) => !a.startsWith('--'));
  const chat = arg(args, '--as');
  const why = arg(args, '--why');
  const idArg = arg(args, '--id');

  if (!repo) die(['claim take REFUSED', '  no repo named.', '  usage: claim take <repo> --as "<chat title>" --why "<one line>"']);
  if (!chat) die(['claim take REFUSED', '  --as is required: the board prints this so a human knows who to ask.']);
  if (!why) {
    die([
      'claim take REFUSED',
      '  --why is required, and it is not ceremony.',
      '  A lane claim is explained by its brief. A direct claim has no brief, so without a reason',
      '  on the line nobody arriving later can tell a live writer from a crashed one, and every',
      '  hand-release becomes a guess.',
      '  usage: claim take <repo> --as "<chat title>" --why "<one line>"',
    ]);
  }

  const policy = loadPolicy(ROOT);
  const rp = repoPolicy(policy, repo);
  if (!rp) {
    die([
      'claim take REFUSED — NO-POLICY',
      `  "${repo}" has no row in _handoffs/_lanes/POLICY.md.`,
      '  A repo that is not in the repos table routes nothing, and this refuses rather than guess',
      '  at its writer cap. Add the row first.',
      `  known: ${[...policy.repos.keys()].join(', ')}`,
    ]);
  }

  const now = new Date();
  const { rows } = readClaims(ROOT, now.getTime());
  const held = activeWriters(rows, repo);

  if (held.length >= rp.writers) {
    const lines = [
      'claim take REFUSED — the repo is at its writer cap',
      `  ${repo} allows ${rp.writers} writer(s) and ${held.length} active claim(s) hold it now:`,
    ];
    for (const h of held) {
      lines.push(`    "${h.chat}" [${h.session || 'no session field'}] opened ${h.ageH.toFixed(1)}h ago`);
    }
    lines.push('');
    lines.push('  SOMEBODY MAY BE WRITING RIGHT NOW. This tool does not tell you to delete their line,');
    lines.push('  and you should not: a claim is the only thing standing between two sessions and one');
    lines.push('  file. Work a different repo, or ask the holder in session.');
    lines.push(`  A claim older than ${CLAIM_ACTIVE_HOURS}h reads as STALE on the board and stops blocking on its own.`);
    die(lines);
  }

  const sweeps = activeSweeps(rows, repo);
  for (const s of sweeps) {
    console.log(`note: a declared sweep "${s.sweep}" is active on ${s.repo} — not a writer, not blocking.`);
  }

  const session = idArg ?? directId(chat, now);
  const stamp = now.toISOString().replace(/\.\d+Z$/, 'Z');

  // The comment block is the part that survives. A bare line with no reason is what produced the
  // dead claims this seat hand-releases every board read.
  const preamble = [
    `# HAND-TAKEN ${localDate(now)} by \`claim take\`, NOT a lane-open. There is no brief and no worktree.`,
    `# WHY: ${why}`,
    '# Release it with: pandoras-router claim release --id ' + session,
  ].join('\n');

  const file = path.join(ROOT, '_handoffs', '_lanes', 'CLAIMS.md');
  const before = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, before.endsWith('\n') ? `${before}${preamble}\n` : `${before}\n${preamble}\n`);
  const line = appendClaim(ROOT, { repo, chat, stamp, session });

  console.log('claim TAKEN');
  console.log(`  ${line}`);
  console.log(`  why: ${why}`);
  console.log('');
  console.log('  Release it on stop clean. A claim you forget is a repo nobody else can fire:');
  console.log(`    pandoras-router claim release --id ${session}`);
}

// ------------------------------------------------------------------ release

function release(args) {
  const id = arg(args, '--id');
  if (!id) die(['claim release REFUSED', '  --id is required.', '  usage: claim release --id <session id>']);

  const removed = releaseClaim(ROOT, id);

  // The claim's own preamble carries a "Release it with: ... --id <id>" line. Left standing after the
  // release it reads as a live instruction for a claim that no longer exists, which is exactly the
  // kind of stale advice this seat spends its board reads cleaning up. The house convention in this
  // file is that a released block STAYS as history and gains a RELEASED line, so do that: rewrite the
  // instruction in place rather than deleting the block.
  const file = path.join(ROOT, '_handoffs', '_lanes', 'CLAIMS.md');
  const text = fs.readFileSync(file, 'utf8');
  const marker = `# Release it with: pandoras-router claim release --id ${id}`;
  if (text.includes(marker)) {
    fs.writeFileSync(file, text.split(marker).join(`# RELEASED ${localDate(new Date())} by \`claim release --id ${id}\`. Not held any more.`));
  }

  if (!removed.length) {
    console.log(`no claim line carries the 4th field "${id}" — nothing removed.`);
    console.log('This is not an error. It is what you see when it was already released.');
    process.exit(0);
  }
  console.log('claim RELEASED');
  for (const r of removed) console.log(`  ${r}`);
  console.log('');
  console.log('  The bridge is not under version control, so the line above IS the undo.');
  console.log('  Paste it back into _handoffs/_lanes/CLAIMS.md if this was wrong.');
}

// ------------------------------------------------------------------ list

function list() {
  const now = Date.now();
  const { rows } = readClaims(ROOT, now);
  const live = rows.filter((r) => !r.malformed && !r.stale);
  if (!live.length) {
    console.log('no active claims.');
    return;
  }
  console.log(`ACTIVE CLAIMS  ${live.length}`);
  for (const c of live) {
    const kind = c.isSweep ? `sweep:${c.sweep}` : c.session || 'NO SESSION FIELD';
    console.log(`  ${c.repo.padEnd(26)} ${c.ageH.toFixed(1)}h  ${kind}`);
    console.log(`  ${''.padEnd(26)} "${c.chat}"`);
  }
  const stale = rows.filter((r) => !r.malformed && r.stale);
  if (stale.length) console.log(`\n${stale.length} stale claim(s) past ${CLAIM_ACTIVE_HOURS}h — flagged, never blocking.`);
}

// ------------------------------------------------------------------ front door

const [verb, ...rest] = process.argv.slice(2);
if (verb === 'take') take(rest);
else if (verb === 'release') release(rest);
else if (verb === 'list') list();
else {
  console.error('usage: pandoras-router claim <take|release|list> [args]');
  console.error('  take <repo> --as "<chat title>" --why "<one line>"');
  console.error('  release --id <session id>');
  console.error('  list');
  process.exit(verb ? 2 : 0);
}
