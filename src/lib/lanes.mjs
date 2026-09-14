// lanes.mjs — the lane ledger at _handoffs/_lanes/LANES.md.
//
// APPEND-ONLY, and that is not a style preference. The workspace root folder is not a git
// repository, so a file rewritten here is unrecoverable. Every record is one line appended to the
// end; the reader folds OPEN and CLOSE records into a lane's current state. Nothing ever edits a
// line that is already written, so a crashed session can lose at most the record it was writing.
//
// RECORD FORMS
//   OPEN  | lane | repo | branch | worktree | port | report | scope | session | ISO | base
//   CLOSE | lane | status | merged | green | live | renamed | report-free | ISO | reason | owner-way | in-scope | roadmap
//
// `base` (added 2026-08-20) is the sha origin/main stood on when the lane opened, and it sits LAST
// for the same reason `owner-way` does: every line written before it parses unchanged and reads as
// '-'. Gate 3 needs it because a lane that merges its own work destroys the merge-base it used to
// measure against. An in-place lane on a non-git target has no branch, no worktree and no base, and
// writes '-' in all three.
//
// The CLOSE record carries the gate results as literal yes/no/skip/n/a so the board can print a
// lane row without re-running anything. `skip` is not `yes` anywhere in this system. `owner-way`
// (gate 6, gated repos only, added 2026-08-18) sits LAST so every line written before it still
// parses; an absent field reads as '-', never as a pass.
//
// THE `scope` FIELD IS WHY A SECOND WRITER SLOT IS REAL. A claim line has four fields and
// none of them is a file scope, so an allocator that only reads CLAIMS.md must treat every open
// lane as holding the whole repo — which is safe, and which makes a capacity of 2 unusable the
// moment one lane is open. The OPEN record carries the scope the lane actually declared, so a
// second lane can be proved disjoint from it rather than assumed to collide. A lane with no OPEN
// record still reads as whole-repo; the conservative default did not move.

import fs from 'node:fs';
import path from 'node:path';
// Imported, never restated: ORPHANED is STALE-CLAIM one layer up and the two must not drift.
import { CLAIM_ACTIVE_HOURS } from './claims.mjs';
import { withLock, writeStateFile } from './lock.mjs';

export function lanesFile(root) {
  return path.join(root, '_handoffs', '_lanes', 'LANES.md');
}

const HEADER = `# LANES — append-only ledger of every lane this router opened and closed.
#
# Written by src/bin/lane-open.mjs and the close driver. Read by the board --lanes.
# NEVER edit a line that is already here: this folder is not a git repository, so a rewrite is
# unrecoverable. Corrections are appended as a new record, not made in place.
#
#   OPEN  | lane | repo | branch | worktree | port | report | scope | session | ISO | base
#   CLOSE | lane | status | merged | green | live | renamed | report-free | ISO | reason | owner-way
#
# merged/green/live/renamed/report-free/owner-way are yes | no | skip | n/a | exempt.
# A skip is NOT a pass. n/a and exempt are: n/a means there was never anything to measure,
# exempt means the surface answered and correctly refused an unauthenticated probe (a gated
# product). Neither claims the build was verified. Ruling in POLICY.md, IOTA2 defect 4.
# owner-way (gate 6, gated repos only) was added 2026-08-18 at the END of the CLOSE form, so older
# lines parse unchanged and read as '-'.
`;

function ensure(root) {
  const file = lanesFile(root);
  if (!fs.existsSync(file)) writeStateFile(root, file, HEADER);
  return file;
}

/**
 * Append one record. UNDER THE STATE LOCK, and atomically (CONC1, 2026-09-14).
 *
 * This was read, concatenate, writeFileSync with nothing between the read and the write, so two
 * appends landing together lost one record, and a reader arriving while writeFileSync had truncated
 * the file read nothing and wrote nothing back, header included. The read and the write now sit in
 * one locked section, and the write is a temporary sibling renamed over the ledger, so no reader sees
 * a half-written file. Re-entrant: a caller already holding the lock (lane-open's compare-and-set,
 * the close's CLOSE-and-release) appends inside its own section.
 */
export function append(root, fields) {
  return withLock(root, () => {
    const file = ensure(root);
    const line = fields.map((f) => String(f ?? '')).join(' | ');
    const before = fs.readFileSync(file, 'utf8');
    writeStateFile(root, file, before.endsWith('\n') ? `${before}${line}\n` : `${before}\n${line}\n`);
    return line;
  });
}

