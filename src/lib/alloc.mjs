// @ts-check
// alloc.mjs — the allocation decision, with no filesystem and no git in it.
//
// Everything that decides which lanes may fire together lives here so it can be unit-tested against
// fixtures. `the allocator` is the shell that reads the disk and prints the cards; it makes
// no decisions of its own. The rule that matters:
//
//   TWO LANES MAY RUN IN ONE REPO ONLY WHEN THEIR DECLARED FILE SCOPES HAVE ZERO INTERSECTION.
//
// and when a scope is not declared, the scope is the whole repo. Undeclared never means "probably
// fine" — it means the lane serializes. Over-reporting overlap costs a wait; under-reporting it
// costs somebody's work.

import { WHOLE_REPO, normalizeScope, scopesIntersect, applyExclusive } from './scope.mjs';
import { activeWriters } from './claims.mjs';
import { ROOT_LABEL, notBeforeVerdict, modelIdFor, compareBriefOrder, orderRuleOf, refiresAfterClose, isExternalLane, EXTERNAL_LABEL } from './briefs.mjs';
import { ROOT_KEY } from './root.mjs';
import { closedUnrenamedVerdict } from './lanes.mjs';
import { laneIdFor, slugFor, branchFor, worktreeFor, sessionIdFor, reportFor, todayLocal } from './naming.mjs';

/**
 * @param {object} o
 * @param {Array} o.briefs        parsed briefs, live only
 * @param {object} o.policy       from loadPolicy()
 * @param {Array}  o.claims       claim rows
 * @param {Map}    [o.repoState]  repo -> { dirty, exists }
 * @param {Set}    [o.existingReports]  report filenames already on the bridge
 * @param {Array}  [o.openLanes]  OPEN records from LANES.md, which is the only place an active
 *                                lane's file scope is written down; a claim line has no such field.
 * @param {Array}  [o.closedLanes] the SAME folded ledger, read for its CLOSE records. Defaults to
 *                                `openLanes` because `readLanes` returns one array holding both, and
 *                                a second read of one file is a second chance for the two to
 *                                disagree. Named separately so the two uses are legible.
 * @param {Set<string>} [o.orphanedLanes]  lane names the caller judged orphaned; they hold no scope
 * @param {number} [o.limit]
 * @param {string|null} [o.as]    this dispatch's name, for OWNED-ELSEWHERE
 * @param {string|null} [o.seat]  this dispatch's bare seat name, matched to POLICY.md's dispatch column
 * @param {string} o.date         YYYY-MM-DD
 */
