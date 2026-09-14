#!/usr/bin/env node
// @ts-check
// measure-wide-read.mjs — the measurement behind guard-wide-read.mjs, as a script anyone can run.
//
//   node hooks/measure-wide-read.mjs [transcripts-dir] [--days <n>] [--since <YYYY-MM-DD>]
//
// WHAT IT DOES: walks Claude Code session transcripts (the JSON-lines files the harness writes under
// its projects directory, by default ~/.claude/projects) and, for every `Read` tool call that got a
// result, records how many bytes that result put into the conversation. From those sizes it prints
// the read count, p50 and p90, and for four candidate thresholds the share of reads the wide-read
// gate would have refused and the share of read bytes those refusals cover.
//
// WHY IT EXISTS: guard-wide-read.mjs chooses its 12,000 byte threshold from a table. A table in a
// comment that nothing can reproduce is a memory, not a measurement. This script IS the measurement;
// the comment quotes its output and says how to rerun it.
//
// WHAT IT PRINTS AND WHAT IT NEVER PRINTS: aggregates only. Never a transcript's path, a file path a
// Read named, prompt text, or a project name. The only path in the output is the directory it was
// told to look in, with the home directory shortened to `~`.
//
// WHAT "REFUSED" MEANS HERE: the gate's rule, simulated. A read is counted as refused at threshold T
// when it named no range (no offset, no limit, no pages) AND its result was larger than T. A read
// that named a range is never refused, however large. This is a simulation from transcript sizes,
// not a replay against files on disk, so two caveats: the result carries line-number prefixes the
// file does not, and Read caps a whole-file read at 2,000 lines, so a very large file's result
// under-reads the file. Both push the same way (the transcript cost is the honest cost) and neither
// moves a read across a threshold it was not already well past.
//
// COVERED IS NOT SAVED: the coverage column is the share of read bytes the gate gets a say over. A
// refusal does not delete those bytes; the caller re-issues with a range and pays for what it takes.
// The saving is the difference between the whole file and the part that was wanted, and it can only
// be measured after the fact from transcripts on either side of the day the gate was wired.
//
// Node builtins only. Reads nothing outside the directory it is given. No network.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const THRESHOLD_TOKENS = [1000, 3000, 5000, 8000];
const BYTES_PER_TOKEN = 4;   // an estimate; the real ratio varies with the text

// ── ARGUMENTS ─────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { dir: null, days: null, since: null, until: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--days') out.days = Number(argv[++i]);
    else if (a.startsWith('--days=')) out.days = Number(a.slice(7));
    else if (a === '--since') out.since = argv[++i];
    else if (a.startsWith('--since=')) out.since = a.slice(8);
    else if (a === '--until') out.until = argv[++i];
    else if (a.startsWith('--until=')) out.until = a.slice(8);
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (out.dir === null) out.dir = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  return out;
}

function usage() {
  return [
    'usage: node hooks/measure-wide-read.mjs [transcripts-dir] [--days <n>] [--since <YYYY-MM-DD>] [--until <YYYY-MM-DD>]',
    '',
    '  transcripts-dir   where Claude Code writes session transcripts (default: ~/.claude/projects)',
    '  --days <n>        only count reads from the last n days',
    '  --since <date>    only count reads on or after this date (ISO, e.g. 2026-09-07)',
    '  --until <date>    only count reads before this date; with --since it bounds a window on both',
    '                    sides, which is how to compare the days before the gate was wired with after',
    '',
    'Prints aggregates only: counts, percentiles and threshold shares. Never a path, prompt or project name.',
  ].join('\n');
}

function parseDate(flag, value) {
  const t = Date.parse(value);
  if (!Number.isFinite(t)) throw new Error(`${flag} needs an ISO date, got ${JSON.stringify(value)}`);
  return t;
}