/**
 * The ledger's scope field, encoded so "writes nothing" survives the round trip.
 *
 * An EMPTY field cannot carry it. `Touches: none` produces an empty scope array, which joins to `''`,
 * and every reader of this file treats a blank scope as unknown and widens it to the whole repo —
 * correctly, because the 64 rows written before scopes existed are blank and unknown is the safe
 * reading of those. So the two states need different bytes: `-` for a lane that declared it writes
 * nothing, blank or `.` for a lane whose scope nobody knows.
 *
 * `-` is already this file's convention for an inapplicable field, and no OPEN row has ever carried
 * it in the scope position — counted 2026-08-24, awk over every OPEN row.
 */
export const SCOPE_NONE = '-';
export const encodeScope = (scope) => ((scope ?? ['.']).length ? (scope ?? ['.']).join(' ') : SCOPE_NONE);
export const decodeScope = (field) => {
  const parts = String(field ?? '').split(/\s+/).filter(Boolean);
  return parts.length === 1 && parts[0] === SCOPE_NONE ? [] : parts;
};

export function recordOpen(root, r) {
  return append(root, [
    'OPEN', r.lane, r.repo, r.branch ?? '-', r.worktree ?? '-', r.port ?? '-', r.report,
    encodeScope(r.scope), r.session, r.stamp, r.base ?? '-',
  ]);
}

/** A decision someone should be able to find later — an override, a deviation, a manual repair. */
export function recordNote(root, lane, text) {
  return append(root, ['NOTE', lane, text.replace(/\|/g, '/'), new Date().toISOString()]);
}

/**
 * KIND | lane | scope|clerical | note | ISO   (Gov DELTA1, 2026-09-06)
 *
 * THE BACKFILL RECORD. This file is append-only — nothing ever edits a line already here — so a
 * historical CLOSE row that predates the scope/clerical classifier cannot be rewritten to carry
 * one. A KIND record is how the regrade (verdict-audit.mjs's LANES.md pass) attaches a kind to a
 * lane's existing CLOSE without touching it: parseLanes folds it onto that lane's record the same
 * way a later CLOSE would, so `pandoras-router alloc` and `alloc` read the same answer a
 * freshly-classified close would have written. Written once per lane at regrade time; a lane
 * closing again afterwards writes its own `kind` straight onto its CLOSE record and this becomes
 * moot for it.
 */
export function recordKind(root, lane, kind, note = '') {
  return append(root, ['KIND', lane, kind, note.replace(/\|/g, '/'), new Date().toISOString()]);
}

export function recordClose(root, r) {
  // `in-scope` (gate 7, 2026-08-22) and then `roadmap` (gate 8, 2026-08-30) sit LAST, same
  // convention as `owner-way` and `base`: every line written before each of them parses unchanged
  // and reads as '-'. A '-' is not a pass anywhere in this system; it means the gate did not exist
  // when that line was written.
  //
  // `kind` (Gov DELTA1, 2026-09-06) sits after roadmap for the same reason: every line written
  // before it parses unchanged and reads as '-'. It is `scope` or `clerical` on a PARTIAL close,
  // and '-' on a DONE (or BLOCKED, or a pre-DELTA1 PARTIAL nobody has regraded yet) — a '-' here
  // means "not classified", never "clerical by default". See lib/close.mjs's classifyPartialKind.
  return append(root, [
    'CLOSE', r.lane, r.status, r.merged, r.green, r.live, r.renamed, r.reportFree, r.stamp, r.reason ?? '', r.ownerWay ?? '-', r.inScope ?? '-', r.roadmap ?? '-', r.kind ?? '-',
  ]);
}

export function readLanes(root) {
  const file = lanesFile(root);
  if (!fs.existsSync(file)) return [];
  return parseLanes(fs.readFileSync(file, 'utf8'));
}

