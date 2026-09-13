// finding-lines.mjs — a `FINDING:` line in a done-file either carries a fix, or the close refuses
// it. The norm nobody enforces, restated as a gate: every problem you raise needs a solution.
//
// FORMAT: `FINDING: <what> | fix: <the fix> | size: small|medium|large | owner: <seat or OWNER>`
// (a leading `- ` or `* ` bullet marker is accepted, matching the report template's own bullets).
// A line missing `fix`, a valid `size`, or `owner` fails gate `findings`, quoted verbatim, so the
// close cannot pass a claim it never gave a size or an owner to. A done-file with zero FINDING
// lines passes — nothing found is fine, and this gate only ever polices completeness, not quantity.
//
// A COMPLETE FINDING GOES TO THE OWNER AS A YES/NO, AND NOWHERE ELSE. The obvious design — a close
// that files every complete line straight into a tracker — was measured and abandoned: a close
// turned a dead symlink that had already been removed into a tracker row owned by the project
// owner, and a later session spun that row into a task prompt. Holding the lines in the report
// instead is no better; it builds a pile of open loops inside documents nobody reads.
//
// So: the close PRINTS the yes/no, worded for wherever the owner actually reads, the dispatcher
// puts it there the same turn, and the filing driver files only the numbers the owner said yes to.
// A small finding owned by the owner is refused at the gate (findingRefusal): a lane fixes it, or
// it names a seat.
//
// ── THE OWNER TOKEN ───────────────────────────────────────────────────────────────────────────
//
// One word in the `owner:` field means "the human who decides", as opposed to a seat that does the
// work. It is configurable, because it is a name. Everything that special-cases it goes through
// `isOwnerToken()`, so there is exactly one place to change.
//
// IDS ARE MINTED HERE BECAUSE NOTHING ELSE MINTS THEM: tracker rows are typically hand-authored,
// and no script generates the next one. `finding_<lane>_<n>` is scoped to the lane and a per-report
// counter, which is enough to make two findings in one report distinct and never collides with a
// hand-authored id.
//
// NO DATABASE. `findingRow()` builds a plain object. Persisting it is the caller's job, and the
// caller passes in its own product mapping — this module never imports a client of any kind.

/** The word in an `owner:` field that means "the human who decides". Configurable; it is a name. */
export let OWNER_TOKEN = 'owner';

export function setOwnerToken(token) {
  OWNER_TOKEN = String(token ?? '').trim() || 'owner';
  return OWNER_TOKEN;
}

/** Case-insensitive, whole-value match against the configured owner token. */
export function isOwnerToken(value) {
  const v = String(value ?? '').trim();
  if (!v) return false;
  return v.toLowerCase() === OWNER_TOKEN.toLowerCase();
}

const FINDING_RE = /^\s*(?:[-*]\s*)?FINDING:\s*(.*)$/i;
const SIZES = ['small', 'medium', 'large'];

/**
 * One `FINDING:` line, split on `|`. Never throws — a line this cannot parse at all (no `FINDING:`
 * prefix) simply is not a finding, and returns null so the caller skips it rather than reports it.
 *
 * @returns {{ok:boolean, what:string, fix:string|null, size:string|null, owner:string|null,
 *             missing:string[], raw:string}|null}
 */
export function parseFindingLine(raw) {
  const m = String(raw ?? '').match(FINDING_RE);
  if (!m) return null;
  const parts = m[1].split('|').map((s) => s.trim());
  const what = parts[0] || '';
  let fix = null;
  let size = null;
  let owner = null;
  for (const p of parts.slice(1)) {
    const fm = p.match(/^fix:\s*(.*)$/i);
    if (fm) { fix = fm[1].trim() || null; continue; }
    const sm = p.match(/^size:\s*(.*)$/i);
    if (sm) { size = sm[1].trim().toLowerCase() || null; continue; }
    const om = p.match(/^owner:\s*(.*)$/i);
    if (om) { owner = om[1].trim() || null; continue; }
  }
  const missing = [];
  if (!what) missing.push('what');
  if (!fix) missing.push('fix');
  if (!size || !SIZES.includes(size)) missing.push('size');
  if (!owner) missing.push('owner');
  return { ok: missing.length === 0, what, fix, size, owner, missing, raw: String(raw).trim() };
}