export function allocate({ briefs, policy, claims, repoState = new Map(), existingReports = new Set(), openLanes = [], closedLanes = openLanes, orphanedLanes = new Set(), limit = 8, as = null, seat = null, date }) {
  // session id -> declared scope, for claims we can actually reason about.
  //
  // AN ORPHANED LANE IS EXCLUDED HERE, which is how "does not hold its scope" is implemented. The
  // caller decides orphanhood (it needs the filesystem and git, which this module deliberately
  // cannot touch) and passes the lane names in. A lane left OPEN with no CLOSE otherwise holds its
  // declared scope forever: a finished lane that removed its worktree, deleted its branch and
  // released its claim still blocks the repo until somebody writes its CLOSE row.
  const scopeOfSession = new Map(
    openLanes
      .filter((l) => l.status === 'OPEN' && l.session && !orphanedLanes.has(l.lane))
      // `l.declaredNone` is the ledger's `-`, decoded: a lane that declared it writes nothing. Its
      // scope is genuinely empty and must stay empty. A merely BLANK scope field is unknown and still
      // widens to the whole repo, which is right for the 64 rows written before scopes existed.
      .map((l) => [l.session, l.declaredNone ? [] : (l.scope?.length ? l.scope : [WHOLE_REPO])]),
  );
  // Claim sessions belonging to orphaned lanes, so a dead lane's claim stops holding a slot too.
  const orphanSessions = new Set(
    openLanes.filter((l) => orphanedLanes.has(l.lane) && l.session).map((l) => l.session),
  );
  const cards = [];
  const skipped = [];
  // Briefs the limit cut off. They are COUNTED, never silently dropped: a burst of new briefs in
  // one repo pushes every other repo's card past the default limit of 8, and a board that lists a
  // brief the allocator did not card while SKIPPED reads 0 is lying by omission. A work queue that
  // truncates without saying so reads as "there is nothing for you to do".
  const truncated = [];
  const emittedByRepo = new Map();

  // Tier first, then the brief's OWN sort key — `Priority:`, else `Filed:`, else mtime. Until
  // 2026-08-24 the only tiebreaker was mtime, so editing a brief moved it to the back of the queue
  // and the printed order was last-touched time dressed as judgement. See compareBriefOrder.
  const ordered = [...briefs].sort((a, b) => {
    const ta = tierOf(policy, a), tb = tierOf(policy, b);
    if (ta !== tb) return ta - tb;
    return compareBriefOrder(a, b);
  });

  for (const brief of ordered) {
    if (cards.length >= limit) {
      truncated.push({ file: brief.file, targets: brief.targets ?? [] });
      continue;
    }

    if (!brief.targets?.length) {
      skipped.push({ brief, why: 'PARSE-FAIL', detail: missingFolderLine(brief) });
      continue;
    }
    // The board's label for the root is human-facing; the policy table keys it on ROOT_KEY.
    const targets = brief.targets.map((t) => (t === ROOT_LABEL ? ROOT_KEY : t));
    const repo = targets.find((t) => policy.repos.has(t)) ?? targets[0];
    const rp = policy.repos.get(repo);
    if (!rp) {
      skipped.push({ brief, repo, why: 'NO-POLICY', detail: `"${repo}" is not in the repos table of _handoffs/_lanes/POLICY.md, so its deploy style and verification method are unknown. The router does not guess either one. Add a row, then re-run.` });
      continue;
    }
    // SEAT MEMBERSHIP, the durable half.
    //
    // Deliberately separate from the `ownership` table, which is a SAME-DAY handoff and matches the
    // dated `--as` string exactly. That table cannot carry durable ownership: a value written there
    // goes stale overnight and produces a FALSE OWNED-ELSEWHERE, so the dispatcher that really owns
    // the repo skips its own work.
    //
    // `seat` is a bare seat name with no date in it, so it cannot go stale the same way. OPT-IN: a
    // caller that passes no seat gets exactly the old behaviour.
    if (seat && rp.dispatch && rp.dispatch !== seat) {
      skipped.push({ brief, repo, why: 'OWNED-ELSEWHERE', detail: `${repo} belongs to the "${rp.dispatch}" dispatch; you are "${seat}". Seat membership is the dispatch column in POLICY.md.` });
      continue;
    }
    if (as && rp.owner && rp.owner !== as) {
      skipped.push({ brief, repo, why: 'OWNED-ELSEWHERE', detail: `${repo} is held by dispatch "${rp.owner}" for this session; you are "${as}".` });
      continue;
    }

    const lane = laneIdFor(brief.file);
    const slug = slugFor(brief.file);
    const scopeDeclared = brief.scope !== null && brief.scope !== undefined;
    // `Touches: none` — a lane that writes no repo file. Its scope is genuinely empty, which
    // intersects nothing, so it neither blocks nor is blocked. Distinguished HERE from a scope that
    // merely normalized away to empty (every token named some other repo), which still falls back to
    // the whole repo because that is the safe reading of a declaration this repo cannot use.
    const declaredNone = scopeDeclared && brief.scope.length === 0;
    const scope = scopeDeclared ? normalizeScope(brief.scope, repo) : [WHOLE_REPO];
    const declaredScope = declaredNone ? [] : (scope.length ? scope : [WHOLE_REPO]);

    // EXCLUSIVE PATHS (2026-08-22, AMENDED 2026-08-24). A scope touching one of the repo's
    // exclusive paths (global machinery: migrations, deploy-all edge functions, package.json) is
    // widened FOR COMPARISON ONLY — and it is widened TO THAT PATH, not to the whole repo. Two
    // lanes inside one exclusive directory therefore serialize against each other; two lanes in
    // DIFFERENT exclusive directories share no hazard and still run in parallel, and a lane clear
    // of the list is untouched. See applyExclusive in lib/scope.mjs and the three RED-PROOF
    // exclusive assertions in router-test.mjs, which were amended the same day.
    //
    // The card still prints the declared scope; the widening is named on the card so the "fires
    // after" line explains itself.
    const exclusiveSet = normalizeScope(rp.exclusive ?? [], repo);
    const guarded = applyExclusive(declaredScope, exclusiveSet);
    const effScope = guarded.scope;

    // A claim whose lane is ORPHANED is a dead hand: the lane wrote its report and stopped, or its
    // worktree and branch are gone. It is flagged on the card and it no longer holds a writer slot.
    const held = activeWriters(claims, repo).filter((c) => !orphanSessions.has(c.session));
    const mine = emittedByRepo.get(repo) ?? [];
    let firesAfter = null;
    // The blocking claim as DATA, not just prose. lane-open needs the holder's identity to tell
    // "another session is writing here" from "you never released your own claim", which are the
    // two cases its refusal could not distinguish.
    let blockedBy = null;

    // 0. DATE GATE, before every other reason. A brief carrying `Not-Before: YYYY-MM-DD` is held
    // until that day, and the card says so. It stays VISIBLE and carded the whole time, which is
    // the point: `parked-` would also hold it, but a parked brief routes nothing and so vanishes
    // from the board on exactly the day somebody needs to see it.
    // `date` is the caller's YYYY-MM-DD, already threaded through for the report filenames. Using it
    // rather than a live clock keeps this function pure and testable, which is the stated point of
    // this whole module.
    // `todayLocal`, never `toISOString().slice(0,10)`: UTC rolls over at 20:00 ET, so a live-clock
    // UTC fallback opened every Not-Before hold up to five hours early. See naming.mjs.
    const nbToday = date ?? todayLocal();
    const nb = notBeforeVerdict(brief.notBefore, nbToday);
    if (nb === 'UNREADABLE') {
      firesAfter = `Not-Before: "${brief.notBefore}" is not a readable YYYY-MM-DD date — HELD until it is fixed`;
    } else if (nb) {
      firesAfter = `Not-Before ${nb} (today is ${nbToday})`;
    }

    // 0b. THE CLOSE LEDGER, before capacity and before scope. A brief whose lane already filed a
    // CLOSE record is finished work wearing a live filename, and the queue reasons below would
    // describe it as merely waiting for a slot — which is the wrong sentence entirely. The verdict
    // is carried on the card AND in `firesAfter`, so `lane-open`'s existing refusal covers it with
    // no second mechanism and `--queued` remains the recorded override.
    //
    // A brief that declares `Standing: refire-until-passed` is exempt and the card says so, because
    // "this one is allowed" is a fact the next dispatcher will otherwise re-derive from the brief.
    const closedBefore = closedUnrenamedVerdict(lane, closedLanes);
    const standingRefire = refiresAfterClose(brief.standing);
    if (closedBefore && !standingRefire && !firesAfter) firesAfter = closedBefore.headline;

    // 1. Capacity next, counting claims already held plus cards already emitted to run NOW.
    //    A lane that declared `Touches: none` is NOT a writer and does not consume a slot — it is the
    //    whole point of the declaration. Without this, LEAP-L7b would still hold five repos at
    //    writers:1 while writing nothing, which is the defect the declaration exists to fix.
    const heldWriters = held.filter((c) => (scopeOfSession.get(c.session) ?? [WHOLE_REPO]).length > 0);
    const concurrentMine = mine.filter((c) => !c.firesAfter && (c.guardScope ?? [WHOLE_REPO]).length > 0).length;
    if (!firesAfter && !declaredNone && heldWriters.length + concurrentMine >= rp.writers) {
      const blocker = mine[mine.length - 1];
      firesAfter = heldWriters.length
        ? `active claim "${heldWriters[0].chat}" [${heldWriters[0].session || 'no session field'}] (repo capacity ${rp.writers})`
        : `lane ${blocker.lane} (repo capacity ${rp.writers})${undeclaredCause(scopeDeclared, lane, blocker)}`;
      if (heldWriters.length) blockedBy = { chat: heldWriters[0].chat, session: heldWriters[0].session ?? null, ageH: heldWriters[0].ageH ?? 0 };
    }

    // 2. A slot is free, but a held claim may still overlap this scope. A claim line has no scope
    //    field, so the scope comes from that session's OPEN record in LANES.md; a claim with no
    //    OPEN record is treated as holding the whole repo, which serializes. Undeclared never means
    //    "probably fine". A held lane whose scope touches an exclusive path is widened the same way
    //    this lane's is — exclusivity binds in both directions.
    if (!firesAfter) {
      for (const h of held) {
        const hs = applyExclusive(scopeOfSession.get(h.session) ?? [WHOLE_REPO], exclusiveSet).scope;
        const x = scopesIntersect(effScope, hs);
        if (x.intersects) {
          blockedBy = { chat: h.chat, session: h.session ?? null, ageH: h.ageH ?? 0 };
          firesAfter = scopeOfSession.has(h.session)
            ? `active claim "${h.chat}" — scopes overlap at ${x.pairs.slice(0, 3).map(([p, q]) => (p === q ? p : `${p} ~ ${q}`)).join(', ')}`
            : `active claim "${h.chat}" [${h.session || 'no session field'}] — it has no OPEN record in LANES.md, so its file scope is unknown and reads as the whole repo`;
          break;
        }
      }
    }

    // 3. Scope intersection against every card already emitted to run NOW in this repo, using the
    //    widened (guard) scopes so an exclusive lane blocks and is blocked correctly.
    if (!firesAfter) {
      for (const other of mine.filter((c) => !c.firesAfter)) {
        const x = scopesIntersect(effScope, other.guardScope ?? other.scope);
        if (x.intersects) {
          // The overlap is named the same way in both branches, because the dispatcher's next
          // question is always "overlap WHERE". The exclusive branch adds only what is different
          // about it: neither lane declared that path, the guard widened them onto it.
          //
          // CORRECTED 2026-08-25 (Gov-ETA1's own named remainder). This read "an exclusive
          // path is involved, which requires sole occupancy of the repo", which survived the
          // 2026-08-24 narrowing and overstated what the code does by a whole repo. A dispatcher
          // reading it would serialize lanes that applyExclusive lets run in parallel — two lanes
          // in different exclusive directories, for instance. The exclusivity is asserted against
          // the exclusive SET rather than against `guarded.widened`, so a pair that was widened
          // but collides somewhere else is described by where it actually collides.
          const overlap = x.pairs.slice(0, 3).map(([p, q]) => (p === q ? p : `${p} ~ ${q}`)).join(', ');
          const onExclusive = x.pairs.some(([p, q]) => exclusiveSet.includes(p) || exclusiveSet.includes(q));
          const why = onExclusive
            ? `scopes overlap at the EXCLUSIVE path ${overlap} — global machinery both lanes would write, so they serialize AT THAT PATH. The rest of ${repo} stays open to other lanes`
            : `scopes overlap at ${overlap}`;
          firesAfter = `lane ${other.lane} — ${why}${undeclaredCause(scopeDeclared, lane, other)}`;
          break;
        }
      }
    }

    let report = reportFor(date, repo, lane, slug);
    let reportTaken = false;
    if (existingReports.has(report)) {
      reportTaken = true;
      let n = 2;
      while (existingReports.has(report.replace(/\.md$/, `-${n}.md`))) n++;
      report = report.replace(/\.md$/, `-${n}.md`);
    }

    const card = {
      lane,
      brief: brief.file,
      repo,
      tier: rp.tier,
      checkout: worktreeFor(repo, lane),
      branch: branchFor(lane, slug),
      session: sessionIdFor(lane),
      report,
      reportTaken,
      port: rp.port,
      model: brief.model ?? null,
      modelId: modelIdFor(brief.model),
      deploy: rp.deploy,
      verify: rp.verify,
      url: rp.url,
      traps: rp.traps,
      // `scope` stays the DECLARED scope: it is what lane-open writes into the OPEN record and what
      // gate 7 (in-scope) later enforces. `guardScope` is the widened scope used only for the
      // serialization comparisons above; the two differ only when an exclusive path is involved.
      scope: declaredScope,
      guardScope: effScope,
      exclusiveHits: guarded.hits,
      scopeDeclared,
      firesAfter,
      blockedBy,
      // The close-ledger cross-check, carried whether or not it blocked. An exempted brief still
      // prints "it closed on the 25th and fires anyway", which is the line a dispatcher needs in
      // order to trust the exemption rather than wonder whether the check ran.
      closedBefore,
      standingRefire,
      runsBeside: brief.runsBeside,
      // WHICH ORDERING RULE PUT THIS CARD HERE. Printed on the card so a dispatcher reading FIRE NOW
      // can see whether it is a stated priority or just the last file somebody typed in.
      order: orderRuleOf(brief),
      dirtyMain: repoState.get(repo)?.dirty ?? null,
    };
    cards.push(card);
    emittedByRepo.set(repo, [...mine, card]);
  }

  return { cards, skipped, truncated };
}

