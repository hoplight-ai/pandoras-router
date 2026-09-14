// open.mjs — the lane-open decisions that involve no git and no writes, so they can be tested.
//
// WHY THIS FILE EXISTS. `lane-alloc` offers cards for the workspace root, and `lane-open` refused
// every one of them, because it assumed the card's target is a git repository and tried to add a
// worktree to it. Root is not a git repository and never will be. Two separate lanes hit this on
// the same day, both worked around it by writing the claim by hand, and both filed it as a defect
// nobody owned. Several root cards were queued behind it at the time.
//
// The fix is not to make root a repo. It is to admit that a lane has two shapes:
//
//   worktree   the target is a git repository. A branch and a checkout are created, and the lane
//              works inside the checkout. This is every product lane.
//   in-place   the target is not a git repository. No branch, no checkout, nothing to create — the
//              lane works in the target directory itself and the ledger says so. Nothing here is
//              recoverable by commit, which is exactly why the OPEN record must exist.

// CLAIM_ACTIVE_HOURS is IMPORTED, never restated: the removal remedy waits until the board
// itself has stopped counting the claim as a writer, and the two must not drift apart.
import { CLAIM_ACTIVE_HOURS } from './claims.mjs';

/**
 * Below this, a claim CANNOT be diagnosed as a crashed session and no removal remedy is printed.
 *
 * A crashed session's claim is old by definition; a live session's is new. That asymmetry is the
 * whole safety win, and it does not depend on identity at all — which matters, because identity
 * cannot separate two sessions of one lane (see the note on `mine` below).
 *
 * Twenty minutes, and the number is not arbitrary: `CLAIMS.md`'s own header states the window this
 * file exists to cover — "a session can be open and mid-read for twenty minutes before its first
 * edit, and git cannot see it". That is exactly the interval where the worktree is clean, nothing
 * has been touched, and a live session looks identical to a dead one.
 */
export const FRESH_CLAIM_MINUTES = 20;

/** A file written this recently means somebody is at the keyboard, whatever the claim's age says. */
export const RECENT_TOUCH_MINUTES = 10;

/**
 * lane-open's refusal when a card is queued behind an active claim.
 *
 * TWO GENERATIONS OF FIX LIVE HERE AND BOTH REASONS STILL BIND.
 *
 * First: the message used to say only "QUEUED behind <prose>", which could not tell "another session
 * is writing here" from "you are already holding this". A refusal that cannot name the holder is
 * noise, and lanes learn to --queued straight past it — test1's own OPEN record carries an OVERRIDE
 * against a claim that had already closed.
 *
 * Second (Ops BETA2, 2026-08-24): the answer it then gave to the second case was WRONG and its
 * remedy was destructive. It asserted "this is the same lane ... a previous run did not stop clean"
 * and told the reader to delete the claim line — against a peer that was mid-edit twenty seconds in.
 * The refusal itself was correct and is unchanged; only the diagnosis and the remedy were wrong, so
 * nothing here is softened and no override flag was added.
 *
 * @param {number} ageH            how old the blocking claim is
 * @param {number|null} worktreeDirty   dirty file count in the holder's worktree; null = unmeasured
 * @param {number|null} newestTouchMin  minutes since the newest write under it; null = unmeasured
 */
