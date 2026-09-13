// findings.mjs — a lane's report block, turned into rows a query can answer.
//
// WHY THIS EXISTS, and it is the whole argument for the table.
//
// A lane's closing summary block is a CLAIM, not a receipt: it strips the command and its output
// and leaves a conclusion formatted to look like a measurement. The usual fix is a provenance word
// on every line — counted, derived or inherited. What that fix cannot do is make the lines
// FINDABLE. They sit in thousands of markdown files no session can hold in one context, so a
// question about a number gets answered out of whichever document a session happened to open,
// which is a reconstruction wearing a measurement's clothes.
//
// So at close, every receipt line becomes one ROW, and a question about a number becomes a query.
// `provenance` is not re-derived here: it is lifted from the line's OWN
// counted/derived/inherited word, because a provenance this module invented would be exactly the
// manufactured measurement the rule exists to prevent.
//
// MECHANICAL, NEVER SESSION DISCIPLINE. That condition is the only reason this is worth having: a
// step a session must remember is a step that is done on the days nothing went wrong and skipped
// on the days something did.
//
// NO CLIENT IN THIS MODULE. It parses and returns rows. Where the rows go is the caller's problem,
// and the caller injects whatever writer it has.
//
// THREE THINGS THIS DELIBERATELY REFUSES TO DO
//   1. It never guesses a provenance. A receipt with no word is REPORTED and not written; the
//      table's own CHECK constraint would reject it anyway, and writing it under a guessed word
//      would put a number in a queryable place with a confidence nobody claimed.
//   2. It never reads prose outside the fenced report block. The block is the claim; the essay
//      around it is context, and grading context is how report-check once counted 126 receipts on
//      a file with a dozen.
//   3. It never fails a close. The close wraps the whole write; a row that cannot be written is
//      printed by name and the ledger record — the thing that must survive — is already on disk.
//
// THE DESTINATION'S OWN CONSTRAINTS, restated here as arrays so a row that would be refused by
// the store is refused by this module first, with a readable reason instead of a 400:
//   finding_type  outcome | health | defect | fact
//   provenance    counted | derived | inherited
//   status        DONE | BLOCKED | PARTIAL

export const FINDING_TYPES = ['outcome', 'health', 'defect', 'fact'];
export const PROVENANCE_WORDS = ['counted', 'derived', 'inherited'];
export const STATUS_WORDS = ['DONE', 'BLOCKED', 'PARTIAL'];

const STATUS_RE = /\b(DONE|PARTIAL|BLOCKED)\b/;

// WHERE THE PROVENANCE WORD ACTUALLY SITS — corrected 2026-09-05.
//
// This used to be anchored at the END of the line, on the theory that `counted` mid-sentence is
// prose about counting rather than a claim about the line's own provenance. The theory is wrong
// about the rule it was enforcing. the project rules file says "Every receipt line names its provenance in one
// word: counted, derived, or inherited. Counted names the query or command" — the word introduces
// the method, so it is followed by the method, so it is in the MIDDLE. Its own worked example:
//   do-not-cite rows: 94 — counted, select count(*) ... where do_not_cite is true
// 17 receipt lines across two reports were refused on 2026-09-05 for obeying the rule they were
// written to, including
//   Skipped as dirty: 1 — counted, lane echo2, `git status --porcelain` shows 1 uncommitted change
//
// SO: the word is found anywhere in the line, as a whole word, PREFERRING the first occurrence
// after the value separator — an em dash, a spaced hyphen, or a colon — because that separator is
// where a receipt stops stating its value and starts stating where the value came from. Everything
// after the word is the METHOD, which is the query or command the rule says the word names; it is
// carried into the evidence string rather than thrown away.
//
// WHAT DID NOT CHANGE: a line with NO provenance word anywhere is still refused and still printed
// by name. Nothing here guesses a word, and the table's CHECK constraint would refuse a guess anyway.
const PROVENANCE_ANYWHERE = /\b(counted|derived|inherited)\b/gi;
const VALUE_SEPARATOR = /—|\s-\s|:/;
// Trailing punctuation left on the fact once the provenance word and its separator are cut away.
const FACT_TAIL = /[\s:,;—-]+$/;
// Leading punctuation between the provenance word and the method it introduces: `counted, <query>`.
const METHOD_HEAD = /^[\s,;:.—-]+/;