/** Every `FINDING:` line in a whole report, split into the complete ones and the ones missing a
 * field. Lines that are not `FINDING:` lines at all are silently not counted either way. */
export function parseFindingLines(text) {
  const complete = [];
  const incomplete = [];
  for (const raw of String(text ?? '').split('\n')) {
    const parsed = parseFindingLine(raw);
    if (!parsed) continue;
    (parsed.ok ? complete : incomplete).push(parsed);
  }
  return { complete, incomplete };
}

/**
 * Gate `findings`'s verdict. `parsed` is `parseFindingLines`'s return, or `null` when this lane's
 * own report could not be read yet (unmeasured, never a guessed pass or fail).
 */
export function findingsGateVerdict(parsed) {
  if (!parsed) {
    return { value: 'n/a', rows: [], note: 'no report text was readable yet, so there is nothing to check for FINDING lines.' };
  }
  if (parsed.incomplete.length) {
    const first = parsed.incomplete[0];
    return {
      value: 'no',
      rows: [],
      note: `${parsed.incomplete.length} FINDING line(s) missing a field (${parsed.incomplete.map((f) => f.missing.join('/')).join('; ')}) `
        + `— every problem raised needs a solution named alongside it. First: "${first.raw}"`,
    };
  }
  const refused = parsed.complete.map(findingRefusal).filter(Boolean);
  if (refused.length) {
    return { value: 'no', rows: [], note: `${refused.length} FINDING line(s) refused: ${refused.join(' ')}` };
  }
  return {
    value: 'yes',
    rows: parsed.complete,
    note: parsed.complete.length
      ? `${parsed.complete.length} complete FINDING line(s).`
      : 'no FINDING lines in this report — nothing found is fine.',
  };
}

/**
 * An owner (a seat or product name, or the owner token) mapped to whatever routing value the
 * caller's tracker wants. The alias table is INJECTED: this module has no opinion about your
 * products and no import that could reach a database.
 *
 * The owner token is returned verbatim rather than lower-cased through the aliases, because it
 * names a person, not a repo.
 *
 * @param {string} owner
 * @param {Record<string,string>} [aliases]  lower-cased name -> routing value
 */
export function ownerToProduct(owner, aliases = {}) {
  const key = String(owner ?? '').trim();
  if (!key) return null;
  if (isOwnerToken(key)) return OWNER_TOKEN;
  const lower = key.toLowerCase();
  return aliases[lower] ?? lower;
}

/** `finding_<lane>_<n>` — see the module note above for why this mints rather than reads an id. */
export function mintFindingId(lane, n) {
  return `finding_${lane}_${n}`;
}

/**
 * Where a finding lands on the board when nobody says otherwise. A finding is by construction
 * something worth doing that nothing is currently blocked on, which is what `q2` means in an
 * important/not-urgent grid. Change it to whatever bucket your tracker uses.
 */
export let FINDING_QUADRANT = 'q2';

export function setFindingQuadrant(q) {
  FINDING_QUADRANT = q;
  return FINDING_QUADRANT;
}

/**
 * One complete FINDING line, as a plain tracker row. `n` is 1-based and the caller's own counter
 * (never re-derived here), so two findings in one report never collide.
 *
 * EVERY FIELD IS ALWAYS WRITTEN, even when it can only fall back. Measured: an earlier version
 * omitted two fields that were NOT NULL in the destination table, so every row it built was
 * rejected and printed as a skipped write while the close carried on regardless. The whole
 * mechanism therefore never once persisted a row, and six findings were lost from one close before
 * anyone noticed. A row this function returns is complete by construction.
 *
 * `project` is descriptive; `product` is the routing value. `repo` is optional because not every
 * caller knows it, and a caller that does not must still never build a row the destination will
 * refuse — so it falls back rather than emitting undefined.
 *
 * @param {object} f                  one complete parsed FINDING line
 * @param {object} o
 * @param {Record<string,string>} [o.aliases]  owner -> routing value, injected by the caller
 */