export function openRefusal({ blockingChat, blockingSession, myChat, mySession, ageH, worktreeDirty, newestTouchMin }) {
  // `mine` NO LONGER MEANS "this is the same lane" AND MUST NOT BE READ THAT WAY. It means an active
  // claim carries the same lane identity as the card being opened. Two dispatch sessions with the
  // same title running the same lane produce BYTE-IDENTICAL claim lines — `dispatch-lane-quebec1` is
  // derived from the lane, not from the session — so the two cases are indistinguishable here and no
  // matching logic on these fields can separate them. Measured; see the same-title block in
  // router-test.mjs for the timeline.
  const mine = Boolean(mySession && blockingSession && mySession === blockingSession)
    || Boolean(myChat && blockingChat && myChat === blockingChat && !blockingSession);
  const age = `${Math.round(ageH * 10) / 10}h`;
  const who = `the blocking claim is "${blockingChat}"${blockingSession ? ` [${blockingSession}]` : ''}, opened ${age} ago`;

  // How to tell the two cases apart, printed instead of the assertion that used to be made for you.
  const howToTell = `\n  An active claim names THIS lane. That is either your own earlier run that did not stop`
    + `\n  clean, or a second session with the same title running the same lane — and those two write`
    + `\n  identical claim lines, so this tool cannot tell them apart for you. To tell them apart:`
    + `\n    - look for a peer session with this title (ListAgents, or the session list)`
    + `\n    - read _handoffs/_lanes/LANES.md for an OPEN record with no CLOSE`
    + `\n    - look at the lane's worktree yourself: git status --short, and the newest file mtime`;

  // The remedy that can destroy another lane's work. Printed ONLY in the one shape where "a previous
  // run did not stop clean" is a fair reading: an old claim, a clean worktree, and nothing touched
  // recently. Everything else — including anything unmeasured — is treated as a live writer.
  const remedy = `\n  If it IS your own dead run: close the old lane (pandoras-router close <lane> --apply)`
    + `\n  or remove its line from _handoffs/_lanes/CLAIMS.md.`;

  if (mine) {
    const stop = (why) => ({
      mine: true,
      live: true,
      message: `STOP — ${who}.\n  ${why}${howToTell}`,
    });

    // 1. THE AGE GATE, and it is the whole safety win. Nothing this young can be a crashed session.
    if (ageH * 60 < FRESH_CLAIM_MINUTES) {
      return stop(`It is less than ${FRESH_CLAIM_MINUTES} minutes old, so SOMEBODY MAY BE WRITING RIGHT NOW.`
        + `\n  A crashed session's claim is old; this one is not. No removal remedy is offered at this age,`
        + `\n  deliberately — taking one here is how two sessions end up writing one file.`);
    }
    // 2. LOOK BEFORE ADVISING. A dirty worktree is a writer at any age.
    if (typeof worktreeDirty === 'number' && worktreeDirty > 0) {
      return stop(`Its worktree has ${worktreeDirty} dirty file(s). That is a live writer, not a crashed session.`);
    }
    // 3. A file written in the last few minutes is the same signal one step earlier.
    if (typeof newestTouchMin === 'number' && newestTouchMin <= RECENT_TOUCH_MINUTES) {
      return stop(`A file under its worktree was touched ${Math.round(newestTouchMin)} minute(s) ago. That is a live writer.`);
    }
    // 4. UNMEASURED IS NOT CRASHED. Same direction as every other unmeasured case in this router.
    if (worktreeDirty === null || worktreeDirty === undefined) {
      return stop(`Its worktree could not be read, so whether anyone is writing is UNMEASURED.`
        + `\n  Unmeasured is not "crashed", so no removal remedy is offered.`);
    }
    // 5. QUIET IS NOT DEAD while the board still counts the claim as active.
    //
    // Found by running this against a live lane rather than a fixture: claim 1h old, worktree
    // clean, nothing touched for 58 minutes, and the first version handed over the removal remedy.
    // A lane in a long read-and-analyse phase looks exactly like that. Zero commits is a lane's
    // expected first-phase state; a claim is never released on quiet-worktree evidence alone.
    //
    // So the remedy waits for the board to have given up first. Under CLAIM_ACTIVE_HOURS a claim is
    // ACTIVE and blocking; over it the board already prints STALE-CLAIM and stops counting it as a
    // writer. Sharing the constant means this tool can never contradict the board.
    if (ageH <= CLAIM_ACTIVE_HOURS) {
      return {
        mine: true,
        live: null,
        message: `An active claim names this lane — ${who}.`
          + `\n  Its worktree is quiet: clean, and nothing touched for ${Math.round(newestTouchMin ?? 0)} minute(s).`
          + `\n  QUIET IS NOT DEAD. A lane reading and analysing before its first edit looks exactly like`
          + `\n  this, and the board still counts this claim as an active writer for another`
          + `\n  ${Math.max(0, Math.round((CLAIM_ACTIVE_HOURS - ageH) * 10) / 10)}h. No removal remedy at this age — message that session and ask.`
          + `${howToTell}`,
      };
    }

    // 6. The genuine crashed-session shape, and the only one that gets the remedy: past the age the
    //    board itself calls STALE, clean worktree, nothing touched.
    return {
      mine: true,
      live: false,
      message: `An active claim names this lane — ${who}.`
        + `\n  It is past ${CLAIM_ACTIVE_HOURS}h, so the board already reads it as STALE-CLAIM and stops counting it`
        + `\n  as a writer. Its worktree is clean and nothing under it has been touched for`
        + `\n  ${Math.round(newestTouchMin ?? 0)} minute(s), so this looks like a run that did not stop clean.`
        + `${howToTell}${remedy}`,
    };
  }
  return {
    mine: false,
    message: `ANOTHER SESSION holds this repo: "${blockingChat}"`
      + `${blockingSession ? ` [${blockingSession}]` : ' [no session field, so it cannot be told apart from any other run of that lane]'}`
      + `, opened ${age} ago.`
      + `\n  Opening anyway puts two writers in one repo. If that is deliberate, re-run with --queued`
      + `\n  and the override goes in the ledger with this holder named.`,
  };
}

