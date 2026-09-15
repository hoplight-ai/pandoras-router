// @ts-check
// board.mjs — the pure half of `pandoras-router board`: what is going on in this workspace right
// now, assembled from three loaders and two verdict functions that already exist and are already
// tested. This module writes nothing, reads nothing, and calls no git — it only arranges what
// readClaims/parseLanes already parsed into four lists a dispatcher can read in one screen instead
// of opening four files by hand.
//
// NO FILESYSTEM, NO GIT, NO PROCESS.EXIT. The orphan probes (does the report exist on the bridge,
// does the worktree still exist, does the branch still exist) are inherently impure, so they are
// computed by the driver (src/bin/board.mjs) and handed in here as plain data, keyed by lane id —
// the same split lane-alloc.mjs's decide() uses for orphanVerdict. This function then calls
// orphanVerdict itself and prints its verdict verbatim, never inventing a second opinion.

import { sameLaneTwice } from './claims.mjs';
import { orphanVerdict, closedUnrenamedVerdict, recentCloses as recentClosesOf } from './lanes.mjs';

/** @param {string|null|undefined} iso @param {number} now @returns {number|null} */
function ageHours(iso, now) {
  const t = Date.parse(String(iso ?? ''));
  return Number.isNaN(t) ? null : (now - t) / 3_600_000;
}

/**
 * ACTIVE CLAIMS — every non-stale, non-malformed row in CLAIMS.md, each carrying repo, chat title,
 * age in hours and the session field, flagged suspect (age past CLAIM_SUSPECT_HOURS, already
 * computed by parseClaims) and flagged as a same-lane-twice collision. `sameLaneTwice` is called
 * once per repo present in the active rows and never re-implemented here.
 *
 * @param {Array} rows   claim rows from readClaims(root).rows
 * @returns {Array}
 */
function activeClaimsOf(rows) {
  const active = rows.filter((c) => !c.malformed && !c.stale);
  const repos = new Set(active.map((c) => c.repo));
  const dupes = new Set();
  for (const repo of repos) {
    for (const group of sameLaneTwice(rows, repo)) {
      for (const r of group.rows) dupes.add(r);
    }
  }
  return active.map((c) => ({
    repo: c.repo,
    chat: c.chat,
    session: c.session,
    ageH: c.ageH,
    suspect: !!c.suspect,
    weak: !!c.weak,
    sameLaneTwice: dupes.has(c),
  }));
}

/**
 * OPEN LANES — every lane with an OPEN record and no CLOSE, oldest first, because age is the
 * signal. `l.scope` is already decoded by parseLanes; `[]` means the lane declared it writes
 * nothing (SCOPE_NONE), an unset/blank scope reads as whole-repo elsewhere and is left as-is here
 * since the board reports what was declared rather than resolving it.
 *
 * @param {Array} lanes  folded lane records from readLanes(root) / parseLanes()
 * @param {number} now
 * @returns {Array}
 */
function openLanesOf(lanes, now) {
  return lanes
    .filter((l) => l.status === 'OPEN')
    .map((l) => ({
      lane: l.lane, repo: l.repo, branch: l.branch, worktree: l.worktree,
      scope: l.scope, ageH: ageHours(l.opened, now),
    }))
    // Oldest first: an unknown age (unparseable `opened`) sorts last, not first, so a genuinely
    // ancient lane is never hidden behind a malformed timestamp.
    .sort((a, b) => (b.ageH ?? -Infinity) - (a.ageH ?? -Infinity));
}

/**
 * RECENT CLOSES — recentCloses()'s existing 48h window (or `closeHours`), newest first, each
 * marked when the same lane family (laneKey) has closed more than once — the signal
 * `closedUnrenamedVerdict` already carries in its "(N closes on this lane; newest shown)" clause,
 * which is exactly the shape of a brief that was never renamed and so fired again. Called, not
 * re-implemented: this reads that clause off the verdict it already returns rather than
 * re-deriving the grouping.
 *
 * @param {Array} lanes
 * @param {number} now
 * @param {number} closeHours
 * @returns {Array}
 */