/**
 * Where the provenance word is in one receipt body, or null.
 *
 * Pure and exported so the choice of occurrence is testable on its own: the FIRST whole-word match
 * after the value separator wins, and when there is none after it (or no separator at all) the
 * first match anywhere does.
 *
 * @param {string} body
 * @returns {{word:string, index:number, length:number}|null}
 */
export function findProvenance(body) {
  const text = String(body ?? '');
  const sep = text.search(VALUE_SEPARATOR);
  const sepEnd = sep < 0 ? -1 : sep + (text.slice(sep).match(VALUE_SEPARATOR)?.[0].length ?? 1);
  const all = [...text.matchAll(new RegExp(PROVENANCE_ANYWHERE.source, 'gi'))];
  if (!all.length) return null;
  const hit = (sepEnd >= 0 ? all.find((m) => m.index >= sepEnd) : null) ?? all[0];
  return { word: hit[1].toLowerCase(), index: hit.index, length: hit[0].length };
}

// A section header inside the block — a line ending in a colon that is not itself a bullet. The
// report template's own headings are "Defects found and NOT fixed:", "What HQ must supply:",
// "Not touched:". Each says what KIND of claim the bullets under it are.
const SECTION_RE = /^\s*\*{0,2}([A-Za-z][^:]{0,80}):\s*\**\s*$/;

// A line the block carries that is not a claim about anything measured.
const NOT_A_FINDING = [
  /^\s*DESIGN-GATE\s*:/i,
  /^\s*[-=_*]{3,}\s*$/,
];

/**
 * Which of the table's four kinds is a bullet under this heading?
 *
 * Default `outcome`: the unheaded receipts at the top of every report block are what the lane did.
 * The other three are recognised from the headings the report template actually uses, and anything
 * unrecognised falls back to `outcome` rather than being dropped — a claim filed under a slightly
 * wrong kind is recoverable, a claim not filed at all is not.
 */
export function findingTypeFor(section) {
  const s = String(section ?? '').toLowerCase();
  if (!s) return 'outcome';
  if (/defect|bug|broken|not fixed/.test(s)) return 'defect';
  if (/health|reachab|latency|outage|uptime|live probe/.test(s)) return 'health';
  if (/fact|corrected|provenance|must supply|needs a decision|open question/.test(s)) return 'fact';
  return 'outcome';
}

/**
 * A short subject for the row, so a query can group without reading every fact.
 *
 * Prefer the head of an explicit `<subject>: <claim>` split, because that is how a receipt names
 * what it is about. Otherwise the first few words. Never longer than 80 characters — `subject` is
 * an index, and the whole claim already lives in `fact`.
 */
export function subjectFor(fact) {
  const text = String(fact ?? '').trim();
  const cut = text.indexOf(':');
  if (cut > 0 && cut <= 80) return text.slice(0, cut).trim();
  const words = text.split(/\s+/).slice(0, 8).join(' ');
  return words.length > 80 ? `${words.slice(0, 77)}...` : words;
}

