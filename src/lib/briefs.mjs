// briefs.mjs — read a brief's routing facts out of its own text.
//
// One parser, so the board and the allocator cannot disagree about what a brief targets. Two
// parsers for one file format is two answers to one question.
//
// WHAT A BRIEF MUST DECLARE
//   1. Its target folder — a `Folder:` line inside the RUN THIS IN block, or a repo named in that
//      block. Missing: PARSE-FAIL, and the allocator names the missing line.
//   2. Its touched-file scope — a `Touches:` line. REQUIRED ONLY where the policy allows more than
//      one writer in the repo, because that is the only place the scope decides anything.
//      Everywhere else the whole repo is the scope and there is nothing to intersect. A brief with
//      no `Touches:` line still fires; it is carded as a whole-repo writer, so it serializes
//      against every other lane in that repo instead of running beside one.
//
// The negation guard, the label filter and the block finder below all exist because of measured
// misreads: a brief saying "Never `<root>`" was landing in the root row on the strength of its own
// prohibition, and `Runs beside:` names OTHER repos, so reading it as a target points the board at
// a repo the brief never opens.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT_KEY, ROOT_LABEL } from './root.mjs';

export { ROOT_LABEL };
export const BRIEF_MARKER = /(^#{1,6}\s.*RUN THIS IN)|(\*\*RUN THIS IN)/im;

// ── HOW A BRIEF MAY SPELL THE WORKSPACE ROOT ──────────────────────────────────────────────────
//
// Briefs written by people name the root folder the way people say it: a shell alias, the folder's
// display name, a path from the home directory. Every spelling that means "the root" is an ALIAS,
// and `<alias>/<repo>` means that repo. The list ships EMPTY, so no particular machine's folder
// names are compiled in; a workspace declares its own with `setRootAliases`. The bare word
// `ROOT_KEY` always means the root, because that is the key the policy table uses.
export let ROOT_ALIASES = [];

/** @param {string[]} list  spellings of the root, with or without a trailing slash */
export function setRootAliases(list) {
  ROOT_ALIASES = (list ?? []).map((a) => String(a).trim().replace(/\/+$/, '')).filter(Boolean);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

function isRootSpelling(t) {
  const low = t.toLowerCase();
  if (low === ROOT_KEY) return true;
  return ROOT_ALIASES.some((a) => low === a.toLowerCase() || low === `${a.toLowerCase()}/`);
}

function stripRootAlias(t) {
  for (const a of ROOT_ALIASES) {
    if (t.toLowerCase().startsWith(`${a.toLowerCase()}/`)) return t.slice(a.length + 1);
  }
  return t;
}

// ── THE EXTERNAL LANE LABEL ───────────────────────────────────────────────────────────────────
//
// Some briefs are written for a worker that is not a code session at all — a research assistant, a
// human, another tool. Those briefs name no repo, and a router that reports them as PARSE-FAIL
// sends somebody hunting for a missing `Folder:` line that was never supposed to be there.
//
// So the parser recognizes one configurable label. `EXTERNAL_LABEL` is the word printed back;
// `EXTERNAL_MATCH` decides whether a block is one; `EXTERNAL_EXCLUDE` is the counter-pattern that
// rescues a brief which merely MENTIONS the external side while still naming a repo here.
//
// Defaults are inert: `EXTERNAL_MATCH` is null, so nothing is ever classified external until a
// caller configures it, and every unrouted brief reads as PARSE-FAIL. That is the honest default.
export let EXTERNAL_LABEL = 'EXTERNAL';
export let EXTERNAL_MATCH = null;
export let EXTERNAL_EXCLUDE = null;

/**
 * @param {{label?:string, match?:RegExp|null, exclude?:RegExp|null}} cfg
 */
export function setExternalLane({ label, match, exclude } = {}) {
  if (label !== undefined) EXTERNAL_LABEL = label;
  if (match !== undefined) EXTERNAL_MATCH = match;
  if (exclude !== undefined) EXTERNAL_EXCLUDE = exclude;
}

export function matchesExternalLabel(text) {
  if (!EXTERNAL_MATCH) return false;
  if (!EXTERNAL_MATCH.test(text)) return false;
  if (EXTERNAL_EXCLUDE && EXTERNAL_EXCLUDE.test(text)) return false;
  return true;
}

/** True when a parsed brief was classified as belonging to the external worker. */
export function isExternalLane(how) {
  return typeof how === 'string' && how.startsWith(`${EXTERNAL_LABEL} (`);
}

const NON_FOLDER_LABEL = /^(model|why|why this model|runs beside|rules stamp|interface)\b/i;
const FOLDER_IN_LINE = /\*\*\s*(folder\b[^*]*|session folder|open the session at\b[^*]*)\s*\*\*/i;
const FOLDER_CELL = /^\|\s*(?:\*\*)?\s*(folder|session folder|open the session at)\b[^|]*\|/i;
const FOLDER_PLAIN = /^\s*[-*]?\s*(folder|session folder|open the session at)\b[^:]*:/i;
const NEGATED = /\b(never|not|avoid|no|don'?t|nor)\s*$/i;

// `Touches:` may sit anywhere in the brief, not only in the RUN THIS IN block, because it is often
// long enough to want its own section. All spellings that have shown up in briefs authored here.
//
// THE SEPARATOR IS REQUIRED — a colon, or the pipe of a table cell — and it used to be optional.
// Optional meant any English sentence starting with the word "touches" was read as a declaration.
// Measured: a brief saying *"Touches nothing in `web`, `api`, or any other repo"* was carded with
// scope `web, api` — the two repos the sentence exists to rule OUT, and neither of them a path
// inside the repo the lane actually writes. That is the worse of the two possible errors: the
// in-scope gate would fail the lane on every file it touched, and the allocator would call it
// disjoint from a neighbour it genuinely overlaps.
//
// The negation guard in `tokensIn` did not catch it because the negating word was "nothing", which
// was not in `NEGATED`. Widening that list fixes this sentence and not the next one. Requiring the
// separator fixes the class: a declaration is a labelled field, never prose. A brief that loses its
// declaration this way reads as UNDECLARED, which widens to the whole repo — the safe direction.
const SCOPE_LINE = /^[-*| \t]*(touches|touched files|file scope|files touched|scope \(files\))[ *]*(?::|\|)[ \t]*(.*)$/im;

export function briefBlock(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s.*RUN THIS IN/i.test(lines[i])) {
      let end = i + 1;
      while (end < lines.length && !/^#{1,6}\s/.test(lines[end]) && !/^\s*---\s*$/.test(lines[end])) end++;
      return lines.slice(i + 1, end);
    }
    if (/\*\*RUN THIS IN/i.test(lines[i])) {
      // `**RUN THIS IN**` alone on its line is a heading in bold clothing: the fields are in the
      // table or list that follows, after a blank line. Reading only the marker line is what makes
      // such a brief PARSE-FAIL.
      const bare = lines[i].replace(/[*:\s]/g, '').toUpperCase() === 'RUNTHISIN';
      let start = i;
      if (bare) {
        start = i + 1;
        while (start < lines.length && lines[start].trim() === '') start++;
      }
      let end = start;
      while (end < lines.length && lines[end].trim() !== '') end++;
      return lines.slice(start, end);
    }
  }
  return null;
}

// ── ONE HOSTILE LINE MUST NOT STALL EVERY DISPATCHER ─────────────────────────────────────────
//
// Measured: a `Touches:` block followed by the word `Model` and 60,000 spaces did not return within
// two minutes. Two quantifiers that both eat spaces (`[A-Za-z ()/-]*` then `\s*`) backtrack
// quadratically on a failing match. One such brief dropped on a bridge stalls every dispatcher's
// `alloc`. Two defences, both cheap: every regex below is written so no two adjacent quantifiers
// can consume the same character, and every line the parser regex-tests is capped at MAX_LINE
// characters first. No legitimate field is anywhere near that long.
export const MAX_LINE = 4000;

/** Cap every line of `text` at MAX_LINE characters. Pure. */
export function capLines(text) {
  return String(text ?? '')
    .split('\n')
    .map((l) => (l.length > MAX_LINE ? l.slice(0, MAX_LINE) : l))
    .join('\n');
}

export function fieldLabelOf(line) {
  const t = capLines(line).trim();
  const tbl = t.match(/^\|[ \t]*(?:\*\*)?[ \t]*([^|*]*[^|* \t])[ \t*]*\|/);
  if (tbl) return tbl[1];
  const bold = t.match(/^[-*\s]*\*\*[ \t]*([^*]*[^*\s])[ \t]*\*\*/);
  if (bold) return bold[1].replace(/:$/, '');
  return null;
}

export function tokensIn(line, repoNames) {
  const out = new Set();
  const raw = [];
  for (const m of line.matchAll(/`([^`]+)`/g)) {
    const before = line.slice(0, m.index).replace(/[\s,;(—-]+$/, ' ').trimEnd();
    if (NEGATED.test(before)) continue;
    raw.push(m[1]);
  }
  // An unticked `<alias>/<repo>` in prose names that repo too, for every configured alias.
  for (const a of ROOT_ALIASES) {
    const re = new RegExp(`(?<![\`\\w])${escapeRe(a)}\\/([A-Za-z0-9._-]+)`, 'g');
    raw.push(...[...line.matchAll(re)].map((m) => m[1]));
  }
  for (const r of raw) {
    let t = r.trim().replace(/^\.\//, '').replace(/\/+$/, '');
    // Every configured spelling of the root IS the root. Measured before the aliases were
    // configuration: several live briefs named the root by its display name and every one of them
    // landed in PARSE-FAIL, because the parser recognised only one spelling.
    if (isRootSpelling(t)) {
      out.add(ROOT_LABEL);
      continue;
    }
    t = stripRootAlias(t);
    if (t.includes('/')) t = t.split('/')[0];
    if (repoNames.has(t)) out.add(t);
  }
  return [...out];
}

/**
 * `Touches: none` — a lane that writes NO repo file at all (Gov ETA1, 2026-08-24).
 *
 * There was no way to say this, and the gap was expensive. `Portfolio-LEAP-L7b`'s own file-set
 * section reads "This lane writes **zero repo files**"; it names five repos, and because a brief with
 * no readable scope reads as the whole repo, it held all five of them shut. The router could express
 * "everything" and any list of paths, but not "nothing", so the most harmless lane on the board was
 * carded as the most expensive one.
 *
 * An empty scope intersects nothing — `scopesIntersect` is a double loop over two lists — so such a
 * lane neither blocks nor is blocked. The value at close time is the other half of the point: gate 7
 * tests every touched path against the declared scope, and against an empty scope EVERY touched path
 * fails. A lane that declared it would write nothing and then wrote something fails its close by
 * name. That is the intended behaviour, not an edge case.
 */
export const NO_SCOPE = /^(none|nothing|n\/a|read-only|readonly|zero repo files)$/i;

// A `Touches:` declaration may WRAP. Long briefs write it as one label followed by several lines of
// backticked paths, each line ending in a comma. `SCOPE_LINE` carries the `m` flag and not `s`, so
// `(.*)` stops at the first newline and reads exactly one line of a ten-file declaration. Measured:
// a brief declaring twelve paths across seven lines produced an OPEN record carrying ONE, the first
// span on the first line; the in-scope gate then failed the close BY NAME on files the brief had
// declared, and the lane closed PARTIAL for staying inside its own scope. That is the worse
// direction: a declaration read narrow lets the allocator run a neighbour beside a lane that in
// truth overlaps it, then blames the lane at close.
//
// A line continues the declaration when the line before it ended in a comma, or when it opens
// with a backticked span. It ends at a blank line, a heading, a rule, a code fence, or the next
// labelled field (`**Model:**`, `| Runs beside |`) — a comma at the end of the previous line does
// not turn the next field into a path list.
const SCOPE_CONTINUES = /^[-*\s]*`[^`]/;
// No two adjacent quantifiers here may eat the same character (see MAX_LINE above): the label's
// words are separated by single runs of spaces, and the run before the colon is one run.
const SCOPE_ENDS = /^[-*|\s]*[A-Za-z][A-Za-z()/-]*(?: +[A-Za-z()/-]+)*\*{0,2} *(?::|\|)/;

// Neither rule above helps when the wrap falls INSIDE a backticked span. Measured: a line opened a
// span on `_handoffs/done-2026-09-07-web-spend1-` and closed it on the next line, but that line
// opens with plain text and the one before it did not end in a comma, so both rules said "stop" —
// two of the brief's four declared paths were lost.
// `scopeDeclarationText` below checks the accumulated declaration text for an open span (an odd
// backtick count) BEFORE every other terminator, including `SCOPE_ENDS`: a heading or a labelled
// field cannot legally appear inside an open backtick, so treating one as a terminator there is
// exactly what truncates the list. Once the span closes, the two rules above resume unchanged.
function scopeDeclarationText(text, m) {
  let tail = (m[2] ?? '').replace(/\|\s*$/, '');
  const lines = text.slice(m.index + m[0].length).split('\n');
  let prev = tail;
  // lines[0] is the empty remainder of the matched line itself; the candidates start at 1.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    const t = line.trim();
    // An odd backtick count means a span is still open. The line is appended RAW, with no
    // separator: it is continuing a token mid-span, not starting a new one, and an inserted ", "
    // would land inside the reconstructed path itself: a wrapped filename must reassemble with no
    // character between the two halves.
    if ((tail.match(/`/g) || []).length % 2 === 1) {
      tail += t.replace(/\|\s*$/, '');
      prev = t;
      continue;
    }
    if (!t) break;
    if (/^#{1,6}\s/.test(t) || /^---+\s*$/.test(t) || /^```/.test(t)) break;
    const startsTicked = SCOPE_CONTINUES.test(line);
    if (!startsTicked && SCOPE_ENDS.test(line)) break;
    if (!startsTicked && !/,\s*$/.test(prev)) break;
    tail += `, ${t.replace(/\|\s*$/, '')}`;
    prev = t;
  }
  return tail;
}

/** Every backticked span on the scope line (and its wrapped continuation lines), in source order, unfiltered by repo name. */
export function scopeTokens(rawText) {
  const text = capLines(rawText);
  const m = SCOPE_LINE.exec(text);
  if (!m) return null;
  const tail = scopeDeclarationText(text, m);
  // `none` FOLLOWED BY ANYTHING IS STILL `none` (Gov LAMBDA1, 2026-09-06). A parenthetical note
  // after the bare word — `Touches: none (verified with \`npm run sync\`)` — is not a second
  // declaration; it is prose explaining the "none". Checked BEFORE the backtick extraction below,
  // because a backticked token sitting inside that parenthetical would otherwise become the ONLY
  // span the regex finds and get read as the declared scope instead of as a note. Measured: the
  // transcript catch-up lane (sync3)'s OPEN record carried a scope of `npm run sync` — a shell
  // command, not a path — lifted straight out of its own "none (...)" note.
  // A `**Touches:**` label closes its bold markers AFTER the colon, not before, so the closing
  // `**` lands inside `tail` itself (SCOPE_LINE only looks for `*{0,2}` ahead of the colon). The
  // backtick-extraction path never notices because it matches backticked spans anywhere in the
  // string; this bare-word check has to strip the same leftover markers explicitly.
  const bareNone = tail.trim().replace(/^\*+\s*/, '').match(/^(none|nothing|n\/a|read-only|readonly|zero repo files)\s*(\(.*\))?\.?$/i);
  if (bareNone) return [];
  const ticked = [...tail.matchAll(/`([^`]+)`/g)].map((x) => x[1].trim());
  const spans = ticked.length
    ? ticked
    : tail.split(',').map((x) => x.trim()).filter((x) => x && !/^-+$/.test(x));
  // One span, and it says "nothing". Two spans do not: `Touches: none, src/x.js` is a brief
  // contradicting itself, and the safe reading of a contradiction is the wider scope, so the token
  // is left in place to be normalized away and the rest of the list stands.
  if (spans.length === 1 && NO_SCOPE.test(spans[0])) return [];
  // A `Touches:` line with nothing readable after it declares nothing, so it reads as UNDECLARED and
  // widens to the whole repo. `[]` is reserved for the explicit "none" above and must not be reachable
  // by an empty or unparseable line: the two look identical downstream and mean opposite things.
  return spans.length ? spans : null;
}

/**
 * `Not-Before: YYYY-MM-DD` — hold this brief until a date, enforced by the allocator.
 *
 * Added 2026-08-23. The need was ordinary: hold a brief until a usage window resets, without it
 * being fireable in the meantime. Every way to say that already existed was PROSE — a "Fires
 * after:" sentence no code reads — and a rule with no mechanism is a note.
 *
 * Parking the brief was the obvious alternative and it is worse. A `parked-` brief routes NOTHING,
 * so it vanishes from the board entirely; the day it comes due, nobody is looking at it. This holds
 * the brief while keeping it VISIBLE, carded and queued with the date printed on the card.
 */
// The colon may sit inside or outside the bold markers: `**Not-Before:** X` and `**Not-Before**: X`
// are both natural to write, and a gate that silently misses one of them is not a gate.
export const NOT_BEFORE_LINE = /^[-*|\s>]*\*{0,2}Not-Before:?\*{0,2}:?\s*`?([^`\s|]+)`?/im;

/** Read the `Not-Before:` value out of a brief, or null. Pure. */
export function notBeforeOf(text) {
  const m = NOT_BEFORE_LINE.exec(capLines(text));
  return m ? m[1].trim() : null;
}

/**
 * Should this brief be held? Returns the date string to print, `'UNREADABLE'`, or null to fire.
 *
 * An unparseable value returns UNREADABLE and HOLDS, deliberately. A typo'd date that reads as
 * "no gate" fires the brief on exactly the day somebody meant to hold it, which is the failure
 * worth designing against; a held brief costs one board line and a correction.
 *
 * The named day itself is LIVE. "Not before Tuesday" means it fires on Tuesday.
 *
 * @param {string|null} notBefore the raw value from the brief
 * @param {string} todayISO today as `YYYY-MM-DD`
 */
export function notBeforeVerdict(notBefore, todayISO) {
  if (notBefore === null || notBefore === undefined || notBefore === '') return null;
  const raw = String(notBefore).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return 'UNREADABLE';
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) return 'UNREADABLE';
  return raw > String(todayISO) ? raw : null;
}

/**
 * `Standing: refire-until-passed` — a brief that is SUPPOSED to fire again after it closes.
 *
 * Added 2026-08-28 with the CLOSED-UNRENAMED refusal in `lanes.mjs`, and it is the half that makes
 * that refusal safe to ship. Most briefs describe work that happens once; a few describe a ladder
 * climbed repeatedly until every rung passes, and KAPPA1's own standing rule 5 has claimed exactly
 * that behaviour in prose since it was written. Prose is advisory. This is the field that means it.
 *
 * DECLARED, NEVER INFERRED. The alternative was to special-case the lane name `kappa1` inside the
 * refusal, which would work today and leave the next such brief hitting a refusal with no way to
 * say what it is. A brief that re-fires by design says so in its own header.
 *
 * THE COLON IS MANDATORY, same ruling as `Priority:` and `Filed:` — "Standing" opens ordinary
 * English sentences and reading one as a field is the fuzzy matching this router refuses.
 * An unrecognised VALUE is named and does NOT exempt: silently reading a typo as "fire forever"
 * would disable the guard on the brief whose author was trying to configure it.
 */
export const STANDING_LINE = /^[-*|\s>]*\*{0,2}Standing\*{0,2}\s*:\*{0,2}\s+`?([A-Za-z0-9-]+)`?/im;
export const STANDING_REFIRE = 'refire-until-passed';

/** The raw `Standing:` value, or null. Pure. */
export function standingOf(text) {
  const m = STANDING_LINE.exec(capLines(text));
  return m ? m[1].trim() : null;
}

/** Does this brief re-fire after a close? Only the exact declared value says yes. */
export function refiresAfterClose(standing) {
  return String(standing ?? '').toLowerCase() === STANDING_REFIRE;
}

/**
 * `Model:` — which model this lane runs on, promoted from prose to a field on the card.
 *
 * Briefs carry a `Model:` line and it is easy for nothing to read it: if the allocator card the
 * dispatcher works from never mentions a model, which model actually ran a lane is whatever the
 * person firing it happened to pick. A sentence in a brief is not a mechanism.
 */
export const MODEL_LINE = /^[-*|\s>]*\*{0,2}Model:?\*{0,2}:?\s*([^(|\n]+)/im;

/** Read the raw `Model:` value out of a brief, or null. Trailing parenthetical gloss is dropped. */
export function modelOf(text) {
  const m = MODEL_LINE.exec(capLines(text));
  return m ? m[1].trim().replace(/[.,;]$/, '') || null : null;
}

/**
 * The exact model id for a name, or null.
 *
 * **NO FUZZY MATCHING, deliberately.** An unrecognised name returns null and the card names it as
 * unrecognised. Guessing manufactures false agreement — a lane silently running the wrong model
 * produces work nobody can attribute, which is worse than an honest "I do not know this one".
 * Exact ids pass through so a brief may write either form.
 *
 * **THE ROSTER IS CONFIGURATION.** The name-to-id table ships EMPTY and is filled from POLICY.md's
 * optional `models` table (see policy.mjs), so no vendor's roster is compiled in. With no table,
 * every `Model:` line reads as unrecognised, which is the honest answer.
 */
export let MODEL_TABLE = new Map();

/** @param {Map<string,string>|Iterable<[string,string]>} table  friendly name (any case) -> exact id */
export function setModels(table) {
  MODEL_TABLE = new Map([...(table ?? [])].map(([k, v]) => [String(k).trim().toLowerCase(), String(v).trim()]));
}

export function modelIdFor(name) {
  if (name === null || name === undefined) return null;
  const raw = String(name).trim();
  if (!raw) return null;
  for (const id of MODEL_TABLE.values()) if (id === raw) return raw;
  return MODEL_TABLE.get(raw.toLowerCase()) ?? null;
}

/**
 * ORDER INSIDE A TIER — `Priority:` and `Filed:`, added 2026-08-24 by Gov WHISKEY1.
 *
 * Until today the only tiebreaker inside a tier was the brief file's mtime, ascending. So EDITING a
 * brief moved it to the back of the queue, and the printed order was a record of what somebody typed
 * most recently wearing the costume of a judgement. Ops Dispatch watched `strag1` and `gate1` swap
 * FIRE NOW twice as it edited each in turn and fired with `--queued` rather than trust the list. It
 * was right not to.
 *
 * Resolution, in order, with the rule PRINTED on the card so the weakness is visible at the point of
 * use rather than discovered by a dispatcher a month later:
 *
 *   1. `Priority:` — an integer, lower fires first. Deliberate judgement, so it wins.
 *   2. `Filed:` — an ISO date, older first. This is CONTENT, so editing the body does not move it.
 *   3. mtime — unchanged, the last resort.
 *
 * ABSENT IS NOT ZERO. Absent means fall through to the next rule, which is why the groups compare
 * before the values do: a brief that states a priority outranks one that states nothing. An
 * UNPARSEABLE value is NAMED and falls through — never guessed at, the same ruling as the
 * Not-Before gate, because a typo silently reading as 0 would jump the queue.
 *
 * With both fields absent everywhere, today's ordering is reproduced EXACTLY. That is the property
 * that makes this safe to ship onto a live board, and it has its own assertion.
 */
// THE COLON IS MANDATORY AND THE WHITESPACE AFTER IT IS TOO, unlike `Not-Before:` and `Model:`
// where it is optional. Measured against the live bridge the moment this shipped: the loose form
// matched "Filed 2026-08-24 by the lane sweep" inside a brief's prose and read it as a field,
// and it matched the string "no Filed:)" inside WHISKEY1's own specification of this feature. Both
// are ordinary English — "Filed" and "Priority" open sentences in a way "Not-Before" never does —
// and reading a sentence as a queue position is fuzzy matching, which manufactures false agreement.
// So: `Filed: 2026-08-20`, `**Filed:** 2026-08-20` and `**Filed**: 2026-08-20` are fields.
// `Filed 2026-08-24 by X` and `no Filed:)` are prose and are not read.
export const PRIORITY_LINE = /^[-*|\s>]*\*{0,2}Priority\*{0,2}\s*:\*{0,2}\s+`?([^`\s|]+)`?/im;
export const FILED_LINE = /^[-*|\s>]*\*{0,2}Filed\*{0,2}\s*:\*{0,2}\s+`?([^`\s|]+)`?/im;

export function priorityOf(text) {
  const m = PRIORITY_LINE.exec(capLines(text));
  if (!m) return null;
  const raw = m[1].trim();
  if (!/^-?\d+$/.test(raw)) return 'UNREADABLE';
  return Number(raw);
}

export function filedOf(text) {
  const m = FILED_LINE.exec(capLines(text));
  if (!m) return null;
  const raw = m[1].trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return 'UNREADABLE';
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) return 'UNREADABLE';
  return raw;
}

/** Group 0 = a readable Priority, 1 = a readable Filed, 2 = mtime. Lower group sorts first. */
function orderKeyOf(brief) {
  const p = brief.priority;
  if (typeof p === 'number') return [0, p, ''];
  const f = brief.filed;
  if (typeof f === 'string' && f !== 'UNREADABLE') return [1, 0, f];
  return [2, brief.mtime?.getTime?.() ?? 0, ''];
}

/** Comparator for `Array.prototype.sort`, applied INSIDE a tier. Pure. */
export function compareBriefOrder(a, b) {
  const ka = orderKeyOf(a), kb = orderKeyOf(b);
  if (ka[0] !== kb[0]) return ka[0] - kb[0];
  if (ka[2] || kb[2]) return String(ka[2]).localeCompare(String(kb[2]));
  return ka[1] - kb[1];
}

/** The one-line resolution string the card prints. Never silent about which rule applied. */
export function orderRuleOf(brief) {
  const bad = [];
  if (brief.priority === 'UNREADABLE') bad.push('Priority: is UNREADABLE and was ignored');
  if (brief.filed === 'UNREADABLE') bad.push('Filed: is UNREADABLE and was ignored');
  const note = bad.length ? ` — ${bad.join('; ')}` : '';
  if (typeof brief.priority === 'number') return `Priority ${brief.priority}${note}`;
  if (typeof brief.filed === 'string' && brief.filed !== 'UNREADABLE') {
    return `Filed ${brief.filed} (no Priority:)${note}`;
  }
  return `mtime (no Priority:, no Filed:)${note}`;
}

export function parseBrief(file, repoNames) {
  const lines = capLines(fs.readFileSync(file, 'utf8')).split('\n');
  const text = lines.join('\n');
  if (!BRIEF_MARKER.test(text)) return null; // not a brief
  const block = briefBlock(lines);
  const rec = {
    file: path.basename(file),
    fullPath: file,
    targets: [],
    how: null,
    scope: scopeTokens(text),
    notBefore: notBeforeOf(text),
    standing: standingOf(text),
    model: modelOf(text),
    priority: priorityOf(text),
    filed: filedOf(text),
    runsBeside: (text.match(/^[-*|\s]*\*\*?Runs beside:?\*\*?:?\s*(.+)$/im) ?? [])[1]?.replace(/\s*\|\s*$/, '') ?? null,
    mtime: fs.statSync(file).mtime,
  };
  if (!block) {
    rec.how = 'PARSE-FAIL: RUN THIS IN marker found but no readable block';
    return rec;
  }
  const folderLines = block.filter((l) => FOLDER_IN_LINE.test(l) || FOLDER_CELL.test(l) || FOLDER_PLAIN.test(l));
  let hits = folderLines.flatMap((l) => tokensIn(l, repoNames));
  if (hits.length) rec.how = 'Folder line';
  if (!hits.length) {
    const usable = block.filter((l) => {
      const label = fieldLabelOf(l);
      return !(label && NON_FOLDER_LABEL.test(label) && !/interface/i.test(label));
    });
    hits = usable.flatMap((l) => tokensIn(l, repoNames));
    if (hits.length) rec.how = 'RUN THIS IN block (no Folder line)';
  }
  rec.targets = [...new Set(hits)];
  if (!rec.targets.length) {
    const b = block.join(' ');
    rec.how = matchesExternalLabel(b) ? `${EXTERNAL_LABEL} (no repo named)` : 'PARSE-FAIL';
  }
  return rec;
}