export function parseLanes(text) {
  const byLane = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const p = line.split('|').map((x) => x.trim());
    if (p[0] === 'OPEN' && p.length >= 10) {
      byLane.set(p[1], {
        lane: p[1], repo: p[2], branch: p[3], worktree: p[4], port: p[5], report: p[6],
        scope: decodeScope(p[7]), declaredNone: p[7].trim() === SCOPE_NONE, session: p[8], opened: p[9],
        // `base` is the sha origin/main stood on when the lane opened. Appended 2026-08-20 at the
        // END of the OPEN form, so every line written before it parses unchanged and reads as '-'.
        // It is what lets gate 3 measure a proof string after the lane has merged its own work.
        base: p[10] && p[10] !== '-' ? p[10] : null,
        status: 'OPEN', merged: '-', green: '-', live: '-', renamed: '-', reportFree: '-', ownerWay: '-', closed: null, reason: '',
        // `land` is filled by a LAND record (2026-09-03) and is null until one is written. null is
        // the honest reading: no landing was recorded, which is not the same as "not landed".
        land: null,
      });
    } else if (p[0] === 'CLOSE' && p.length >= 9) {
      const rec = byLane.get(p[1]) ?? { lane: p[1], repo: '?', branch: '?', worktree: '?', port: '-', report: '?', scope: ['.'], session: '?', opened: '?' };
      Object.assign(rec, {
        status: p[2], merged: p[3], green: p[4], live: p[5], renamed: p[6], reportFree: p[7], closed: p[8], reason: p[9] ?? '', ownerWay: p[10] ?? '-', inScope: p[11] ?? '-', roadmap: p[12] ?? '-',
        // `kind` (Gov DELTA1, 2026-09-06): 'scope' | 'clerical' on a PARTIAL, '-' (read as null)
        // on everything else, including a PARTIAL nobody has classified yet. A KIND record (see
        // recordKind below) written AFTER this CLOSE line for the same lane overrides it — that is
        // how the regrade backfills a historical row without rewriting the line that is already here.
        kind: p[13] && p[13] !== '-' ? p[13] : null,
      });
      byLane.set(p[1], rec);
    } else if (p[0] === 'LAND' && p.length >= 9) {
      // LAND | lane | repo | branch | tip | merge | brief | report | ISO   (2026-09-03, lane-land.mjs)
      // The permanent identity of a landing: the branch tip at the moment it was merged, and the ONE
      // merge commit that landed it. Gate 7 walks from `tip`; a revert is `git revert -m 1 <merge>`.
      // A LAND row for a lane with no OPEN row still parses, so a hand-merged lane can be recorded.
      const rec = byLane.get(p[1]) ?? { lane: p[1], repo: p[2], branch: p[3], worktree: '?', port: '-', report: p[7] !== '-' ? p[7] : '?', scope: ['.'], session: '?', opened: '?', status: 'OPEN', merged: '-', green: '-', live: '-', renamed: '-', reportFree: '-', ownerWay: '-', closed: null, reason: '', land: null };
      rec.land = { tip: p[4], merge: p[5], brief: p[6] !== '-' ? p[6] : null, report: p[7] !== '-' ? p[7] : null, at: p[8] };
      byLane.set(p[1], rec);
    } else if (p[0] === 'NOTE' && p.length >= 3) {
      const rec = byLane.get(p[1]);
      if (rec) rec.notes = [...(rec.notes ?? []), p[2]];
    } else if (p[0] === 'KIND' && p.length >= 3) {
      // Backfill for a CLOSE row written before the classifier existed. Folds onto the lane's
      // record the same way a CLOSE's own kind field would; a lane with no record yet (its CLOSE
      // line predates this file, or was hand-written) is left alone rather than manufactured.
      const rec = byLane.get(p[1]);
      if (rec) rec.kind = p[2] && p[2] !== '-' ? p[2] : null;
    }
  }
  return [...byLane.values()];
}

/**
 * ORPHANED — an OPEN record with no CLOSE beside it, on a lane that cannot still be running.
 *
 * Measured: a lane finished its work, wrote its report, removed its worktree, deleted its branch
 * and released its claim, and left an OPEN line here with no CLOSE. For the 39 minutes until a
 * human noticed, every card in that repo read as queued behind a lane that no longer existed.
 * Nothing in the system could notice the gap between "report filed" and "close recorded".
 *
 * This is modelled on STALE-CLAIM one layer down, and modelled on it deliberately: that mechanism
 * FLAGS and NEVER BLOCKS, on the stated ground that crashed sessions never come back to clean up
 * after themselves. Same reasoning, same shape, same import — `CLAIM_ACTIVE_HOURS` is imported
 * rather than restated so the two can never drift to different numbers.
 *
 * IT DOES NOT AUTO-WRITE A CLOSE RECORD, and that is the important half. A CLOSE line carries seven
 * gate results; a reconciler that writes one is manufacturing measurements nobody took, which is the
 * exact failure `a skip is not a pass` exists to prevent. It prints the `lane-close` command instead,
 * so the dispatcher runs the real gates.
 *
 * AND IT SAYS `work state UNKNOWN`, NEVER `finished`. A lane whose worktree and branch are both gone
 * might be a session that crashed after merging. Freeing the slot is still the right call — a dead
 * lane holding a repo hostage is the more expensive failure, measured — but the board must never
 * assert a state it did not measure.
 *
 * @param {object} lane        a folded lane record from parseLanes()
 * @param {object} probe       { reportExists, worktreeExists, branchExists, now }
 * @returns {{why:string, headline:string, closeCmd:string}|null}
 */
