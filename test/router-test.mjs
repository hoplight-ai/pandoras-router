// router-test.mjs — the router's unit assertions. No network, no secrets, no git, no writes.
//
// Every module here is PURE by construction: the scheduling core, the lock parsers, the close
// gates and the naming derivations all take data and return data. That is not an accident of
// style, it is what makes this suite possible — a concurrency system whose safety argument can
// only be exercised by opening real worktrees does not get exercised.
//
//   npm test
//
// RED-PROOF. An assertion whose name starts with RED-PROOF asserts a REFUSAL: the machinery saying
// no, or saying "unmeasured", when it should. Those are the ones worth counting. A suite made only
// of happy paths passes just as well with every guard deleted, so the runner prints the red-proof
// count separately and you should watch that number rather than the total.

import assert from 'node:assert/strict';

import { readTable, stripCell } from '../src/lib/md-table.mjs';
import { classify, editDistanceAtMostOne } from '../src/lib/prefixes.mjs';
import { parseVerify, parseLiveness, setSeats, seatAllowed } from '../src/lib/policy.mjs';
import { landMessage, landRefusal } from '../src/lib/land.mjs';
import { parseReportFindings, findProvenance, findingTypeFor, subjectFor, findingArgs, FINDING_TYPES, PROVENANCE_WORDS } from '../src/lib/findings.mjs';
import { normalizePath, normalizeScope, pathsIntersect, scopesIntersect, applyExclusive, setWorkspacePrefixes, WHOLE_REPO } from '../src/lib/scope.mjs';
import { parseClaims, activeWriters, activeSweeps, sameLaneTwice, releaseRewrite, CLAIM_ACTIVE_HOURS, CLAIM_SUSPECT_HOURS } from '../src/lib/claims.mjs';
import { laneIdFor, slugFor, reportFor, branchFor, worktreeFor, sessionIdFor, todayLocal, reportNameForStatus, PREFIX_FOR_STATUS } from '../src/lib/naming.mjs';
import { notBeforeOf, notBeforeVerdict, modelOf, modelIdFor, setModels, priorityOf, filedOf, compareBriefOrder, orderRuleOf, scopeTokens, standingOf, refiresAfterClose, fieldLabelOf, MAX_LINE } from '../src/lib/briefs.mjs';
import { parseModels } from '../src/lib/policy.mjs';
import { allocate, undeclaredCause } from '../src/lib/alloc.mjs';
import { orphanVerdict, parseLanes, encodeScope, decodeScope, SCOPE_NONE, laneKey, closedUnrenamedVerdict, recentCloses, reportOnBridge } from '../src/lib/lanes.mjs';
import { laneOpenPlan, openRefusal, IN_PLACE, WORKTREE, FRESH_CLAIM_MINUTES, resumeVerdict } from '../src/lib/open.mjs';
import { classifyLock, repoReadState, sweepDecision, lockSites } from '../src/lib/gitread.mjs';
import { replaceFromIndex, modeForTarget, DEFAULT_NEW_MODE, TMP_SUFFIX } from '../src/lib/atomic.mjs';
import {
  classifyPath, gradeMerge, proofStringNovel, gradeGates, worktreeRemovable, chooseProofBase,
  isBranchless, briefMatchesLane, briefMatchesLaneOrKey, pathIsInside, scopeCompliance,
  ALWAYS_IN_SCOPE, freshBaseVerdict, landingGapVerdict, liveShaVerdict, surfaceReach,
  liveStringVerdict, walkTipFor, zeroCommitScopeVerdict, reportFreeVerdict, renameOnCloseVerdict,
  claimReleasePlan, deployProbePlan, verifyProdVerdict, obsProbeVerdict, scopeDerivedNote,
  doneReportRefusal, overrulesReportCheck, overrulesVocabulary, vocabularyFindingOverruled,
  gradedReportRename, overrideReportStatusWord, walkStartFor, removalEligible,
  classifyPartialKind, partialStatusLabel, NO_DEPLOY_PROBE,
} from '../src/lib/close.mjs';
import { installPlan } from '../src/bin/lane-open.mjs';

const tests = [];
const T = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------- md-table
const TBL = [
  '',
  '<!-- table: demo -->',
  '',
  '| repo | tier | **note** |',
  '|---|---|---|',
  '| `web` | 1 | one |',
  '| docs | 4 | two |',
  '',
].join('\n');

T('md-table reads rows by marker', () => {
  const r = readTable(TBL, 'demo');
  assert.equal(r.length, 2);
  assert.equal(r[0].repo, 'web');
  assert.equal(r[1].tier, '4');
});

T('md-table strips backticks and bold from cells and headers', () => {
  assert.equal(stripCell('`x`'), 'x');
  assert.equal(stripCell('**y**'), 'y');
  assert.equal(readTable(TBL, 'demo')[0].note, 'one');
});

T('md-table THROWS on a missing marker rather than returning zero rows', () => {
  assert.throws(() => readTable(TBL, 'nope'), /no <!-- table: nope --> marker/);
});

T('md-table THROWS on a marker with a header and no rows', () => {
  assert.throws(() => readTable('<!-- table: e -->\n\n| a |\n|---|\n', 'e'), /has a header but no rows/);
});

// ---------------------------------------------------------------- scope
// The workspace prefix is CONFIGURATION: the module ships with none, and a workspace whose briefs
// quote paths from its root sets its own. The suite installs a synthetic one.
setWorkspacePrefixes(['~/work/']);

T('scope: every spelling of one path normalizes to the same token', () => {
  for (const s of ['~/work/web/app/widget', 'web/app/widget', './app/widget', 'app/widget/', 'app/widget/**', '/app/widget'])
    assert.equal(normalizePath(s, 'web'), 'app/widget', `failed on ${s}`);
});

T('scope: the repo itself, `.`, and a bare glob all mean WHOLE REPO', () => {
  for (const s of ['web', '.', '*', '**', '~/work/web/']) assert.equal(normalizePath(s, 'web'), WHOLE_REPO);
});

// THE THREE TRAVERSAL CASES. Each let two lanes that WILL collide be carded as safe, which is the
// one thing this module's header says it must never do. Watched red before normalizePath learned
// `..`, `./` and letter case.
T('RED-PROOF scope: `src/../lib/x.ts` IS `lib/x.ts`, so the pair intersects', () => {
  assert.equal(normalizePath('src/../lib/x.ts', 'web'), 'lib/x.ts');
  assert.equal(scopesIntersect(normalizeScope(['src/../lib/x.ts'], 'web'), normalizeScope(['lib/x.ts'], 'web')).intersects, true);
  assert.equal(normalizePath('app/./widget//page.tsx', 'web'), 'app/widget/page.tsx');
});

T('RED-PROOF scope: a path that escapes the repo (`../other/db`) widens to WHOLE REPO, never to nothing', () => {
  assert.equal(normalizePath('../other-repo/lib/x.ts', 'web'), WHOLE_REPO);
  assert.equal(normalizePath('src/../../db', 'web'), WHOLE_REPO);
  assert.equal(scopesIntersect(normalizeScope(['../other/db'], 'web'), normalizeScope(['db'], 'web')).intersects, true);
});

T('RED-PROOF scope: `App/x.ts` and `app/x.ts` are ONE file on a case-insensitive disk and must intersect there', () => {
  const a = normalizeScope(['App/x.ts'], 'web');
  const b = normalizeScope(['app/x.ts'], 'web');
  const insensitive = scopesIntersect(a, b, { caseInsensitive: true });
  assert.equal(insensitive.intersects, true, 'case-folded comparison sees one file');
  assert.deepEqual(insensitive.pairs[0], ['App/x.ts', 'app/x.ts'], 'the pair is reported as the lanes declared it');
  // and the platform default follows the disk this process runs on
  const expectDefault = process.platform === 'darwin' || process.platform === 'win32';
  assert.equal(scopesIntersect(a, b).intersects, expectDefault);
  assert.equal(scopesIntersect(a, b, { caseInsensitive: false }).intersects, false, 'a case-sensitive disk keeps them apart');
});

T('scope: a mid-path glob widens to its parent, never narrows', () => {
  assert.equal(normalizePath('app/*/page.tsx', 'web'), 'app');
});

T('scope: containment is by path segment, not by string prefix', () => {
  assert.ok(pathsIntersect('app', 'app/widget/page.tsx'));
  assert.ok(!pathsIntersect('app', 'application/x.ts'));
});

T('scope: disjoint scopes do not intersect', () => {
  const a = normalizeScope(['app/widget', 'scripts/x1-verify.mjs'], 'web');
  const b = normalizeScope(['app/cohort', 'db/migrations'], 'web');
  assert.equal(scopesIntersect(a, b).intersects, false);
});

T('RED-PROOF scope: an overlapping pair of web scopes IS detected and names the pair', () => {
  const a = normalizeScope(['app/widget'], 'web');
  const b = normalizeScope(['app/widget/page.tsx'], 'web');
  const x = scopesIntersect(a, b);
  assert.equal(x.intersects, true);
  assert.deepEqual(x.pairs[0], ['app/widget', 'app/widget/page.tsx']);
});

T('RED-PROOF scope: WHOLE REPO intersects everything, so an undeclared scope can never be disjoint', () => {
  assert.equal(scopesIntersect([WHOLE_REPO], ['app/widget']).intersects, true);
  assert.equal(scopesIntersect(['lib/x.ts'], [WHOLE_REPO]).intersects, true);
});

// ---------------------------------------------------------------- claims
const NOW = Date.parse('2026-08-18T05:00:00Z');

const CLAIMTEXT = [
  '# a comment',
  'web | Web EPSILON1 | 2026-08-18T04:00:00Z | wd:web',
  'web | Web EPSILON1 | 2026-08-18T04:30:00Z | wd:web-design2',
  'repo-a | Old Lane | 2026-08-17T00:00:00Z | pid:1',
  'docs | Weak Lane | 2026-08-18T04:00:00Z',
  '* | Nightly Hygiene | 2026-08-18T04:50:00Z | sweep:git-hygiene',
  'this line is broken',
].join('\n');

const CLAIMS = parseClaims(CLAIMTEXT, NOW).rows;

T('claims: a four-field line parses and is not weak', () => {
  const c = CLAIMS.find((r) => r.session === 'wd:web');
  assert.equal(c.weak, false);
  assert.equal(c.repo, 'web');
});

T('claims: a three-field line still parses and is marked WEAK, which is not a pass', () => {
  const c = CLAIMS.find((r) => r.chat === 'Weak Lane');
  assert.equal(c.weak, true);
  assert.equal(c.malformed, false);
});

T('claims: a line that is not <repo>|<chat>|<ISO> is MALFORMED, never silently honoured', () => {
  assert.equal(CLAIMS.filter((r) => r.malformed).length, 1);
});

T('claims: a claim older than 12 hours is stale and does not block', () => {
  assert.equal(CLAIMS.find((r) => r.chat === 'Old Lane').stale, true);
  assert.equal(activeWriters(CLAIMS, 'repo-a').length, 0);
});

T('claims: a sweep: fourth field is typed as a sweep and is NOT counted as a writer', () => {
  assert.equal(activeWriters(CLAIMS, 'web').length, 2);
  assert.equal(activeSweeps(CLAIMS, 'web').length, 1);
  assert.equal(activeSweeps(CLAIMS, 'web')[0].sweep, 'git-hygiene');
  assert.equal(activeWriters(CLAIMS, '*').length, 0);
});

T('RED-PROOF claims: SAME LANE TWICE fires on the exact shape of the report-overwrite incident', () => {
  const hits = sameLaneTwice(CLAIMS, 'web');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].lane, 'Web EPSILON1');
  assert.equal(hits[0].rows.length, 2);
  assert.equal(hits[0].distinguishable, true);
});

T('claims: two same-lane claims with no session field report as INDISTINGUISHABLE', () => {
  const rows = parseClaims('web | L | 2026-08-18T04:00:00Z\nweb | L | 2026-08-18T04:10:00Z', NOW).rows;
  assert.equal(sameLaneTwice(rows, 'web')[0].distinguishable, false);
});

// ---------------------------------------------------------------- naming
T('naming: a path-like root label produces a FILENAME, not a path', () => {
  const n = reportFor('2026-08-21', '~/work', 'code-l1', 'burn-down');
  assert.ok(!n.includes('/'), `report name still contains a slash: ${n}`);
  assert.equal(n, 'done-2026-08-21-work-code-l1-burn-down.md');
});

T('RED-PROOF naming: a slash in any repo name is refused entry to the filename', () => {
  assert.ok(!reportFor('2026-08-21', 'a/b', 'l', 's').includes('/'));
  assert.ok(!reportFor('2026-08-21', 'a\\b', 'l', 's').includes('\\'));
});

T('naming: an ordinary repo name is untouched', () => {
  assert.equal(reportFor('2026-08-21', 'web', 'l', 's'), 'done-2026-08-21-web-l-s.md');
});

T('naming: lane ids come from the brief filename and disambiguate short tokens', () => {
  assert.equal(laneIdFor('Web-CEILING1-Raise-It-Per-Provider.md'), 'ceiling1');
  assert.equal(laneIdFor('Catalogue-L1-Decision-Queue.md'), 'catalogue-l1');
  assert.equal(laneIdFor('Backup-L2-Keyring-Secret-Injection.md'), 'backup-l2');
  assert.equal(laneIdFor('CHI1-Lanes-That-Run.md'), 'chi1');
});

T('naming: the report filename CONTAINS the lane id — the whole defence against an overwrite', () => {
  const lane = laneIdFor('Web-EPSILON1-Make-Production-Match.md');
  const name = reportFor('2026-08-18', 'web', lane, slugFor('Web-EPSILON1-Make-Production-Match.md'));
  assert.ok(name.includes(lane), name);
  assert.ok(name.startsWith('done-2026-08-18-web-'), name);
});

T('naming: branch, worktree and session ids are derived, not invented per lane', () => {
  assert.equal(branchFor('alpha1', 'everything-a-client'), 'alpha1-everything-a-client');
  assert.equal(worktreeFor('web', 'alpha1'), 'web-alpha1');
  assert.equal(sessionIdFor('alpha1'), 'dispatch-lane-alpha1');
});

// ---------------------------------------------------------------- brief scope line
T('briefs: a Touches: line is read in every spelling that has appeared on this bridge', () => {
  assert.deepEqual(scopeTokens('**Touches:** `app/widget`, `lib/gate.ts`'), ['app/widget', 'lib/gate.ts']);
  assert.deepEqual(scopeTokens('| **File scope** | `src/x.ts` |'), ['src/x.ts']);
  assert.deepEqual(scopeTokens('- Touched files: app/a, app/b'), ['app/a', 'app/b']);
});

T('briefs: no Touches: line returns null, which the allocator reads as WHOLE REPO', () => {
  assert.equal(scopeTokens('# a brief with no scope'), null);
});

// Regression, 2026-08-25. Transcripts-SYNC-2026-08-25-catch-up.md carries the sentence below, and
// the allocator carded it with scope `web, repo-a` — the two repos the sentence rules OUT,
// and neither of them a path inside the repo the lane writes. The separator after the keyword is
// now required, so a sentence is prose and only a labelled field is a declaration.
T('briefs: a sentence that merely begins with "touches" is prose, not a scope declaration', () => {
  assert.equal(scopeTokens('- Touches nothing in `web`, `repo-a`, or any other repo.'), null);
  assert.equal(scopeTokens('This lane touches the finalize gate and nothing else.'), null);
  assert.equal(scopeTokens('Touches `src/a.ts` only when the flag is on'), null);
  // and the real declarations still parse, separator present
  assert.deepEqual(scopeTokens('Touches: `src/a.ts`'), ['src/a.ts']);
  assert.deepEqual(scopeTokens('| Touches | `src/b.ts` |'), ['src/b.ts']);
});

// ---------------------------------------------------------------- allocator
const P = { repos: new Map([
  ['web', { repo: 'web', tier: 1, writers: 2, port: 5173, deploy: 'push+fns', verify: { kind: 'sha', path: '/api/status', field: 'release' }, url: 'https://web.example', traps: [], owner: null }],
  ['api', { repo: 'api', tier: 2, writers: 1, port: 5176, deploy: 'push', verify: { kind: 'string' }, url: 'https://v', traps: [], owner: null }],
  ['docs', { repo: 'docs', tier: 4, writers: 1, port: 5177, deploy: 'push', verify: { kind: 'none' }, url: null, traps: [], owner: 'DISPATCH-B' }],
]) };

const brief = (file, targets, scope, mtime = 0) => ({ file, targets, scope, how: 'Folder line', runsBeside: null, mtime: new Date(mtime) });

// The card list is capped, and until 2026-08-20 it was capped SILENTLY. Measured that morning:
// seven new web briefs pushed every ops and root card past the default limit of 8, so fire-board
// listed Ops-PSI1 under repo-a while alloc did not card it and reported SKIPPED as 0 at
// the same moment. A work queue that truncates without saying so reads as "there is nothing for you
// to do", which is the same class of untruth as a done- file over a PARTIAL body.
T('RED-PROOF alloc: reaching the limit is REPORTED, never silent', () => {
  const many = Array.from({ length: 5 }, (_, i) => brief(`Web-Z${i}-Thing.md`, ['web'], [`app/z${i}`]));
  const r = allocate({ briefs: many, policy: P, claims: [], date: '2026-08-18', limit: 2 });
  assert.equal(r.cards.length, 2);
  assert.equal(r.truncated.length, 3, 'the three briefs past the limit are counted, not dropped');
});

T('alloc: what was truncated names its brief and its repo, so the drop is actionable', () => {
  const many = [brief('Web-Z0-Thing.md', ['web'], ['app/a']), brief('Api-Z1-Thing.md', ['api'], ['app/b'])];
  const r = allocate({ briefs: many, policy: P, claims: [], date: '2026-08-18', limit: 1 });
  assert.equal(r.truncated.length, 1);
  assert.equal(r.truncated[0].file, 'Api-Z1-Thing.md');
  assert.deepEqual(r.truncated[0].targets, ['api']);
});

T('alloc: under the limit, nothing is reported as truncated', () => {
  const r = allocate({ briefs: [brief('Web-Z0-Thing.md', ['web'], ['app/a'])], policy: P, claims: [], date: '2026-08-18', limit: 8 });
  assert.deepEqual(r.truncated, []);
});

T('alloc: a `Touches: none` lane fires beside a whole-repo lane in a one-writer repo', () => {
  // LEAP-L7b's own text says it writes zero repo files, and it named five repos. Before this, that
  // read as the whole repo and held all five shut. A lane that writes nothing is not a writer.
  const r = allocate({
    briefs: [brief('Api-Whole-Repo.md', ['api'], null), brief('Portfolio-Readonly.md', ['api'], [])],
    policy: P, claims: [], date: '2026-08-18', limit: 8,
  });
  assert.equal(r.cards.length, 2);
  assert.equal(r.cards.filter((c) => !c.firesAfter).length, 2);
  const ro = r.cards.find((c) => c.brief === 'Portfolio-Readonly.md');
  assert.deepEqual(ro.scope, []);
  assert.equal(ro.scopeDeclared, true, 'declared-empty is DECLARED, so it is not counted as undeclared');
});

T('RED-PROOF alloc: declared-empty and normalized-empty are not the same thing', () => {
  // A non-empty scope whose tokens all normalize away must still read as the WHOLE REPO. Only the
  // brief saying "none" in so many words buys an empty scope; anything the router merely failed to
  // make sense of takes the safe reading. The two are one `.length === 0` apart downstream.
  const r = allocate({
    briefs: [brief('Api-Blank.md', ['api'], ['   ', ''])],
    policy: P, claims: [], date: '2026-08-18', limit: 8,
  });
  assert.deepEqual(r.cards[0].scope, [WHOLE_REPO]);
});

T('alloc: two web lanes with disjoint scopes BOTH fire now', () => {
  const r = allocate({
    briefs: [brief('Web-A1-One.md', ['web'], ['app/widget']), brief('Web-B1-Two.md', ['web'], ['app/cohort'])],
    policy: P, claims: [], date: '2026-08-18',
  });
  assert.equal(r.cards.length, 2);
  assert.equal(r.cards.filter((c) => !c.firesAfter).length, 2);
});

T('RED-PROOF alloc: two web lanes with OVERLAPPING scopes serialize, second names the overlap', () => {
  const r = allocate({
    briefs: [brief('Web-A1-One.md', ['web'], ['app/widget']), brief('Web-B1-Two.md', ['web'], ['app/widget/page.tsx'])],
    policy: P, claims: [], date: '2026-08-18',
  });
  assert.equal(r.cards[0].firesAfter, null);
  assert.match(r.cards[1].firesAfter, /scopes overlap at app\/widget/);
});

// THE QUEUE REASON FOR AN EXCLUSIVE COLLISION MUST NOT OVERSTATE WHAT THE GUARD DOES.
// Gov-ETA1 filed this as a defect it found and did not fix (2026-08-24): the message read
// "an exclusive path is involved, which requires sole occupancy of the repo", which survived the
// same-day narrowing of applyExclusive and was wrong by a whole repo. A dispatcher who believes it
// serializes lanes the code would have run in parallel, and the overstatement is invisible — it
// reads like caution. Fixed 2026-08-25. Both assertions were observed RED against the old string.
//
// Its report also said the string was asserted in the existing suite. It was not — grep found no
// assertion on it anywhere, which is exactly why it could drift. These two are that missing gate.
const PX = { repos: new Map([
  ['web', { ...P.repos.get('web'), writers: 4, exclusive: ['db/migrations', 'db/functions'] }],
]) };

T('RED-PROOF alloc: an exclusive collision names the path and does NOT claim the whole repo', () => {
  const r = allocate({
    briefs: [brief('Web-A1-One.md', ['web'], ['db/migrations/0110_a.sql']),
             brief('Web-B1-Two.md', ['web'], ['db/migrations/0111_b.sql'])],
    policy: PX, claims: [], date: '2026-08-18',
  });
  assert.equal(r.cards[0].firesAfter, null);
  assert.match(r.cards[1].firesAfter, /EXCLUSIVE path .*db\/migrations/);
  assert.match(r.cards[1].firesAfter, /serialize AT THAT PATH/);
  assert.doesNotMatch(r.cards[1].firesAfter, /sole occupancy/,
    'the queue reason claims sole occupancy of the repo, which applyExclusive stopped doing on 2026-08-24');
});