function fencedBlocks(lines) {
  const blocks = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(```+|~~~+)/);
    if (!m) continue;
    if (open === null) open = { start: i, mark: m[1][0].repeat(3) };
    else if (lines[i].trim().startsWith(open.mark)) { blocks.push({ start: open.start + 1, end: i }); open = null; }
  }
  return blocks;
}

/**
 * Parse a lane report into rows the RPC can take.
 *
 * @param {string} text  the whole report file
 * @returns {{ok:boolean, why:string|null, rows:Array, unwritable:Array, block:object|null}}
 *   rows        {finding_type, subject, fact, provenance, lineNo}
 *   unwritable  {lineNo, text, why} — printed by the caller, never written, never guessed at
 */
/**
 * WHICH fenced block is the report block — and the first version of this got it wrong on the very
 * report it was written in.
 *
 * "The first block carrying a status word" is the obvious rule and it is wrong for any report that
 * QUOTES a close's own output, which every honest report about the close machinery does: that
 * quoted output contains the line `STATUS PARTIAL`, so the parser locked onto a transcript and
 * found nothing to write, while the real report block sat further down carrying twelve receipts.
 *
 * So: among the blocks carrying a status word, take the last one that also carries a bullet. The
 * report block is conventionally the final section of a report and it is the only one made of
 * receipts; a quoted transcript has the status word and no bullets. When no candidate has a bullet
 * there is nothing to write either way, and the last candidate is returned so the caller can say so
 * against a real block rather than against nothing.
 */
function reportBlock(lines) {
  const candidates = fencedBlocks(lines).filter((b) => STATUS_RE.test(lines.slice(b.start, b.end).join('\n')));
  if (!candidates.length) return null;
  const withBullets = candidates.filter((b) => lines.slice(b.start, b.end).some((l) => /^\s*[-*]\s+\S/.test(l)));
  const pick = withBullets.length ? withBullets : candidates;
  return pick[pick.length - 1];
}

export function parseReportFindings(text) {
  const lines = String(text ?? '').split('\n');
  const block = reportBlock(lines);
  if (!block) {
    return {
      ok: false,
      rows: [],
      unwritable: [],
      block: null,
      why: 'this report has no fenced report block carrying a status word, so there is no delimited claim to read. '
        + 'Nothing was written. A block is not guessed at from prose — that is how a report with a dozen receipts '
        + 'gets read as having a hundred.',
    };
  }

  const rows = [];
  const unwritable = [];
  let section = '';
  let sawStatus = false;

  for (let i = block.start; i < block.end; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    if (NOT_A_FINDING.some((re) => re.test(raw))) continue;

    // The header line declares the lane's status. It is the frame around the claims, not one of
    // them, and only the FIRST such line is the header — a receipt may legitimately mention a
    // status word in passing.
    if (!sawStatus && STATUS_RE.test(raw) && !/^\s*[-*]\s/.test(raw)) { sawStatus = true; continue; }

    const asSection = raw.match(SECTION_RE);
    if (asSection && !/^\s*[-*]\s/.test(raw)) { section = asSection[1]; continue; }

    // Bullets only. The report template writes every receipt as one, and a rule that swallowed
    // free-form lines too would file the wrapped tail of a sentence as its own finding.
    const bullet = raw.match(/^\s*[-*]\s+(.*)$/);
    if (!bullet) continue;
    const body = bullet[1].trim();
    if (!body) continue;

    const prov = findProvenance(body);
    if (!prov) {
      unwritable.push({
        lineNo: i + 1,
        text: body,
        why: 'no provenance word (counted / derived / inherited) anywhere in the line. The table refuses it and '
          + 'this module will not guess one — a claim filed under an invented provenance is worse than one not filed.',
      });
      continue;
    }
    const fact = body.slice(0, prov.index).replace(FACT_TAIL, '').trim();
    if (!fact) {
      unwritable.push({ lineNo: i + 1, text: body, why: 'the line is a bare provenance word with no claim in front of it' });
      continue;
    }
    rows.push({
      finding_type: findingTypeFor(section),
      subject: subjectFor(fact),
      fact,
      provenance: prov.word,
      // The query or command the provenance word names. Empty when the word ends the line — that is
      // a receipt that named its provenance and not its method, and inventing one would be a lie.
      method: body.slice(prov.index + prov.length).replace(METHOD_HEAD, '').trim(),
      lineNo: i + 1,
    });
  }

  return { ok: true, why: null, rows, unwritable, block };
}

/**
 * One row, as the RPC's own parameter names.
 *
 * `p_evidence` points at the report and the line the claim came from. That is deliberately not a
 * restatement of the claim: the point of an evidence field is to say where to go and read it, and
 * a line number in a named file is the shortest true answer.
 *
 * THE METHOD RIDES IN THE SAME FIELD. The rule is that the provenance word NAMES the query or
 * command, so a row carrying `counted` and not the command has kept the weaker half of the
 * receipt. It goes into `p_evidence` rather than into a new argument on purpose: a store that
 * resolves a procedure by its argument NAMES turns an added argument into a 404 rather than a
 * silent wrong write. Capped so a long shell line cannot dominate the field.
 *
 * The shape is a plain object. This module never sends it anywhere; the caller owns the transport.
 */
export function findingArgs(row, ctx) {
  return {
    p_lane: String(ctx.lane ?? ''),
    p_repo: String(ctx.repo ?? ''),
    p_dispatch: String(ctx.dispatch ?? ''),
    p_status: String(ctx.status ?? ''),
    p_finding_type: row.finding_type,
    p_subject: row.subject,
    p_fact: row.fact,
    p_provenance: row.provenance,
    p_evidence: `_handoffs/${ctx.report} line ${row.lineNo}${row.method ? ` — ${row.provenance}, ${String(row.method).slice(0, 200)}` : ''}`,
    p_session: String(ctx.session ?? ''),
  };
}