/**
 * Name the undeclared scope AT THE POINT OF BLOCKAGE, when it is the reason.
 *
 * A brief with no `Touches:` line silently becomes the most expensive declaration there is: the
 * whole repo. Measured on one board, that was half the cards queued behind lanes that had declared
 * nothing. The obvious fix — more dispatchers, or higher `writers` caps — fires ZERO extra cards,
 * because every pair of those lanes intersects at `.` whatever the cap says. So the per-card
 * `UNDECLARED` note is not enough: it is read by the lane, and the person who needs it is whoever
 * is wondering why nothing fires. Put the cause in the queue reason itself.
 */
export function undeclaredCause(scopeDeclared, lane, blocker) {
  const who = [];
  if (!scopeDeclared) who.push(`this lane (${lane})`);
  if (blocker && blocker.scopeDeclared === false) who.push(`lane ${blocker.lane}`);
  if (!who.length) return '';
  return `; ${who.join(' and ')} declares no scope, so it holds the whole repo`;
}

function tierOf(policy, brief) {
  for (const raw of brief.targets ?? []) {
    const rp = policy.repos.get(raw === ROOT_LABEL ? ROOT_KEY : raw);
    if (rp) return rp.tier;
  }
  return 99;
}

function missingFolderLine(brief) {
  if (isExternalLane(brief.how)) return `The RUN THIS IN block names no repo — this reads as a ${EXTERNAL_LABEL} lane and there is nothing here to route.`;
  return 'MISSING LINE: the RUN THIS IN block has no readable `**Folder:** `<repo>`` line, and no repo name is backticked anywhere inside it. Add that one line; the router will not guess a target.';
}