// [start, end): start null means from the beginning, end null means up to now.
function window({ days, since, until }) {
  let start = null;
  if (since !== null) start = parseDate('--since', since);
  else if (days !== null) {
    if (!Number.isFinite(days) || days <= 0) throw new Error('--days needs a positive number');
    start = Date.now() - days * 86400000;
  }
  const end = until !== null ? parseDate('--until', until) : null;
  if (start !== null && end !== null && end <= start) throw new Error('--until must be later than the window start');
  return { start, end };
}

function tilde(p) {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}

// ── WALK ──────────────────────────────────────────────────────────────────────────────────────
// Every *.jsonl under the directory, recursively. A file whose mtime is older than the window cannot
// hold an entry inside it, so it is skipped unread and counted as skipped.
function listTranscripts(dir, start) {
  const files = [];
  let skippedOld = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      if (start !== null) {
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (st.mtimeMs < start) { skippedOld++; continue; }
      }
      files.push(p);
    }
  }
  files.sort();
  return { files, skippedOld };
}

// ── MEASURE ───────────────────────────────────────────────────────────────────────────────────
// Bytes a tool_result puts into the conversation: its text, whatever shape the harness wrapped it in.
function resultBytes(content) {
  if (typeof content === 'string') return Buffer.byteLength(content, 'utf8');
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const block of content) {
    if (block && typeof block.text === 'string') n += Buffer.byteLength(block.text, 'utf8');
  }
  return n;
}

function namedRange(input) {
  if (!input || typeof input !== 'object') return false;
  return input.offset !== undefined || input.limit !== undefined || input.pages !== undefined;
}

// One transcript file. Returns the reads found in it: { bytes, ranged, day }.
// A Read's tool_use always precedes its tool_result in the same file, so one pass with a map is enough.
async function measureFile(file, { start, end }) {
  const pending = new Map();   // tool_use id -> { ranged, ts }
  const reads = [];
  let outsideWindow = 0;
  const bounded = start !== null || end !== null;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const content = e?.message?.content;
    if (!Array.isArray(content)) continue;
    const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use' && block.name === 'Read' && typeof block.id === 'string') {
        pending.set(block.id, { ranged: namedRange(block.input), ts });
      } else if (block.type === 'tool_result' && pending.has(block.tool_use_id)) {
        const use = pending.get(block.tool_use_id);
        pending.delete(block.tool_use_id);
        const when = Number.isFinite(use.ts) ? use.ts : ts;
        const inside = Number.isFinite(when) && (start === null || when >= start) && (end === null || when < end);
        if (bounded && !inside) { outsideWindow++; continue; }
        const bytes = resultBytes(block.content);
        const day = Number.isFinite(when) ? new Date(when).toISOString().slice(0, 10) : null;
        reads.push({ bytes, ranged: use.ranged, day });
      }
    }
  }
  return { reads, outsideWindow };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);   // nearest-rank
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const pct = (num, den) => (den ? ((100 * num) / den).toFixed(1) : '0.0') + '%';
const tok = (bytes) => fmt(bytes / BYTES_PER_TOKEN);