/**
 * OPEN IS A COMPARE-AND-SET (CONC1, 2026-09-14).
 *
 * THE DEFECT. lane-open ran the allocator, found its card firing now, and wrote the claim and the OPEN
 * row, with nothing between the allocator's read and the write. Two dispatchers opening overlapping
 * lanes at the same moment each read a board without the other, each got a card that fired now, and
 * both wrote. Measured by concurrency-test.mjs against the unlocked code: two opens, two exits 0, two
 * active claims, two OPEN rows for one lane.
 *
 * THE REPAIR is that lane-open re-reads the claims and the ledger INSIDE the state lock, re-runs the
 * allocator's own decision against them (`decide` in lane-alloc.mjs, which uses the same
 * `scopesIntersect` every card was built with), and passes both cards here. Nothing is written unless
 * this says ok, and the write happens in the same locked section, so the board cannot move between
 * the check and the write.
 *
 * THE REFUSAL IS IN THE ALLOCATOR'S OWN WORDS: `why` carries the re-read card's `firesAfter` verbatim,
 * which is the sentence `alloc` would print for that card now. A second vocabulary for the same
 * condition would be one more thing to drift.
 *
 * `--queued` OVERRIDES ONLY THE REASON THE DISPATCHER WAS SHOWN. A dispatcher who read "queued behind
 * X" and chose to open anyway made that decision about X. If the re-read says queued for a DIFFERENT
 * reason (a lane that opened in the seconds between), that decision was never made, and it refuses.
 *
 * Pure: no disk, no git, no lock. The caller holds the lock.
 *
 * @param {object} o
 * @param {object} o.card        the card the dispatcher was shown (first read)
 * @param {object|null} o.freshCard  the same brief's card from the re-read under the lock, or null
 * @param {boolean} o.queued     was --queued passed
 * @returns {{ok:boolean, why:string|null, blockedBy:object|null}}
 */
export function openCasVerdict({ card, freshCard, queued }) {
  if (!freshCard) {
    return {
      ok: false,
      why: `the card for ${card?.brief ?? 'this brief'} is gone on the re-read under the lock: the board moved between the allocator's read and this open. Run: pandoras-router alloc --limit 99`,
      blockedBy: null,
    };
  }
  if (!freshCard.firesAfter) return { ok: true, why: null, blockedBy: null };
  if (queued && card?.firesAfter && card.firesAfter === freshCard.firesAfter) {
    return { ok: true, why: null, blockedBy: freshCard.blockedBy ?? null };
  }
  return { ok: false, why: freshCard.firesAfter, blockedBy: freshCard.blockedBy ?? null };
}

export const IN_PLACE = 'in-place';
export const WORKTREE = 'worktree';

/**
 * RESUME — a PARTIAL lane picking its own checkout back up, inside the machinery.
 *
 * THE DEFECT. `lane-open` hard-refuses when the checkout directory exists, and a PARTIAL close
 * deliberately LEAVES the checkout — removing a worktree is a destructive act the close is not
 * allowed to take on anything short of a full pass. Those two correct rules compose into a wall:
 * every retry of a partial lane exits the machinery and is stitched together by hand. Counted over
 * four days on one board: nine hand-stitched resumes across seven lanes. Each hand-stitch writes
 * its own claim line, and the ones that forgot to write an OPEN row alongside it made the repo
 * read single-occupancy for an hour.
 *
 * WHAT MAKES THIS SAFE, and it is one fact: an existing directory whose lane's LAST close was
 * PARTIAL is a checkout the machinery itself left behind. Every other existing directory is
 * unexplained, and unexplained stays a hard refusal — the collision the refusal was built for is
 * untouched. In particular a lane with a live OPEN row and no CLOSE is NOT resumable: that is a lane
 * that may still be running, and the fact its folder exists proves nothing about whether a session
 * is inside it.
 *
 * @param {object} o
 * @param {boolean} o.checkoutExists   does the checkout directory exist
 * @param {object|null} o.lane         the folded ledger record for this lane, or null
 * @returns {{resume:boolean, why:string}}
 */
export function resumeVerdict({ checkoutExists, lane }) {
  if (!checkoutExists) return { resume: false, why: 'the checkout does not exist, so this is an ordinary open' };
  if (!lane) {
    return { resume: false, why: 'the checkout exists and NO ledger record explains it. Unexplained is a collision, not a resume.' };
  }
  if (lane.status === 'OPEN') {
    return { resume: false, why: `lane ${lane.lane} has an OPEN record with no CLOSE. It may still be running, and its folder existing proves nothing either way. Read _handoffs/_lanes/LANES.md.` };
  }
  if (lane.status !== 'PARTIAL') {
    return { resume: false, why: `lane ${lane.lane} closed ${lane.status}, not PARTIAL. Only a PARTIAL close is documented to leave its checkout behind; anything else existing is unexplained.` };
  }
  return {
    resume: true,
    why: `lane ${lane.lane} closed PARTIAL at ${lane.closed} and the close correctly left its checkout standing (removing a worktree is a destructive act the close does not take on its own). Resuming on the existing branch ${lane.branch}.`,
  };
}

/**
 * @param {{repo:string, branch:string, checkout:string, repoIsGit:boolean}} card
 * @returns {{mode:string, branch:string|null, worktree:string|null, why:string}}
 */
export function laneOpenPlan({ repo, branch, checkout, repoIsGit }) {
  if (repoIsGit) {
    return { mode: WORKTREE, branch, worktree: checkout, why: `${repo} is a git repository` };
  }
  return {
    mode: IN_PLACE,
    branch: null,
    worktree: null,
    why: `${repo} is not a git repository, so there is no branch to cut and no worktree to add. The lane works in ${repo} itself and the OPEN record is the only trace it leaves — nothing written there is recoverable by commit.`,
  };
}