T('RED-PROOF alloc: two lanes in DIFFERENT exclusive directories both fire now', () => {
  // The behaviour the old message denied outright. The deploy-all command ships every function and the
  // migration pipeline applies every migration, but those are two hazards, not one shared one.
  const r = allocate({
    briefs: [brief('Web-A1-One.md', ['web'], ['db/migrations/0110_a.sql']),
             brief('Web-B1-Two.md', ['web'], ['db/functions/query/index.ts'])],
    policy: PX, claims: [], date: '2026-08-18',
  });
  assert.equal(r.cards.filter((c) => !c.firesAfter).length, 2);
});

T('RED-PROOF alloc: an undeclared scope is WHOLE REPO, so it never runs beside anything', () => {
  const r = allocate({
    briefs: [brief('Web-A1-One.md', ['web'], ['app/widget']), brief('Web-B1-Two.md', ['web'], null)],
    policy: P, claims: [], date: '2026-08-18',
  });
  assert.equal(r.cards[1].scopeDeclared, false);
  assert.ok(r.cards[1].firesAfter, 'an undeclared-scope lane was allowed to run concurrently');
});

T('RED-PROOF alloc: a second lane on a ONE-writer repo is queued behind the active claim', () => {
  const claims = parseClaims('api | Api L1 | 2026-08-18T04:50:00Z | pid:9', NOW).rows;
  const r = allocate({ briefs: [brief('Api-X1-Thing.md', ['api'], ['app/a'])], policy: P, claims, date: '2026-08-18' });
  assert.match(r.cards[0].firesAfter, /repo capacity 1/);
});

T('alloc: a DECLARED SWEEP does not consume a writer slot', () => {
  const claims = parseClaims('api | Nightly | 2026-08-18T04:50:00Z | sweep:hygiene', NOW).rows;
  const r = allocate({ briefs: [brief('Api-X1-Thing.md', ['api'], ['app/a'])], policy: P, claims, date: '2026-08-18' });
  assert.equal(r.cards[0].firesAfter, null);
});

T('alloc: a claim WITH an OPEN record contributes its real scope, so web slot 2 is usable', () => {
  const claims = parseClaims('web | Held | 2026-08-18T04:50:00Z | dispatch-lane-held', NOW).rows;
  const openLanes = [{ lane: 'held', repo: 'web', session: 'dispatch-lane-held', scope: ['app/cohort'], status: 'OPEN' }];
  const r = allocate({ briefs: [brief('Web-A1-One.md', ['web'], ['app/widget'])], policy: P, claims, openLanes, date: '2026-08-18' });
  assert.equal(r.cards[0].firesAfter, null);
});

T('alloc: a claim with NO OPEN record reads as whole-repo and serializes, saying exactly why', () => {
  const claims = parseClaims('web | Held | 2026-08-18T04:50:00Z | dispatch-lane-held', NOW).rows;
  const r = allocate({ briefs: [brief('Web-A1-One.md', ['web'], ['app/widget'])], policy: P, claims, openLanes: [], date: '2026-08-18' });
  assert.match(r.cards[0].firesAfter, /no OPEN record in LANES.md/);
});

T('RED-PROOF alloc: a report filename that ALREADY EXISTS is never reused', () => {
  const b = brief('Web-A1-One.md', ['web'], ['app/widget']);
  const taken = reportFor('2026-08-18', 'web', laneIdFor(b.file), slugFor(b.file));
  const r = allocate({ briefs: [b], policy: P, claims: [], existingReports: new Set([taken]), date: '2026-08-18' });
  assert.equal(r.cards[0].reportTaken, true);
  assert.notEqual(r.cards[0].report, taken);
  assert.match(r.cards[0].report, /-2\.md$/);
});

// SEAT MEMBERSHIP (Ops SIERRA1, 2026-08-21). Separate from the `owner` field above, which is a
// same-day handoff matched against the dated --as string. A seat name carries no date, so unlike
// `owner` it cannot go stale overnight and produce a false OWNED-ELSEWHERE — the failure POLICY.md
// records happening once.
const PS = { repos: new Map([
  ['repo-a', { repo: 'repo-a', tier: 2, writers: 1, port: null, deploy: 'push', verify: { kind: 'string' }, url: 'https://q', traps: [], owner: null, dispatch: 'ops' }],
]) };

T('alloc: a seat skips a repo belonging to another seat', () => {
  const r = allocate({ briefs: [brief('Ops-X1-Thing.md', ['repo-a'], null)], policy: PS, claims: [], seat: 'gov', date: '2026-08-21' });
  assert.equal(r.cards.length, 0);
  assert.equal(r.skipped[0].why, 'OWNED-ELSEWHERE');
  assert.match(r.skipped[0].detail, /belongs to the "ops" dispatch/);
});

T('alloc: the owning seat is NOT skipped', () => {
  const r = allocate({ briefs: [brief('Ops-X1-Thing.md', ['repo-a'], null)], policy: PS, claims: [], seat: 'ops', date: '2026-08-21' });
  assert.equal(r.skipped.length, 0);
  assert.equal(r.cards.length, 1);
});

T('RED-PROOF alloc: passing NO seat changes nothing, so this could not break an existing run', () => {
  const r = allocate({ briefs: [brief('Ops-X1-Thing.md', ['repo-a'], null)], policy: PS, claims: [], date: '2026-08-21' });
  assert.equal(r.skipped.length, 0, 'a seatless caller must be unaffected');
  assert.equal(r.cards.length, 1);
});

T('alloc: OWNED-ELSEWHERE only fires when this dispatch is named and differs', () => {
  const b = [brief('Docs-X1-Thing.md', ['docs'], null)];
  assert.equal(allocate({ briefs: b, policy: P, claims: [], as: 'DISPATCH-A', date: '2026-08-18' }).skipped[0].why, 'OWNED-ELSEWHERE');
  assert.equal(allocate({ briefs: b, policy: P, claims: [], as: 'DISPATCH-B', date: '2026-08-18' }).cards.length, 1);
  assert.equal(allocate({ briefs: b, policy: P, claims: [], as: null, date: '2026-08-18' }).cards.length, 1);
});

T('alloc: a brief with no target lands in PARSE-FAIL and the missing line is named', () => {
  const r = allocate({ briefs: [brief('X1-Thing.md', [], null)], policy: P, claims: [], date: '2026-08-18' });
  assert.equal(r.skipped[0].why, 'PARSE-FAIL');
  assert.match(r.skipped[0].detail, /MISSING LINE/);
});

T('alloc: tier orders the queue, and it is the ONLY thing tier does', () => {
  const r = allocate({
    briefs: [brief('Docs-X1-A.md', ['docs'], null), brief('Web-A1-B.md', ['web'], ['app/a'])],
    policy: P, claims: [], as: 'DISPATCH-B', date: '2026-08-18',
  });
  assert.equal(r.cards[0].repo, 'web');
  assert.equal(r.cards[1].firesAfter, null, 'a lower tier was blocked from firing, which priority must never do');
});

T('alloc: the card carries the repo traps so the dispatcher does not restate them in prose', () => {
  const withTrap = { repos: new Map([['web', { ...P.repos.get('web'), traps: ['lazily chunked'] }]]) };
  const r = allocate({ briefs: [brief('Web-A1-One.md', ['web'], ['app/a'])], policy: withTrap, claims: [], date: '2026-08-18' });
  assert.deepEqual(r.cards[0].traps, ['lazily chunked']);
});

// ---------------------------------------------------------------- close gates
T('close: a squash-merged path reads MERGED even though ancestry would say otherwise', () => {
  assert.equal(classifyPath('base', 'new', 'new'), 'MERGED');
});

T('close: an unlanded path reads NOT-MERGED', () => {
  assert.equal(classifyPath('base', 'new', 'base'), 'NOT-MERGED');
});

T('close: a path the branch never touched reads UNTOUCHED', () => {
  assert.equal(classifyPath('base', 'base', 'base'), 'UNTOUCHED');
});

T('close: a path somebody else edited after the branch started reads MAIN-MOVED, not a verdict', () => {
  assert.equal(classifyPath('base', 'mine', 'theirs'), 'MAIN-MOVED');
});

T('close: a deletion present on main reads MERGED; a deletion not on main does not', () => {
  assert.equal(classifyPath('base', null, null), 'MERGED');
  assert.equal(classifyPath('base', null, 'base'), 'NOT-MERGED');
});

T('close: gradeMerge fails on any unmerged or main-moved path', () => {
  assert.equal(gradeMerge([{ path: 'a', verdict: 'MERGED' }]).merged, 'yes');
  assert.equal(gradeMerge([{ path: 'a', verdict: 'MERGED' }, { path: 'b', verdict: 'NOT-MERGED' }]).merged, 'no');
  assert.equal(gradeMerge([{ path: 'b', verdict: 'MAIN-MOVED' }]).merged, 'no');
});

T('RED-PROOF close: a proof string already on main is REFUSED', () => {
  const patch = '--- a/x\n+++ b/x\n context Build OK\n+brand new line\n';
  assert.equal(proofStringNovel(patch, 'Build OK').novel, false);
  assert.match(proofStringNovel(patch, 'Build OK').why, /already on main/);
});

T('close: a proof string the branch introduced is accepted', () => {
  const patch = '--- a/x\n+++ b/x\n+cohort isolation v2\n';
  assert.equal(proofStringNovel(patch, 'cohort isolation v2').novel, true);
});

T('close: a proof string that appears nowhere in the diff is refused as decoration', () => {
  assert.match(proofStringNovel('+something else\n', 'zzz').why, /cannot fail/);
});

T('close: an empty proof string is refused', () => {
  assert.equal(proofStringNovel('+x\n', '   ').novel, false);
});

T('RED-PROOF close: DONE requires all six gates; one skip forces PARTIAL and writes the reason', () => {
  const all = { merged: 'yes', green: 'yes', live: 'yes', renamed: 'yes', reportFree: 'yes', ownerWay: 'n/a' };
  assert.equal(gradeGates(all).status, 'DONE');
  const g = gradeGates({ ...all, green: 'skip' });
  assert.equal(g.status, 'PARTIAL');
  assert.match(g.reason, /green=skip/);
  assert.equal(gradeGates({ ...all, live: 'no' }).status, 'PARTIAL');
  assert.equal(gradeGates({ ...all, reportFree: 'no' }).status, 'PARTIAL');
});

T('close: n/a passes where the policy says there is no deployed surface; skip never does', () => {
  const all = { merged: 'yes', green: 'yes', live: 'n/a', renamed: 'yes', reportFree: 'yes', ownerWay: 'n/a' };
  assert.equal(gradeGates(all).status, 'DONE');
  assert.equal(gradeGates({ ...all, live: 'skip' }).status, 'PARTIAL');
});

// ---------------------------------------------------------------- gate 6: owner-way-in
const ALLPASS = { merged: 'yes', green: 'yes', live: 'yes', renamed: 'yes', reportFree: 'yes' };

T('RED-PROOF ownerway: a locked-out owner forces PARTIAL and LEADS the reason, ahead of every other failure', () => {
  const g = gradeGates({ ...ALLPASS, green: 'skip', ownerWay: 'no' });
  assert.equal(g.status, 'PARTIAL');
  assert.equal(g.lockedOut, true);
  assert.match(g.reason, /^owner locked out; owner-way-in=no/);
  assert.equal(g.failed[0].gate, 'owner-way-in');
});

T('ownerway: skip on gate 6 is PARTIAL, not a pass; n/a and a missing field both pass (ungated repos, old callers)', () => {
  assert.equal(gradeGates({ ...ALLPASS, ownerWay: 'skip' }).status, 'PARTIAL');
  assert.equal(gradeGates({ ...ALLPASS, ownerWay: 'n/a' }).status, 'DONE');
  assert.equal(gradeGates(ALLPASS).status, 'DONE');
  assert.equal(gradeGates(ALLPASS).lockedOut, false);
});

// ---------------------------------------------------------------- concurrency gates (2026-08-22)
// The four gates instituted BEFORE web's writers cap was raised past 2. Each proven able to go
// red here, per the workspace rule that an unproven gate is decoration.

T('RED-PROOF gate7: a touched path OUTSIDE the declared scope fails the close and is named', () => {
  const r = scopeCompliance(['scripts/exp1/run.mjs', 'app/page.tsx'], ['scripts/exp1', 'data/exp1']);
  assert.equal(r.value, 'no');
  assert.deepEqual(r.breaches, ['app/page.tsx']);
  assert.match(r.note, /app\/page\.tsx/);
});

T('gate7: every touched path inside the declaration passes; containment is by path segment, not prefix', () => {
  assert.equal(scopeCompliance(['scripts/exp1/run.mjs', 'data/exp1/out.json'], ['scripts/exp1', 'data/exp1']).value, 'yes');
  // `scripts/exp1` must NOT contain `scripts/exp1b/x` — the substring trap.
  assert.equal(scopeCompliance(['scripts/exp1b/x.mjs'], ['scripts/exp1']).value, 'no');
});

// THE SHARED-FILE ALLOWLIST. Some repos require every lane to run a script that rewrites one
// repo-wide generated file — a lockfile, a regenerated index, a pinned baseline. No brief declares
// it, so the required procedure trips the in-scope gate every time: measured, a fully landed,
// fully green lane graded PARTIAL(scope) on one such file alone. The allowlist is the fix. It
// ships EMPTY, because the paths are yours; these pin the mechanism and the empty default.
T('gate7: a path on the allowlist is in scope for every lane', () => {
  ALWAYS_IN_SCOPE.add('data/codename-baseline.json');
  try {
    const r = scopeCompliance(['scripts/judge1/run.mjs', 'data/judge1/out.json', 'data/codename-baseline.json'], ['scripts/judge1', 'data/judge1']);
    assert.equal(r.value, 'yes');
    assert.deepEqual(r.breaches, []);
    assert.match(r.note, /all 3 touched path\(s\)/);
  } finally {
    ALWAYS_IN_SCOPE.delete('data/codename-baseline.json');
  }
});

T('RED-PROOF gate7: the allowlist matches BY NAME — a sibling, a prefix and a nested path all still fail', () => {
  ALWAYS_IN_SCOPE.add('data/codename-baseline.json');
  try {
    const r = scopeCompliance(['scripts/judge1/run.mjs', 'data/codename-baseline.json', 'data/other.json'], ['scripts/judge1']);
    assert.equal(r.value, 'no');
    assert.deepEqual(r.breaches, ['data/other.json']);
    // A prefix or nested path does not ride on the exemption either.
    assert.equal(scopeCompliance(['data/codename-baseline.json/x'], ['scripts/judge1']).value, 'no');
    assert.equal(scopeCompliance(['web/data/codename-baseline.json'], ['scripts/judge1']).value, 'no');
  } finally {
    ALWAYS_IN_SCOPE.delete('data/codename-baseline.json');
  }
});

T('RED-PROOF gate7: the allowlist SHIPS EMPTY, so no path is exempt until somebody adds one on purpose', () => {
  assert.deepEqual([...ALWAYS_IN_SCOPE], []);
});

T('gate7: an undeclared (whole-repo) scope is n/a — the lane held the repo alone, nothing to breach', () => {
  assert.equal(scopeCompliance(['anything.ts'], ['.']).value, 'n/a');
  assert.equal(scopeCompliance(['anything.ts'], []).value, 'n/a');
});

T('RED-PROOF gate7: in-scope=no forces PARTIAL through gradeGates; n/a and a missing field pass (old ledger lines)', () => {
  const seven = { ...ALLPASS, ownerWay: 'n/a' };
  assert.equal(gradeGates({ ...seven, inScope: 'no' }).status, 'PARTIAL');
  assert.match(gradeGates({ ...seven, inScope: 'no' }).reason, /in-scope=no/);
  assert.equal(gradeGates({ ...seven, inScope: 'skip' }).status, 'PARTIAL');
  assert.equal(gradeGates({ ...seven, inScope: 'n/a' }).status, 'DONE');
  assert.equal(gradeGates(seven).status, 'DONE');
});

// ---------------------------------------------------------------- ninth input: the report's own word
// Gov LAMBDA1, 2026-09-06, defect 2. Measured twice on the live bridge: webskills1 and victor1
// both graded a DONE CLOSE row on eight passing gates while their own reports said STATUS PARTIAL.
// Root the standing rules: "the STATUS word inside the report is the only scope claim."
T('RED-PROOF grade: a report saying PARTIAL cannot be overruled by eight passing gates', () => {
  const all = { ...ALLPASS, ownerWay: 'n/a', inScope: 'n/a', roadmap: 'yes' };
  assert.equal(gradeGates(all).status, 'DONE', 'sanity: eight gates alone still grade DONE');
  const g = gradeGates({ ...all, reportStatusWord: 'PARTIAL' });
  assert.equal(g.status, 'PARTIAL');
  assert.match(g.reason, /STATUS word/);
});

T('RED-PROOF grade: a report saying BLOCKED cannot be overruled either, and grades BLOCKED, not PARTIAL', () => {
  const all = { ...ALLPASS, ownerWay: 'n/a', inScope: 'n/a', roadmap: 'yes' };
  const g = gradeGates({ ...all, reportStatusWord: 'BLOCKED' });
  assert.equal(g.status, 'BLOCKED');
});

T('grade: a report saying DONE, or no report yet, never touches an otherwise-DONE grade', () => {
  const all = { ...ALLPASS, ownerWay: 'n/a', inScope: 'n/a', roadmap: 'yes' };
  assert.equal(gradeGates({ ...all, reportStatusWord: 'DONE' }).status, 'DONE');
  assert.equal(gradeGates({ ...all, reportStatusWord: null }).status, 'DONE');
  assert.equal(gradeGates(all).status, 'DONE');
});

T('grade: the report word only ever lowers the grade — a failing gate is not raised back to DONE by it', () => {
  const g = gradeGates({ ...ALLPASS, ownerWay: 'n/a', inScope: 'n/a', roadmap: 'yes', live: 'no', reportStatusWord: 'PARTIAL' });
  assert.equal(g.status, 'PARTIAL');
  assert.match(g.reason, /live=no/, 'the gate reason still leads when a real gate failed, not the report-word override text');
});

// ---------------------------------------------------------------- gate7: zero commits ahead of base
// Gov LAMBDA1, 2026-09-06, defect 3. scopeCompliance alone cannot tell "declared none, wrote
// nothing" (a clean pass) from "declared real files, wrote none of them" (unmeasured, not clean) —
// both hand it an empty touched list and both used to read as its own vacuous "0 touched paths are
// inside the declared scope" yes. Measured on the transcript catch-up lane (sync3, 2026-09-06).
T('zeroCommitScopeVerdict: declared none, zero commits — a clean yes, not a skip', () => {
  const v = zeroCommitScopeVerdict({ declaredNone: true, scope: [] });
  assert.equal(v.value, 'yes');
  assert.match(v.note, /declared no files, touched no files/);
});

T('RED-PROOF zeroCommitScopeVerdict: declared real files, zero commits — unmeasured, stays skip, never a vacuous yes', () => {
  const v = zeroCommitScopeVerdict({ declaredNone: false, scope: ['lib/x.mjs'] });
  assert.equal(v.value, 'skip');
  assert.notEqual(v.value, 'yes');
  assert.match(v.note, /unmeasured, not clean/);
});

T('zeroCommitScopeVerdict: an undeclared (whole-repo) scope with zero commits stays n/a, unchanged', () => {
  assert.equal(zeroCommitScopeVerdict({ declaredNone: false, scope: ['.'] }).value, 'n/a');
  assert.equal(zeroCommitScopeVerdict({ declaredNone: false, scope: [] }).value, 'n/a');
});