// ── MAIN ──────────────────────────────────────────────────────────────────────────────────────
async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) {
    console.error(`measure-wide-read: ${e.message}\n\n${usage()}`);
    process.exit(2);
  }
  if (args.help) { console.log(usage()); return; }

  const dir = path.resolve(args.dir ?? path.join(os.homedir(), '.claude', 'projects'));
  let win;
  try { win = window(args); } catch (e) {
    console.error(`measure-wide-read: ${e.message}\n\n${usage()}`);
    process.exit(2);
  }
  const { start, end } = win;
  const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');

  const out = [];
  out.push(`measure-wide-read: looked in ${tilde(dir)}`);
  if (start === null && end === null) {
    out.push('window: every transcript in the directory (no --days, --since or --until given)');
  } else {
    const flags = [
      args.since !== null ? `--since ${args.since}` : args.days !== null ? `--days ${args.days}` : null,
      args.until !== null ? `--until ${args.until}` : null,
    ].filter(Boolean).join(' ');
    const span = start !== null && end !== null ? `from ${iso(start)} until ${iso(end)}`
      : start !== null ? `on or after ${iso(start)}` : `before ${iso(end)}`;
    out.push(`window: reads ${span} (${flags})`);
  }

  let stat;
  try { stat = fs.statSync(dir); } catch {
    out.push(`the directory is missing or unreadable, so there is nothing to count`);
    console.log(out.join('\n'));
    process.exit(2);
  }
  if (!stat.isDirectory()) {
    out.push(`that is a file, not a directory, so there is nothing to count`);
    console.log(out.join('\n'));
    process.exit(2);
  }

  const { files, skippedOld } = listTranscripts(dir, start);
  const reads = [];
  let outsideWindow = 0;
  for (const f of files) {
    try {
      const r = await measureFile(f, win);
      reads.push(...r.reads);
      outsideWindow += r.outsideWindow;
    } catch { /* an unreadable transcript is skipped, never fatal */ }
  }

  out.push(`transcript files: ${fmt(files.length)} scanned` +
    (start !== null ? `, ${fmt(skippedOld)} skipped as last written before the window` : ''));
  if (!reads.length) {
    out.push(`reads with a result: 0` + (outsideWindow ? ` (${fmt(outsideWindow)} found but outside the window)` : ''));
    out.push('no Read results to measure, so no percentiles and no threshold table');
    console.log(out.join('\n'));
    return;
  }

  const sizes = reads.map((r) => r.bytes).sort((a, b) => a - b);
  const total = sizes.reduce((a, b) => a + b, 0);
  const days = new Set(reads.map((r) => r.day).filter(Boolean)).size;
  const unranged = reads.filter((r) => !r.ranged);
  const unrangedBytes = unranged.reduce((a, r) => a + r.bytes, 0);
  const p50 = percentile(sizes, 50);
  const p90 = percentile(sizes, 90);

  out.push(`reads with a result: ${fmt(reads.length)} over ${days} calendar day${days === 1 ? '' : 's'} (UTC)` +
    (outsideWindow ? `, ${fmt(outsideWindow)} more found but outside the window` : ''));
  out.push(`no range named: ${fmt(unranged.length)} of those reads (${pct(unranged.length, reads.length)}), carrying ${pct(unrangedBytes, total)} of read bytes`);
  out.push(`p50 ${fmt(p50)} bytes (about ${tok(p50)} tokens), p90 ${fmt(p90)} bytes (about ${tok(p90)} tokens)`);
  out.push(`total ${fmt(total)} bytes (about ${tok(total)} tokens); tokens are bytes divided by ${BYTES_PER_TOKEN}, an estimate`);
  out.push('');
  // Third column: every read over T, range named or not. On a fleet where the gate is already wired,
  // the gap between it and "refused" is the big reads that already arrive with a range, which is the
  // gate doing its job and also the reason a post-gate window cannot reproduce a pre-gate table.
  out.push('threshold        refused (no range and over)   covered (share of read bytes)   all reads over T');
  for (const t of THRESHOLD_TOKENS) {
    const limit = t * BYTES_PER_TOKEN;
    const refused = unranged.filter((r) => r.bytes > limit);
    const covered = refused.reduce((a, r) => a + r.bytes, 0);
    const over = sizes.filter((b) => b > limit).length;
    const label = `T=${fmt(t)} tok`.padEnd(17);
    out.push(`${label}${pct(refused.length, reads.length).padStart(6)} of reads`.padEnd(46) +
      `${pct(covered, total).padStart(6)}`.padEnd(32) + `${pct(over, reads.length).padStart(6)}`);
  }
  out.push('');
  out.push('covered is not saved: a refusal does not delete those bytes. The caller re-issues with a range and');
  out.push('pays for what it takes. Covered is the share of read bytes the gate gets a say over, not the share');
  out.push('it removes; the saving can only be measured after the fact, from transcripts on either side of the');
  out.push('day the gate was wired.');
  out.push('');
  out.push('rerun: node hooks/measure-wide-read.mjs [transcripts-dir] --days 7');
  console.log(out.join('\n'));
}

await main();
