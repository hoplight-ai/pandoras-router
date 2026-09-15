// @ts-check
// revert.mjs — the pure half of `router revert <lane>`: which merge to reverse, or a refusal
// naming its own fix. No git, no filesystem, so every case here is a unit test.
//
// WHAT THIS COMMAND NEVER DOES, and it is written here first because a command named `revert`
// invites the wrong assumption: IT NEVER FORCE-PUSHES, AND IT NEVER DELETES A BRANCH. A revert is a
// new commit on main that reverses a merge; history is added to, never rewritten. The lane's branch
// and its tip stay exactly where they are, because that tip is the record of what the lane wrote and
// reverting the merge does not make it untrue.
//
// WHY THIS EXISTS. `land.mjs` already writes a LAND record carrying the branch tip and the merge
// sha precisely so a lookup answers "what did this lane put on main, and how do I undo it" — the
// README and the merge message both say the undo is `git revert -m 1 <merge>`. Nobody had made that
// a command, so the undo was typed by hand from a message a human had to find, and typing it
// recorded nothing: the ledger kept reading as though the lane's work was still on main. This file
// is the lookup half of closing that gap; `src/bin/revert.mjs` is the half that runs git and writes
// the REVERT record.

/**
 * Which LAND record to reverse for a lane, or a refusal naming its own fix.
 *
 * @param {string} laneId
 * @param {Array<{lane:string, repo?:string, branch?:string, land?:{tip:string,merge:string,brief?:string|null,report?:string|null,at?:string}|null, landCount?:number, revert?:{merge:string,commit:string,who:string,at:string}|null}>} lanes
 *   folded records — normally `readLanes()`/`parseLanes()` from lanes.mjs, but any object shaped
 *   this way works, since this function reads no file itself.
 *
 * The shape is uniform on purpose — `ok`, `why` and every plan field are always present, null when
 * they do not apply — the same convention `lib/land.mjs`'s `landRefusal` uses. A true discriminated
 * union (`{ok:true,...}|{ok:false,why}`) does not narrow cleanly through this repo's `@ts-check`
 * once a caller does `if (!x.ok) return x;`, so nothing here relies on it.
 *
 * @returns {{ok:boolean, why:string|null, lane:string, repo:string|null, branch:string|null, merge:string|null, tip:string|null, brief:string|null, report:string|null}}
 */
export function planRevert(laneId, lanes = []) {
  const empty = { lane: laneId, repo: null, branch: null, merge: null, tip: null, brief: null, report: null };
  const rec = lanes.find((l) => l.lane === laneId);
  if (!rec) {
    return {
      ok: false,
      why: `no lane "${laneId}" appears in the ledger at all. Check the id against _handoffs/_lanes/LANES.md — a lane id is matched exactly, never fuzzily.`,
      ...empty,
    };
  }
  if (!rec.land) {
    return {
      ok: false,
      why: `lane "${laneId}" has no LAND record, so it never landed on main and there is nothing to reverse. If it was merged by hand, run \`pandoras-router land ${laneId} --record <merge sha>\` first so the ledger carries the link.`,
      ...empty,
      repo: rec.repo ?? null,
      branch: rec.branch ?? null,
    };
  }
  const landCount = rec.landCount ?? 1;
  if (landCount > 1) {
    return {
      ok: false,
      why: `lane "${laneId}" has ${landCount} LAND records, so which one to reverse is a person's decision. Read every LAND line for this lane in _handoffs/_lanes/LANES.md and revert the right merge by hand: git -C ${rec.repo ?? '<repo>'} revert -m 1 <merge sha>.`,
      ...empty,
      repo: rec.repo ?? null,
      branch: rec.branch ?? null,
    };
  }
  if (rec.revert) {
    return {
      ok: false,
      why: `lane "${laneId}" already has a REVERT record, written ${rec.revert.at}. It was undone already; reverting a revert is not this command's job — see "not in scope" in the brief.`,
      ...empty,
      repo: rec.repo ?? null,
      branch: rec.branch ?? null,
    };
  }
  return {
    ok: true,
    why: null,
    lane: laneId,
    repo: rec.repo ?? null,
    branch: rec.branch ?? null,
    merge: rec.land.merge,
    tip: rec.land.tip,
    brief: rec.land.brief ?? null,
    report: rec.land.report ?? null,
  };
}

/**
 * The two repository-state refusals before any write happens, checked before a merge shape is even
 * asked about. Wording matched to the landing refusals in `lib/land.mjs` (`onMain`, `dirty`) on
 * purpose, so a dispatcher reads one vocabulary across `land` and `revert`, not two. Pure: it takes
 * the already-measured state and calls no git and touches no filesystem itself, same as
 * `landRefusal` does.
 *
 * @param {{onMain:boolean, dirty:number, repo:string}} p
 * @returns {{ok:boolean, why:string|null}}
 */
export function repoStateRefusal({ onMain, dirty, repo }) {
  if (!onMain) {
    return {
      ok: false,
      why: `${repo}'s own checkout is not on main. A revert commits INTO main from the repo's own working copy; check out main there first (never from inside a lane worktree, which this session must not stand in either).`,
    };
  }
  if (dirty > 0) {
    return {
      ok: false,
      why: `${repo}'s main checkout has ${dirty} uncommitted change(s). A revert commit on a dirty tree mixes someone's half-finished edit into the revert. Commit or stash it first, or find out whose it is.`,
    };
  }
  return { ok: true, why: null };
}

/**
 * The first-parent rule (`git revert -m 1`) only means anything on a real merge: refuse unless the
 * named commit has two parents. Pure: `parentCount` is measured elsewhere
 * (`git rev-list --parents -n1 <sha>`, the same shape `lane-land.mjs --record` already uses).
 *
 * @param {{merge:string, parentCount:number}} p
 * @returns {{ok:boolean, why:string|null}}
 */
export function mergeShapeRefusal({ merge, parentCount }) {
  if (parentCount < 2) {
    return {
      ok: false,
      why: `${merge} is not a merge commit (${Math.max(0, parentCount)} parent(s)). \`git revert -m 1\` only means anything on a real merge — the first-parent rule has nothing to select on anything else.`,
    };
  }
  return { ok: true, why: null };
}

/**
 * The argument array `git revert` is spawned with — never a string a shell re-parses. The caller
 * prepends `-C <repoDir>` and spawns with `shell: false`, the same discipline `src/lib/build.mjs`
 * uses to run npm.
 *
 * @param {string} merge
 * @returns {string[]}
 */
export function revertArgs(merge) {
  return ['revert', '-m', '1', merge];
}
