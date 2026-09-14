#!/usr/bin/env node
// report-check.mjs — mechanize the report rules in the project rules file §"your closing summary
// block is a claim, not a receipt" and the standing orders.
//
// USAGE
//   node src/lib/report-check.mjs _handoffs/done-2026-08-09-something.md
//   node src/lib/report-check.mjs _handoffs            # sweeps done-/partial-/blocked-/parked-
//
// WHAT IT CHECKS
//   1. status      DONE, BLOCKED or PARTIAL appears in the report block.
//                  Missing → "no status word → treat as PARTIAL". That is the
//                  standing rule (the project rules file), not an invention here. FAIL.
//   2. done-honest HEURISTIC, WARN ONLY, NEVER FAILS. If the status is DONE and the
//                  file also admits a skipped / barred / deferred / could-not step
//                  next to a scope item, a human should read it. "deliberately not
//                  touched" sections are excluded — declaring scope you left is
//                  correct behaviour, not a contradiction.
//   3. provenance  Every logical receipt line carries `counted`, `derived` or
//                  `inherited` as a whole word, anywhere on the line (at the end, or
//                  mid-line with the method after it, which is how root the project rules file
//                  writes the rule; widened 2026-09-05, it used to want the end only).
//                  The rule was ratified 2026-08-07, so this FAILS only for files
//                  dated 2026-08-08 or later; earlier files are reported and never
//                  failed. An `Evidence:` line inside the block is check 4's, not a
//                  receipt here.
//   4. evidence    An `Evidence:` line (or `## Evidence` heading) exists.
//   5. name-status WARN ONLY, and one check beyond the four the brief asked for:
//                  the filename's lifecycle prefix disagrees with the body's status
//                  word. It never fails — the project rules file is explicit that the STATUS word
//                  is the only scope claim and the filename is not one — but it is
//                  the exact defect the headline measurement counted, so it is worth
//                  a number.
//
// WHAT COUNTS AS A RECEIPT LINE — the one judgment call in this script
//   There is no universal "receipts section" in the corpus, so this locates one:
//     a. a fenced code block containing a status word, else
//     b. the run of lines beginning at a `LANE: … STATUS: …` or `STATUS:` line
//        (several real reports carry the block unfenced),
//   plus every `Evidence:` line anywhere in the file.
//   Within that region the header line (the one carrying the status word) is not a
//   receipt, and the region ENDS at the first free-form tail heading — "defects
//   found", "needs a ruling", "deliberately not touched", "not touched",
//   "semantics", "notes". Those are prose by design and the report
//   template itself leaves them untagged.
//   Physical lines are grouped into LOGICAL receipts: a line starting at column 0
//   opens one, indented lines continue it, and the provenance word is looked for on
//   the whole logical receipt (end of the last physical line first, then anywhere).
//   That is how the report template wraps a long receipt onto two lines with the tag
//   on the second, and how the project rules file writes it with the method after the word.
//
// EXIT CODES
//   0  every check passed (WARNs do not fail)
//   1  at least one FAIL
//   2  usage error

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localDate } from './naming.mjs';
import { findProvenance } from './findings.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROVENANCE_CUTOFF = '2026-08-08'; // rule ratified 2026-08-07; binding from the next day
// Trailing `|` is allowed because a markdown table row is the corpus's most common
// receipt shape: `| npm run build | green | counted |`.
const PROVENANCE = /(^|[\s`*_(\[|])(counted|derived|inherited)([\s`*_.)\]|]*)$/i;
const PROVENANCE_ANYWHERE = /\b(counted|derived|inherited)\b/i;
const STATUS_WORDS = /\b(DONE|PARTIAL|BLOCKED)\b/;
const TAIL_HEADING =
  /^\s*[*_#\-\s]*((defects?\b[^:]*)|(needs a ruling[^:]*)|(deliberately not touched)|(not touched)|(semantics[^:]*)|(notes?)|(open questions?)|(re-route)|(reason))\s*:?\s*$/i;

function fencedBlocks(lines) {
  const blocks = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(```+|~~~+)/);
    if (!m) continue;
    if (open === null) open = { start: i, mark: m[1][0].repeat(3) };
    else if (lines[i].trim().startsWith(open.mark)) {
      blocks.push({ start: open.start + 1, end: i });
      open = null;
    }
  }
  return blocks;
}

// A status word is only a LANE status when it is declared as one. A per-item
// "JOB 1 ......... DONE" checklist is not a lane status, and reading it as one is
// exactly the misfiling this script exists to catch — so the loose fallback is
// deliberately narrow rather than "the word appears somewhere".
// WHICH fenced block, when a report carries several. Corrected 2026-08-30, and the correction was
// found by a report this script FAILED for getting its own name right.
//
// "The first block carrying a status word" is wrong for any report that QUOTES a close's own
// output — and an honest report about the close machinery always does, because that transcript is
// the evidence. The quoted output carries the line `STATUS PARTIAL`, so this locked onto a
// transcript, graded its two lines as untagged receipts, and reported a provenance FAIL against a
// file whose real report block seventeen lines further down was fully tagged.
//
// So: among the blocks carrying a status word, take the last one that also carries a bullet. The
// report block is conventionally the final section of a report and it is the only one made of
// receipts; a quoted transcript has the status word and no bullets. Measured across the whole
// bridge before it shipped — 325 files, verdicts compared file by file, no file moved except the
// one this repaired. lib/findings.mjs carries the same rule for the same reason.
function reportFence(lines) {
  const candidates = fencedBlocks(lines).filter((b) => STATUS_WORDS.test(lines.slice(b.start, b.end).join('\n')));
  if (!candidates.length) return null;
  const withBullets = candidates.filter((b) => lines.slice(b.start, b.end).some((l) => /^\s*[-*]\s+\S/.test(l)));
  const pick = withBullets.length ? withBullets : candidates;
  return pick[pick.length - 1];
}

function findStatus(lines) {
  const fenced = reportFence(lines);
  if (fenced) {
    for (let i = fenced.start; i < fenced.end; i++) {
      const m = lines[i].match(STATUS_WORDS);
      if (m) return { word: m[1], line: i, source: 'fenced report block', region: fenced };
    }
  }
  /** @type {Array<[RegExp, string]>} pattern that declares a status, and the name of that form */
  const declarers = [
    [/STATUS\s*(\*\*)?\s*[:=]/i, 'STATUS: line'],
    [/\bREPORT\b/, 'REPORT header line'],
    // `ZULU1 · 2026-08-08 · **PARTIAL** — …` is a real and common declaration form
    // in this corpus. Bolding the word is the declaring act.
    [/(\*\*|__)\s*(DONE|PARTIAL|BLOCKED)\s*(\*\*|__)/, 'bolded status word'],
    [/^\s*#{1,6}\s/, 'heading'],
    [/^\s*[*_>\s-]*(DONE|PARTIAL|BLOCKED)[*_.\s]*$/, 'status word alone on its line'],
  ];
  for (const [pattern, source] of declarers) {
    for (let i = 0; i < lines.length; i++) {
      if (!pattern.test(lines[i])) continue;
      const m = lines[i].match(STATUS_WORDS);
      if (!m) continue;
      // An unfenced report block is the contiguous run of lines from the status
      // declaration. Running "until the next tail heading" swallowed whole documents
      // and reported 133 receipt lines on a file that has about a dozen.
      let end = i + 1;
      while (end < lines.length && lines[end].trim() !== '' && !TAIL_HEADING.test(lines[end])) end++;
      return { word: m[1], line: i, source, region: { start: i, end } };
    }
  }
  return null;
}

// Group a slice of physical lines into logical receipts.
function logicalReceipts(lines, start, end) {
  const out = [];
  for (let i = start; i < end; i++) {
    const raw = lines[i];
    if (raw.trim() === '') continue;
    if (TAIL_HEADING.test(raw)) break;
    if (/^\s*[-=_|]{3,}\s*$/.test(raw)) continue; // rules / table separators
    // An indented BULLET is a new receipt, not a continuation: the report template indents its
    // bullets two spaces under the LANE: line, and reading the whole block as one receipt let a
    // single tagged line vouch for twenty (measured on one report: 1 receipt counted where 8 lines
    // were written). Only an indented non-bullet line continues a receipt.
    if (/^\s/.test(raw) && out.length && !/^\s+([-*+]|\d+[.)])\s/.test(raw)) {
      out[out.length - 1].lastLine = raw;
      out[out.length - 1].endNo = i + 1;
      continue;
    }
    out.push({ firstNo: i + 1, endNo: i + 1, first: raw, lastLine: raw });
  }
  return out;
}

function evidenceLines(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*[*_#\->\s]*Evidence\b\s*:/i.test(lines[i])) continue;
    let end = i;
    while (end + 1 < lines.length && lines[end + 1].trim() !== '' && !/^\s*[#|]/.test(lines[end + 1])) end++;
    out.push({ firstNo: i + 1, endNo: end + 1, first: lines[i], lastLine: lines[end] });
    i = end;
  }
  return out;
}

function hasEvidence(lines) {
  return lines.some((l) => /^\s*[*_#\->\s]*Evidence\b\s*[:\n]/i.test(l) || /^#{1,6}\s*\**Evidence\b/i.test(l));
}

// The filename date is authoritative. Falling back to "the first date in the body"
// picks up the demo date, a trip date, a migration stamp — measured wrong on several
// real files — so the fallback is an explicit DATE: field, then the file's mtime.
function fileDate(file, lines) {
  const fromName = path.basename(file).match(/(20\d\d-\d\d-\d\d)/);
  if (fromName) return { date: fromName[1], via: 'filename' };
  const fromField = lines.join('\n').match(/\bDATE\s*[:=]\s*(20\d\d-\d\d-\d\d)/i);
  if (fromField) return { date: fromField[1], via: 'DATE: field' };
  try {
    // localDate, not toISOString: an mtime of 23:19 ET renders as the NEXT day in UTC, so an
    // evening report would be dated tomorrow. Same defect as the Not-Before gate, see naming.mjs.
    return { date: localDate(fs.statSync(file).mtime), via: 'mtime' };
  } catch {
    return { date: null, via: 'none' };
  }
}

const SKIP_WORDS =
  /\b(skipped|skipping|could not|couldn't|cannot|barred|deferred|not run|unable to|did not run|stalled|blocked on)\b/i;

function doneHonesty(lines, status) {
  if (!status || status.word !== 'DONE') return { status: 'PASS', summary: 'not a DONE file, check does not apply', detail: [] };
  const hits = [];
  let inTail = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^#{1,6}\s/.test(l) || TAIL_HEADING.test(l)) inTail = TAIL_HEADING.test(l);
    if (inTail) continue;
    if (/deliberately not/i.test(l)) continue;
    if (SKIP_WORDS.test(l)) hits.push(`line ${i + 1}: ${l.trim().slice(0, 110)}`);
  }
  return {
    status: hits.length ? 'WARN' : 'PASS',
    summary: hits.length
      ? `${hits.length} skipped/barred/deferred phrase(s) in a DONE file — heuristic, needs a human read`
      : 'no skipped/barred/deferred phrase outside the declared-not-touched sections',
    detail: hits.slice(0, 6),
  };
}

// The `done-` prefix is overloaded on this bridge: it marks BOTH a consumed brief
// (the kickoff, renamed once fired) and a lane report (the close). Report rules
// apply to the second and are a category error against the first, so classify
// before checking. A brief is the file that tells a session where to run.
const BRIEF_MARKERS = [/^#{1,6}.*RUN THIS IN/im, /\*\*RUN THIS IN/i, /this chat is named/i, /name this chat/i];
function isBrief(lines) {
  const text = lines.join('\n');
  return BRIEF_MARKERS.some((r) => r.test(text));
}

function checkFile(file) {
  return checkText(fs.readFileSync(path.resolve(file), 'utf8'), file);
}

// The same checks over text the caller already holds. The close driver reads the report once for
// its findings and side-file gates, and hands that same text here, so the refusal and the gates can
// never judge two different reads of one file. `file` still names the report: its date comes from
// the filename first, and only a name with no date falls back to a stat.
function checkText(text, file) {
  const abs = path.resolve(file);
  const lines = String(text ?? '').split('\n');
  const { date, via } = fileDate(abs, lines);

  if (isBrief(lines)) {
    return {
      file: path.relative(ROOT, abs),
      date,
      kind: 'consumed-brief',
      statusWord: null,
      enforced: false,
      checks: [
        {
          name: 'kind',
          status: 'SKIP',
          summary: 'consumed brief, not a lane report — report rules do not apply. Its report is a separate file.',
          detail: [],
        },
      ],
      failed: false,
      warned: false,
      provenanceClean: false,
    };
  }

  const status = findStatus(lines);

  const checks = [];

  checks.push({
    name: 'status',
    status: status ? 'PASS' : 'FAIL',
    summary: status
      ? `${status.word} (${status.source}, line ${status.line + 1})`
      : 'no status word → treat as PARTIAL (standing rule, the project rules file)',
    detail: [],
  });

  checks.push({ name: 'done-honest', ...doneHonesty(lines, status) });

  // provenance — graded ONLY inside a fenced report block.
  //
  // Measured against the corpus: an unfenced block is hard-wrapped prose, and a
  // wrapped continuation starting at column 0 is indistinguishable from a new
  // receipt. Grading those produced 126 "untagged receipts" on a file with about a
  // dozen, which is a gate lying in the loud direction. A gate that cannot see must
  // say so and must not pass — so an unfenced report is reported UNSCOPED, counted
  // as such in the sweep, and never silently marked clean.
  const fencedRegion = status && status.source === 'fenced report block' ? status.region : null;
  const receipts = fencedRegion
    ? logicalReceipts(lines, Math.max(fencedRegion.start, status.line + 1), fencedRegion.end)
    : [];
  const fileWideTagged = lines.filter((l) => l.trim() && PROVENANCE_ANYWHERE.test(l)).length;
  // 2026-09-05: the word counts WHEREVER it sits on the receipt. The project rules file writes the rule as
  // "94 — counted, select count(*) ...", word first and method after, and this check used to grade
  // exactly that shape as untagged. Same reader as the findings writer (lib/findings.mjs), so the two
  // cannot disagree again. An `Evidence:` line inside the block is graded by its own check below and
  // is not a receipt here.
  // `DESIGN-GATE: n/a, ...` is a declaration the template requires, not a measurement; lib/findings.mjs
  // already leaves it out of the writable rows, so this reader leaves it out of the graded ones.
  const graded = receipts.filter((r) => !/^\s*[*_#\->\s]*Evidence\b\s*:/i.test(r.first) && !/^\s*[-*]?\s*DESIGN-GATE\s*:/i.test(r.first));
  const trailing = graded.filter((r) => PROVENANCE.test(r.lastLine.trimEnd()));
  const midLine = graded.filter((r) => !PROVENANCE.test(r.lastLine.trimEnd()) && findProvenance(r.first + ' ' + r.lastLine));
  const untagged = graded.filter((r) => !PROVENANCE.test(r.lastLine.trimEnd()) && !findProvenance(r.first + ' ' + r.lastLine));
  const silent = untagged.length;
  const enforced = date !== null && date >= PROVENANCE_CUTOFF;
  let provStatus, provSummary;
  if (!fencedRegion) {
    provStatus = 'UNSCOPED';
    provSummary =
      `no fenced report block, so the receipts section cannot be delimited mechanically — ` +
      `not graded, not passed. file-wide ${fileWideTagged} line(s) end in counted/derived/inherited ` +
      `(date ${date ?? 'unknown'} via ${via})`;
  } else if (!graded.length) {
    provStatus = enforced ? 'FAIL' : 'INFO';
    provSummary = `fenced report block is empty (date ${date ?? 'unknown'} via ${via})`;
  } else {
    provStatus = !untagged.length ? 'PASS' : enforced ? 'FAIL' : 'INFO';
    provSummary =
      `${graded.length} receipt line(s), ${untagged.length} with no provenance word ` +
      `(${trailing.length} end in counted/derived/inherited, ${midLine.length} carry it mid-line, ${silent} name it nowhere); ` +
      `file-wide ${fileWideTagged} tagged` +
      `${enforced ? '' : ' — report-only, dated before ' + PROVENANCE_CUTOFF}`;
  }
  checks.push({
    name: 'provenance',
    status: provStatus,
    summary: provSummary,
    detail: untagged.slice(0, 6).map((r) => `line ${r.endNo}: ${r.lastLine.trim().slice(0, 110)}`),
  });

  checks.push({
    name: 'evidence',
    status: hasEvidence(lines) ? 'PASS' : 'FAIL',
    summary: hasEvidence(lines) ? 'Evidence line present' : 'no Evidence: line and no Evidence heading',
    detail: [],
  });

  // Fifth check, WARN-only, beyond the four the brief named. It measures the exact
  // headline defect ("9 of 18 done- files carried PARTIAL bodies"). It never fails,
  // because the project rules file is explicit that the STATUS word governs and the filename does not.
  // `partial-` added 2026-08-30. PREFIXES.md has defined it since the vocabulary was written, and
  // this pattern did not know it — so a correctly-named PARTIAL report was told it carried "no
  // lifecycle prefix on the filename", which is the check accusing the one report that got its own
  // name right. Same blind spot lane-close had at the other end of the pipeline.
  const prefix = (path.basename(abs).match(/^(done|partial|blocked|parked)-/i) ?? [, null])[1];
  const expected = { done: 'DONE', partial: 'PARTIAL', blocked: 'BLOCKED', parked: null };
  const want = prefix ? expected[prefix.toLowerCase()] : null;
  const mismatch = want && status && status.word !== want;
  checks.push({
    name: 'name-status',
    status: mismatch ? 'WARN' : 'PASS',
    summary: !prefix
      ? 'no lifecycle prefix on the filename'
      : mismatch
        ? `filename says ${prefix} but the body says ${status.word} — the body governs, the name misleads`
        : `filename prefix ${prefix} agrees with the body`,
    detail: [],
  });

  return {
    file: path.relative(ROOT, abs),
    date,
    kind: 'report',
    statusWord: status ? status.word : null,
    enforced,
    checks,
    failed: checks.some((c) => c.status === 'FAIL'),
    warned: checks.some((c) => c.status === 'WARN'),
    provenanceClean: provStatus === 'PASS',
  };
}

function isBridgeReport(name) {
  return /^(done|partial|blocked|parked)-.*\.md$/i.test(name);
}

export function collect(target) {
  const abs = path.resolve(target);
  const st = fs.statSync(abs);
  if (st.isFile()) return [abs];
  return fs
    .readdirSync(abs)
    .filter((n) => isBridgeReport(n))
    .filter((n) => fs.statSync(path.join(abs, n)).isFile())
    .sort()
    .map((n) => path.join(abs, n));
}

// findStatus and STATUS_WORDS are exported so lib/close.mjs's status-override (Gov PHI1,
// 2026-09-09) can locate and rewrite the exact line this file itself would read — never a second,
// hand-rolled parser that could drift from the one the verdict sweep actually runs.
export { checkFile, checkText, findStatus, STATUS_WORDS };

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('usage: node src/lib/report-check.mjs <done-file.md | _handoffs>');
    process.exit(2);
  }
  const files = args.flatMap(collect);
  let anyFail = false;
  for (const f of files) {
    const r = checkFile(f);
    if (r.failed) anyFail = true;
    console.log(`${r.failed ? 'FAIL' : r.warned ? 'WARN' : 'PASS'}  ${r.file}`);
    for (const c of r.checks) {
      console.log(`  ${c.name.padEnd(12)} ${c.status.padEnd(5)} ${c.summary}`);
      for (const d of c.detail) console.log(`      ${d}`);
    }
    if (files.length > 1) console.log('');
  }
  if (files.length > 1) console.log(`SUMMARY  ${files.length} file(s)  ${anyFail ? 'at least one FAIL' : 'no FAIL'}`);
  process.exit(anyFail ? 1 : 0);
}