function recentClosesOfBoard(lanes, now, closeHours) {
  const closedFamilyPattern = /\(\d+ closes on this lane/;
  return recentClosesOf(lanes, { now, hours: closeHours }).map((l) => {
    const fam = closedUnrenamedVerdict(l.lane, lanes);
    const unrenamed = !!fam && closedFamilyPattern.test(fam.headline);
    return { lane: l.lane, status: l.status, report: l.report, closed: l.closed, unrenamed };
  });
}

/**
 * A claim matching this OPEN lane by the join key the rest of the router already uses: the
 * `session` field, written byte-identical into both CLAIMS.md's fourth field and LANES.md's OPEN
 * row by lane-open.mjs. Stale claims don't count as holding anything (same rule `activeFor` uses
 * everywhere else in this router).
 *
 * @param {object} lane
 * @param {Array} claims
 * @returns {boolean}
 */
function laneHasClaim(lane, claims) {
  return claims.some((c) => !c.malformed && !c.stale && c.session && c.session === lane.session);
}

/**
 * ORPHANED LANES — an open lane whose worktree directory is gone, whose branch no longer exists,
 * whose declared report already landed on the bridge, or whose OPEN record has outlived
 * CLAIM_ACTIVE_HOURS with no CLOSE (all four decided by `orphanVerdict`, printed verbatim), PLUS
 * one more case that function does not cover: an OPEN lane holding no claim in CLAIMS.md at all.
 * A lane can lose its claim (released by hand, or never written) while its LANES.md record still
 * reads OPEN, and that is exactly as orphaned as a missing worktree — nobody is holding the repo
 * even though the ledger says somebody is.
 *
 * @param {Array} lanes
 * @param {Array} claims
 * @param {Record<string, {reportExists?:boolean, worktreeExists?:boolean, branchExists?:boolean}>} probes
 *   keyed by lane id; a lane with no entry reads as "unknown", which answers TRUE for
 *   worktree/branch existence (the safe direction — see orphanVerdict's own doc) and FALSE for
 *   reportExists (absence is the safe default there: it never invents a bridge hit).
 * @param {number} now
 * @returns {Array}
 */
function orphanedOf(lanes, claims, probes, now) {
  const out = [];
  for (const l of lanes) {
    if (l.status !== 'OPEN') continue;
    const probe = probes[l.lane] ?? {};
    const v = orphanVerdict(l, {
      reportExists: probe.reportExists === true,
      worktreeExists: probe.worktreeExists !== false,
      branchExists: probe.branchExists !== false,
      now,
    });
    if (v) { out.push({ lane: l.lane, repo: l.repo, ...v }); continue; }
    if (!laneHasClaim(l, claims)) {
      const why = 'holds no claim in CLAIMS.md while its record still reads OPEN';
      out.push({
        lane: l.lane, repo: l.repo, why,
        headline: `ORPHANED, slot freed, work state UNKNOWN — ${why}`,
        closeCmd: `pandoras-router close ${l.lane}`,
      });
    }
  }
  return out;
}

/**
 * The board: what is going on in this workspace right now, in four lists. Pure — no printing, no
 * process.exit, no filesystem, no git. The driver (src/bin/board.mjs) reads the world, computes
 * `probes`, and calls this.
 *
 * @param {object} o
 * @param {Array} [o.claims]   claim rows, e.g. readClaims(root).rows
 * @param {Array} [o.lanes]    folded lane records, e.g. readLanes(root)
 * @param {Record<string, object>} [o.probes]  orphan probes, keyed by lane id (see orphanedOf)
 * @param {number} [o.now]
 * @param {number} [o.closeHours]  recentCloses() window; defaults to its own 48h default
 * @returns {{activeClaims:Array, openLanes:Array, recentCloses:Array, orphaned:Array,
 *   counts:{activeClaims:number, openLanes:number, recentCloses:number, orphaned:number}}}
 */
export function buildBoard({ claims = [], lanes = [], probes = {}, now = Date.now(), closeHours = 48 } = {}) {
  const activeClaims = activeClaimsOf(claims);
  const openLanes = openLanesOf(lanes, now);
  const recentClosesList = recentClosesOfBoard(lanes, now, closeHours);
  const orphaned = orphanedOf(lanes, claims, probes, now);
  return {
    activeClaims, openLanes, recentCloses: recentClosesList, orphaned,
    counts: {
      activeClaims: activeClaims.length, openLanes: openLanes.length,
      recentCloses: recentClosesList.length, orphaned: orphaned.length,
    },
  };
}