/**
 * The lane identity two records share when one is a continuation of the other.
 *
 * Lane ids drift by suffix and always have: `hotel2` reopened as `hotel2-b`, `transcripts-l1` as
 * `-l1-b` and `-l1-c`, `foxtrot1` as `foxtrot1-w3a`. Every one of those is the same piece of work
 * on a second pass, and an exact string comparison reads them as five unrelated lanes.
 *
 * The key is the leading run of tokens ending at the LAST token shaped `<word><digits>` — the
 * lane token `naming.mjs` derives from the brief's own filename. Everything after it is a
 * continuation marker and is dropped. An id with no such token is its own key, unchanged.
 *
 * THIS IS NOT FUZZY MATCHING and must never become it. `oscar1` and `fix10` are different tokens and
 * stay different keys; nothing here compares by edit distance or by prefix-of-string, both of which
 * would manufacture the false agreement this router refuses everywhere else.
 */
export function laneKey(id) {
  const parts = String(id ?? '').toLowerCase().split('-').filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^[a-z]+\d+$/.test(parts[i])) return parts.slice(0, i + 1).join('-');
  }
  return parts.join('-');
}

/**
 * CLOSED-UNRENAMED — this brief's lane already closed, and nobody renamed the file.
 *
 * THE DEFECT, measured. The only startup-readable record that work finished is the
 * brief's filename carrying a `consumed-` prefix, and that rename is performed by the most
 * failure-prone actor in the system: the closing lane itself, at the end of its run, often while
 * reporting PARTIAL for an unrelated reason. `board` and `alloc` read filenames, `CLAIMS.md` and
 * `POLICY.md`. Neither has ever read `LANES.md`, which is where the close records are.
 *
 * So a lane that closed on Monday is offered again on Tuesday as though nothing happened. kappa1's
 * own CLOSE record says `renamed=no: ... the next dispatch will fire it again`, and it did.
 *
 * IT FLAGS AND REFUSES, and the two are deliberately the same act: the card carries the verdict so a
 * human reads WHY, and `firesAfter` carries it so `lane-open` refuses without a second mechanism.
 * `--queued` is the escape hatch and the override lands in the ledger, which is the existing
 * behaviour for every other block — nothing new to learn and nothing silently unfireable.
 *
 * THE EXEMPTION IS A DECLARATION, NOT A NAME. A brief carrying `Standing: refire-until-passed`
 * fires however many times it has closed. KAPPA1 is the case that forced it, and special-casing the
 * string "kappa1" would have been the cheap version and the wrong one: the next such brief would
 * have hit the refusal with nothing to say about it.
 *
 * @param {string} laneId   the card's lane id
 * @param {Array}  lanes    folded lane records from parseLanes()
 * @returns {{lane:string, status:string, closed:string, report:string, headline:string}|null}
 */
export function closedUnrenamedVerdict(laneId, lanes = []) {
  const key = laneKey(laneId);
  const hits = lanes
    .filter((l) => l.closed && l.status !== 'OPEN' && laneKey(l.lane) === key)
    .sort((a, b) => String(a.closed).localeCompare(String(b.closed)));
  const last = hits[hits.length - 1];
  if (!last) return null;
  const when = String(last.closed).slice(0, 10);
  const also = hits.length > 1 ? ` (${hits.length} closes on this lane; newest shown)` : '';
  return {
    lane: last.lane,
    status: last.status,
    closed: last.closed,
    report: last.report,
    headline: `CLOSED-UNRENAMED (closed ${when}, status ${last.status}) — lane ${last.lane} filed a CLOSE`
      + ` record in LANES.md and nobody renamed this brief${also}. Read ${last.report} before firing it again.`
      + ` If the work genuinely re-fires every cycle, put \`Standing: refire-until-passed\` in the brief's header.`,
  };
}

/**
 * The CLOSE records inside a window, newest first — the board's "what finished recently" block.
 *
 * This is the startup-readable surface a fresh session never had. It is printed rather than written
 * to a file, on the ratified pattern that anything a session should know at startup goes into the
 * board output: a document has to be found and opened, and the board is already the first thing a
 * dispatch runs.
 */
