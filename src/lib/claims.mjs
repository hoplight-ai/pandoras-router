// claims.mjs — one parser for _handoffs/_lanes/CLAIMS.md, shared by the board, the allocator,
// lane-open and lane-close. There was one parser inside fire-board.mjs; four copies of it would
// have drifted within a week and the board would have disagreed with the allocator about who holds
// what, which is worse than no claim file at all.
//
// FORMAT
//   <repo> | <chat title> | <ISO 8601 timestamp> | <session id, pid, worktree path, or sweep:<name>>
//
// The fourth field is OPTIONAL so every historical three-field line still parses. A claim without
// it is honoured and printed under WEAK CLAIMS, because two sessions of one lane are identical in
// it — that is the exact blind spot that let two sessions of one lane each read the claim as
// satisfied while one destroyed the other's report.
//
// TYPED CLAIMS. A fourth field of the form `sweep:<name>` declares a cross-repo hygiene pass. A
// sweep is NOT a writer for the purpose of the board's recent-commit heuristic: it commits across
// many repos in a few minutes, and every one of those commits used to read as "a session is mid-run
// here", producing a WAIT on repos nobody was building in. A sweep that declares itself gets its
// commits explained instead of counted.

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------------------------
// FIX 4 OF Ops BETA2 — "make the fourth field session-unique" — IS DEFERRED, WITH THE REASON.
//
// The brief allows either building it here or deferring it here with the reason written down. It is
// deferred, and this is the reason rather than a preference.
//
// The field is documented as "session id, pid, or worktree path", and the dispatch path fills it
// with `dispatch-lane-<lane>` from `naming.mjs` — derived from the LANE, so two sessions of one lane
// write byte-identical lines and no comparison can separate them. That is the defect.
//
// WHY NOT NOW: that string is a JOIN KEY, not a label. `lane-close` pairs a claim with its `OPEN`
// record in `LANES.md` on exactly this field, and `alloc.mjs` maps session -> declared file scope
// through it. Making it session-unique means a claim written today no longer matches an `OPEN`
// record written by an older `lane-open`, and the failure is SILENT: the matcher finds nothing and
// the lane reads as scope-unknown, which widens it to the whole repo and serializes everything.
//
// That is not hypothetical. Measured once: a ledger OPEN row carried session id
// `dispatch-lane-x` while a hand-written second-pass claim carried
// `dispatch-lane-x-w3`, so the matcher found nothing and the close could not release the
// claim automatically. One character of drift in this field already cost a close.
//
// Changing a join key under a live lane is the shape of change to refuse mid-flight.
//
// WHAT IT NEEDS, so the next lane does not re-derive it: a migration, not an edit. The OPEN record
// needs a second identity column carrying the session-unique value while the lane-derived one keeps
// matching historical rows, and the close matcher needs to accept either.
//
// THE AGE GATE STANDS WITHOUT IT, because it does not depend on identity at all — which is why it
// is the larger share of the safety win. `claim.mjs`, for lane-less direct claims, already stamps
// its own ids with the wall clock and is not affected.
// ---------------------------------------------------------------------------------------------

export const CLAIM_ACTIVE_HOURS = 12;

/**
 * Past this, an ACTIVE claim is old enough to be worth adjudicating — and it is still blocking.
 *
 * THE GAP THIS CLOSES, and why it is not the 24h the brief asked for. Gov-GAMMA1 W3 specified "flag
 * any claim older than 24h". A claim is already flagged STALE-CLAIM past `CLAIM_ACTIVE_HOURS`, at
 * which point the board has stopped counting it as a writer and it blocks nothing. A flag that can
 * only fire on claims which are already flagged and already harmless is a note, not a mechanism,
 * and this seat is told not to build those. So the threshold sits INSIDE the active window, where a
 * dead hand is still holding cards shut.
 *
 * DERIVED, NOT PICKED: half the active window, so the two can never drift to unrelated numbers.
 * Six hours covers every incident on record here: the longest dead claims measured ran 7.8h, 6.5h
 * and 8.7h before somebody released them by hand, and all three would have been named on the first
 * board read after the sixth hour.
 *
 * IT FLAGS AND NEVER RELEASES. Release stays a dispatch act with a written receipt naming the method
 * used to prove the session gone. An automatic release on an age alone would kill a lane in a long
 * read-and-analyse phase, which is the failure `QUIET IS NOT DEAD` in lib/open.mjs exists to refuse.
 */
export const CLAIM_SUSPECT_HOURS = CLAIM_ACTIVE_HOURS / 2;

/** The one-line adjudication procedure the board prints beside a suspect claim. */
export const CLAIM_ADJUDICATION =
  'adjudicate: is the holder alive (ListAgents / session list), is its work merged, is its report on the bridge, '
  + 'does LANES.md carry a CLOSE? Dead on all four → release with a receipt naming which check you used.';

export function claimsFile(root) {
  return path.join(root, '_handoffs', '_lanes', 'CLAIMS.md');
}

export function readClaims(root, now = Date.now()) {
  const file = claimsFile(root);
  if (!fs.existsSync(file)) return { rows: [], missing: true, file };
  return { ...parseClaims(fs.readFileSync(file, 'utf8'), now), missing: false, file };
}

