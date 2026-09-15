// @ts-check
// lib/verdict.mjs — the pure half of Gov DELTA1: read by verdict-audit.mjs (the audit + rename
// CLI) and by the session-start sweep, so both share one definition of "the prefix lies."
//
// THE DEFECT THIS ANSWERS. A `done-` file is supposed to mean the report body says DONE. Measured:
// nearly half of the `done-` files filed in one week did not.
// The project rules file's own rule settles which one governs: "the `done-` prefix marks the brief
// consumed, nothing more; the STATUS word inside the report is the only scope claim." So the fix is
// never to trust the filename — it is to make the filename FOLLOW the word, the same way
// `lib/naming.mjs`'s `reportNameForStatus` already makes a close's own report follow its grade.
//
// A REPORT WITH NO STATUS WORD IS PARTIAL. That is the project rules file's standing rule, not an
// invention here — `expectedPrefixFor` applies it by treating `null` the same as `'PARTIAL'`.
//
// WHAT THIS FILE DOES NOT DO. It never deletes a file and never edits a report's body. It renames,
// and only within the three graded prefixes (`done-`, `partial-`, `blocked-`) — `parked-` is a
// human's decision to withhold a brief, never a grade a checker hands out (same reasoning
// `lib/naming.mjs` gives for leaving it out of `PREFIX_FOR_STATUS`), so a `parked-` file is walked
// and reported but never a rename target.

import path from 'node:path';
import { reportNameForStatus } from './naming.mjs';

export const GRADED_PREFIXES = ['done-', 'partial-', 'blocked-'];
export const PREFIX_WORD = { done: 'DONE', partial: 'PARTIAL', blocked: 'BLOCKED' };

/** The prefix a filename starts with, or null. Case-sensitive: the vocabulary is lowercase. */
export function prefixOf(name) {
  return GRADED_PREFIXES.find((p) => name.startsWith(p)) ?? null;
}

/**
 * The STATUS word a report's own body governs it by, normalized per the standing rule: no word
 * found reads as PARTIAL, never as "unknown" and never as a pass. `statusWord` is whatever
 * `report-check.mjs`'s `checkFile` found (`'DONE'|'PARTIAL'|'BLOCKED'|null`).
 */
export function normalizedWord(statusWord) {
  return statusWord ?? 'PARTIAL';
}

/**
 * Does the filename's prefix agree with the body's word? `null` prefix (no graded prefix at all,
 * e.g. a `parked-` file) never disagrees — there is nothing graded to compare it to.
 */
export function agrees(name, statusWord) {
  const prefix = prefixOf(name);
  if (!prefix) return true;
  return PREFIX_WORD[prefix.replace('-', '')] === normalizedWord(statusWord);
}

/**
 * The rename a disagreement calls for, via the same `reportNameForStatus` a close uses on its own
 * report — one definition of "what prefix does this word want", never a second one invented here.
 * Returns null when nothing needs to move (parked-, or an unrecognized name graded's helper leaves
 * untouched, or a name that already agrees).
 */
export function renameFor(name, statusWord) {
  if (agrees(name, statusWord)) return null;
  const to = reportNameForStatus(name, normalizedWord(statusWord));
  return to && to !== name ? to : null;
}

/**
 * Lane keys held by an ACTIVE claim right now (CLAIMS.md rows, not stale, not malformed) — read
 * from the session field's `dispatch-lane-<key>` shape first (the reliable source; the ZETA1
 * comment on `briefMatchesLaneOrKey` in lib/close.mjs establishes the same convention), and from any
 * ALL-CAPS token in the chat title as a fallback for claims that predate the session field or were
 * taken by hand (`claim.mjs` direct claims carry no session key at all).
 *
 * WHY THIS EXISTS: the brief's claims gate — "do not rename any report belonging to a lane with an
 * active claim" — a rename mid-lane could point a live session's own `writeFindings`/`stampRoadmap`
 * calls at a name that no longer exists on disk.
 */
export function activeLaneKeys(claimsRows) {
  const keys = new Set();
  for (const c of claimsRows ?? []) {
    if (c.malformed || c.stale) continue;
    const m = c.session && c.session.match(/^dispatch-lane-(.+)$/i);
    if (m) keys.add(m[1].toLowerCase());
    for (const t of (c.chat ?? '').match(/\b[A-Z][A-Z0-9]{2,}\b/g) ?? []) keys.add(t.toLowerCase());
  }
  return keys;
}

/** Does this filename carry a hyphen-delimited segment naming a lane with an active claim? */
export function belongsToActiveLane(name, laneKeys) {
  if (!laneKeys?.size) return null;
  const base = path.basename(name).replace(/\.md$/i, '').toLowerCase();
  const segs = base.split('-');
  const hit = segs.find((s) => laneKeys.has(s));
  return hit ?? null;
}

/**
 * One row of the audit table: what would happen to this file, given its filename and the STATUS
 * word `report-check.mjs` found in it. Pure — no filesystem, no renaming, so it is what both
 * verdict-audit.mjs and the session-start sweep call to decide, and both act on the same answer.
 *
 * @param {{name:string, statusWord:(string|null)}} file
 * @param {Set<string>} laneKeys   from activeLaneKeys() — pass an empty Set to skip the claims check
 * @returns {{name:string, prefix:string|null, word:string, agrees:boolean, to:string|null,
 *            heldBy:string|null, action:'none'|'rename'|'skip-active-claim'|'skip-collision'}}
 */
export function planFor(file, laneKeys = new Set(), existing = new Set()) {
  const { name, statusWord } = file;
  const prefix = prefixOf(name);
  const word = normalizedWord(statusWord);
  const ok = agrees(name, statusWord);
  const to = ok ? null : renameFor(name, statusWord);
  const heldBy = belongsToActiveLane(name, laneKeys);
  if (ok || !to) return { name, prefix, word, agrees: ok, to, heldBy: null, action: 'none' };
  if (heldBy) return { name, prefix, word, agrees: ok, to, heldBy, action: 'skip-active-claim' };
  if (existing.has(to)) return { name, prefix, word, agrees: ok, to, heldBy: null, action: 'skip-collision' };
  return { name, prefix, word, agrees: ok, to, heldBy: null, action: 'rename' };
}