export function recentCloses(lanes = [], { now = Date.now(), hours = 48 } = {}) {
  return lanes
    .filter((l) => l.closed && l.status !== 'OPEN')
    .map((l) => ({ ...l, closedAt: Date.parse(l.closed) }))
    .filter((l) => !Number.isNaN(l.closedAt) && (now - l.closedAt) / 3_600_000 <= hours)
    .sort((a, b) => b.closedAt - a.closedAt);
}

export function orphanVerdict(lane, probe = {}) {
  if (!lane || lane.status !== 'OPEN') return null;
  const { reportExists = false, worktreeExists = true, branchExists = true, now = Date.now() } = probe;

  // Order matters only for which reason is NAMED, and the most informative one goes first: a report
  // on the bridge is positive evidence the lane got to the end, where a missing worktree is merely
  // evidence it is not there any more.
  let why = null;
  if (reportExists) why = `its declared report ${lane.report} is already on the bridge`;
  else if (!worktreeExists) why = `its worktree ${lane.worktree} does not exist on disk`;
  else if (!branchExists) why = `its branch ${lane.branch} does not exist in the repo`;
  else {
    const opened = Date.parse(lane.opened);
    if (!Number.isNaN(opened) && (now - opened) / 3_600_000 > CLAIM_ACTIVE_HOURS) {
      why = `its OPEN record is older than ${CLAIM_ACTIVE_HOURS}h and no CLOSE was ever written`;
    }
  }
  if (!why) return null;

  return {
    why,
    headline: `ORPHANED, slot freed, work state UNKNOWN — ${why}`,
    closeCmd: `pandoras-router close ${lane.lane}`,
  };
}

// THE PREFIXES A REPORT WEARS ON THE BRIDGE, for the ONE question this file answers about them:
// is the report present, under whatever lifecycle word it now carries. `lane-close.mjs` renames a
// lane's report from the `done-` name recorded at OPEN to `partial-` or `blocked-` when the lane
// does not grade DONE (see `reportNameForStatus` in naming.mjs); a later sweep can also rename it
// `consumed-` once the file has been read and filed. None of that ever touches LANES.md, so the
// name a lane's own record carries is frozen at whatever `lane-open` wrote — almost always a
// `done-` name, because at OPEN time nobody yet knows how the lane will grade.
export const BRIDGE_REPORT_PREFIXES = ['done-', 'partial-', 'blocked-', 'consumed-'];

/**
 * BOARD-1: "NOT on the bridge" was a false alarm on every non-DONE close.
 *
 * Measured 2026-09-06: 17 of 22 closes on one day's board were flagged `(NOT on the bridge)`, and
 * all 17 reports existed — filed correctly under `partial-` or `blocked-`, exactly as
 * `reportNameForStatus` names them. The board's own check was `fs.existsSync` on the literal
 * string LANES.md recorded at OPEN, which is a `done-` name for every lane that has not yet closed
 * DONE. A PARTIAL or BLOCKED close can never match that check, so the alarm fired on the grade,
 * not on a missing file.
 *
 * This checks the recorded name AND each of its prefix swaps, and says WHICH one it found — `board`
 * prints "on the bridge as partial-" instead of a bare pass/fail, so a human reads the grade off the
 * one line rather than opening the file.
 *
 * @param {string} handoffsDir   absolute path to `_handoffs`
 * @param {string} recordedName  the `report` field folded from LANES.md — the name as OPEN wrote it
 * @returns {{found:boolean, prefix:string|null, name:string|null}}
 *   `prefix` is the lifecycle word the file was actually found under (e.g. `'partial-'`), or the
 *   literal recorded name's own prefix when that exact file exists, or `null` when the recorded
 *   name carries no known prefix at all (a legacy or hand-written record) and nothing was found.
 */
export function reportOnBridge(handoffsDir, recordedName) {
  if (!recordedName || recordedName === '?' || recordedName === '-') {
    return { found: false, prefix: null, name: null };
  }
  const had = BRIDGE_REPORT_PREFIXES.find((p) => recordedName.startsWith(p)) ?? null;
  if (fs.existsSync(path.join(handoffsDir, recordedName))) {
    return { found: true, prefix: had, name: recordedName };
  }
  const stem = had ? recordedName.slice(had.length) : recordedName;
  for (const p of BRIDGE_REPORT_PREFIXES) {
    if (p === had) continue;
    const candidate = `${p}${stem}`;
    if (fs.existsSync(path.join(handoffsDir, candidate))) {
      return { found: true, prefix: p, name: candidate };
    }
  }
  return { found: false, prefix: null, name: null };
}