export function findingRow(f, { lane, n, today, repo = null, aliases = {} }) {
  const product = ownerToProduct(f.owner, aliases);
  return {
    id: mintFindingId(lane, n),
    title: f.what,
    project: repo || product || lane,
    quadrant: FINDING_QUADRANT,
    context: `fix: ${f.fix} | size: ${f.size}`,
    executor: f.owner,
    product,
    completed: false,
    parked: false,
    first_seen: today,
    last_seen: today,
  };
}

/**
 * What a close PRINTS instead of writing rows.
 *
 * This is not a holding notice. It is the yes/no itself, one per finding, worded for wherever the
 * owner actually reads, plus the instruction to put it there THIS turn. A finding lives in exactly
 * one place until the owner answers: in front of them. Pure — it returns lines, it writes nothing.
 *
 * Markdown bold, because the destination is a chat rather than the terminal. ANSI would paste as
 * garbage; `**` renders.
 */
export function ownerDecisionLines({ rows, report, owner = OWNER_TOKEN }) {
  if (!rows?.length) return [];
  const who = owner.toUpperCase();
  const out = [
    `  ${rows.length} FINDING(s). NOT filed, NOT held in the report. Put each of these in front of the ${owner} now, as written, and stop:`,
  ];
  rows.forEach((f, i) => {
    const n = i + 1;
    out.push(`    **ASK ${who} ${n}: ${f.what}. Fix: ${f.fix} (${f.size}, ${f.owner}). Yes puts it on the board, no drops it.**`);
  });
  out.push(`    on a yes:  npm run findings -- _handoffs/${report} --only <the numbers agreed> --apply`);
  out.push('    on a no:   nothing. Do not file it, park it, or write it anywhere else.');
  return out;
}

/**
 * A finding that is SMALL and owned by the OWNER is refused outright. Measured: a lane called a
 * dead symlink "a removal of an untracked file and therefore the owner's call", filed it with the
 * owner's name on it, and the owner ended up holding a task prompt about a link that was already
 * gone. A small fix is the lane's to make, or a seat's; it is never the decider's. Returns the
 * reason, or null.
 */
export function findingRefusal(f) {
  if (!f?.ok) return null;
  if (f.size === 'small' && isOwnerToken(f.owner)) {
    return `"${f.what}" is size small with owner ${f.owner}. A small fix is never the decider's: do it in the lane and say so, or name the seat that owns it.`;
  }
  return null;
}

/**
 * `partial-2026-09-07-scripts-tau1-cut-the-opening.md` -> { repo: 'scripts', lane: 'tau1' }.
 * The repo is every token between the date and the lane token, so root reports and hyphenated repo
 * names (`repo-a`, `web-api`) both come back whole. Unknown shapes return nulls rather than a
 * guess; the caller says so.
 */
export function reportLaneAndRepo(filename) {
  const stem = String(filename ?? '').replace(/^.*\//, '').replace(/\.md$/i, '');
  const m = stem.match(/^(?:done|partial|blocked)-(\d{4}-\d{2}-\d{2})-(.+)$/i);
  if (!m) return { repo: null, lane: null };
  const parts = m[2].split('-').filter(Boolean);
  const at = parts.findIndex((p) => /^[A-Za-z]+\d+$/.test(p));
  if (at < 1) return { repo: null, lane: null };
  return { repo: parts.slice(0, at).join('-'), lane: parts[at].toLowerCase() };
}

/** `--only 1,3` against the 1-based order the lines appear in the report. No `only` means all;
 * an index outside the list is reported, not silently dropped. */
export function selectFindings(complete, only) {
  if (!only) return { picked: complete.map((f, i) => ({ f, n: i + 1 })), bad: [] };
  const idx = String(only).split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !Number.isNaN(n));
  const bad = idx.filter((n) => n < 1 || n > complete.length);
  const picked = idx.filter((n) => n >= 1 && n <= complete.length).map((n) => ({ f: complete[n - 1], n }));
  return { picked, bad };
}