T('RED-PROOF rename-on-close: a second failing gate keeps the brief live, and says which one', () => {
  const r = renameOnCloseVerdict({
    failed: [{ gate: 'renamed' }, { gate: 'green' }],
    liveBrief: 'Web-X1-Something.md',
    apply: true,
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /2 gate\(s\) failed/);
  assert.match(r.why, /green/);
  assert.match(r.why, /stay live/);
});

T('rename-on-close: gate 4 alone, under --apply, renames to consumed-', () => {
  const r = renameOnCloseVerdict({ failed: [{ gate: 'renamed' }], liveBrief: 'Web-X1-Something.md', apply: true });
  assert.equal(r.ok, true);
  assert.equal(r.to, 'consumed-Web-X1-Something.md');
});

T('rename-on-close: measure-only NEVER renames, and says what --apply would do', () => {
  const r = renameOnCloseVerdict({ failed: [{ gate: 'renamed' }], liveBrief: 'Web-X1-Something.md', apply: false });
  assert.equal(r.ok, false);
  assert.match(r.why, /measure only/);
  assert.match(r.why, /consumed-Web-X1-Something\.md/);
});

T('rename-on-close: an all-pass close and a missing brief both do nothing quietly', () => {
  assert.equal(renameOnCloseVerdict({ failed: [], liveBrief: 'x.md', apply: true }).ok, false);
  assert.equal(renameOnCloseVerdict({ failed: [{ gate: 'renamed' }], liveBrief: null, apply: true }).ok, false);
  assert.equal(renameOnCloseVerdict({ failed: [{ gate: 'renamed' }], liveBrief: 'notmarkdown.txt', apply: true }).ok, false);
});

// ---------------------------------------------------------------- ZETA1: the four clerical gates
// Measured over 269 CLOSE rows in _handoffs/_lanes/LANES.md: renamed=no 60, live=no 56,
// in-scope=skip 48. Each of the four behaviours below turns a clerical PARTIAL into either a real
// measurement or an act the close performs itself. Nothing here converts an unmeasured gate into a
// pass; every fallback that measures nothing still says `skip`, and says a skip is not a pass.
T('gate4 matcher: a continuation lane finds its own brief under a closed prefix', () => {
  const brief = 'consumed-2026-08-22-Web-THETA1-Three-Example-Workspaces.md';
  // The live defect, from lane theta1-b's own CLOSE row: the brief WAS renamed by hand and gate 4
  // still said it was not, because the lane id carries a continuation suffix no filename has.
  assert.equal(briefMatchesLane(brief, 'theta1-b'), false);
  assert.equal(briefMatchesLaneOrKey(brief, 'theta1-b', 'theta1'), true);
});

T('RED-PROOF gate4 matcher: the lane-key fallback never widens to a neighbouring lane', () => {
  // ops-l1 is a prefix of ops-l1b and laneKey() leaves both alone, so the fallback must not
  // manufacture the substring match briefMatchesLane exists to refuse.
  assert.equal(briefMatchesLaneOrKey('Ops-L1b-Collector-And-Defects.md', 'ops-l1', 'ops-l1'), false);
  assert.equal(briefMatchesLaneOrKey('Web-ALPHA12-Something.md', 'alpha1', 'alpha1'), false);
});

T('gate4: a lane that filed its report renames its brief even when another gate failed', () => {
  const r = renameOnCloseVerdict({
    failed: [{ gate: 'renamed' }, { gate: 'live' }],
    liveBrief: 'Web-X1-Something.md',
    apply: true,
    reportOnBridge: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.to, 'consumed-Web-X1-Something.md');
});

T('RED-PROOF gate4: no report on the bridge keeps the brief live, whatever --apply says', () => {
  const r = renameOnCloseVerdict({
    failed: [{ gate: 'renamed' }, { gate: 'live' }],
    liveBrief: 'Web-X1-Something.md',
    apply: true,
    reportOnBridge: false,
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /no report/i);
  assert.match(r.why, /stay live/);
});

T('claim release: an exact session id is the only thing a close releases', () => {
  const rows = [
    { session: 'dispatch-lane-theta1-b', repo: 'web', key: 'theta1', raw: 'a' },
    { session: 'dispatch-lane-theta1', repo: 'web', key: 'theta1', raw: 'b' },
  ];
  const p = claimReleasePlan({ rows, session: 'dispatch-lane-theta1-b', key: 'theta1', repo: 'web' });
  assert.equal(p.exact.length, 1);
  assert.equal(p.exact[0].raw, 'a');
  assert.equal(p.nearMiss.length, 0);
});

T('RED-PROOF claim release: a lane-key near miss is NAMED and never released', () => {
  const rows = [{ session: 'dispatch-lane-x', repo: 'web', key: 'x', raw: 'b', stale: false }];
  const p = claimReleasePlan({ rows, session: 'dispatch-lane-x-w3', key: 'x', repo: 'web' });
  assert.equal(p.exact.length, 0);
  assert.equal(p.nearMiss.length, 1);
  assert.match(p.why, /NOT released/);
});

T('claim release: a near miss on another repo is not a near miss at all', () => {
  const rows = [{ session: 'dispatch-lane-x', repo: 'docs', key: 'x', raw: 'b', stale: false }];
  const p = claimReleasePlan({ rows, session: 'dispatch-lane-x-w3', key: 'x', repo: 'web' });
  assert.equal(p.nearMiss.length, 0);
});

T('RED-PROOF gate3 fallback: only an unmeasured live gate gets a second probe', () => {
  for (const value of ['yes', 'no', 'n/a', 'exempt']) {
    assert.equal(deployProbePlan({ value, hasScript: true, url: 'https://x' }).probe, 'none');
  }
  assert.equal(deployProbePlan({ value: 'skip', hasScript: true, url: 'https://x' }).probe, 'verify:prod');
});

T('gate3 fallback: verify:prod wins, and the status route is the second ask', () => {
  assert.equal(deployProbePlan({ value: 'skip', hasScript: false, url: 'https://x' }).probe, 'status-route');
  const p = deployProbePlan({ value: 'skip', hasScript: false, namedInDocs: true, url: 'https://x' });
  assert.match(p.why, /package\.json has no such script/);
});

T('RED-PROOF gate3 fallback: no script and no route leaves a skip, and says a skip is not a pass', () => {
  const p = deployProbePlan({ value: 'skip', hasScript: false, url: null });
  assert.equal(p.probe, 'none');
  assert.match(p.why, /no verify:prod script and no deployment status route/);
  const v = obsProbeVerdict({ status: 404, sha: 'abc' });
  assert.equal(v.value, 'skip');
  assert.match(v.why, /no verify:prod script and no deployment status route/);
  assert.match(v.why, /skip is not a pass/);
});

T('gate3 fallback: verify:prod exit 0 is a yes, and a non-zero exit is a no carrying its last line', () => {
  assert.equal(verifyProdVerdict({ code: 0 }).value, 'yes');
  const bad = verifyProdVerdict({ code: 1, tail: 'served sha 1111111 != head 2222222' });
  assert.equal(bad.value, 'no');
  assert.match(bad.why, /2222222/);
});

T('gate3 fallback: the status route compares release to the branch head by ancestry', () => {
  assert.equal(obsProbeVerdict({ status: 200, served: 'aaa', sha: 'aaa' }).value, 'yes');
  assert.equal(obsProbeVerdict({ status: 200, served: 'bbb', sha: 'aaa', isAncestor: true }).value, 'yes');
  assert.equal(obsProbeVerdict({ status: 200, served: 'bbb', sha: 'aaa', isAncestor: false, servedKnown: true }).value, 'no');
});

T('gate7: an unmeasured scope gate carries the derived touched-file list', () => {
  const n = scopeDerivedNote({ touched: ['a.ts', 'b.ts'], base: '1234567890', source: 'lane-open', branch: 'x1-slug' });
  assert.match(n, /^ derived:/);
  assert.match(n, /a\.ts, b\.ts/);
  assert.match(n, /12345678/);
});

T('RED-PROOF gate7 derived: an unavailable diff says so rather than printing an empty list', () => {
  assert.match(scopeDerivedNote({ touched: null, base: '123', source: 'lane-open', branch: 'x' }), /could not be computed/);
  assert.match(scopeDerivedNote({ touched: [], base: null, source: null, branch: 'x' }), /no diff base/);
  assert.match(scopeDerivedNote({ touched: [], base: '123', source: 'lane-open', branch: 'x' }), /0 path\(s\)/);
});

T('RED-PROOF lane-open install: a checkout with no node_modules and no --install WARNS, loudly and by name', () => {
  const p = installPlan({ inPlace: false, hasPackageJson: true, hasModules: false, install: false });
  assert.equal(p.run, false);
  assert.equal(p.warn, true);
  assert.match(p.why, /no --install/);
});

T('lane-open install: --install on a checkout with no node_modules runs npm ci, and never warns as well', () => {
  const p = installPlan({ inPlace: false, hasPackageJson: true, hasModules: false, install: true });
  assert.equal(p.run, true);
  assert.equal(p.warn, false);
});

T('lane-open install: in-place, no package.json, and an already-installed checkout are all silent', () => {
  for (const p of [
    installPlan({ inPlace: true, hasPackageJson: true, hasModules: false, install: true }),
    installPlan({ inPlace: false, hasPackageJson: false, hasModules: false, install: true }),
    installPlan({ inPlace: false, hasPackageJson: true, hasModules: true, install: true }),
  ]) {
    assert.equal(p.run, false);
    assert.equal(p.warn, false);
  }
});

// ---------------------------------------------------------- VICTOR1 W1: check 6's liveness half
//
// The naming half above needs no database. This half asks whether the row is REALLY THERE and still
// open, which is the question that separates "names a row" from "moves something". A brief citing
// item_000000 passed every assertion above it, and so did one citing a row closed last month.
//
// `board` is a Map, never a network call: the verdict is pure so these run with no credential and no
// connection, exactly like every other assertion in this file.
const BOARD = new Map([
  ['item_101', { completed: false }],
  ['item_102', { completed: true }],
  ['item_103', { completed: false }],
]);

T('RED-PROOF fresh-base: a green build on a branch missing main\'s head is REFUSED for post-ship lanes', () => {
  const r = freshBaseVerdict({ containsMainHead: false, grandfathered: false, behindBy: '3' });
  assert.equal(r.fresh, false);
  assert.match(r.why, /does NOT contain origin\/main/);
  assert.match(r.why, /3 commit/);
});

T('fresh-base: containing main\'s head passes; a grandfathered stale base passes with the observation in prose', () => {
  assert.equal(freshBaseVerdict({ containsMainHead: true, grandfathered: false }).fresh, true);
  const g = freshBaseVerdict({ containsMainHead: false, grandfathered: true, behindBy: '2' });
  assert.equal(g.fresh, true);
  assert.match(g.why, /^NOTE:/);
});

// GATE 2 AND THE LANDING MERGE (Gov BRAVO1, 2026-09-04). `router.mjs land` merges the branch into
// main as ONE merge commit and never fast-forwards the branch, so the branch lacks exactly one commit
// of main's: its own landing. Gate 2 read that as "main moved" and the most recently landed lane could
// never pass (purge1 49ea2457, auddata1 0188f572, measured 2026-09-04). The five assertions below pin
// the rule that excuses a landing and nothing else. In every fixture `ahead` is what
// `rev-list --parents <branch>..origin/main` returns, and `isInBranch` is `merge-base --is-ancestor`.
T('gate 2: the lane\'s own LAND merge is the only commit main has that the branch lacks — contained (BRAVO1)', () => {
  // main: M0 -> L (merge, parents [M0, T]). Branch tip T already contains M0.
  const gap = landingGapVerdict({
    ahead: [{ sha: 'L', parents: ['M0', 'T'] }],
    land: { tip: 'T', merge: 'L' },
    isInBranch: (s) => s === 'T' || s === 'M0',
  });
  assert.equal(gap.contained, true);
  assert.deepEqual(gap.unexplained, []);
  assert.equal(gap.excused[0].as, 'LAND merge');
  const r = freshBaseVerdict({ containsMainHead: false, grandfathered: false, behindBy: '1', gap });
  assert.equal(r.fresh, true, 'a lane that was just landed must be able to pass gate 2');
  assert.match(r.why, /landing/);
});

T('gate 2: without a LAND record, a merge on main whose second parent is in the branch is still this branch\'s landing (BRAVO1 rule b)', () => {
  const gap = landingGapVerdict({ ahead: [{ sha: 'L', parents: ['M0', 'T'] }], land: null, isInBranch: (s) => s === 'T' || s === 'M0' });
  assert.equal(gap.contained, true);
  assert.equal(gap.excused[0].as, 'merge of this branch');
});

T('RED-PROOF gate 2: main moved by ANOTHER lane before this branch landed — still refused, the intent survives (BRAVO1)', () => {
  // main: M0 -> N1 (neighbour) -> L (merge, parents [N1, T]). Branch T contains M0, not N1.
  const gap = landingGapVerdict({
    ahead: [{ sha: 'L', parents: ['N1', 'T'] }, { sha: 'N1', parents: ['M0'] }],
    land: { tip: 'T', merge: 'L' },
    isInBranch: (s) => s === 'T' || s === 'M0',
  });
  assert.equal(gap.contained, false);
  assert.deepEqual(gap.unexplained, ['N1']);
  const r = freshBaseVerdict({ containsMainHead: false, grandfathered: false, behindBy: '2', gap });
  assert.equal(r.fresh, false);
  assert.match(r.why, /N1/);
});

T('RED-PROOF gate 2: a commit on main AFTER the landing merge is not excused by the landing', () => {
  const gap = landingGapVerdict({
    ahead: [{ sha: 'F', parents: ['L'] }, { sha: 'L', parents: ['M0', 'T'] }],
    land: { tip: 'T', merge: 'L' },
    isInBranch: (s) => s === 'T' || s === 'M0',
  });
  assert.equal(gap.contained, false);
  assert.deepEqual(gap.unexplained, ['F']);
});

T('RED-PROOF gate 2: a NEIGHBOUR\'s landing merge (second parent not in this branch) is not excused', () => {
  const gap = landingGapVerdict({ ahead: [{ sha: 'LN', parents: ['M0', 'TN'] }], land: { tip: 'T', merge: 'L' }, isInBranch: (s) => s === 'T' || s === 'M0' });
  assert.equal(gap.contained, false);
  assert.deepEqual(gap.unexplained, ['LN']);
  assert.equal(freshBaseVerdict({ containsMainHead: false, grandfathered: false, behindBy: '1', gap }).fresh, false);
});

T('RED-PROOF gate 2: a gap that could not be listed is not contained — a skip is not a pass', () => {
  const gap = landingGapVerdict({ ahead: null, land: { tip: 'T', merge: 'L' }, isInBranch: () => true });
  assert.equal(gap.contained, false);
  assert.match(gap.why, /could not be listed/);
  assert.equal(freshBaseVerdict({ containsMainHead: false, grandfathered: false, behindBy: null, gap }).fresh, false);
});

T('gate 2: freshBaseVerdict with no gap argument is unchanged — a stale base is still refused', () => {
  assert.equal(freshBaseVerdict({ containsMainHead: false, grandfathered: false, behindBy: '1' }).fresh, false);
});

T('live-ancestry: exact match passes; a later neighbour\'s deploy that CONTAINS this head passes with ancestry named', () => {
  assert.equal(liveShaVerdict({ served: 'abc', sha: 'abc', isAncestor: false, servedKnown: null }).value, 'yes');
  const a = liveShaVerdict({ served: 'def4567890', sha: 'abc1234567', isAncestor: true, servedKnown: true });
  assert.equal(a.value, 'yes');
  assert.match(a.why, /CONTAINS/);
});

T('RED-PROOF live-ancestry: a served build that neither matches nor contains this head is still NO — stale bytes cannot pass', () => {
  const r = liveShaVerdict({ served: 'old4567890', sha: 'abc1234567', isAncestor: false, servedKnown: true });
  assert.equal(r.value, 'no');
  const unknown = liveShaVerdict({ served: 'xyz4567890', sha: 'abc1234567', isAncestor: false, servedKnown: false });
  assert.equal(unknown.value, 'skip');
  assert.match(unknown.why, /fetch/);
});

// ------------------------------------------------- gate 3, string form: where does a change land
// The defect: the gate fetched the repo's ROOT url and looked for the proof string in that HTML.
// repo-a' root url is a stub, so the gate could not see ANY change to that repo — audit-policy
// closed live=no on two files it had already proved byte-identical at their own live urls, and
// psi1 hit the same wall on a page change two days earlier. The fallback direction is the
// safety property and three of the assertions below exist to hold it in place.

const SURF = [{ path: '.', surface: 'self' }, { path: 'ops', surface: 'none' }];

T('surfaces: a change under a `self` prefix is probed at its own url, not at the repo root', () => {
  const r = surfaceReach(['scripts/velocity-collect.mjs', 'scripts/verify-velocity-coverage.mjs'], SURF, 'repo-a');
  assert.equal(r.kind, 'files');
  assert.deepEqual(r.probes, ['scripts/velocity-collect.mjs', 'scripts/verify-velocity-coverage.mjs']);
});

T('surfaces: a change that reaches nothing served is EXEMPT territory, not a red', () => {
  const r = surfaceReach(['ops/ci.yml'], SURF, 'repo-a');
  assert.equal(r.kind, 'unreachable');
  assert.match(r.why, /render into no page/);
});

T('surfaces: longest declared prefix wins, so `.` can be carved out by a narrower row', () => {
  assert.equal(surfaceReach(['ops/x'], SURF).kind, 'unreachable');
  assert.equal(surfaceReach(['opsimilar/x'], SURF).kind, 'files'); // segment boundary, not substring
});

T('RED-PROOF surfaces: an UNDECLARED path falls back to the root url and is never read as unreachable', () => {
  const r = surfaceReach(['app/page.tsx'], [{ path: 'scripts', surface: 'none' }], 'marketing-site');
  assert.equal(r.kind, 'homepage');
  assert.deepEqual(r.undeclared, ['app/page.tsx']);
  assert.match(r.why, /NEVER read as unreachable/);
  // and one undeclared path among declared ones drags the whole close back to the root url
  assert.equal(surfaceReach(['scripts/x', 'app/page.tsx'], [{ path: 'scripts', surface: 'none' }]).kind, 'homepage');
});

T('surfaces: a repo with no rows behaves exactly as it did before this table existed', () => {
  assert.equal(surfaceReach(['anything.ts'], []).kind, 'homepage');
  assert.equal(surfaceReach(['anything.ts'], undefined).kind, 'homepage');
  assert.equal(surfaceReach([], SURF).kind, 'homepage');
});

T('string-verdict: a probed url serving the novel proof string passes and names the url', () => {
  const r = liveStringVerdict({ results: [{ url: 'https://x/a.mjs', status: 404, hasProof: false }, { url: 'https://x/b.mjs', status: 200, hasProof: true }], proof: 'p', mode: 'files' });
  assert.equal(r.value, 'yes');
  assert.match(r.why, /b\.mjs/);
});

T('RED-PROOF string-verdict: a url that answers 200 WITHOUT the string is still a hard no', () => {
  const r = liveStringVerdict({ results: [{ url: 'https://x/a.mjs', status: 200, hasProof: false }], proof: 'p', mode: 'files' });
  assert.equal(r.value, 'no');
  // the reach question must never convert a reachable-but-stale surface into an exemption
  assert.notEqual(r.value, 'exempt');
});

T('string-verdict: an all-401 probe set is the Basic Auth wall — skip, never a pass', () => {
  const r = liveStringVerdict({ results: [{ url: 'https://x/tools/a', status: 401, hasProof: false }], proof: 'p', mode: 'files' });
  assert.equal(r.value, 'skip');
  assert.match(r.why, /credential the policy names/);
});

T('RED-PROOF string-verdict: ONE walled url outranks a dozen public 200s — media-l2\'s shape', () => {
  // Twelve public files answered 200 and the string lives on the one gated page. Grading that a
  // `no` claims to have measured the only surface it could be on. It is a skip.
  const many = Array.from({ length: 12 }, (_, i) => ({ url: `https://x/lib/${i}.mjs`, status: 200, hasProof: false }));
  const r = liveStringVerdict({ results: [...many, { url: 'https://x/tools/private', status: 401, hasProof: false }], proof: 'p', mode: 'files' });
  assert.equal(r.value, 'skip');
  assert.match(r.why, /NOT read as a no/);
  // and the wall never manufactures a pass out of an unmeasured surface
  assert.notEqual(r.value, 'yes');
});

T('string-verdict: a proof found on a public url still wins even when another probe is walled', () => {
  const r = liveStringVerdict({ results: [{ url: 'https://x/tools/a', status: 401, hasProof: false }, { url: 'https://x/s.mjs', status: 200, hasProof: true }], proof: 'p', mode: 'files' });
  assert.equal(r.value, 'yes');
});

T('string-verdict: 404 on a path POLICY says is served is skip, and says it cannot tell wrong-row from never-shipped', () => {
  const r = liveStringVerdict({ results: [{ url: 'https://x/a.mjs', status: 404, hasProof: false }], proof: 'p', mode: 'files' });
  assert.equal(r.value, 'skip');
  assert.match(r.why, /row is wrong or the file never shipped/);
});

T('string-verdict: a capped probe list says so out loud rather than reading as full coverage', () => {
  const r = liveStringVerdict({ results: [{ url: 'https://x/a', status: 200, hasProof: true }], proof: 'p', mode: 'files', dropped: 4 });
  assert.match(r.why, /4 further changed file\(s\) were not probed/);
});

T('string-verdict: live=exempt passes gradeGates alongside n/a, and skip still does not', () => {
  const seven = { ...ALLPASS, ownerWay: 'n/a', inScope: 'n/a' };
  assert.equal(gradeGates({ ...seven, live: 'exempt' }).status, 'DONE');
  assert.equal(gradeGates({ ...seven, live: 'skip' }).status, 'PARTIAL');
});

T('RED-PROOF exclusive: a scope touching an exclusive path is widened to THAT PATH, not to the whole repo', () => {
  const r = applyExclusive(['db/migrations', 'scripts/x'], ['db/migrations', 'package.json']);
  assert.equal(r.widened, true);
  assert.deepEqual(r.scope, ['db/migrations', 'scripts/x']);
  // AMENDED 2026-08-24. This used to assert `[WHOLE_REPO]` and that an exclusive lane therefore
  // intersects EVERY neighbour. That is the behaviour being removed: it is stricter than any of
  // the three hazards requires and it made web's `writers: 4` unreachable. An unrelated lane
  // must now pass beside it.
  assert.equal(scopesIntersect(r.scope, ['scripts/exp1']).intersects, false);
});

T('RED-PROOF exclusive: lanes sharing one exclusive path still serialize, in both directions', () => {
  const ex = ['db/migrations', 'db/functions', 'package.json'];
  // Two lanes inside the SAME exclusive dir: the deploy-all command ships both, so they must collide.
  const a = applyExclusive(['db/functions/_shared', 'scripts/tailor1'], ex).scope;
  // CHARLIE1's real declared scope, which touches BOTH exclusive paths.
  const b = applyExclusive(['db/functions/run-capability', 'db/migrations', 'scripts/charlie1'], ex).scope;
  assert.deepEqual(a, ['db/functions', 'scripts/tailor1']);
  assert.equal(scopesIntersect(a, b).intersects, true);
  assert.equal(scopesIntersect(b, a).intersects, true);
  // Two lanes in DIFFERENT exclusive dirs share no hazard and must now run in parallel.
  const c = applyExclusive(['scripts/x', 'db/migrations'], ex).scope;
  assert.equal(scopesIntersect(a, c).intersects, false);
  assert.equal(scopesIntersect(c, a).intersects, false);
  // But the migration-number hazard still binds against anyone else touching migrations.
  assert.equal(scopesIntersect(c, b).intersects, true);
});

T('exclusive: widening never NARROWS — a whole-repo scope and an over-wide scope both keep their own form', () => {
  const ex = ['db/migrations', 'db/functions'];
  // `.` must never be promoted down to one exclusive path; it still blocks everyone.
  assert.deepEqual(applyExclusive([WHOLE_REPO], ex).scope, [WHOLE_REPO]);
  assert.equal(scopesIntersect(applyExclusive([WHOLE_REPO], ex).scope, ['scripts/x']).intersects, true);
  // A scope WIDER than the exclusive path keeps the wider form, which already covers it.
  assert.deepEqual(applyExclusive(['db'], ex).scope, ['db']);
  assert.equal(scopesIntersect(['db'], ['db/functions']).intersects, true);
});

T('exclusive: a scope clear of the exclusive list is untouched, and an empty list changes nothing', () => {
  assert.deepEqual(applyExclusive(['scripts/exp1'], ['db/migrations']).scope, ['scripts/exp1']);
  assert.equal(applyExclusive(['scripts/exp1'], []).widened, false);
  // containment counts: a scope INSIDE an exclusive dir is a hit.
  assert.equal(applyExclusive(['db/migrations/0100_x.sql'], ['db/migrations']).widened, true);
});

// ---------------------------------------------------------------- worktree removal
T('RED-PROOF worktree: the repo\'s own checkout is never removable, whatever the gates said', () => {
  const p = worktreeRemovable({ repo: 'web', worktree: 'web', registered: ['web', 'web-alpha1'] });
  assert.equal(p.ok, false);
  assert.match(p.why, /never removed/);
});

T('RED-PROOF worktree: a directory git does not list as a worktree of this repo is not removable', () => {
  const p = worktreeRemovable({ repo: 'web', worktree: 'web-ghost', registered: ['web', 'web-alpha1'] });
  assert.equal(p.ok, false);
  assert.match(p.why, /not a registered worktree/);
});

T('worktree: the lane\'s own registered worktree is removable after a full pass', () => {
  assert.equal(worktreeRemovable({ repo: 'web', worktree: 'web-alpha1', registered: ['web', 'web-alpha1'] }).ok, true);
});

// ---------------------------------------------------------------- the report refuses the close
// Measured across one bridge: more than half of the reports saying DONE admitted a skipped, unrun,
// unmerged or undeployed step in their own text, a few carried no STATUS word, and about a third
// carried no Evidence line. report-check.mjs saw all three the whole time and the close path never
// asked it.
const DONE_OK = {
  file: '_handoffs/done-2026-09-03-fixture1.md',
  present: true, statusFound: true, statusWord: 'DONE', evidencePresent: true, doneHonestWarn: false,
};

T('RED-PROOF report: a report with no STATUS word aborts the close', () => {
  const v = doneReportRefusal({ ...DONE_OK, statusFound: false, statusWord: null });
  assert.equal(v.ok, false);
  assert.equal(v.condition, 'no-status-word');
  assert.match(v.why, /done-2026-09-03-fixture1\.md/, 'the refusal names the file');
  assert.match(v.why, /PARTIAL/, 'the refusal names the standing rule it is enforcing');
});

T('RED-PROOF report: STATUS DONE with no Evidence line aborts the close, and PARTIAL does not', () => {
  const v = doneReportRefusal({ ...DONE_OK, evidencePresent: false });
  assert.equal(v.ok, false);
  assert.equal(v.condition, 'done-without-evidence');
  assert.match(v.why, /Evidence/);
  assert.equal(doneReportRefusal({ ...DONE_OK, statusWord: 'PARTIAL', evidencePresent: false }).ok, true,
    'the Evidence rule in the governing rules is about done- files; a PARTIAL is not held to it here');
  assert.equal(doneReportRefusal({ ...DONE_OK, statusWord: 'BLOCKED', evidencePresent: false }).ok, true);
});

T('RED-PROOF report: STATUS DONE beside an unanswered done-honest flag aborts the close', () => {
  const flagged = { ...DONE_OK, doneHonestWarn: true, doneHonestSummary: '3 skipped/barred/deferred phrase(s) in a DONE file' };
  const v = doneReportRefusal(flagged);
  assert.equal(v.ok, false);
  assert.equal(v.condition, 'done-honest-unaddressed');
  assert.match(v.why, /overruled:/, 'the refusal shows the L6 line that answers it');
  assert.equal(doneReportRefusal({ ...flagged, overruled: true }).ok, true,
    'L6 gives two valid answers, and writing the overrule line is one of them');
});

T('RED-PROOF report: an overrule must NAME report-check, not merely contain the word overruled', () => {
  assert.equal(overrulesReportCheck('overruled: report-check flagged "not run" in lane-close.mjs; it is inside quoted output'), true);
  assert.equal(overrulesReportCheck('- overruled: report-check flagged a phrase; the phrase is a quotation'), true);
  assert.equal(overrulesReportCheck('overruled: eslint flagged an unused import; the type uses it'), false,
    'answering a different reviewer does not answer this one');
  assert.equal(overrulesReportCheck('this was overruled by me'), false, 'prose is not the L6 line');
  assert.equal(overrulesReportCheck(null), false);
});

// Gov, 2026-09-07. The fourth refusal (vocabulary-alias-unexplained) had no overrule at all: a
// correct L6 line changed nothing, measured live on x12. The overrule is per TERM, so the
// two reviewers stay distinct even when a lane names report-check in both lines.
T('RED-PROOF vocabulary overrule: the line must name the vocabulary check (or report-check) AND quote the term; only that term is released', () => {
  const one = overrulesVocabulary('overruled: vocabulary flagged "LABEL1" in _handoffs/done-x.md; LABEL1 is the "LABEL1 bench" workspace label, not a lane');
  assert.deepEqual([...one].sort(), ['LABEL1', 'LABEL1 bench'], 'every quoted span on the line is a released term');
  assert.deepEqual([...overrulesVocabulary('- overruled: vocab flagged `some_column` in this file; it is a column name')], ['some_column']);
  assert.deepEqual([...overrulesVocabulary('overruled: report-check flagged "X12" in this file as an unexplained bridge term; the plain')], ['X12'],
    'the x12 report\'s own line, verbatim in shape: --check-report printed the refusal, so naming report-check answers it');
  assert.equal(overrulesVocabulary('overruled: report-check flagged a skipped phrase in the transcript; it is a quotation').size, 0,
    'a done-honest overrule that quotes no term releases no vocabulary finding');
  assert.equal(overrulesVocabulary('overruled: eslint flagged "RT1" as unused; it is used by the type').size, 0,
    'answering a different reviewer does not answer this one');
  assert.equal(overrulesVocabulary('the vocabulary check flagged "RT1" and I disagree').size, 0, 'prose is not the L6 line');
  assert.equal(overrulesVocabulary(null).size, 0);
});

T('vocabulary overrule: a finding is released by its token, and a fuzzy finding by either half of its token', () => {
  const released = new Set(['LABEL1', 'stage4RubricBlock']);
  assert.equal(vocabularyFindingOverruled({ kind: 'unregistered-codename', token: 'LABEL1' }, released), true);
  assert.equal(vocabularyFindingOverruled({ kind: 'unregistered-codename', token: 'LABEL2' }, released), false, 'a neighbouring token is not released');
  assert.equal(vocabularyFindingOverruled({ kind: 'bare-alias', token: 'stage-4 rubric (≈ stage4RubricBlock)', fuzzy: true }, released), true);
  assert.equal(vocabularyFindingOverruled({ kind: 'bare-alias', token: 'stage-4 rubric (≈ stage4RubricBlock)', fuzzy: true }, new Set(['stage-4 rubric'])), true);
  assert.equal(vocabularyFindingOverruled({ kind: 'bare-alias', token: 'ECHO2' }, new Set()), false);
  assert.equal(vocabularyFindingOverruled({ kind: 'bare-alias', token: 'ECHO2' }, null), false);
});

T('report: a clean DONE, and a report the lane has not written yet, are both left alone', () => {
  assert.equal(doneReportRefusal(DONE_OK).ok, true);
  assert.equal(doneReportRefusal(DONE_OK).condition, null);
  const absent = doneReportRefusal({ file: '_handoffs/done-2026-09-03-fixture1.md', present: false });
  assert.equal(absent.ok, true, 'closing before writing the report is the normal order, not a fault');
});

T('report: the refusals are ordered, so the first missing thing is the one the close reports', () => {
  const v = doneReportRefusal({
    file: '_handoffs/done-2026-09-03-fixture1.md',
    present: true, statusFound: false, statusWord: null, evidencePresent: false, doneHonestWarn: true,
  });
  assert.equal(v.condition, 'no-status-word');
});

// ---------------------------------------------------------------- atomic patch application
// The half-apply defect fixed 2026-09-03: apply-atomic.mjs stat-ed each target inside the rename
// loop to copy its mode, and `git apply --cached` never creates a working-tree file, so a patch
// that ADDS one threw ENOENT after the files ahead of it had already been renamed over.
T('RED-PROOF atomic: a file the patch CREATES gets a default mode instead of a stat that throws', () => {
  assert.equal(modeForTarget(null), DEFAULT_NEW_MODE);
  assert.equal(modeForTarget(undefined), DEFAULT_NEW_MODE);
  assert.equal(modeForTarget({ mode: 0o755 }), 0o755, 'an existing executable stays executable');
});

T('RED-PROOF atomic: a failure part-way through renames NOTHING, so the close path is never half-replaced', () => {
  const renamed = []; const written = []; const unlinked = [];
  const r = replaceFromIndex({
    files: ['lib/close.mjs', 'lane-close.mjs'],
    readStaged: (f) => { if (f === 'lane-close.mjs') throw new Error('fatal: bad object'); return Buffer.from('new'); },
    statTarget: () => null,
    writeTmp: (tmp) => written.push(tmp),
    rename: (tmp, f) => renamed.push(f),
    unlink: (tmp) => unlinked.push(tmp),
  });
  assert.equal(r.ok, false);
  assert.deepEqual(renamed, []);
  assert.deepEqual(written, [`lib/close.mjs${TMP_SUFFIX}`]);
  assert.deepEqual(unlinked, [`lib/close.mjs${TMP_SUFFIX}`], 'the temp sibling written before the failure is cleaned up');
  assert.match(r.why, /NOTHING was replaced/);
});

T('atomic: the normal case writes every temp file first, then renames every one of them', () => {
  const order = [];
  const r = replaceFromIndex({
    files: ['a.mjs', 'b.mjs'],
    readStaged: () => Buffer.from('xyz'),
    statTarget: () => null,
    writeTmp: (tmp) => order.push(`write ${tmp}`),
    rename: (tmp, f) => order.push(`rename ${f}`),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(order, [`write a.mjs${TMP_SUFFIX}`, `write b.mjs${TMP_SUFFIX}`, 'rename a.mjs', 'rename b.mjs']);
  assert.equal(r.replaced.length, 2);
  assert.equal(r.replaced[0].bytes, 3);
});

// ---------------------------------------------------------------- the third refusal (FOXTROT1 W2)
//
// THE BUG: a dispatch session opened in the worktree it was about to close, and `close --apply`
// ran `git worktree remove` on the directory its own shell was standing in. The agent harness pins
// a session's working folder at startup and cannot move it, so the chat died, taking two in-flight
// jobs with it. On macOS an open cwd is not a lock, so git removes it without complaint.
//
// `worktreeRemovable` refused two cases and could not see this one: nothing in its signature knew
// where the calling process was standing.
T('RED-PROOF worktree: a session standing IN the target worktree may not remove it', () => {
  const p = worktreeRemovable({
    repo: 'web', worktree: 'web-x1', registered: ['web', 'web-x1'],
    worktreeAbs: '/code/web-x1', cwd: '/code/web-x1',
  });
  assert.equal(p.ok, false);
  assert.match(p.why, /standing inside/i);
});

T('RED-PROOF worktree: a session in a SUBDIRECTORY of the target may not remove it either', () => {
  const p = worktreeRemovable({
    repo: 'web', worktree: 'web-x1', registered: ['web', 'web-x1'],
    worktreeAbs: '/code/web-x1', cwd: '/code/web-x1/src/app',
  });
  assert.equal(p.ok, false);
});

T('RED-PROOF worktree: a SIBLING whose name merely starts the same is not "inside"', () => {
  // The prefix trap: '/code/web-x1' must not swallow '/code/web-x10'. Getting this wrong
  // blocks legitimate cleanups forever, which is how a guard gets deleted.
  const p = worktreeRemovable({
    repo: 'web', worktree: 'web-x1', registered: ['web', 'web-x1'],
    worktreeAbs: '/code/web-x1', cwd: '/code/web-x10',
  });
  assert.equal(p.ok, true);
});

T('worktree: closing from the repo\'s own checkout is still allowed', () => {
  const p = worktreeRemovable({
    repo: 'web', worktree: 'web-x1', registered: ['web', 'web-x1'],
    worktreeAbs: '/code/web-x1', cwd: '/code/web',
  });
  assert.equal(p.ok, true);
});

T('worktree: omitting cwd keeps the old two-refusal behaviour exactly', () => {
  // Backwards compatibility is load-bearing: every existing caller passes no cwd, and a check that
  // silently started refusing them would look like the close path breaking.
  assert.equal(worktreeRemovable({ repo: 'web', worktree: 'web-alpha1', registered: ['web', 'web-alpha1'] }).ok, true);
});

T('paths: pathIsInside is exact about the separator', () => {
  assert.equal(pathIsInside('/a/b', '/a/b'), true);
  assert.equal(pathIsInside('/a/b/c', '/a/b'), true);
  assert.equal(pathIsInside('/a/bb', '/a/b'), false);
  assert.equal(pathIsInside('/a', '/a/b'), false);
});

// ---------------------------------------------------------------- not-before date gate
//
// Added 2026-08-23. the owner needed a brief held until a usage reset without it being fireable in the
// meantime. Every existing way to say that was PROSE — a "Fires after:" sentence the allocator
// never reads — and prose is exactly what this seat is told not to accept as a gate. Parking the
// brief was the alternative and it is worse: a parked brief routes NOTHING, so it disappears from
// the board and nobody sees it on the day it comes due.
T('not-before: a date in the future holds the card', () => {
  assert.equal(notBeforeVerdict('2026-08-25', '2026-08-23'), '2026-08-25');
});

T('not-before: the named day itself is live, not held', () => {
  // Held UNTIL the date, not through it. A brief marked for Tuesday fires on Tuesday.
  assert.equal(notBeforeVerdict('2026-08-25', '2026-08-25'), null);
});

T('not-before: a past date holds nothing', () => {
  assert.equal(notBeforeVerdict('2026-08-25', '2026-09-01'), null);
});

T('not-before: absent means absent, never "held forever"', () => {
  assert.equal(notBeforeVerdict(null, '2026-08-23'), null);
  assert.equal(notBeforeVerdict(undefined, '2026-08-23'), null);
});

T('RED-PROOF not-before: an UNPARSEABLE date must not silently mean "fire now"', () => {
  // A typo'd date reading as "no gate" is the failure that matters: the brief fires on the day
  // somebody meant to hold it. It holds instead, and the card says the date is unreadable.
  assert.equal(notBeforeVerdict('next tuesday', '2026-08-23'), 'UNREADABLE');
  assert.equal(notBeforeVerdict('2026-13-99', '2026-08-23'), 'UNREADABLE');
});

T('not-before: the line is read out of a brief body', () => {
  assert.equal(notBeforeOf('# X\n\n**Not-Before:** 2026-08-25\n\nbody'), '2026-08-25');
  assert.equal(notBeforeOf('- Not-Before: `2026-09-01`'), '2026-09-01');
  assert.equal(notBeforeOf('# X\n\nno such line'), null);
});

// ---------------------------------------------------------------- "today" is the shop's day, not UTC's
//
// Added 2026-08-24 after LEAP-L7b's third run reported it from the other side of the seam:
// at 2026-08-23 23:19 EDT the allocator printed `Not-Before 2026-08-25 (today is 2026-08-24)` and
// named every report file `done-2026-08-24-...`, five hours before that day began here. `counted`,
// quoted verbatim in partial-2026-08-23-portfolio-leap-l7b-eve-of-departure.md.
//
// Two costs, and the first is the one that matters: a Not-Before hold opens up to five hours EARLY
// every single evening, which is the one thing that gate exists to stop. The second is that the
// bridge's own chronology drifts, because a report written on Sunday night is filed under Monday.
//
// A brief that says "Tuesday" means the owner's Tuesday, so the day comes from a local calendar.
// These assertions were written and watched RED against `todayUTC` before the fix landed.
//
// So these pin their zone explicitly instead of reading it off the host. The rule under test is
// "a calendar day in the shop's zone, never UTC", and that rule is the same in every zone; the
// old form could only ever be green in one of them. A red assertion nobody can fix by being
// correct is the "gate lanes learn to ignore" failure, and it had already started — a lane running
// the suite today cannot tell this failure from one of its own.
const ET = 'America/New_York';

const ES = 'Europe/Madrid';   // a second zone, chosen so one instant falls on two calendar days

T('RED-PROOF today: a late evening in ET is still TODAY, not tomorrow', () => {
  // 23:19 EDT on the 23rd is 03:19Z on the 24th. UTC calls it the 24th; the shop calls it the 23rd,
  // and the shop is who the board is for. This is the exact clock reading that was observed.
  assert.equal(todayLocal(new Date('2026-08-23T23:19:00-04:00'), ET), '2026-08-23');
});

T('RED-PROOF today: the early hours of the morning are still the new day', () => {
  // The mirror case, so the fix cannot be "subtract a day and call it done".
  assert.equal(todayLocal(new Date('2026-08-24T00:05:00-04:00'), ET), '2026-08-24');
});

T('RED-PROOF today: the SAME instant is a different day in a second zone, and that is the point', () => {
  // The zone is not decoration. One instant, two shop-days, and a travelling operator's day is
  // whichever zone the laptop is in. This is also the assertion that would go red if `localDate` ever went back to
  // reading date parts off the host clock, because then both calls below would return the same
  // string whatever zone was asked for.
  const instant = new Date('2026-08-23T23:19:00-04:00');
  assert.equal(todayLocal(instant, ET), '2026-08-23');
  assert.equal(todayLocal(instant, ES), '2026-08-24');
});

T('today: midday agrees with UTC, so ordinary daytime runs are unchanged', () => {
  assert.equal(todayLocal(new Date('2026-08-24T11:46:00-04:00'), ET), '2026-08-24');
});

// ---------------------------------------------------------------- order inside a tier (Gov WHISKEY1)
//
// Until 2026-08-24 the only tiebreaker inside a tier was the brief file's mtime, ascending. So
// EDITING a brief moved it to the back of the queue, and the printed order was a record of what
// somebody typed most recently wearing the costume of a judgement. Ops Dispatch watched `strag1` and
// `gate1` swap FIRE NOW twice as it edited each in turn, did not trust the order, and fired with
// `--queued` instead. It was right not to trust it.
//
// Resolution order, and the card PRINTS which rule applied so the weakness is visible at the point
// of use: `Priority:` (integer, lower first), then `Filed:` (ISO date, older first — content, so
// editing the body does not move it), then mtime. Absent is not zero; absent falls through.
T('order: Priority is read out of a brief body', () => {
  assert.equal(priorityOf('# X\n\n**Priority:** 3\n\nbody'), 3);
  assert.equal(priorityOf('- Priority: `10`'), 10);
  assert.equal(priorityOf('# X\n\nno such line'), null);
});

T('RED-PROOF order: an UNPARSEABLE Priority is NAMED, never guessed at', () => {
  // Same shape as the Not-Before gate: a value the parser cannot read must not silently become 0
  // and jump the queue. It is named and it falls through to the next rule.
  assert.equal(priorityOf('Priority: soon'), 'UNREADABLE');
  assert.equal(priorityOf('Priority: 2.5'), 'UNREADABLE');
});

T('order: Filed is read out of a brief body, and a bad date is named', () => {
  assert.equal(filedOf('**Filed:** 2026-08-20'), '2026-08-20');
  assert.equal(filedOf('**Filed**: 2026-08-20'), '2026-08-20');
  assert.equal(filedOf('Filed: last tuesday'), 'UNREADABLE');
  assert.equal(filedOf('nothing here'), null);
});

T('RED-PROOF order: PROSE is not a field — both of these were live on the bridge', () => {
  // Caught the moment this shipped, by running it against the real bridge rather than fixtures.
  // "Filed" and "Priority" open ordinary English sentences in a way "Not-Before" never does, so the
  // colon is mandatory here and the whitespace after it is too. Reading a sentence as a queue
  // position is fuzzy matching, and fuzzy matching manufactures false agreement.
  assert.equal(filedOf('Filed 2026-08-24 by the lane sweep. It is defect 1 of'), null);   // Web-INDIA1
  assert.equal(filedOf('   Filed:)` in those words, so the weakness is visible'), null);  // Gov-WHISKEY1 itself
  assert.equal(priorityOf('mtime (no Priority:, no Filed:)'), null);
  assert.equal(priorityOf('Priority is what this lane is about'), null);
});

T('RED-PROOF order: Priority BEATS mtime, so editing a brief cannot re-rank it', () => {
  // This is the defect verbatim. `late` was touched most recently, so under mtime-only it sorts
  // last inside its tier. It carries Priority 1 and must sort FIRST.
  const early = { file: 'A.md', mtime: new Date(1_000), priority: null, filed: null };
  const late = { file: 'B.md', mtime: new Date(9_000), priority: 1, filed: null };
  assert.deepEqual([early, late].sort(compareBriefOrder).map((b) => b.file), ['B.md', 'A.md']);
});

T('order: Filed beats mtime when neither carries a Priority', () => {
  const older = { file: 'A.md', mtime: new Date(9_000), priority: null, filed: '2026-08-01' };
  const newer = { file: 'B.md', mtime: new Date(1_000), priority: null, filed: '2026-08-20' };
  assert.deepEqual([newer, older].sort(compareBriefOrder).map((b) => b.file), ['A.md', 'B.md']);
});

T('order: with both fields absent, today\'s mtime ordering is reproduced EXACTLY', () => {
  // The property that makes this safe to ship onto a live board: no existing brief moves.
  const a = { file: 'A.md', mtime: new Date(1_000), priority: null, filed: null };
  const b = { file: 'B.md', mtime: new Date(5_000), priority: null, filed: null };
  const c = { file: 'C.md', mtime: new Date(9_000), priority: null, filed: null };
  assert.deepEqual([c, a, b].sort(compareBriefOrder).map((x) => x.file), ['A.md', 'B.md', 'C.md']);
});

T('order: the rule that applied is printable, so nobody has to guess', () => {
  assert.match(orderRuleOf({ priority: 2, filed: null }), /^Priority 2$/);
  assert.match(orderRuleOf({ priority: null, filed: '2026-08-01' }), /^Filed 2026-08-01 \(no Priority:\)$/);
  assert.match(orderRuleOf({ priority: null, filed: null }), /^mtime \(no Priority:, no Filed:\)$/);
  assert.match(orderRuleOf({ priority: 'UNREADABLE', filed: null }), /UNREADABLE/);
});

// ---------------------------------------------------------------- ORPHANED lanes (Gov WHISKEY1)
//
// Lane `strag1` finished, wrote its report, removed its worktree, deleted its branch and released
// its claim — and left an OPEN line in LANES.md with no CLOSE beside it. For the 39 minutes until a
// human noticed, every repo-a card read as queued behind a lane that no longer existed.
//
// Modelled on STALE-CLAIM, which solved the identical problem one layer down and solved it the same
// way: flag, never block, on the stated ground that crashed sessions never clean up after themselves.
//
// It says `work state UNKNOWN`, never `finished`. A lane whose worktree and branch are both gone
// might be a session that crashed after merging. Freeing the slot is still right — a dead lane
// holding a repo hostage is the more expensive failure — but the board must never assert something
// it did not measure.
T('RED-PROOF orphan: an OPEN lane whose report is already on the bridge is ORPHANED', () => {
  const lane = { lane: 'strag1', repo: 'repo-a', status: 'OPEN', report: 'done-x.md', worktree: 'wt', branch: 'br', opened: '2026-08-24T02:00:00Z' };
  const v = orphanVerdict(lane, { reportExists: true, worktreeExists: true, branchExists: true, now: Date.parse('2026-08-24T02:10:00Z') });
  assert.ok(v, 'expected an ORPHANED verdict');
  assert.match(v.why, /report/i);
});

T('orphan: a vanished worktree orphans the lane, and the reason names which condition fired', () => {
  const lane = { lane: 'x', repo: 'r', status: 'OPEN', report: 'r.md', worktree: 'wt', branch: 'br', opened: '2026-08-24T02:00:00Z' };
  const v = orphanVerdict(lane, { reportExists: false, worktreeExists: false, branchExists: true, now: Date.parse('2026-08-24T02:10:00Z') });
  assert.match(v.why, /worktree/i);
});

T('orphan: age past CLAIM_ACTIVE_HOURS orphans it, and the constant is IMPORTED not restated', () => {
  const lane = { lane: 'x', repo: 'r', status: 'OPEN', report: 'r.md', worktree: 'wt', branch: 'br', opened: '2026-08-24T02:00:00Z' };
  const justInside = Date.parse('2026-08-24T02:00:00Z') + (CLAIM_ACTIVE_HOURS - 0.5) * 3_600_000;
  const justPast = Date.parse('2026-08-24T02:00:00Z') + (CLAIM_ACTIVE_HOURS + 0.5) * 3_600_000;
  const probe = { reportExists: false, worktreeExists: true, branchExists: true };
  assert.equal(orphanVerdict(lane, { ...probe, now: justInside }), null);
  assert.match(orphanVerdict(lane, { ...probe, now: justPast }).why, /older than/i);
});

T('orphan: a CLOSED lane is never orphaned, and a healthy OPEN one is not either', () => {
  const closed = { lane: 'x', repo: 'r', status: 'DONE', report: 'r.md', worktree: 'wt', branch: 'br', opened: '2026-08-24T02:00:00Z' };
  const healthy = { lane: 'y', repo: 'r', status: 'OPEN', report: 'r.md', worktree: 'wt', branch: 'br', opened: '2026-08-24T02:00:00Z' };
  const now = Date.parse('2026-08-24T02:10:00Z');
  assert.equal(orphanVerdict(closed, { reportExists: true, worktreeExists: false, branchExists: false, now }), null);
  assert.equal(orphanVerdict(healthy, { reportExists: false, worktreeExists: true, branchExists: true, now }), null);
});

T('orphan: it says work state UNKNOWN, never "finished"', () => {
  const lane = { lane: 'x', repo: 'r', status: 'OPEN', report: 'r.md', worktree: 'wt', branch: 'br', opened: '2026-08-24T02:00:00Z' };
  const v = orphanVerdict(lane, { reportExists: true, worktreeExists: false, branchExists: false, now: Date.parse('2026-08-24T02:10:00Z') });
  assert.match(v.headline, /UNKNOWN/);
  assert.ok(!/finished/i.test(v.headline), 'the board must not assert a work state it did not measure');
});

T('RED-PROOF orphan: an ORPHANED lane does NOT hold its declared scope', () => {
  // The allocation half. A brief whose scope overlaps a dead lane's must still fire.
  const claims = [{ repo: 'api', chat: 'dead', stamp: '2026-08-24T02:00:00Z', session: 'dispatch-lane-dead', ageH: 0.2, stale: false, malformed: false, isSweep: false, weak: false }];
  const openLanes = [{ lane: 'dead', repo: 'api', status: 'OPEN', branch: 'b', worktree: 'w', report: 'r.md', scope: ['app/a'], session: 'dispatch-lane-dead', opened: '2026-08-24T02:00:00Z' }];
  const b = brief('Api-Z1-Thing.md', ['api'], ['app/a']);
  const blocked = allocate({ briefs: [b], policy: P, claims, openLanes, date: '2026-08-24' });
  assert.ok(blocked.cards[0].firesAfter, 'a LIVE lane holding this scope must still block');
  const freed = allocate({ briefs: [b], policy: P, claims, openLanes, orphanedLanes: new Set(['dead']), date: '2026-08-24' });
  assert.equal(freed.cards[0].firesAfter, null, 'an ORPHANED lane must not hold its scope');
});

// ---------------------------------------------------------------- model as a real field
//
// Every brief already carried a `Model:` line and NOTHING read it — the card the dispatcher works
// from never mentioned a model, so which model ran a lane was whatever the person firing it happened
// to pick. One brief needed a specific model, and prose in a brief is not a mechanism.
//
// NO FUZZY MATCHING. An unrecognised name is reported as unrecognised and NAMED; it never guesses
// a model id, because silently running the wrong model is worse than saying "I don't know this".
//
// THE ROSTER IS CONFIGURATION. The code ships with an EMPTY name-to-id table; POLICY.md's optional
// `models` table fills it, so no vendor's model names are compiled in. These assertions install a
// synthetic roster first.
const MODELS = new Map([['large 5', 'vendor-large-5'], ['medium 5', 'vendor-medium-5'], ['small 4.5', 'vendor-small-4-5']]);

T('RED-PROOF model: with no `models` table configured, every name is unrecognised', () => {
  setModels(new Map());
  assert.equal(modelIdFor('Large 5'), null);
  assert.equal(modelIdFor('vendor-large-5'), null, 'an id is only "exact" once the table names it');
});

T('model: friendly names map to exact ids', () => {
  setModels(MODELS);
  assert.equal(modelIdFor('Large 5'), 'vendor-large-5');
  assert.equal(modelIdFor('Medium 5'), 'vendor-medium-5');
  assert.equal(modelIdFor('medium 5'), 'vendor-medium-5');
  assert.equal(modelIdFor('  SMALL 4.5  '), 'vendor-small-4-5');
});

T('model: an exact id passes through unchanged', () => {
  setModels(MODELS);
  assert.equal(modelIdFor('vendor-large-5'), 'vendor-large-5');
  assert.equal(modelIdFor('vendor-medium-5'), 'vendor-medium-5');
});

T('RED-PROOF model: an unknown name is NEVER guessed', () => {
  setModels(MODELS);
  assert.equal(modelIdFor('Medium 4'), null);
  assert.equal(modelIdFor('other-5'), null);
  assert.equal(modelIdFor('fastest one'), null);
  assert.equal(modelIdFor(''), null);
  assert.equal(modelIdFor(null), null);
});

T('model: the line is read out of a brief body', () => {
  assert.equal(modelOf('- **Model:** Large 5 (`vendor-large-5`)'), 'Large 5');
  assert.equal(modelOf('# X\n\n**Model**: Medium 5\n\nbody'), 'Medium 5');
  assert.equal(modelOf('no such line'), null);
});

T('model: a parenthetical id does not confuse the friendly name', () => {
  setModels(MODELS);
  // Briefs write both, e.g. "Large 5 (`vendor-large-5`)". Take the name, resolve it, ignore the gloss.
  assert.equal(modelIdFor(modelOf('- **Model:** Large 5 (`vendor-large-5`)')), 'vendor-large-5');
});

T('model: POLICY.md\'s optional `models` table is the roster, and a missing table is an empty roster', () => {
  const withTable = ['<!-- table: models -->', '', '| name | id |', '|---|---|', '| `Large 5` | `vendor-large-5` |', ''].join('\n');
  assert.deepEqual([...parseModels(withTable)], [['large 5', 'vendor-large-5']]);
  assert.equal(parseModels('# a policy with no models table').size, 0);
});

// ---------------------------------------------------------------- lane ledger
T('lanes: OPEN then CLOSE then NOTE fold into one lane row', () => {
  const rows = parseLanes([
    'OPEN | alpha1 | web | alpha1-x | web-alpha1 | 5173 | done-a.md | app/widget app/x | dispatch-lane-alpha1 | 2026-08-18T04:00:00Z',
    'NOTE | alpha1 | OVERRIDE --queued | 2026-08-18T04:01:00Z',
    'CLOSE | alpha1 | PARTIAL | yes | skip | no | yes | yes | 2026-08-18T06:00:00Z | green=skip',
  ].join('\n'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'PARTIAL');
  assert.deepEqual(rows[0].scope, ['app/widget', 'app/x']);
  assert.equal(rows[0].green, 'skip');
  assert.deepEqual(rows[0].notes, ['OVERRIDE --queued']);
});

T('lanes: `-` in the scope field round-trips as "writes nothing", blank does not', () => {
  assert.equal(encodeScope([]), '-');
  assert.equal(encodeScope(['src/a']), 'src/a');
  assert.deepEqual(decodeScope('-'), []);
  assert.deepEqual(decodeScope('src/a src/b'), ['src/a', 'src/b']);
});

T('RED-PROOF lanes: a BLANK scope field is unknown, never empty', () => {
  // 64 OPEN rows predate scopes and carry `.` or nothing. Reading those as "writes nothing" would
  // make every one of them stop serializing, which is the unsafe direction.
  assert.deepEqual(decodeScope(''), []);
  const rows = parseLanes([
    'OPEN | a | web | b | w | - | r.md | - | s-a | 2026-08-18T04:00:00Z',
    'OPEN | b | web | b | w | - | r.md | . | s-b | 2026-08-18T04:00:00Z',
  ].join('\n'));
  assert.equal(rows.find((r) => r.lane === 'a').declaredNone, true);
  assert.equal(rows.find((r) => r.lane === 'b').declaredNone, false);
});

T('lanes: a CLOSE with no OPEN still produces a row rather than being dropped', () => {
  const rows = parseLanes('CLOSE | ghost | DONE | yes | yes | yes | yes | yes | 2026-08-18T06:00:00Z |');
  assert.equal(rows[0].lane, 'ghost');
  assert.equal(rows[0].repo, '?');
});

// ---------------------------------------------------------------- Touches: none
T('briefs: `Touches: none` is an empty scope, not a missing one', () => {
  assert.deepEqual(scopeTokens('Touches: none'), []);
  assert.deepEqual(scopeTokens('**Touches:** `read-only`'), []);
  assert.deepEqual(scopeTokens('Touches: zero repo files'), []);
});

T('RED-PROOF briefs: a `Touches:` line with nothing readable is UNDECLARED, never empty', () => {
  // The two look identical downstream and mean opposite things: empty serializes against nobody,
  // undeclared holds the whole repo. An unparseable line must take the safe reading.
  assert.equal(scopeTokens('Touches:'), null);
  assert.equal(scopeTokens('Touches:  -  '), null);
  assert.equal(scopeTokens('no scope line here at all'), null);
});

T('RED-PROOF briefs: a brief that contradicts itself keeps the wider scope', () => {
  assert.deepEqual(scopeTokens('Touches: `none`, `src/app.js`'), ['none', 'src/app.js']);
});

// ---------------------------------------------------------------- Touches: none (...)
// Gov LAMBDA1, 2026-09-06. Measured on the transcript catch-up lane (sync3): its brief declared
// `Touches: none (...)` with a backticked `npm run sync` inside the parenthetical note, and the
// parser read that backticked token as the ONE declared scope span instead of reading the leading
// `none` and treating the parenthetical as a note. `none` followed by anything is `none`.
T('briefs: `Touches: none (...)` reads as none even when the parenthetical carries a backticked token', () => {
  assert.deepEqual(scopeTokens('Touches: none (see the report instead, ran `npm run sync`)'), []);
  assert.deepEqual(scopeTokens('**Touches:** none (nothing changed; verified with `npm run verify`)'), []);
  assert.deepEqual(scopeTokens('Touches: nothing (checked via `git status`)'), []);
  // The real sync3 brief, verbatim, sentence-punctuated with a trailing period after the paren.
  assert.deepEqual(
    scopeTokens('**Touches:** none (this lane runs `npm run sync` and writes no repo file; its output is database rows and the report).'),
    [],
  );
});

T('RED-PROOF briefs: a `Touches: none (...)` parenthetical never becomes the declared scope', () => {
  const tokens = scopeTokens('Touches: none (verified with `npm run sync`)');
  assert.notDeepEqual(tokens, ['npm run sync']);
  assert.deepEqual(tokens, []);
});

// ---------------------------------------------------------------- wrapped Touches:
// Measured 2026-09-05: JULIET1 declared ten paths across seven lines; the OPEN record carried one
// and gate 7 failed the lane on the nine it had declared. The fixture below is that brief's block.
T('RED-PROOF briefs: a `Touches:` declaration that wraps across lines is read whole, not its first line', () => {
  const brief = [
    '# Web JULIET1',
    '',
    '**Touches:** `web/db/functions/_shared/prompt-diet.ts`,',
    '`web/db/functions/run-capability/index.ts`, `web/db/functions/_shared/stage1.ts`,',
    '`web/db/functions/_shared/audience-spec.ts` (read first, edit only if cheap — see below),',
    '`web/scripts/battery1/` (delete), `web/scripts/gates/battery1.mjs` (delete),',
    '`web/scripts/juliet1/unit.mjs` (new), `web/scripts/gates/juliet1.mjs` (new),',
    '`web/scripts/oscar1-unit.mjs`, `web/scripts/stage1/unit.mjs`, `web/scripts/tool2/*`,',
    '`web/docs/GATE-INVENTORY.md`.',
    '',
    '## What this closes',
    'Prose with `a/backtick` that must not be read as scope.',
  ].join('\n');
  assert.deepEqual(scopeTokens(brief), [
    'web/db/functions/_shared/prompt-diet.ts',
    'web/db/functions/run-capability/index.ts',
    'web/db/functions/_shared/stage1.ts',
    'web/db/functions/_shared/audience-spec.ts',
    'web/scripts/battery1/',
    'web/scripts/gates/battery1.mjs',
    'web/scripts/juliet1/unit.mjs',
    'web/scripts/gates/juliet1.mjs',
    'web/scripts/oscar1-unit.mjs',
    'web/scripts/stage1/unit.mjs',
    'web/scripts/tool2/*',
    'web/docs/GATE-INVENTORY.md',
  ]);
});

// ONE HOSTILE LINE MUST NOT STALL EVERY DISPATCHER. Measured before the fix: this exact brief did
// not return within two minutes (catastrophic backtracking on a `Model` line of 60,000 spaces).
// Watched red with a 20-second cap, then fixed: no two adjacent quantifiers eat the same character,
// and every line is capped at MAX_LINE before any regex sees it.
T('RED-PROOF briefs: one line of 60,000 spaces cannot stall the parser (2-second budget)', () => {
  const hostile = `Model${' '.repeat(60000)}`;
  const brief = ['# X', '', '**Touches:** `src/a.ts`,', hostile, '', 'body'].join('\n');
  const t0 = Date.now();
  const out = scopeTokens(brief);
  const ms = Date.now() - t0;
  assert.ok(ms < 2000, `scopeTokens took ${ms} ms`);
  assert.deepEqual(out, ['src/a.ts'], 'the hostile line is not a path and does not lose the declared one');
  const t1 = Date.now();
  assert.equal(fieldLabelOf(`| ${hostile}`), null);
  assert.equal(fieldLabelOf(`**${hostile}`), null);
  for (const f of [notBeforeOf, modelOf, standingOf, priorityOf, filedOf]) f(brief);
  assert.ok(Date.now() - t1 < 2000, 'every field reader sees the same cap');
  assert.ok(MAX_LINE >= 1000 && MAX_LINE <= 10000, 'the cap is generous for a field and small for an attack');
});

T('briefs: a wrapped `Touches:` stops at the next labelled field, a blank line, or a heading', () => {
  // A trailing comma does not turn the next field into a path list.
  assert.deepEqual(scopeTokens('**Touches:** `src/a.ts`,\n**Model:** `medium`\n`src/zzz.ts`'), ['src/a.ts']);
  assert.deepEqual(scopeTokens('| Touches | `src/a.ts`, |\n| Runs beside | `repo-a` |'), ['src/a.ts']);
  assert.deepEqual(scopeTokens('Touches: `src/a.ts`,\n\n`src/b.ts`'), ['src/a.ts']);
  assert.deepEqual(scopeTokens('Touches: `src/a.ts`,\n## Next\n`src/b.ts`'), ['src/a.ts']);
  assert.deepEqual(scopeTokens('Touches: `src/a.ts`\n```\n`src/b.ts`\n```'), ['src/a.ts']);
  // A line opening with a backticked span continues even without a trailing comma before it.
  assert.deepEqual(scopeTokens('Touches: `src/a.ts`\n`src/b.ts`, `src/c.ts`.'), ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  // Plain prose after a comma-free line is not scope.
  assert.deepEqual(scopeTokens('Touches: `src/a.ts`\nand nothing else in `src/b.ts`.'), ['src/a.ts']);
  // Unticked, comma-continued paths still join.
  assert.deepEqual(scopeTokens('Touches: app/a,\napp/b, app/c'), ['app/a', 'app/b', 'app/c']);
  // `Touches: none` stays an empty scope with a field beneath it.
  assert.deepEqual(scopeTokens('Touches: none\n**Model:** `medium`'), []);
});

T('RED-PROOF briefs: a wrap inside an open backtick span continues even when the next line starts with a plain word', () => {
  // No backtick at the start of the continuation line and no comma at the end of the line before it
  // — the two OLD rules both say "stop". The span is still open, so it must continue anyway.
  assert.deepEqual(
    scopeTokens('Touches: `src/very-long-file-name-that-wraps-\nmid-word.ts`, `src/b.ts`'),
    ['src/very-long-file-name-that-wraps-mid-word.ts', 'src/b.ts'],
  );
});

T('RED-PROOF briefs: a wrap inside an open backtick span continues even when the next line would otherwise read as a labelled field', () => {
  // "Model: ..." matches SCOPE_ENDS on its own; inside an open span it cannot be a field.
  assert.deepEqual(
    scopeTokens('Touches: `src/odd-name-\nModel: medium.ts`, `src/b.ts`'),
    ['src/odd-name-Model: medium.ts', 'src/b.ts'],
  );
});

T('RED-PROOF briefs: once an open span closes mid-line, the rest of that line still counts as scope', () => {
  assert.deepEqual(
    scopeTokens('Touches: `src/wrapped-\nname.ts` and also `src/plain.ts`'),
    ['src/wrapped-name.ts', 'src/plain.ts'],
  );
});

T('scope: an empty scope intersects nothing, in both directions', () => {
  assert.equal(scopesIntersect([], ['src/a.js']).intersects, false);
  assert.equal(scopesIntersect(['.'], []).intersects, false);
  assert.equal(scopesIntersect([], []).intersects, false);
});

// ---------------------------------------------------------------- undeclared scope, named where it bites
T('alloc: a queue reason names an undeclared scope as the cause', () => {
  const blocker = { lane: 'gate1', scopeDeclared: false };
  assert.match(undeclaredCause(true, 'pizza1', blocker), /lane gate1 declares no scope/);
  assert.match(undeclaredCause(false, 'pizza1', blocker), /this lane \(pizza1\) and lane gate1 declare/);
  assert.match(undeclaredCause(false, 'pizza1', null), /this lane \(pizza1\) declares no scope/);
});

T('RED-PROOF alloc: two declared scopes never blame an undeclared one', () => {
  // The clause must appear only when it is TRUE. A reason that blames a missing Touches: line on
  // every queued card teaches dispatchers to skip the clause, which is worse than not printing it.
  assert.equal(undeclaredCause(true, 'pizza1', { lane: 'gate1', scopeDeclared: true }), '');
  assert.equal(undeclaredCause(true, 'pizza1', null), '');
});

// ---------------------------------------------------------------- release leaves a record
const CLAIMSTXT = [
  '# preamble',
  'web | Web INDIA1 | 2026-08-25T00:08:00Z | dispatch-lane-india1',
  'docs | Docs LIMA1 | 2026-08-24T23:29:08Z | dispatch-lane-lima1',
].join('\n');

T('claims: a release retires its line as commented history, never deletes it', () => {
  const r = releaseRewrite(CLAIMSTXT, 'dispatch-lane-lima1', '2026-08-25T01:44:00Z');
  assert.equal(r.removed.length, 1);
  assert.match(r.text, /# RELEASED 2026-08-25T01:44:00Z — claim id `dispatch-lane-lima1`/);
  assert.match(r.text, /^#   docs \| Docs LIMA1/m);
});

T('RED-PROOF claims: a retired line can never be re-read as an active claim', () => {
  const r = releaseRewrite(CLAIMSTXT, 'dispatch-lane-lima1', '2026-08-25T01:44:00Z');
  const rows = parseClaims(r.text, Date.parse('2026-08-25T01:45:00Z'));
  assert.equal(rows.rows.filter((c) => !c.malformed).length, 1);
  assert.equal(rows.rows.filter((c) => c.repo === 'docs').length, 0);
});

T('RED-PROOF claims: a release touches only the id it names', () => {
  const r = releaseRewrite(CLAIMSTXT, 'dispatch-lane-lima1', '2026-08-25T01:44:00Z');
  assert.match(r.text, /^web \| Web INDIA1/m);
  assert.equal(releaseRewrite(CLAIMSTXT, 'no-such-id').removed.length, 0);
});

// ---------------------------------------------------------------- disk reclaim
const WT = { name: 'web-x', repo: 'web', isMain: false, dirty: 0, unlanded: false, hasModules: true };

// ---------------------------------------------------------------- exempt is a pass, and says why
T('gates: exempt passes, because a gate that cannot apply is not a failed gate', () => {
  assert.equal(gradeGates({ ...ALLPASS, live: 'exempt' }).status, 'DONE');
});

T('RED-PROOF gates: exempt is NOT a blanket pass — skip still fails', () => {
  assert.equal(gradeGates({ ...ALLPASS, live: 'skip' }).status, 'PARTIAL');
  assert.equal(gradeGates({ ...ALLPASS, live: 'no' }).status, 'PARTIAL');
});

// ---------------------------------------------------------------- git failures are not silence
// gitread's git() returns null on ANY failure, so a sweep running while git is dying prints a
// clean, plausible, entirely fictional board. Named in three lane reports and fixed in none. The
// board cannot distinguish "0 dirty files" from "git could not answer" unless something does.
T('git verdict: a real porcelain answer is measured', () => {
  const v = repoReadState({ porcelain: '', branch: 'main' });
  assert.equal(v.unmeasured, false);
  assert.equal(v.dirty, 0);
});

T('git verdict: counted dirty files are counted', () => {
  const v = repoReadState({ porcelain: ' M a\n?? b', branch: 'main' });
  assert.equal(v.dirty, 2);
  assert.equal(v.unmeasured, false);
});

T('RED-PROOF git verdict: a null from git is UNMEASURED, never a clean tree', () => {
  const v = repoReadState({ porcelain: null, branch: null });
  assert.equal(v.unmeasured, true);
  assert.equal(v.dirty, null);
  assert.match(v.why, /could not answer/);
});

// ---------------------------------------------------------------- lane-open's refusal
// A refusal that cannot say WHO holds the thing is noise, and lanes learn to --queued past it.
// Measured: test1's own OPEN record carries an OVERRIDE against a claim that had already closed.
// REWRITTEN. This assertion used to require the message to say
// `YOU already hold` — the exact sentence that is unknowable and that BETA2 exists to stop being
// asserted. The test encoded the defect, so it had to change with it; noted here rather than
// silently edited. What is still true is that the claim carries this lane's identity, and with no
// worktree reading supplied the liveness of it is UNMEASURED.
T('open refusal: a claim carrying THIS lane\'s identity is named, without asserting whose it is', () => {
  const r = openRefusal({ blockingChat: 'Ops Dispatch', blockingSession: 'dispatch-lane-x', myChat: 'Ops Dispatch', mySession: 'dispatch-lane-x', ageH: 2 });
  assert.equal(r.mine, true);
  assert.match(r.message, /An active claim names THIS lane|active claim names this lane/i);
  assert.ok(!/YOU already hold/i.test(r.message), 'with identical claim lines, whose it is cannot be known');
  assert.ok(!/remove its line/i.test(r.message), 'and it is UNMEASURED, so no removal remedy');
});

T('RED-PROOF open refusal: another session names the holder and how long it has held', () => {
  const r = openRefusal({ blockingChat: 'Web MIKE1', blockingSession: 'dispatch-lane-mike1', myChat: 'Ops Dispatch', mySession: 'dispatch-lane-iota2', ageH: 3.5 });
  assert.equal(r.mine, false);
  assert.match(r.message, /Web MIKE1/);
  assert.match(r.message, /3\.5h/);
});

T('open refusal: a holder with no session field is still named, and the gap is stated', () => {
  const r = openRefusal({ blockingChat: 'Some Lane', blockingSession: null, myChat: 'Ops Dispatch', mySession: 'dispatch-lane-iota2', ageH: 1 });
  assert.equal(r.mine, false);
  assert.match(r.message, /no session field/);
});

// ------------------------------------------------- a refusal that tells you to delete a LIVE claim
//
// Two dispatch sessions were open with an IDENTICAL title, which is normal when several dispatchers
// run at once. Peer A opened a lane. Peer B ran lane-open on the same brief about twenty seconds
// later and was told, verbatim:
//
//     YOU already hold this repo ... which is this same lane.
//     That means a previous run did not stop clean, not that someone else is writing.
//     Close the old lane ... or remove its line from _handoffs/_lanes/CLAIMS.md
//
// Every sentence after the first was wrong and the last was an instruction to break a live lane.
// Peer A's first edits landed in the minute between two status reads of its worktree: clean on the
// first read, three files modified on the second. Had peer B taken the remedy the tool offered, the
// board would have read `web` unclaimed and both sessions would have written the same file. That is
// the report-overwrite collision arriving through the tool built to prevent it.
//
// IT IS NOT A FUZZY-MATCH BUG AND NO MATCHING LOGIC FIXES IT. The fourth field is derived from the
// LANE (`dispatch-lane-quebec1`), so two sessions of one lane produce byte-identical claim lines.
// Identity comparison cannot separate them. The age gate below does not depend on identity at all,
// which is why it is the whole safety win.
//
// The refusal itself was CORRECT — peer B should not have opened. Only the diagnosis and the remedy
// were wrong, so nothing here softens it or adds an override.
T('RED-PROOF beta2: a 30-second-old claim must offer NO removal remedy', () => {
  // The exact shape of the event: same title, same lane-derived session, seconds old.
  const r = openRefusal({
    blockingChat: 'Dispatch A', blockingSession: 'dispatch-lane-quebec1',
    myChat: 'Dispatch A', mySession: 'dispatch-lane-quebec1',
    ageH: 30 / 3600, worktreeDirty: 3,
  });
  assert.ok(!/remove its line/i.test(r.message), 'a fresh claim must never be offered for removal');
  assert.ok(!/lane-close/i.test(r.message), 'nor for closing — closing a live lane is the same damage');
  assert.match(r.message, /may be writing right now/i);
});

T('RED-PROOF beta2: it must STOP asserting "this is the same lane" when that is unknowable', () => {
  // With byte-identical claim lines it cannot be known, so it must not be claimed. Say what is
  // true: an active claim names this lane, and here is how to tell the two cases apart.
  const r = openRefusal({
    blockingChat: 'Dispatch A', blockingSession: 'dispatch-lane-quebec1',
    myChat: 'Dispatch A', mySession: 'dispatch-lane-quebec1',
    ageH: 30 / 3600, worktreeDirty: 3,
  });
  assert.ok(!/which is this same lane/i.test(r.message));
  assert.ok(!/a previous run did not stop clean/i.test(r.message));
});

T('RED-PROOF beta2: a DIRTY worktree means a live writer at ANY age', () => {
  // Look before advising. An old claim whose worktree is dirty is not a crashed session.
  const r = openRefusal({
    blockingChat: 'X', blockingSession: 'dispatch-lane-x', myChat: 'X', mySession: 'dispatch-lane-x',
    ageH: 6, worktreeDirty: 2,
  });
  assert.ok(!/remove its line/i.test(r.message));
  assert.match(r.message, /dirty/i);
});

T('RED-PROOF beta2: a file touched minutes ago means a live writer, however old the claim', () => {
  const r = openRefusal({
    blockingChat: 'X', blockingSession: 'dispatch-lane-x', myChat: 'X', mySession: 'dispatch-lane-x',
    ageH: 9, worktreeDirty: 0, newestTouchMin: 2,
  });
  assert.ok(!/remove its line/i.test(r.message));
  assert.match(r.message, /touched/i);
});

T('beta2: the genuine crashed-session case DOES still get the remedy', () => {
  // The case the old message assumed always held: a claim the board itself has already given up on,
  // a clean worktree, nothing touched recently. This is the only shape where "a previous run did not
  // stop clean" is a fair reading, and suppressing the remedy here would make the refusal useless.
  const r = openRefusal({
    blockingChat: 'X', blockingSession: 'dispatch-lane-x', myChat: 'X', mySession: 'dispatch-lane-x',
    ageH: CLAIM_ACTIVE_HOURS + 1, worktreeDirty: 0, newestTouchMin: 400,
  });
  assert.match(r.message, /remove its line/i);
});

T('RED-PROOF beta2: a QUIET worktree inside the active window is not a dead lane', () => {
  // FOUND BY RUNNING IT LIVE, not by a fixture. Dry-run against the open `india1` lane: claim 1h old,
  // worktree clean, nothing touched for 58 minutes — and the first version handed over the removal
  // remedy. A lane in a long read-and-analyse phase looks exactly like this, and CLAIMS.md already
  // carries the precedent in those words: "Zero commits in web-ground1 is the lane's expected
  // first-phase state ... Do not release this claim on quiet-worktree evidence alone; message this
  // session first."
  //
  // So the remedy needs the board to have given up on the claim first. Below CLAIM_ACTIVE_HOURS a
  // claim is ACTIVE and blocking; above it the board already prints STALE-CLAIM and stops counting
  // it as a writer. Aligning the two means this tool never contradicts the board.
  const r = openRefusal({
    blockingChat: 'X', blockingSession: 'dispatch-lane-x', myChat: 'X', mySession: 'dispatch-lane-x',
    ageH: 1, worktreeDirty: 0, newestTouchMin: 58,
  });
  assert.ok(!/remove its line/i.test(r.message), 'quiet is not dead inside the active window');
  assert.match(r.message, /message that session|ask the holder|in session/i);
});

T('beta2: an UNMEASURED worktree is treated as live, never as crashed', () => {
  // The probe could not look. It must not then advise a removal — same direction as every other
  // unmeasured case in this router: unknown is not a pass.
  const r = openRefusal({
    blockingChat: 'X', blockingSession: 'dispatch-lane-x', myChat: 'X', mySession: 'dispatch-lane-x',
    ageH: 9, worktreeDirty: null, newestTouchMin: null,
  });
  assert.ok(!/remove its line/i.test(r.message));
  assert.match(r.message, /could not/i);
});

T('beta2: a DIFFERENT session holding it is unchanged — that message was already right', () => {
  const r = openRefusal({
    blockingChat: 'Web MIKE1', blockingSession: 'dispatch-lane-mike1',
    myChat: 'Ops Dispatch', mySession: 'dispatch-lane-iota2', ageH: 3.5,
  });
  assert.equal(r.mine, false);
  assert.match(r.message, /ANOTHER SESSION/);
});

T('beta2: the age threshold is stated to the reader, not just applied', () => {
  const r = openRefusal({
    blockingChat: 'X', blockingSession: 'dispatch-lane-x', myChat: 'X', mySession: 'dispatch-lane-x',
    ageH: 30 / 3600, worktreeDirty: 0,
  });
  assert.match(r.message, new RegExp(`${FRESH_CLAIM_MINUTES}`));
});

// ---------------------------------------------------------------- gate 5, report-free
// THE GATE THAT TURNED FINISHED LANES INTO PARTIAL. It asked only "does a file exist at this
// lane's report filename", which is true the moment the lane writes its OWN report — so a lane
// that did everything right was told it was a colliding second session. Measured in one ledger:
// four lanes each closed merged=yes green=yes live=yes and
// were still stamped PARTIAL for exactly this. Four false PARTIALs in one night, and each one also
// held its repo, because lane-close does not release a PARTIAL lane's claim.
//
// The distinguisher is TIME, and the OPEN record already carries it: a report written after this
// lane opened is this lane's own. A report that was already there when it opened belongs to
// somebody else, and that is the real report-overwrite collision the gate exists to catch.
const T0 = Date.parse('2026-08-20T10:00:00Z');

T('gate 5: no file at the report name is free, as before', () => {
  const v = reportFreeVerdict({ exists: false, reportMtimeMs: 0, laneOpenedMs: T0 });
  assert.equal(v.free, true);
  assert.equal(v.own, false);
});

T('gate 5: a report written AFTER the lane opened is the lane\'s own and does not block it', () => {
  const v = reportFreeVerdict({ exists: true, reportMtimeMs: T0 + 60_000, laneOpenedMs: T0 });
  assert.equal(v.free, true);
  assert.equal(v.own, true);
  assert.match(v.why, /own report/);
});

T('RED-PROOF gate 5: a report that predates the lane IS a collision and still refuses', () => {
  const v = reportFreeVerdict({ exists: true, reportMtimeMs: T0 - 60_000, laneOpenedMs: T0 });
  assert.equal(v.free, false);
  assert.match(v.why, /second session/);
});

T('gate 5: an unknown lane-open time falls back to refusing, never to passing', () => {
  const v = reportFreeVerdict({ exists: true, reportMtimeMs: T0, laneOpenedMs: null });
  assert.equal(v.free, false);
  assert.match(v.why, /could not be established/);
});

// ---------------------------------------------------------------- stale git locks
// `git status` used to take .git/index.lock even to read, so a run whose git child was killed left
// the lock behind and every later commit in that repo failed with "Unable to create index.lock".
// Measured repeatedly: orphaned locks jammed a dozen or more repos at once. `--no-optional-locks`
// stops this router CAUSING it, but nothing anywhere DETECTED it — repos silently refused commits
// for most of a day and the only symptom was a confusing error the next time somebody committed.
T('lock: no lock file is the ordinary state and reports nothing', () => {
  const l = classifyLock({ present: false, ageMs: 0 });
  assert.equal(l.locked, false);
  assert.equal(l.stale, false);
});

T('lock: a fresh lock is a live git process, reported but not called stale', () => {
  const l = classifyLock({ present: true, ageMs: 30 * 1000 });
  assert.equal(l.locked, true);
  assert.equal(l.stale, false);
  assert.match(l.why, /may be a git command running right now/);
});

T('RED-PROOF lock: a FUTURE mtime is stale, not fresh — otherwise clock skew hides it forever', () => {
  const l = classifyLock({ present: true, ageMs: -60 * 60 * 1000 });
  assert.equal(l.stale, true);
  assert.match(l.why, /FUTURE/);
});

T('RED-PROOF lock: a lock older than the grace period is STALE and says commits are blocked', () => {
  const l = classifyLock({ present: true, ageMs: 20 * 60 * 1000 });
  assert.equal(l.stale, true);
  assert.match(l.why, /cannot commit/i);
});

// ---------------------------------------------------------------- clearing a stale lock
// classifyLock above only NAMES a stale lock. Nothing acted on it, so several repos sat unable to
// accept a commit until the next morning and were found by hand. sweepDecision is the
// acting half, and every assertion here is about what it must REFUSE to touch: a sweeper that
// removes a lock a live git command is holding corrupts the index it was protecting.
//
// v2 (review findings): the first cut froze the whole sweep whenever ANY git process
// existed on the machine — on a machine that routinely runs many lanes, that sweep stands down
// most of the time. `heldOpen` replaces it: is some process holding THIS lock file open right now?
// That is per-file and race-free, because git creates a lock with create-exclusive — once an
// unheld lock exists, no future process can ever come to hold it; it can only be in the way.
// And `bytes` is new: a genuine orphan is always ZERO bytes (git creates the lock empty and fills
// it only at the end), so a NON-empty stale lock is a mid-write index snapshot — odd enough that
// it is reported loudly, never auto-cleared.
T('sweep: nothing to do when there is no lock', () => {
  const d = sweepDecision({ present: false, ageMs: 0, bytes: 0, heldOpen: false });
  assert.equal(d.action, 'none');
});

// AMENDED: this used to pass `heldOpen: true` alone, because held-by-anything
// was the whole test. It is now held-by-GIT, which is what the assertion always meant. A holder that
// is NOT git is a blocker, and its own red-proofs live in a lock-sweep integration test, which can
// plant a real file and hold a real descriptor.
T('RED-PROOF sweep: a lock a GIT process holds OPEN is never touched, however old it looks', () => {
  const d = sweepDecision({ present: true, ageMs: 48 * 60 * 60 * 1000, bytes: 0, heldOpen: true, holderIsGit: true });
  assert.equal(d.action, 'leave');
  assert.match(d.why, /holding/i);
});

T('RED-PROOF sweep: a lock held by a NON-GIT process is a BLOCKER, not an all-clear "leave"', () => {
  const d = sweepDecision({ present: true, ageMs: 48 * 60 * 60 * 1000, bytes: 0, heldOpen: true, holderIsGit: false });
  assert.equal(d.action, 'blocked');
  assert.match(d.why, /cannot commit/i);
});

T('RED-PROOF sweep: a lock inside the grace period is left alone — it may be a live command', () => {
  const d = sweepDecision({ present: true, ageMs: 30 * 1000, bytes: 0, heldOpen: false });
  assert.equal(d.action, 'leave');
});

T('sweep: an empty, unheld, stale lock is the proven orphan signature and is cleared', () => {
  const d = sweepDecision({ present: true, ageMs: 20 * 60 * 1000, bytes: 0, heldOpen: false });
  assert.equal(d.action, 'clear');
});

T('RED-PROOF sweep: a NON-empty stale lock is reported, not auto-cleared — it is not the orphan signature', () => {
  const d = sweepDecision({ present: true, ageMs: 20 * 60 * 1000, bytes: 812, heldOpen: false });
  assert.equal(d.action, 'report');
  assert.match(d.why, /not empty/i);
});

T('RED-PROOF sweep: a FUTURE-dated empty lock is cleared, not treated as fresh forever', () => {
  const d = sweepDecision({ present: true, ageMs: -60 * 60 * 1000, bytes: 0, heldOpen: false });
  assert.equal(d.action, 'clear');
});

// The blind spot that left many lanes jammed for days: a lane checkout's lock does NOT live in the
// lane folder. Its `.git` is a FILE pointing home, and the real lock is
// `<parent>/.git/worktrees/<lane>/index.lock`. The first sweeper only looked at `<dir>/.git/` as a
// DIRECTORY, so every lane lock was invisible and "no lock anywhere" was printed over every jam.
// AMENDED: HEAD.lock joined the fixed list. `index.lock` blocks add and
// commit; `HEAD.lock` blocks everything that moves the branch pointer, and one repo
// held one of each while this function named neither. Ref locks are a filesystem
// walk (refLockFiles) and are covered end-to-end in a lock-sweep integration test.
T('RED-PROOF lock sites: a plain checkout contributes BOTH of its own lock paths', () => {
  const sites = lockSites({ name: 'docs', hasGitDir: true, laneNames: [] });
  assert.deepEqual(sites.map((s) => s.rel), ['.git/index.lock', '.git/HEAD.lock']);
});

T('RED-PROOF lock sites: a checkout with lanes contributes both lock paths PER LANE as well', () => {
  const sites = lockSites({ name: 'web', hasGitDir: true, laneNames: ['web-dest1', 'web-fid5'] });
  assert.deepEqual(sites.map((s) => s.rel), [
    '.git/index.lock',
    '.git/HEAD.lock',
    '.git/worktrees/web-dest1/index.lock',
    '.git/worktrees/web-dest1/HEAD.lock',
    '.git/worktrees/web-fid5/index.lock',
    '.git/worktrees/web-fid5/HEAD.lock',
  ]);
  assert.equal(sites[2].lane, 'web-dest1');
});

T('lock sites: a lane folder itself (whose .git is a file, not a directory) contributes nothing', () => {
  const sites = lockSites({ name: 'web-dest1', hasGitDir: false, laneNames: [] });
  assert.deepEqual(sites, []);
});

// ---------------------------------------------------------------- gate 3's diff base
// Reported by lane ops-l1 (2026-08-19) and not fixed there: lane-close measured a proof string's
// novelty against merge-base(origin/main, branch). The workspace's own doctrine is that lanes merge
// and push their own work — and the moment they do, origin/main contains the branch, that merge-base
// becomes the branch tip, the branch's own diff is empty, and every proof string is REFUSED. A lane
// that followed the rules could not close, scored PARTIAL, and never released its claim.
const TIP = 'ffff111';

T('RED-PROOF gate 3 base: a candidate equal to the branch tip is refused, because its diff is empty', () => {
  const c = chooseProofBase({ mergeBase: TIP, branchTip: TIP });
  assert.equal(c.base, null);
  assert.match(c.why, /already contained in origin\/main/);
});

T('gate 3 base: after a self-merge, main-as-of-lane-open is used instead of the merge base', () => {
  const c = chooseProofBase({ atOpen: 'aaa000', mergeBase: TIP, branchTip: TIP });
  assert.equal(c.base, 'aaa000');
  assert.equal(c.source, 'main-at-lane-open');
});

T('gate 3 base: a base recorded at lane-open beats both the timestamp lookup and the merge base', () => {
  const c = chooseProofBase({ recorded: 'bbb111', atOpen: 'aaa000', mergeBase: 'ccc222', branchTip: TIP });
  assert.equal(c.base, 'bbb111');
  assert.equal(c.source, 'recorded-at-open');
});

T('gate 3 base: an explicit --base beats every derived candidate', () => {
  const c = chooseProofBase({ explicit: 'ddd333', recorded: 'bbb111', atOpen: 'aaa000', mergeBase: 'ccc222', branchTip: TIP });
  assert.equal(c.base, 'ddd333');
  assert.equal(c.source, 'explicit');
});

T('gate 3 base: an unmerged branch still uses its merge base, so nothing about the old path changed', () => {
  const c = chooseProofBase({ mergeBase: 'ccc222', branchTip: TIP });
  assert.equal(c.base, 'ccc222');
  assert.equal(c.source, 'merge-base');
});

T('RED-PROOF gate 3 base: no usable candidate returns null and says so, rather than guessing one', () => {
  const c = chooseProofBase({ branchTip: TIP });
  assert.equal(c.base, null);
  assert.equal(c.source, 'none');
  assert.match(c.why, /Nothing was measured/);
});

// ---------------------------------------------------------------- gate 4's filename match
// Found 2026-08-20 while proving the gate-3 fix above: gate 4 asked whether the brief filename
// CONTAINS the lane id, so lane `ops-l1` matched `Ops-L1b-Collector-And-Defects.md` and was told its
// own brief was still live when that file belongs to a different lane.
T('RED-PROOF gate 4: a lane id that is only a PREFIX of another lane id does not match its brief', () => {
  assert.equal(briefMatchesLane('Ops-L1b-Collector-And-Defects.md', 'ops-l1'), false);
});

T('gate 4: a lane matches its own brief, whatever the case', () => {
  assert.equal(briefMatchesLane('Ops-L1-Deploy-Attribution.md', 'ops-l1'), true);
  assert.equal(briefMatchesLane('superseded-2026-08-19-Ops-L1-Deploy-Attribution.md', 'ops-l1'), true);
});

T('gate 4: the longer lane id still matches its own brief', () => {
  assert.equal(briefMatchesLane('Ops-L1b-Collector-And-Defects.md', 'ops-l1b'), true);
});

T('RED-PROOF gate 4: a lane id embedded inside a longer word is not a match', () => {
  assert.equal(briefMatchesLane('Web-ALPHA12-Something.md', 'alpha1'), false);
  assert.equal(briefMatchesLane('Web-ALPHA1-Everything.md', 'alpha1'), true);
});

// ---------------------------------------------------------------- in-place lanes
// Reported by lanes os-l1c AND ops-m1 on the same day (2026-08-19) and fixed by neither: lane-alloc
// offers cards targeting the workspace root, and lane-open refused every one of them because it tried
// to add a worktree to a directory that is not a git repository. Both lanes wrote their claim by hand.
T('a git target still gets a worktree lane, unchanged', () => {
  const p = laneOpenPlan({ repo: 'web', branch: 'uniform2-load', checkout: 'web-uniform2', repoIsGit: true });
  assert.equal(p.mode, WORKTREE);
  assert.equal(p.branch, 'uniform2-load');
  assert.equal(p.worktree, 'web-uniform2');
});

T('a non-git target gets an in-place lane instead of a refusal', () => {
  const p = laneOpenPlan({ repo: 'root', branch: 'os-l1c-install-the', checkout: 'root-os-l1c', repoIsGit: false });
  assert.equal(p.mode, IN_PLACE);
  assert.match(p.why, /not a git repository/);
});

T('RED-PROOF an in-place lane proposes no branch and no worktree, so nothing can be created in it', () => {
  const p = laneOpenPlan({ repo: 'root', branch: 'os-l1c-install-the', checkout: 'root-os-l1c', repoIsGit: false });
  assert.equal(p.branch, null);
  assert.equal(p.worktree, null);
});

T('gate 1 reads a branchless lane as n/a, never as an unmeasured skip', () => {
  assert.equal(isBranchless('-'), true);
  assert.equal(isBranchless(''), true);
  assert.equal(isBranchless('uniform2-load'), false);
});

T('an in-place lane is never a worktree removal candidate', () => {
  assert.equal(worktreeRemovable({ repo: 'root', worktree: '-', registered: [] }).ok, false);
});

T('board: an unset or placeholder report name is never looked up on disk', () => {
  assert.deepEqual(reportOnBridge('/nonexistent-dir-xyz', '?'), { found: false, prefix: null, name: null });
  assert.deepEqual(reportOnBridge('/nonexistent-dir-xyz', '-'), { found: false, prefix: null, name: null });
  assert.deepEqual(reportOnBridge('/nonexistent-dir-xyz', ''), { found: false, prefix: null, name: null });
});

T('lane key: a continuation suffix is the same lane', () => {
  assert.equal(laneKey('hotel2-b'), 'hotel2');
  assert.equal(laneKey('transcripts-l1-c'), 'transcripts-l1');
  assert.equal(laneKey('foxtrot1-w3a'), 'foxtrot1');
  assert.equal(laneKey('gamma1'), 'gamma1');
});

T('RED-PROOF lane key: it is NOT prefix matching', () => {
  // The whole reason this is a token rule and not a string prefix. `oscar1` and `fix10` are different
  // lanes, and a matcher that folded them would refuse a live brief on a stranger's close record.
  assert.notEqual(laneKey('oscar1'), laneKey('fix10'));
  assert.notEqual(laneKey('mike1'), laneKey('press6'));
  // An id with no lane token is its own key rather than being truncated to something shorter.
  assert.equal(laneKey('algo-j6r'), 'algo-j6r');
});

const CLOSED_LEDGER = [
  { lane: 'kappa1', status: 'PARTIAL', closed: '2026-08-25T13:49:52Z', report: 'done-kappa1.md', branch: 'kappa1-x', worktree: 'web-kappa1' },
  { lane: 'oscar1', status: 'DONE', closed: '2026-08-26T17:33:53Z', report: 'done-oscar1.md', branch: 'oscar1-x', worktree: 'web-oscar1' },
  { lane: 'live1', status: 'OPEN', closed: null, report: 'done-live1.md', branch: 'live1-x', worktree: 'web-live1' },
];

T('close ledger: a lane that already closed is found', () => {
  const v = closedUnrenamedVerdict('oscar1', CLOSED_LEDGER);
  assert.ok(v, 'a DONE close was not found');
  assert.equal(v.status, 'DONE');
  assert.match(v.headline, /CLOSED-UNRENAMED \(closed 2026-08-26, status DONE\)/);
  assert.match(v.headline, /done-oscar1\.md/, 'the verdict must name the report to read');
});

T('close ledger: a PARTIAL close counts, because the brief is still live either way', () => {
  assert.equal(closedUnrenamedVerdict('kappa1', CLOSED_LEDGER)?.status, 'PARTIAL');
});

T('RED-PROOF close ledger: an OPEN lane is NOT a close', () => {
  // The expensive inversion. A lane still running would be read as finished work, and its brief
  // would be refused to the dispatch that is meant to be watching it.
  assert.equal(closedUnrenamedVerdict('live1', CLOSED_LEDGER), null);
  assert.equal(closedUnrenamedVerdict('neverran1', CLOSED_LEDGER), null);
});

T('close ledger: the NEWEST close is the one reported', () => {
  const two = [
    { lane: 'bench1', status: 'PARTIAL', closed: '2026-08-24T01:00:00Z', report: 'a.md' },
    { lane: 'bench1', status: 'DONE', closed: '2026-08-24T09:00:00Z', report: 'b.md' },
  ];
  assert.equal(closedUnrenamedVerdict('bench1', two).status, 'DONE');
});

T('Standing: the declared value exempts, and only that value', () => {
  assert.equal(standingOf('# X\n\nStanding: refire-until-passed\n'), 'refire-until-passed');
  assert.equal(standingOf('**Standing:** refire-until-passed'), 'refire-until-passed');
  assert.ok(refiresAfterClose(standingOf('Standing: refire-until-passed')));
});

T('RED-PROOF Standing: a typo does NOT exempt, and prose is not a field', () => {
  // Both directions of the fuzzy-matching refusal this router applies everywhere. A misspelt value
  // silently reading as "fire forever" would disable the guard on the one brief whose author was
  // trying to configure it; an English sentence opening with the word Standing is not a field.
  assert.equal(refiresAfterClose(standingOf('Standing: refire-until-past')), false);
  assert.equal(refiresAfterClose(standingOf('Standing orders say to stop clean.')), false);
  assert.equal(refiresAfterClose(null), false);
});

T('alloc: a card whose lane already closed is refused and named', () => {
  const policy = { repos: new Map([['web', { tier: 1, writers: 4, port: 5173, deploy: 'push', verify: { kind: 'none' }, url: null, traps: [], exclusive: [] }]]) };
  const brief = { file: 'Web-OSCAR1-Six-Defects.md', targets: ['web'], scope: ['src'] };
  const { cards } = allocate({ briefs: [brief], policy, claims: [], closedLanes: CLOSED_LEDGER, date: '2026-08-28' });
  assert.match(cards[0].firesAfter ?? '', /CLOSED-UNRENAMED/);
  assert.equal(cards[0].closedBefore.status, 'DONE');
});

T('RED-PROOF alloc: `Standing: refire-until-passed` fires anyway, and the card still says it closed', () => {
  // Both halves matter. The exemption must actually fire the card, and it must NOT hide the close —
  // a dispatcher who cannot see that the check ran cannot tell an exemption from a broken gate.
  const policy = { repos: new Map([['web', { tier: 1, writers: 4, port: 5173, deploy: 'push', verify: { kind: 'none' }, url: null, traps: [], exclusive: [] }]]) };
  const brief = { file: 'Web-KAPPA1-The-Whole-Wheel.md', targets: ['web'], scope: ['data'], standing: 'refire-until-passed' };
  const { cards } = allocate({ briefs: [brief], policy, claims: [], closedLanes: CLOSED_LEDGER, date: '2026-08-28' });
  assert.equal(cards[0].firesAfter, null, 'a standing brief was refused');
  assert.equal(cards[0].standingRefire, true);
  assert.ok(cards[0].closedBefore, 'the close was hidden instead of reported');
});

T('board: the recent-closes window keeps what is inside it and drops what is not', () => {
  const now = Date.parse('2026-08-28T12:00:00Z');
  const rows = recentCloses(
    [
      { lane: 'a', status: 'DONE', closed: '2026-08-28T06:00:00Z', report: 'a.md' },
      { lane: 'b', status: 'PARTIAL', closed: '2026-08-27T06:00:00Z', report: 'b.md' },
      { lane: 'old', status: 'DONE', closed: '2026-08-20T06:00:00Z', report: 'o.md' },
      { lane: 'open', status: 'OPEN', closed: null, report: 'x.md' },
    ],
    { now, hours: 48 },
  );
  assert.deepEqual(rows.map((r) => r.lane), ['a', 'b'], 'newest first, window respected, OPEN excluded');
});

T('resume: a PARTIAL close is the one explanation that reopens a checkout', () => {
  const v = resumeVerdict({ checkoutExists: true, lane: { lane: 'bench1', status: 'PARTIAL', closed: '2026-08-24T09:00:00Z', branch: 'bench1-x' } });
  assert.equal(v.resume, true);
  assert.match(v.why, /closed PARTIAL/);
});

T('RED-PROOF resume: every other existing directory is still a hard refusal', () => {
  // The collision the original refusal was built for is untouched. Four shapes, and the OPEN one is
  // the dangerous one: a lane that may still be running, whose folder existing proves nothing.
  const no = (lane) => assert.equal(resumeVerdict({ checkoutExists: true, lane }).resume, false);
  no(null);                                                        // unexplained directory
  no({ lane: 'x1', status: 'OPEN', closed: null });                 // may still be running
  no({ lane: 'x1', status: 'DONE', closed: '2026-08-24T09:00:00Z' }); // a full pass removes its own folder
  no({ lane: 'x1', status: 'BLOCKED', closed: '2026-08-24T09:00:00Z' });
});

T('resume: no checkout is an ordinary open, not a resume', () => {
  assert.equal(resumeVerdict({ checkoutExists: false, lane: { lane: 'x1', status: 'PARTIAL', closed: 'z' } }).resume, false);
});

T('claims: an active claim past the suspect age is flagged while it is still blocking', () => {
  const now = Date.parse('2026-08-28T12:00:00Z');
  const at = (h) => new Date(now - h * 3_600_000).toISOString();
  const { rows } = parseClaims(
    `web | fresh | ${at(1)} | s1\nweb | suspect | ${at(8)} | s2\nweb | stale | ${at(20)} | s3\n`,
    now,
  );
  assert.deepEqual(rows.map((r) => [r.chat, r.suspect, r.stale]), [
    ['fresh', false, false],
    ['suspect', true, false],
    ['stale', false, true],
  ]);
});

T('RED-PROOF claims: the suspect flag fires INSIDE the active window, or it is decorative', () => {
  // The whole reason this threshold is not the 24h the brief named. Past CLAIM_ACTIVE_HOURS a claim
  // is already STALE-CLAIM and already blocking nothing, so a flag that could only fire there would
  // never once change an outcome. It must be strictly inside the window.
  assert.ok(CLAIM_SUSPECT_HOURS < CLAIM_ACTIVE_HOURS, 'the suspect flag can only fire on claims that are already stale');
  assert.ok(CLAIM_SUSPECT_HOURS > 0);
  // And it must catch the incidents it was built for: the longest dead claims measured ran
  // between six and nine hours.
  for (const h of [6.5, 7.8, 8.7]) assert.ok(h > CLAIM_SUSPECT_HOURS && h <= CLAIM_ACTIVE_HOURS, `${h}h would not have been flagged`);
});

// ---------------------------------------------------------------- gate 7: where the commit walk starts
// Found by a dispatcher. playbook1 and playbook2 both graded PARTIAL on
// in-scope=skip with every declared path in scope. Cause: the dispatcher merged each branch into
// main with a merge commit (first parent main, second parent the lane's tip) and then fast-forwarded
// the branch onto that merge. The first-parent walk from such a tip descends MAIN's side, never
// visits the lane's own commits, and is left holding only the neighbours' commits — which it
// correctly refuses to attribute, so the gate reads skip on a lane that breached nothing.
T('RED-PROOF gate 7: a tip that is main\'s landing merge walks from its SECOND parent', () => {
  const r = walkTipFor({ tip: 'L', parents: ['M1', 'T1'], mainFP: new Set(['L', 'M1', 'M0']), formerTips: new Set(['T1', 'T0', 'B']) });
  assert.equal(r.tip, 'T1', 'the lane\'s commits hang off the landing merge\'s second parent');
  assert.ok(r.why && r.why.includes('landing merge'), 'the redirect says why, so the close prints it');
});

// Second shape, found the same evening: playbook1's branch
// had been fast-forwarded PAST its own landing merge to a later main head that was ablate1's
// landing merge. The second-parent redirect then walked ablate1's commits as playbook1's and
// graded NO on 18 of ablate1's paths — a false red, which is worse than the skip it replaced.
// The branch's own reflog is the identity: a landing merge is this lane's only if its second
// parent was once this branch's tip. Anything else reads SKIP, never a guessed NO.
T('RED-PROOF gate 7: a landing merge whose second parent was NEVER this branch\'s tip is not this lane\'s — SKIP, never NO', () => {
  const r = walkTipFor({ tip: 'L2', parents: ['M2', 'A_tip'], mainFP: new Set(['L2', 'M2', 'L1', 'M1']), formerTips: new Set(['L1', 'T1', 'T0']) });
  assert.equal(r.tip, null, 'a neighbour\'s tip must never become this lane\'s walk start');
  assert.ok(r.why && r.why.startsWith('SKIP'), 'the caller must read this as an unmeasured gate');
});

T('RED-PROOF gate 7: no reflog at all means no identity, so a redirect is refused', () => {
  const r = walkTipFor({ tip: 'L', parents: ['M1', 'T1'], mainFP: new Set(['L', 'M1']) });
  assert.equal(r.tip, null);
  assert.ok(r.why && r.why.startsWith('SKIP'));
});

T('gate 7: the lane\'s own fresh-base merge (first parent = the lane) is walked as it is', () => {
  const r = walkTipFor({ tip: 'W', parents: ['T1', 'M1'], mainFP: new Set(['M1', 'M0']) });
  assert.equal(r.tip, 'W');
  assert.equal(r.why, null);
});

T('gate 7: a plain commit on main\'s line, or a merge off it, is never redirected', () => {
  assert.equal(walkTipFor({ tip: 'C', parents: ['B'], mainFP: new Set(['C']) }).tip, 'C',
    'a NON-merge tip on main\'s line is the old fast-forward-landing shape and keeps its existing handling');
  assert.equal(walkTipFor({ tip: 'X', parents: ['A', 'B'], mainFP: new Set(['M0']) }).tip, 'X');
  assert.equal(walkTipFor({ tip: 'Z', parents: [], mainFP: new Set(['Z']) }).tip, 'Z', 'no parents means nothing to redirect to');
});

T('RED-PROOF ledger: a LAND record folds into its lane as the permanent landing identity', () => {
  const lanes = parseLanes([
    'OPEN | x1 | web | x1-branch | web-x1 | 5173 | done-2026-09-03-web-x1-a.md | src | dispatch-lane-x1 | 2026-09-03T00:00:00Z | aaaa',
    'LAND | x1 | web | x1-branch | bbbb | cccc | Web-X1-A.md | done-2026-09-03-web-x1-a.md | 2026-09-03T01:00:00Z',
  ].join('\n'));
  const l = lanes.find((r) => r.lane === 'x1');
  assert.equal(l.land.tip, 'bbbb');
  assert.equal(l.land.merge, 'cccc');
  assert.equal(l.land.brief, 'Web-X1-A.md');
  assert.equal(l.land.report, 'done-2026-09-03-web-x1-a.md');
  assert.equal(l.land.at, '2026-09-03T01:00:00Z');
});

T('RED-PROOF ledger: a lane with no LAND record reads land = null, never a guessed sha', () => {
  const lanes = parseLanes('OPEN | x2 | web | x2-branch | web-x2 | 5173 | done-x2.md | src | dispatch-lane-x2 | 2026-09-03T00:00:00Z | aaaa');
  assert.equal(lanes.find((r) => r.lane === 'x2').land, null);
});

T('RED-PROOF ledger: a LAND record for a lane with no OPEN row still parses, so an old lane can be landed by hand', () => {
  const lanes = parseLanes('LAND | x3 | web | x3-branch | bbbb | cccc | Web-X3.md | done-x3.md | 2026-09-03T01:00:00Z');
  const l = lanes.find((r) => r.lane === 'x3');
  assert.ok(l && l.land && l.land.merge === 'cccc');
});

T('RED-PROOF gate 7: a LAND record wins over every parent or reflog heuristic', () => {
  const r = walkStartFor({ land: { tip: 'T_land', merge: 'M_land' }, tip: 'L2', parents: ['M2', 'A_tip'], mainFP: new Set(['L2', 'M2']), formerTips: new Set() });
  assert.equal(r.tip, 'T_land', 'the recorded pre-landing tip is the walk start');
  assert.ok(r.why && r.why.includes('LAND'), 'the note says the identity came from the ledger');
});

T('gate 7: without a LAND record walkStartFor is exactly walkTipFor', () => {
  const args = { tip: 'L', parents: ['M1', 'T1'], mainFP: new Set(['L', 'M1']), formerTips: new Set(['T1']) };
  assert.deepEqual(walkStartFor({ land: null, ...args }), walkTipFor(args));
  assert.deepEqual(walkStartFor(args), walkTipFor(args));
});

T('RED-PROOF land: the merge message names lane, brief, report, branch tip, scope and the one-command revert', () => {
  const m = landMessage({ repo: 'web', lane: 'x1', brief: 'Web-X1-A-Title.md', report: 'done-2026-09-03-web-x1-a.md', branch: 'x1-branch', tip: 'bbbb1234bbbb1234', scope: ['src', 'docs/x1'] });
  assert.ok(m.startsWith(`Merge branch 'x1-branch' into main: land lane x1`), m.split('\n')[0]);
  // The subject is what git itself writes for a merge, because web's commit-msg hook and
  // check-commit-label.mjs exempt exactly that prefix and refuse any `[class]` outside their list.
  // `[merge]` was refused on every landing until 2026-09-03; a subject that ends in a bracket tag
  // would be checked against the class list again.
  assert.ok(/^Merge branch /.test(m.split('\n')[0]), 'the subject is a git merge subject, exempt from the label hook');
  assert.ok(!/\[[a-z]+\]$/.test(m.split('\n')[0]), 'the subject carries no bracket class for the hook to refuse');
  for (const s of ['Lane: x1', 'Brief: Web-X1-A-Title.md', 'Report: done-2026-09-03-web-x1-a.md', 'Branch: x1-branch @ bbbb1234', 'Scope: src docs/x1', 'git revert -m 1'])
    assert.ok(m.includes(s), `missing "${s}"`);
});

T('RED-PROOF land: a missing brief or report is written as such, never blank', () => {
  const m = landMessage({ repo: 'web', lane: 'x1', brief: null, report: null, branch: 'b', tip: 'abcdef12', scope: [] });
  assert.ok(m.includes('Brief: (none found on the bridge)'));
  assert.ok(m.includes('Report: (none named)'));
  assert.ok(m.includes('Scope: (whole repo)'));
});

T('RED-PROOF land: every refusal refuses, and the order is the order a dispatcher can act on', () => {
  const ok = { branchless: false, onMain: true, dirty: 0, alreadyContained: false, containsMain: true };
  assert.equal(landRefusal(ok).ok, true);
  assert.equal(landRefusal({ ...ok, branchless: true }).ok, false, 'an in-place lane has nothing to land');
  assert.equal(landRefusal({ ...ok, onMain: false }).ok, false, 'the repo checkout must be on main');
  assert.equal(landRefusal({ ...ok, dirty: 2 }).ok, false, 'a dirty main checkout is never merged into');
  assert.equal(landRefusal({ ...ok, alreadyContained: true }).ok, false, 'already on main means nothing to land');
  const fresh = landRefusal({ ...ok, containsMain: false });
  assert.equal(fresh.ok, false, 'the fresh-base rule: the branch must contain origin/main first');
  assert.ok(fresh.why.includes('merge origin/main'), 'the refusal says what to run');
});

T('RED-PROOF land: in a repo with no remote the fresh-base refusal names a ref that exists', () => {
  // Found landing a lane on a deliberately remote-less repo (one holding records that must never
  // be pushed), so `git merge-base --is-ancestor
  // origin/main <tip>` ERRORS rather than answering, the caller read that as "does not contain
  // main", and the lane was refused with an instruction that could not run either. The caller now
  // resolves the base once and passes it here; these assertions hold the refusal text to it.
  const ok = { branchless: false, onMain: true, dirty: 0, alreadyContained: false, containsMain: true };
  const local = landRefusal({ ...ok, containsMain: false, base: 'main', worktree: 'local-local1' });
  assert.equal(local.ok, false, 'the fresh-base rule still applies without a remote');
  assert.ok(local.why.includes('git -C local-local1 merge main'), 'the refusal tells a local-only repo to merge main, a ref it actually has');
  assert.ok(!local.why.includes('origin/main'), 'it never names origin/main in a repo that has no origin');
  const remote = landRefusal({ ...ok, containsMain: false, worktree: 'web-x1' });
  assert.ok(remote.why.includes('git -C web-x1 merge origin/main'), 'the remote case is unchanged and still the default');
});

T('RED-PROOF land: a fast-forward is never offered — the message is a merge-commit message, not a ff instruction', () => {
  const m = landMessage({ repo: 'web', lane: 'x1', brief: 'B.md', report: 'R.md', branch: 'b', tip: 'abcdef12', scope: [] });
  assert.ok(!/fast-forward/i.test(m) && !/--ff/.test(m));
});


// ---------------------------------------------------------------- PAPA1 step 5: the findings write
//
// A report block is the one artifact HQ reads and the one that cannot be verified — the standing rules says
// so in the section that made every receipt line carry counted/derived/inherited. Writing those
// lines into a table at close time is what turns them from prose into something queryable. It is
// MECHANICAL inside the close and never left to session discipline, which is the condition the owner
// attached when he approved it.
const FENCE = '```';

const REPORT_FIXTURE = [
  '# Gov PAPA1 — a lane report',
  '',
  'Prose above the block is not a receipt and must never be written as one.',
  '',
  FENCE,
  'Gov PAPA1 — 2026-08-30 — PARTIAL',
  '',
  '- the state probe shipped with three subjects: counted',
  '- the lint cut untagged corpus hits from 39 to 19: derived',
  '',
  'Defects found and NOT fixed:',
  '- web.web_runs is unreachable by every credential here: counted',
  '- the governance hook did not fire on an ordinary edit',
  '',
  'DESIGN-GATE: n/a, no rendered surface touched',
  FENCE,
].join('\n');

T('findings: every receipt in the report block becomes one row, typed by its section', () => {
  const p = parseReportFindings(REPORT_FIXTURE);
  assert.equal(p.ok, true);
  assert.equal(p.rows.length, 3);
  assert.deepEqual(p.rows.map((r) => r.finding_type), ['outcome', 'outcome', 'defect']);
  assert.deepEqual(p.rows.map((r) => r.provenance), ['counted', 'derived', 'counted']);
  assert.match(p.rows[2].fact, /web_runs is unreachable/);
});

T('RED-PROOF findings: a receipt with NO provenance word is never written, and the row is named', () => {
  // The table's own CHECK constraint allows only counted/derived/inherited, so a line carrying none
  // cannot be written at all. The failure mode that matters is writing it under a guessed word —
  // that would manufacture a provenance nobody claimed, which is the exact error the provenance
  // rule exists to prevent. It is refused and printed instead.
  const p = parseReportFindings(REPORT_FIXTURE);
  assert.equal(p.unwritable.length, 1);
  assert.match(p.unwritable[0].text, /governance hook did not fire/);
  assert.match(p.unwritable[0].why, /provenance/i);
  for (const r of p.rows) assert.ok(PROVENANCE_WORDS.includes(r.provenance));
});

T('findings: the status header line and the DESIGN-GATE line are not receipts', () => {
  const p = parseReportFindings(REPORT_FIXTURE);
  const all = [...p.rows.map((r) => r.fact), ...p.unwritable.map((u) => u.text)].join('\n');
  assert.doesNotMatch(all, /2026-08-30 — PARTIAL/);
  assert.doesNotMatch(all, /DESIGN-GATE/);
});

T('RED-PROOF findings: prose outside the fenced block is NEVER written as a finding', () => {
  const p = parseReportFindings(REPORT_FIXTURE);
  const all = [...p.rows.map((r) => r.fact), ...p.unwritable.map((u) => u.text)].join('\n');
  assert.doesNotMatch(all, /Prose above the block/);
});

T('RED-PROOF findings: a QUOTED close transcript never shadows the real report block', () => {
  // Found the first time this ran on a real report, 2026-08-30. An honest report about the close
  // machinery quotes the close's own output, and that transcript carries the line `STATUS PARTIAL`.
  // "The first block with a status word" locked onto the transcript, found no bullets, and wrote
  // nothing — while twelve receipts sat in the real block further down.
  const doc = [
    'Gate 8 observed RED, verbatim:',
    '',
    FENCE,
    '  8. roadmap       no     no roadmap row named',
    '  STATUS PARTIAL',
    FENCE,
    '',
    '## Report block',
    '',
    FENCE,
    'Gov X — 2026-08-30 — PARTIAL',
    '',
    '- the thing that actually shipped: counted',
    FENCE,
  ].join('\n');
  const p = parseReportFindings(doc);
  assert.equal(p.ok, true);
  assert.equal(p.rows.length, 1);
  assert.match(p.rows[0].fact, /the thing that actually shipped/);
});

T('RED-PROOF findings: no fenced report block writes NOTHING and says so — it never guesses a block', () => {
  const p = parseReportFindings('# a document\n\nsome prose, no report block anywhere\n');
  assert.equal(p.ok, false);
  assert.equal(p.rows.length, 0);
  assert.match(p.why, /fenced report block/i);
});

T('findings: every finding_type is one the destination allows', () => {
  // The destination allows four kinds: outcome, health, defect, fact.
  const p = parseReportFindings(REPORT_FIXTURE);
  for (const r of p.rows) assert.ok(FINDING_TYPES.includes(r.finding_type), `${r.finding_type} would be rejected by the table`);
});

T('findings: the RPC argument names are the function\'s own, and evidence points at the report line', () => {
  const p = parseReportFindings(REPORT_FIXTURE);
  const a = findingArgs(p.rows[0], { lane: 'papa1', repo: 'root', dispatch: '/dispatch-gov', status: 'PARTIAL', session: 'x', report: 'partial-x.md' });
  assert.deepEqual(Object.keys(a).sort(), [
    'p_dispatch', 'p_evidence', 'p_fact', 'p_finding_type', 'p_lane', 'p_provenance', 'p_repo', 'p_session', 'p_status', 'p_subject',
  ]);
  assert.match(a.p_evidence, /partial-x\.md line \d+/);
  assert.equal(a.p_status, 'PARTIAL');
});

// ------------------------------------------ the report's name follows the grade, on disk as well
//
// THE DEFECT, 2026-09-05. lane-close --apply accepted a report sitting at the `done-` slot for a
// lane it graded PARTIAL, recorded the CLOSE against the `partial-` name, and then printed
// "partial-2026-09-05-scripts-romeo1-archive-the-bridge.md is not on disk yet, so there is no report
// block to read. Nothing written." The report was on disk the whole time, under the prefix
// lane-open had reserved. A dispatcher renamed it by hand afterwards.
//
// reportNameForStatus has followed the grade since 2026-08-30, but only in the string the ledger
// records. Nothing reconciled that string with the prefix the file was actually found under, so the
// findings write looked for a file nobody had written and said so as though the lane had not
// reported. The rename now happens, prints its own undo the way the brief rename already does, and
// the findings are read from the renamed file.

const TIDY_DONE = 'done-2026-09-05-scripts-romeo1-archive-the-bridge.md';

const TIDY_PARTIAL = 'partial-2026-09-05-scripts-romeo1-archive-the-bridge.md';

T('close: gradedReportRename refuses rather than merge two reports this lane wrote itself', () => {
  const p = gradedReportRename({ graded: TIDY_PARTIAL, found: [TIDY_DONE], targetOwn: true, targetTaken: false });
  assert.equal(p.ok, false);
  assert.match(p.why, /already/i);
});

// ------------------------------------------ the report's own STATUS word follows the grade too
//
// THE DEFECT. gradedReportRename above renames the FILENAME to match the gate grade; a separate
// sweep renames it to match the STATUS word INSIDE the report. A lane that writes "STATUS: DONE"
// while the gates grade PARTIAL made the two rename the file in opposite directions forever —
// seven collisions on one bridge in one night, all "NOT RENAMED: target already exists".
// overrideReportStatusWord rewrites the
// disagreeing word in place, using report-check.mjs's own findStatus so it can never rewrite a
// line the sweep would not itself read as the status.

const DONE_BLOCK = ['# a report', '', '```', 'STATUS: DONE', '  shipped it — counted', '```'].join('\n');

T('RED-PROOF status-override: a body claiming DONE is rewritten to the grade the gates actually gave', () => {
  const r = overrideReportStatusWord({ text: DONE_BLOCK, gradedStatus: 'PARTIAL', gradedLabel: 'PARTIAL (scope)', stamp: '2026-09-09T00:00:00Z' });
  assert.equal(r.changed, true);
  assert.equal(r.from, 'DONE');
  assert.match(r.text, /STATUS: PARTIAL/);
  assert.doesNotMatch(r.text, /STATUS: DONE/);
  assert.match(r.text, /graded by lane-close 2026-09-09T00:00:00Z, overrides the lane's own DONE claim above/);
});

T('status-override: a report already at the grade\'s word is left untouched', () => {
  const body = ['# a report', '', '```', 'STATUS: PARTIAL', '  something unfinished — counted', '```'].join('\n');
  const r = overrideReportStatusWord({ text: body, gradedStatus: 'PARTIAL', gradedLabel: 'PARTIAL (scope)', stamp: '2026-09-09T00:00:00Z' });
  assert.equal(r.changed, false);
  assert.equal(r.text, body, 'the bytes are untouched when nothing disagrees');
});

function findingsReadFollowsRename(src) {
  const rename = src.indexOf('= reconcileReportName(');
  const reads = [...src.matchAll(/await writeFindings\(\{[^}]*\}\)/g)];
  const problems = [];
  if (rename < 0) problems.push('no report rename call in the close');
  if (!reads.length) problems.push('no findings write in the close');
  for (const m of reads) {
    if (rename >= 0 && m.index < rename) problems.push(`findings write at offset ${m.index} runs BEFORE the rename at ${rename}`);
    if (!/readFrom:\s*nameFix\.source/.test(m[0])) problems.push(`findings write at offset ${m.index} does not read from the rename's source name`);
  }
  return { ok: problems.length === 0, reads: reads.length, problems };
}

T('RED-PROOF close ordering: the pre-fix close shape (findings read at the graded name, no rename) is refused', () => {
  // This is the close body as it stood before 6342d0c: the findings write named the graded file and
  // nothing had moved the report there. Observed red against that revision on 2026-09-05.
  const preFix = [
    '  if (!apply) {',
    '    await writeFindings({ rec, rp, status: graded.status, report, apply: false });',
    '    process.exit(1);',
    '  }',
    '  recordClose(ROOT, { lane });',
    '  await writeFindings({ rec, rp, status: graded.status, report, apply: true });',
  ].join('\n');
  const v = findingsReadFollowsRename(preFix);
  assert.equal(v.ok, false);
  assert.ok(v.problems.some((p) => /no report rename/.test(p)));
  // A rename that exists but sits AFTER the read is the same defect wearing a different order.
  const renameLast = `${preFix}\n  const nameFix = reconcileReportName({ bridge, graded: report, owned, laneOpenedMs, apply });\n`;
  const w = findingsReadFollowsRename(renameLast.replace(/apply: (false|true) \}\)/g, 'readFrom: nameFix.source, apply: $1 })'));
  assert.equal(w.ok, false);
  assert.ok(w.problems.some((p) => /BEFORE the rename/.test(p)));
});

// ------------------------------------------------ the provenance word sits where the rule puts it
//
// THE DEFECT, 2026-09-05. The parser demanded the provenance word at the END of the line. the standing rules
// puts it in the MIDDLE by design — "Every receipt line names its provenance in one word: counted,
// derived, or inherited. Counted names the query or command", and its own worked example reads
// `do-not-cite rows: 94 — counted, select count(*) ... where do_not_cite is true`. So 17 receipt
// lines across two reports were refused for obeying the rule they were written to.
//
// The word is now accepted anywhere in the line as a whole word, preferring the first occurrence
// after the value separator. What comes after it is the METHOD — the query or command the rule says
// the word names — and it is carried into the evidence string rather than thrown away. A line with
// no provenance word anywhere still refuses, and nothing here ever guesses one.
const MID_LINE_FIXTURE = [
  FENCE,
  'Gov ROMEO1 — 2026-09-05 — PARTIAL',
  '',
  '- Skipped as dirty: 1 — counted, web-echo2, `git status --porcelain` shows 1 uncommitted change',
  '- Linked worktrees found: 27 across 10 repos (26 repos scanned in total) — counted, `node scripts/worktree-inventory.mjs`',
  '- the lint cut untagged corpus hits from 39 to 19: derived',
  '- the governance hook did not fire on an ordinary edit',
  FENCE,
].join('\n');

T('RED-PROOF findings: a provenance word in the MIDDLE of the line is accepted, not refused', () => {
  const p = parseReportFindings(MID_LINE_FIXTURE);
  assert.equal(p.rows.length, 3, 'the two mid-line receipts and the trailing one are all writable');
  assert.deepEqual(p.rows.map((r) => r.provenance), ['counted', 'counted', 'derived']);
  assert.equal(p.rows[0].fact, 'Skipped as dirty: 1');
  assert.equal(p.rows[1].fact, 'Linked worktrees found: 27 across 10 repos (26 repos scanned in total)');
});

T('findings: what follows the provenance word is the METHOD and is kept, not discarded', () => {
  const p = parseReportFindings(MID_LINE_FIXTURE);
  assert.equal(p.rows[0].method, 'web-echo2, `git status --porcelain` shows 1 uncommitted change');
  assert.equal(p.rows[1].method, '`node scripts/worktree-inventory.mjs`');
  assert.equal(p.rows[2].method, '', 'a trailing provenance word names no method, and an invented one would be a lie');
});

T('findings: the method reaches the row the RPC writes, in the evidence string', () => {
  const p = parseReportFindings(MID_LINE_FIXTURE);
  const a = findingArgs(p.rows[1], { lane: 'romeo1', repo: 'scripts', dispatch: '/dispatch-gov', status: 'PARTIAL', session: 'x', report: 'partial-x.md' });
  assert.match(a.p_evidence, /partial-x\.md line \d+/);
  assert.match(a.p_evidence, /worktree-inventory\.mjs/);
  assert.deepEqual(Object.keys(a).sort(), [
    'p_dispatch', 'p_evidence', 'p_fact', 'p_finding_type', 'p_lane', 'p_provenance', 'p_repo', 'p_session', 'p_status', 'p_subject',
  ], 'no new RPC argument — PostgREST resolves by argument name and an unknown one is a 404');
});

T('RED-PROOF findings: a line with no provenance word ANYWHERE is still refused', () => {
  const p = parseReportFindings(MID_LINE_FIXTURE);
  assert.equal(p.unwritable.length, 1);
  assert.match(p.unwritable[0].text, /governance hook did not fire/);
  assert.match(p.unwritable[0].why, /provenance/i);
});

// ---------------------------------------------------------------- PAPA1 step 5b: uncommitted work
//
// worktreeRemovable already refused three cases. The fourth is the one the standing rules has said was
// missing since 2026-08-22: a target holding uncommitted work. git itself refuses a dirty removal
// without --force, so this is belt and braces — but the refusal git prints is a stderr string
// nobody grades, and a deterministic refusal is what the workspace asked for.
T('RED-PROOF worktree: a target holding UNCOMMITTED WORK may not be removed', () => {
  const p = worktreeRemovable({
    repo: 'web', worktree: 'web-x1', registered: ['web', 'web-x1'],
    dirty: [' M src/app.tsx', '?? notes.md'],
  });
  assert.equal(p.ok, false);
  assert.match(p.why, /uncommitted/i);
});

T('worktree: every refusal names WHICH condition tripped', () => {
  assert.equal(worktreeRemovable({ repo: 'web', worktree: 'web', registered: ['web'] }).condition, 'own-checkout');
  assert.equal(worktreeRemovable({ repo: 'web', worktree: 'ghost', registered: ['web'] }).condition, 'not-registered');
  assert.equal(worktreeRemovable({
    repo: 'web', worktree: 'web-x1', registered: ['web', 'web-x1'],
    worktreeAbs: '/code/web-x1', cwd: '/code/web-x1',
  }).condition, 'session-cwd');
  assert.equal(worktreeRemovable({
    repo: 'web', worktree: 'web-x1', registered: ['web', 'web-x1'], dirty: [' M a.ts'],
  }).condition, 'uncommitted-work');
  assert.equal(worktreeRemovable({ repo: 'web', worktree: 'web-x1', registered: ['web', 'web-x1'] }).condition, null);
});

T('worktree: an EMPTY dirty list is a clean tree, not an unmeasured one', () => {
  assert.equal(worktreeRemovable({ repo: 'web', worktree: 'web-x1', registered: ['web', 'web-x1'], dirty: [] }).ok, true);
});

T('worktree: omitting dirty keeps the previous three-refusal behaviour exactly', () => {
  // Backwards compatibility again: a caller that cannot measure the tree must not be refused as
  // though it had measured a dirty one. Unmeasured is not the same as dirty, and git still refuses.
  assert.equal(worktreeRemovable({ repo: 'web', worktree: 'web-x1', registered: ['web', 'web-x1'], dirty: null }).ok, true);
});

// ---------------------------------------------------------------- the PARTIAL filename defect
//
// Found by review. reportFor() always produces `done-<date>-...`, and lane-close
// recorded that name into LANES.md whatever the close graded. So a PARTIAL lane's ledger record
// pointed at a file that does not exist, because PREFIXES.md defines `partial-` for exactly this
// case and the lane correctly filed its report under that name.
T('RED-PROOF naming: a PARTIAL close NEVER computes a done- report filename', () => {
  const n = reportNameForStatus('done-2026-08-30-code-papa1-give-code-a.md', 'PARTIAL');
  assert.equal(n, 'partial-2026-08-30-code-papa1-give-code-a.md');
  assert.ok(!n.startsWith('done-'), 'the ledger would point at a file that does not exist');
});

T('naming: DONE keeps done-, BLOCKED becomes blocked-', () => {
  const base = 'done-2026-08-30-web-x-y.md';
  assert.equal(reportNameForStatus(base, 'DONE'), base);
  assert.equal(reportNameForStatus(base, 'BLOCKED'), 'blocked-2026-08-30-web-x-y.md');
});

T('naming: a name carrying no lifecycle prefix GAINS the status one rather than being left bare', () => {
  assert.equal(reportNameForStatus('2026-08-30-web-x-y.md', 'PARTIAL'), 'partial-2026-08-30-web-x-y.md');
});

T('naming: an unknown status changes nothing, so a caller cannot invent a prefix', () => {
  assert.equal(reportNameForStatus('done-x.md', 'MAYBE'), 'done-x.md');
  assert.equal(reportNameForStatus('done-x.md', undefined), 'done-x.md');
  assert.deepEqual(Object.keys(PREFIX_FOR_STATUS).sort(), ['BLOCKED', 'DONE', 'PARTIAL']);
});

T('naming: the -parallel-session-B suffix survives a status rename', () => {
  assert.equal(
    reportNameForStatus('done-2026-08-30-web-x-y-parallel-session-B.md', 'PARTIAL'),
    'partial-2026-08-30-web-x-y-parallel-session-B.md',
  );
});

T('roadmap: a MISSING roadmap field reads n/a, so every pre-gate-8 ledger line stays valid', () => {
  assert.equal(gradeGates({ merged: 'yes', green: 'yes', live: 'yes', renamed: 'yes', reportFree: 'yes' }).status, 'DONE');
});

// ---------------------------------------------------------------- the actions shelf (TANGO1)
//
// Fourteen assertions, of which six assert a REFUSAL or a named gap. The two that matter most are
// the unrouted ones: a target with no row must survive routing as a named row, because the failure
// this whole helper exists to prevent is a story the owner filed sitting at `filed` forever while every
// seat's run prints nothing.

const ACT_TBL = `<!-- table: actions -->

| target | repo |

|---|---|

| Web | web |

| STATS | stats |

| Repo-a | repo-a |

| Personal | - |

`;

// A stand-in for the policy object: only the repos map's dispatch column is read.
const ACT_POLICY = { repos: new Map([
  ['web', { dispatch: 'web' }],
  ['gamma', { dispatch: 'apps' }],
  ['repo-a', { dispatch: 'ops' }],
]) };

// ------------------------------------------------------------------- open-loops shelf
//
// The shelf command every dispatch runs after alloc only ever read one table; a second open-loop
// table nothing at dispatch time ever printed. A seat could run the shelf, see nothing filed, and
// never learn a loop against its own repo had sat open for weeks. This section proves the routing
// and the fetch in isolation before either is wired into the CLI.

const LOOPS_POLICY = {
  repos: new Map([
    ['web', { repo: 'web', dispatch: 'web' }],
    ['repo-a', { repo: 'repo-a', dispatch: 'ops' }],
    ['local', { repo: 'local', dispatch: 'apps' }],
    ['beta', { repo: 'beta', dispatch: 'research' }],
    ['gamma', { repo: 'gamma', dispatch: 'apps' }],
    ['alpha-pipeline', { repo: 'alpha-pipeline', dispatch: 'research' }],
    ['policy-pipeline', { repo: 'policy-pipeline', dispatch: 'research' }],
    ['scripts', { repo: 'scripts', dispatch: 'gov' }],
    ['root', { repo: 'root', dispatch: 'gov' }],
  ]),
};

const LOOP_ROWS = [
  { id: 'item_1', product: 'web', title: 'a' },
  { id: 'item_2', product: 'repo-a', title: 'b' },
  { id: 'item_3', product: 'gamma', title: 'c' },
  { id: 'item_4', product: 'alpha', title: 'd' },
  { id: 'item_5', product: 'beta', title: 'e' },
];

const HARVEST_REPOS = new Map([
  ['root', { dispatch: 'gov' }],
  ['web', { dispatch: 'web' }],
  ['api', { dispatch: 'apps' }],
]);

// ------------------------------------------------ a lane's own codename is registered by the board
//
// THE DEFECT, 2026-09-05. Both `# Gov ROMEO1 — archive the bridge and repair the root` and the
// papa1 report's own H1 were refused as "not a registered lane codename", with the plain words
// sitting in the same sentence, because a lane codename was only ever registered by a hand-written
// VOCABULARY.json row. Registration now comes from the board itself: an OPEN record in LANES.md, or
// a brief on the bridge whose filename carries the codename, and the plain name is that brief's own
// title words. Nothing about the same-sentence rule moved.

const LANES_FIXTURE = [
  '# LANES — fixture',
  'OPEN | romeo1 | scripts | romeo1-archive-the-bridge | scripts-romeo1 | - | done-2026-09-05-scripts-romeo1-archive-the-bridge.md | _handoffs | dispatch-lane-romeo1 | 2026-09-05T10:45:05Z | 50c2289',
  'OPEN | papa1 | root | - | - | - | done-2026-09-05-root-papa1-give-code-a.md | scripts | dispatch-lane-papa1 | 2026-09-05T10:45:09Z | -',
  'CLOSE | romeo1 | PARTIAL | yes | n/a | n/a | yes | yes | 2026-09-05T11:03:09.569Z | in-scope=skip | n/a | skip | yes',
].join('\n');

const BRIEFS_FIXTURE = [
  'consumed-Gov-ROMEO1-Archive-The-Bridge-And-Repair-The-Root.md',
  'consumed-Gov-PAPA1-Give-Code-A-Map-Of-What-It-Cannot-See.md',
  'partial-2026-09-05-scripts-romeo1-archive-the-bridge.md',
  'partial-2026-09-05-code-papa1-give-code-a.md',
];

// A lane landed twice, its brief was consumed off the bridge, and its report's H1 carried the
// plain words beside the codename — refused, because the plain name was read only off a bridge
// filename. The LAND record carries that filename, so the ledger supplies it.
const X12_LANES = [
  'OPEN | x12 | web | x12-widget | web-x12 | 5186 | done-2026-09-06-web-x12-widget-four-sizes.md | src | dispatch-lane-x12 | 2026-09-06T12:51:51Z | 10bb46f',
  'LAND | x12 | web | x12-widget | 96a3c65 | 6dc3620 | Web-X12-Widget-Four-Sizes.md | done-2026-09-06-web-x12-widget-four-sizes.md | 2026-09-06T14:29:45.877Z',
].join('\n');


// ---------------------------------------------------------------- run

let pass = 0;
const fails = [];
for (const t of tests) {
  try { t.fn(); pass++; } catch (e) { fails.push({ name: t.name, message: e.message }); }
}
for (const f of fails) console.log(`FAIL  ${f.name}\n      ${String(f.message).split('\n')[0]}`);
const red = tests.filter((t) => /RED-PROOF/.test(t.name)).length;
console.log(`ROUTER UNIT ASSERTIONS  ${pass}/${tests.length} pass, ${fails.length} fail`);
console.log(`  ${red} of them are RED-PROOF: each asserts a refusal, so weakening a guard turns them red.`);
if (fails.length) throw new Error(`router-test.mjs: ${fails.length}/${tests.length} assertion(s) failed.`);