export function parseClaims(text, now = Date.now()) {
  const rows = [];
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('<!--') || line.startsWith('>')) continue;
    const parts = line.split('|').map((p) => p.trim());
    if (parts.length < 3) {
      rows.push({ lineNo: i + 1, raw: line, malformed: true });
      continue;
    }
    const [repo, chat, stamp] = parts;
    const when = Date.parse(stamp);
    if (Number.isNaN(when)) {
      rows.push({ lineNo: i + 1, raw: line, malformed: true });
      continue;
    }
    const session = parts.length >= 4 ? parts[3] : '';
    const sweep = /^sweep:/i.test(session) ? session.slice(session.indexOf(':') + 1).trim() : null;
    const ageH = (now - when) / 3_600_000;
    rows.push({
      lineNo: i + 1,
      raw: line,
      repo,
      chat,
      stamp,
      session,
      sweep,
      isSweep: sweep !== null,
      weak: !session,
      ageH,
      stale: ageH > CLAIM_ACTIVE_HOURS,
      // Old enough to adjudicate, young enough to still be blocking. Deliberately NOT a subset of
      // `stale` — the two describe different halves of a claim's life and a stale claim needs no
      // liveness verdict, because it has already stopped holding anything.
      suspect: ageH > CLAIM_SUSPECT_HOURS && ageH <= CLAIM_ACTIVE_HOURS,
      malformed: false,
    });
  }
  return { rows };
}

export const activeFor = (rows, repo) =>
  rows.filter((c) => !c.malformed && c.repo === repo && !c.stale);

/** Writers only. A declared sweep holds a claim but is not a writer. */
export const activeWriters = (rows, repo) => activeFor(rows, repo).filter((c) => !c.isSweep);

/** A sweep active on this repo, or on `*` meaning every repo. */
export const activeSweeps = (rows, repo) =>
  rows.filter((c) => !c.malformed && !c.stale && c.isSweep && (c.repo === repo || c.repo === '*'));

/**
 * Same-lane collisions on one repo — the 08-15 shape.
 * @returns {Array<{lane:string, rows:Array, distinguishable:boolean}>}
 */
export function sameLaneTwice(rows, repo) {
  const active = activeWriters(rows, repo);
  const byLane = new Map();
  for (const c of active) byLane.set(c.chat, [...(byLane.get(c.chat) ?? []), c]);
  const out = [];
  for (const [lane, group] of byLane) {
    if (group.length < 2) continue;
    const ids = group.map((r) => r.session).filter(Boolean);
    out.push({ lane, rows: group, distinguishable: ids.length === group.length && new Set(ids).size === group.length });
  }
  return out;
}

/** Append one claim line. Append-only by design: the root folder is not a git repo. */
export function appendClaim(root, { repo, chat, stamp, session, note = null }) {
  const file = claimsFile(root);
  const line = `${repo} | ${chat} | ${stamp} | ${session}`;
  // An optional comment ABOVE the claim, for anything a reader needs that the four fields cannot
  // carry. Every hand-written release in this file's history left a paragraph explaining itself and
  // every tool-driven one left nothing; this is how a tool leaves one. It can never be re-parsed as
  // a claim — the parser skips `#` before it looks at anything else.
  const block = note ? `# ${String(note).replace(/\n/g, ' ')}\n${line}` : line;
  const before = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, before.endsWith('\n') ? `${before}${block}\n` : `${before}\n${block}\n`);
  return line;
}

/**
 * Retire exactly the lines whose 4th field equals `session`, IN PLACE, as commented history.
 *
 * IT USED TO DELETE THE LINE OUTRIGHT, and that was a hole in the only audit trail this folder has.
 * The workspace root is not a git repository, so a deleted line is gone: nothing anywhere records that a claim
 * ever existed, who held it, or who released it. Every hand-written release in this file's history
 * left a paragraph explaining itself; every tool-driven one left nothing, and the two are
 * indistinguishable afterwards from "the claim was never taken."
 *
 * `claim.mjs` partly covered this by rewriting the `# Release it with:` instruction it had written
 * itself — but only `claim take` writes that marker, so a claim written by `lane-open` was released
 * silently. Measured 2026-08-24: releasing lane `lima1` removed its line and left no record at all.
 *
 * The retired line is emitted commented, so it stays readable and re-pasteable, and it can never be
 * re-parsed as an active claim — the parser skips `#` before it looks at anything else. That is what
 * makes this change strictly safer than the delete it replaces rather than merely different.
 *
 * @returns {Array<string>} the retired lines verbatim, so the caller can print them as the undo.
 */
export function releaseRewrite(text, session, stampedAt = new Date().toISOString()) {
  const removed = [];
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const parts = line.startsWith('#') ? [] : line.split('|').map((p) => p.trim());
    if (!line || parts.length < 4 || parts[3] !== session) {
      out.push(raw);
      continue;
    }
    removed.push(line);
    out.push(`# RELEASED ${stampedAt} — claim id \`${session}\`. Not held any more. The line below is the undo:`);
    out.push(`#   ${line}`);
  }
  return { text: out.join('\n'), removed };
}

export function releaseClaim(root, session, stampedAt = new Date().toISOString()) {
  const file = claimsFile(root);
  const { text, removed } = releaseRewrite(fs.readFileSync(file, 'utf8'), session, stampedAt);
  if (removed.length) fs.writeFileSync(file, text);
  return removed;
}
