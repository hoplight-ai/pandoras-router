// scope-prop-test.mjs — property tests for lib/scope.mjs, plus the built-in exclusive list.
// No filesystem writes, no git, no network, no dependency: the generator is twenty lines of
// linear congruential arithmetic below.
//
// WHY PROPERTIES. The hand-picked scope assertions in router-test.mjs each pin one spelling the
// module once got wrong. A generator reaches spellings nobody picked: `~/work//web/App/./x//`,
// a glob in the third segment of a path that also climbs with `..`, a repo name in capitals.
// Six properties, each run PROP_CASES times (default 3000) against fresh inputs:
//
//   1. intersection is symmetric
//   2. a path intersects itself
//   3. a directory intersects every path under it
//   4. a normalised path intersects every raw spelling of itself
//   5. two paths with no common first segment after normalisation never intersect
//   6. widening (a glob to its parent, an escape to the whole repo, an exclusive promotion) never
//      makes an intersecting pair disjoint
//
// REPLAY. The seed is printed on every run and in every failure line. `PROP_SEED=<n> npm test`
// replays a run exactly; `PROP_CASES=<n>` changes the count. A failure line carries the seed, the
// case number, both raw inputs and both normalised forms, on ONE line, because the runner prints
// only the first line of a message.
//
// It throws on failure rather than calling process.exit(), so the runner that imports several of
// these files cannot mask a red with its own later exit call.

import assert from 'node:assert/strict';
// Namespace import on purpose: a named import of an export that does not exist yet is a link
// error that fails the WHOLE file, and the built-in-list assertions below were written to be
// watched failing one at a time before the export existed.
import * as S from '../src/lib/scope.mjs';

const { normalizePath, normalizeScope, pathsIntersect, scopesIntersect, applyExclusive, setWorkspacePrefixes, WHOLE_REPO } = S;

const tests = [];
const T = (name, fn) => tests.push({ name, fn });

// The same synthetic workspace prefix router-test.mjs installs; module state is shared across the
// suites in one process, so this suite sets it explicitly rather than inheriting it by run order.
const PREFIX = '~/work/';
const REPO = 'web';
setWorkspacePrefixes([PREFIX]);

// ---------------------------------------------------------------- the generator
// A linear congruential generator (Numerical Recipes constants). 32-bit state, seeded once per
// run from the environment or the clock, so every case is replayable from one printed number.
const SEED = Number.isInteger(Number(process.env.PROP_SEED)) && process.env.PROP_SEED !== ''
  ? Number(process.env.PROP_SEED) >>> 0
  : ((Date.now() ^ (process.pid << 12)) >>> 0);
const CASES = Number(process.env.PROP_CASES) > 0 ? Number(process.env.PROP_CASES) : 3000;
let state = SEED >>> 0;
const rnd = () => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state / 4294967296;
};
const int = (n) => Math.floor(rnd() * n);
const pick = (arr) => arr[int(arr.length)];
const chance = (p) => rnd() < p;
const flipCase = (s) => s.split('').map((c) => (chance(0.5) ? c.toUpperCase() : c.toLowerCase())).join('');

// Segment alphabet. Deliberately includes pairs where one is a string prefix of the other
// (`app`/`application`, `lib`/`lib2`, `a`/`a.b`) because segment containment is the trap the
// header of scope.mjs names, and the repo's own name so the strip-once rule is exercised.
const NAMES = ['a', 'b', 'app', 'application', 'lib', 'lib2', 'src', 'db', 'migrations', 'x.ts', 'page.tsx', 'a.b', 'web', 'scripts'];
const GLOBS = ['*', '**', '*.ts', 'a*', '*x'];
const OUTERS = ['', '', '', './', '/', `${REPO}/`, `${PREFIX}${REPO}/`];
const TAILS = ['', '', '', '/', '//', '/*', '/**'];

const fold = (s, ci) => (ci ? String(s).toLowerCase() : String(s));
const segsOf = (p) => (p === WHOLE_REPO ? [] : p.split('/'));

function genSegment({ dots = true, globs = true } = {}) {
  const r = rnd();
  if (dots && r < 0.12) return chance(0.5) ? '.' : '..';
  if (globs && r < 0.22) return pick(GLOBS);
  if (r < 0.35) return flipCase(pick(NAMES));
  return pick(NAMES);
}

/** A raw declaration as a brief might spell it: 1-5 segments, prefix, doubled slashes, tail, backticks, spaces. */
function genRaw(opts = {}) {
  const k = 1 + int(5);
  const segs = [];
  for (let i = 0; i < k; i++) segs.push(genSegment(opts));
  let t = pick(OUTERS) + segs.join('/') + pick(TAILS);
  if (chance(0.25)) t = doubleASlash(t);
  if (chance(0.15)) t = `\`${t}\``;
  if (chance(0.1)) t = ` ${t} `;
  return t;
}

function doubleASlash(t) {
  const idx = [...t].map((c, i) => (c === '/' ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return t;
  const i = pick(idx);
  return `${t.slice(0, i)}/${t.slice(i)}`;
}

/** A normalised path that is a real directory-or-file inside the repo, never WHOLE_REPO. */
function genInside() {
  for (;;) {
    const n = normalizePath(genRaw({ dots: false, globs: false }), REPO);
    if (!n || n === WHOLE_REPO) continue;
    // A canonical path whose first segment is the repo's own name (`web/x`, from a raw
    // `web/web/x`) is inside the repo but re-strips if it is ever passed back through
    // normalizePath. That is the documented strip-once rule, not a defect, and the properties
    // that rebuild raw spellings from a canonical path skip it rather than assert on an
    // ambiguity the module has already ruled on. (Seen on the first run: seed 2937245016.)
    if (fold(n.split('/')[0], true) === REPO) continue;
    return n;
  }
}

/** A raw path guaranteed to sit at or under `dir`: no `..`, so it can never climb out. */
function genChildRaw(dir) {
  const k = int(4);
  const segs = [];
  for (let i = 0; i < k; i++) segs.push(genSegment({ dots: false, globs: chance(0.3) }));
  if (chance(0.2)) segs.push('.');
  let t = `${dir}/${segs.join('/')}${pick(TAILS)}`;
  if (chance(0.25)) t = doubleASlash(t);
  return t;
}

/**
 * Re-spell a canonical path the way a brief might, so property 4 can demand the module read it
 * back to the same token. Returns { raw, cased } where `cased` says letter case was flipped
 * somewhere, which is only an identity on a case-insensitive disk.
 */
function dirtify(n) {
  let cased = false;
  let body;
  if (n === WHOLE_REPO) {
    body = pick(['', '.', '*', '**', './']);
  } else {
    const segs = n.split('/');
    const out = [];
    for (const s of segs) {
      if (chance(0.2)) out.push('.');
      if (chance(0.15)) out.push('zz', '..');
      out.push(s);
    }
    body = out.join('/');
  }
  // Outer wrappers in a FIXED order (prefix+repo outermost, then `./` or `/`), because
  // `./web/app` is a folder named web inside the repo, not the repo — that spelling is not an
  // alias and is not generated here.
  const outer = pick(['', '', `${REPO}/`, `${PREFIX}${REPO}/`]);
  // A canonical path whose first segment folds to the repo's name (`wEB/x.ts`, from a raw
  // `web/wEB/x.ts`) re-strips if it is spelled bare, by the strip-once rule genInside also
  // skips. So with no outer wrapper it always gets `./` or `/`, which the module reads as a folder
  // inside the repo. (Seen on seed 3076105467, case 172.)
  const firstIsRepo = n !== WHOLE_REPO && fold(n.split('/')[0], true) === REPO;
  const inner = n === WHOLE_REPO ? '' : firstIsRepo && outer === '' ? pick(['./', '/']) : pick(['', '', './', '/']);
  let raw = outer + inner + body;
  if (n === WHOLE_REPO && (raw === '' || raw === `${REPO}/` || raw === `${PREFIX}${REPO}/`)) {
    // an empty raw is null, not WHOLE_REPO; `web/` and the prefixed form are already the repo
    if (raw === '') raw = pick(['.', REPO, `${PREFIX}${REPO}`, `${REPO}/`]);
  }
  if (n !== WHOLE_REPO) raw += pick(TAILS);
  if (chance(0.3)) raw = doubleASlash(raw);
  if (chance(0.3)) raw = doubleASlash(raw);
  if (chance(0.15)) raw = `\`${raw}\``;
  if (chance(0.1)) raw = `  ${raw}\t`;
  if (chance(0.25)) { raw = flipCase(raw); cased = true; }
  return { raw, cased };
}

// ---------------------------------------------------------------- the harness
const fmt = (v) => JSON.stringify(v);
/** Throws a one-line, replayable failure. */
function fail(prop, i, what, fields) {
  const detail = Object.entries(fields).map(([k, v]) => `${k}=${fmt(v)}`).join(' ');
  throw new Error(`property ${prop} case ${i} seed=${SEED} (replay: PROP_SEED=${SEED}) ${detail} : ${what}`);
}

function runProperty(prop, fn) {
  let checks = 0;
  for (let i = 0; i < CASES; i++) checks += fn(i) ?? 1;
  return checks;
}

const counts = {};

// ---------------------------------------------------------------- property 1: symmetric
T('property 1: pathsIntersect and scopesIntersect are symmetric', () => {
  counts[1] = runProperty(1, (i) => {
    const ra = genRaw(), rb = genRaw();
    const a = normalizePath(ra, REPO), b = normalizePath(rb, REPO);
    if (a === null || b === null) return 0;
    for (const ci of [true, false]) {
      const ab = pathsIntersect(a, b, { caseInsensitive: ci }), ba = pathsIntersect(b, a, { caseInsensitive: ci });
      if (ab !== ba) fail(1, i, `pathsIntersect not symmetric (ci=${ci}): ${ab} vs ${ba}`, { ra, rb, a, b });
    }
    const sa = normalizeScope([ra, genRaw()], REPO), sb = normalizeScope([rb, genRaw(), genRaw()], REPO);
    if (scopesIntersect(sa, sb).intersects !== scopesIntersect(sb, sa).intersects)
      fail(1, i, 'scopesIntersect not symmetric', { ra, rb, sa, sb });
    return 1;
  });
});

// ---------------------------------------------------------------- property 2: reflexive
T('property 2: every normalised path intersects itself, under either case rule', () => {
  counts[2] = runProperty(2, (i) => {
    const r = genRaw();
    const n = normalizePath(r, REPO);
    if (n === null) return 0;
    for (const ci of [true, false])
      if (!pathsIntersect(n, n, { caseInsensitive: ci })) fail(2, i, `a path does not intersect itself (ci=${ci})`, { r, n });
    if (!scopesIntersect([n], [n]).intersects) fail(2, i, 'a one-path scope does not intersect itself', { r, n });
    return 1;
  });
});

// ---------------------------------------------------------------- property 3: containment
T('property 3: a directory intersects every path under it, in any spelling of the child', () => {
  counts[3] = runProperty(3, (i) => {
    const dir = genInside();
    const rc = genChildRaw(dir);
    const child = normalizePath(rc, REPO);
    // construction check: with no `..` in the suffix the child can only be the dir or under it
    if (child !== dir && !child.startsWith(`${dir}/`)) fail(3, i, 'child left its directory without a `..`', { dir, rc, child });
    for (const ci of [true, false])
      if (!pathsIntersect(dir, child, { caseInsensitive: ci })) fail(3, i, `directory does not contain its child (ci=${ci})`, { dir, rc, child });
    if (!scopesIntersect([dir], [child]).intersects) fail(3, i, 'scope of the directory misses the child', { dir, rc, child });
    return 1;
  });
});

// ---------------------------------------------------------------- property 4: raw spelling
T('property 4: a normalised path reads back from every raw spelling of itself and intersects it', () => {
  counts[4] = runProperty(4, (i) => {
    const seedRaw = genRaw();
    const n = normalizePath(seedRaw, REPO);
    if (n === null) return 0;
    const { raw, cased } = dirtify(n);
    const m = normalizePath(raw, REPO, { caseInsensitive: true });
    if (m === null) fail(4, i, 'a re-spelling of a real path normalised to nothing', { n, raw });
    if (fold(m, true) !== fold(n, true)) fail(4, i, 'the re-spelling normalised to a DIFFERENT token (case-folded)', { seedRaw, n, raw, m });
    if (!pathsIntersect(n, m, { caseInsensitive: true })) fail(4, i, 'a path does not intersect its own re-spelling (ci=true)', { n, raw, m });
    if (!cased) {
      // no letter was flipped, so the identity must hold on a case-sensitive disk too
      const ms = normalizePath(raw, REPO, { caseInsensitive: false });
      if (ms !== n) fail(4, i, 'the uncased re-spelling normalised to a different token (ci=false)', { seedRaw, n, raw, ms });
      if (!pathsIntersect(n, ms, { caseInsensitive: false })) fail(4, i, 'a path does not intersect its own re-spelling (ci=false)', { n, raw, ms });
    }
    return 1;
  });
});

// ---------------------------------------------------------------- property 5: disjoint
T('property 5: two paths whose first segments differ after normalisation never intersect', () => {
  counts[5] = runProperty(5, (i) => {
    // b is redrawn until its first segment differs from a's even case-folded, so every case is a
    // real check under both case rules rather than a skipped pair.
    const a = genInside();
    let b = genInside();
    while (fold(segsOf(b)[0], true) === fold(segsOf(a)[0], true)) b = genInside();
    const fa = segsOf(a)[0], fb = segsOf(b)[0];
    let checked = 0;
    for (const ci of [true, false]) {
      if (fold(fa, ci) === fold(fb, ci)) fail(5, i, `construction: first segments meant to differ (ci=${ci})`, { a, b });
      checked++;
      if (pathsIntersect(a, b, { caseInsensitive: ci })) fail(5, i, `no common first segment yet intersect (ci=${ci})`, { a, b });
    }
    // and across whole scopes: every cross pair with differing first segments must be disjoint
    const sa = [a, genInside()], sb = [b, genInside()];
    const allDiffer = sa.every((p) => sb.every((q) => fold(segsOf(p)[0], true) !== fold(segsOf(q)[0], true)));
    if (allDiffer) {
      checked++;
      if (scopesIntersect(sa, sb).intersects) fail(5, i, 'scopes with no shared first segment intersect', { sa, sb });
    }
    return checked ? 1 : 0;
  });
});

// ---------------------------------------------------------------- property 6: widening
T('property 6: widening a declaration never makes an intersecting pair disjoint', () => {
  counts[6] = runProperty(6, (i) => {
    const a = genInside();
    // b is built to intersect a: a itself, a child, an ancestor, or the whole repo
    const kind = int(4);
    const b = kind === 0 ? a
      : kind === 1 ? normalizePath(genChildRaw(a), REPO)
      : kind === 2 ? (segsOf(a).slice(0, 1 + int(segsOf(a).length)).join('/') || WHOLE_REPO)
      : WHOLE_REPO;
    if (!pathsIntersect(a, b)) fail(6, i, 'construction: the pair was meant to intersect', { a, b });

    // (a) an unparseable segment: a glob in segment k widens a to its first k segments
    const segs = segsOf(a);
    const k = int(segs.length);
    const globbed = [...segs.slice(0, k), pick(GLOBS), ...segs.slice(k + 1)].join('/');
    const wa = normalizePath(globbed, REPO);
    if (!pathsIntersect(wa, b)) fail(6, i, 'glob widening made the pair disjoint', { a, b, globbed, wa });

    // (b) an escape: `../` in front widens to the whole repo
    const escaped = normalizePath(`../${a}`, REPO);
    if (escaped !== WHOLE_REPO) fail(6, i, 'an escaping path did not widen to the whole repo', { a, escaped });
    if (!pathsIntersect(escaped, b)) fail(6, i, 'escape widening made the pair disjoint', { a, b, escaped });

    // (c) an exclusive promotion on either side, with a list that may or may not name them
    const ex = [];
    if (chance(0.5)) ex.push(segs.slice(0, 1 + int(segs.length)).join('/'));
    if (chance(0.5)) ex.push(genInside());
    const A = applyExclusive([a], ex).scope, B = applyExclusive([b], ex).scope;
    if (!scopesIntersect(A, B).intersects) fail(6, i, 'exclusive promotion made the pair disjoint', { a, b, ex, A, B });
    if (!scopesIntersect(B, A).intersects) fail(6, i, 'exclusive promotion made the pair disjoint (reversed)', { a, b, ex, A, B });
    return 1;
  });
});

// ---------------------------------------------------------------- defects the properties found
// Each was reached by property 4 on the module as it stood on 2026-09-14 and is pinned here as a
// fixed case so it stays red-proof when the generator's seed moves on. Both are the same failure:
// a spelling of a path INSIDE the repo read as a different path, so a lane declaring it was
// carded disjoint from a lane declaring the plain form. Silent narrowing, the one thing the
// header of scope.mjs forbids.
T('RED-PROOF scope: a doubled slash before or inside the workspace prefix still strips the prefix and repo', () => {
  // Before the fix `~/work//web/app` read as `web/app`, a folder that does not exist, disjoint from `app`.
  assert.equal(normalizePath(`${PREFIX}/${REPO}/app`, REPO), 'app');
  assert.equal(normalizePath(`~//work/${REPO}/app`, REPO), 'app');
  assert.equal(normalizePath(`${REPO}//app`, REPO), 'app');
  assert.equal(scopesIntersect(normalizeScope([`${PREFIX}/${REPO}/app`], REPO), ['app']).intersects, true);
});

T('RED-PROOF scope: a capitalised repo name or workspace prefix is stripped on a case-insensitive disk', () => {
  // Before the fix `Web/app` in repo `web` read as `Web/app` even on macOS, where it IS `app`.
  assert.equal(normalizePath('Web/app', REPO, { caseInsensitive: true }), 'app');
  assert.equal(normalizePath('~/Work/WEB/app', REPO, { caseInsensitive: true }), 'app');
  assert.equal(normalizePath('WEB', REPO, { caseInsensitive: true }), WHOLE_REPO);
  assert.equal(scopesIntersect(normalizeScope(['Web/app'], REPO, { caseInsensitive: true }), ['app'], { caseInsensitive: true }).intersects, true);
  // and a case-sensitive disk keeps them apart: `Web/app` is a real folder there
  assert.equal(normalizePath('Web/app', REPO, { caseInsensitive: false }), 'Web/app');
  assert.equal(normalizePath('WEB', REPO, { caseInsensitive: false }), 'WEB');
});

// ---------------------------------------------------------------- the built-in exclusive list
const LOCKFILE = 'package-lock.json';

T('RED-PROOF exclusive: a lane naming a lockfile is exclusive at that path with no policy row at all', () => {
  // Watched red before the change: applyExclusive with an empty list returned untouched.
  assert.ok(Array.isArray(S.BUILTIN_EXCLUSIVE), 'BUILTIN_EXCLUSIVE is exported');
  assert.ok(S.BUILTIN_EXCLUSIVE.includes(LOCKFILE), `${LOCKFILE} is on the built-in list`);
  const r = applyExclusive([LOCKFILE, 'src/a'], []);
  assert.equal(r.widened, true, 'a lockfile scope is widened with an EMPTY policy list');
  assert.deepEqual(r.hits, [[LOCKFILE, LOCKFILE]], 'the hit names the lockfile');
  assert.deepEqual(r.scope, [LOCKFILE, 'src/a'], 'the widening is to the path, never to the repo');
  // any other lane in the repo that touches the lockfile, in any spelling, serializes against it
  for (const spelling of [LOCKFILE, `./${LOCKFILE}`, `${REPO}/${LOCKFILE}`, `${PREFIX}${REPO}/${LOCKFILE}`]) {
    const other = applyExclusive(normalizeScope([spelling, 'docs/y'], REPO), []);
    assert.equal(other.widened, true, `spelling ${spelling} is recognised`);
    assert.equal(scopesIntersect(r.scope, other.scope).intersects, true, `serializes against ${spelling}`);
  }
  // and the same holds with a policy list that does not mention it
  assert.equal(applyExclusive([LOCKFILE], ['db/functions']).widened, true);
});

T('RED-PROOF exclusive: two lanes each adding one numbered migration serialize with no policy row', () => {
  // Watched red before the change: `db/migrations/0100_a.sql` and `db/migrations/0101_b.sql` were
  // disjoint files, and two lanes were carded side by side onto one numbered sequence.
  const a = applyExclusive(['db/migrations/0100_a.sql', 'src/a'], []).scope;
  const b = applyExclusive(['db/migrations/0101_b.sql', 'src/b'], []).scope;
  assert.deepEqual(a, ['db/migrations', 'src/a']);
  assert.equal(scopesIntersect(a, b).intersects, true);
  // the other conventional names promote the same way
  for (const dir of ['migrations', 'db/migrate', 'supabase/migrations', 'prisma/migrations', 'alembic/versions'])
    assert.deepEqual(applyExclusive([`${dir}/0001_x`], []).scope, [dir], dir);
});

T('RED-PROOF exclusive: the router\'s own state directory is held alone', () => {
  const a = applyExclusive(['_handoffs/_lanes/LANES.md'], []).scope;
  const b = applyExclusive(['_handoffs/_lanes/CLAIMS.md'], []).scope;
  assert.deepEqual(a, ['_handoffs/_lanes']);
  assert.equal(scopesIntersect(a, b).intersects, true);
});

T('exclusive: a lane naming nothing on the built-in list is unaffected', () => {
  for (const scope of [['src/a', 'docs/x'], ['app/widget'], ['scripts/x1.mjs', 'data/x1']]) {
    const r = applyExclusive(scope, []);
    assert.equal(r.widened, false);
    assert.deepEqual(r.scope, scope);
    assert.deepEqual(r.hits, []);
    const withPolicy = applyExclusive(scope, ['db/functions']);
    assert.equal(withPolicy.widened, false);
    assert.deepEqual(withPolicy.scope, scope);
  }
  // an empty and a declared-none scope stay empty
  assert.deepEqual(applyExclusive([], []).scope, []);
  assert.equal(applyExclusive([], []).widened, false);
  // a whole-repo scope is never promoted DOWN to a built-in entry
  assert.deepEqual(applyExclusive([WHOLE_REPO], []).scope, [WHOLE_REPO]);
});

T('exclusive: a policy row adds to the built-in list and nothing can subtract from it', () => {
  // adds: a path the built-in list does not know becomes exclusive when the policy names it
  assert.equal(applyExclusive(['db/functions/x'], []).widened, false, 'not built in');
  assert.deepEqual(applyExclusive(['db/functions/x'], ['db/functions']).scope, ['db/functions'], 'added by the policy row');
  // cannot subtract: every built-in entry stays exclusive whatever the policy list says
  for (const e of S.BUILTIN_EXCLUSIVE) {
    assert.equal(applyExclusive([e], []).widened, true, `${e} with no policy`);
    assert.equal(applyExclusive([e], ['somewhere/else']).widened, true, `${e} with an unrelated policy row`);
    assert.equal(applyExclusive([`${e}/inner`], ['somewhere/else']).scope[0], e, `${e} promotes what sits inside it`);
  }
  // the merged set is the policy's rows plus every built-in entry, deduplicated
  const merged = S.withBuiltinExclusive(['db/functions', LOCKFILE]);
  assert.equal(merged.filter((p) => p === LOCKFILE).length, 1, 'a policy row naming a built-in entry does not double it');
  for (const e of S.BUILTIN_EXCLUSIVE) assert.ok(merged.includes(e), e);
  assert.ok(merged.includes('db/functions'));
  // the list itself is frozen, so no caller can edit an entry away at runtime
  assert.ok(Object.isFrozen(S.BUILTIN_EXCLUSIVE), 'frozen');
  assert.throws(() => { S.BUILTIN_EXCLUSIVE.push('x'); }, TypeError);
});

T('exclusive: every built-in entry is already in canonical form, so the compare can never skip it', () => {
  for (const e of S.BUILTIN_EXCLUSIVE) {
    assert.equal(normalizePath(e, REPO), e, `${e} normalises to itself`);
    assert.notEqual(e, WHOLE_REPO, 'no entry is the whole repo');
  }
  assert.equal(new Set(S.BUILTIN_EXCLUSIVE).size, S.BUILTIN_EXCLUSIVE.length, 'no duplicates');
});

T('exclusive: with the built-in list in play, the widest containing entry wins, in any list order', () => {
  // A policy row `db` is wider than the built-in `db/migrations`; whichever comes first in the
  // merged list, the declared path promotes to the wider one, because widening is the safe direction.
  assert.deepEqual(applyExclusive(['db/migrations/0100_a.sql'], ['db']).scope, ['db']);
  assert.deepEqual(applyExclusive(['db/migrations/0100_a.sql'], ['db/other', 'db']).scope, ['db']);
});

// ---------------------------------------------------------------- run
let pass = 0;
const fails = [];
for (const t of tests) {
  try { t.fn(); pass++; } catch (e) { fails.push({ name: t.name, message: e.message }); }
}
for (const f of fails) console.log(`FAIL  ${f.name}\n      ${String(f.message).split('\n')[0]}`);
const redProof = tests.filter((t) => t.name.startsWith('RED-PROOF')).length;
const caseLine = [1, 2, 3, 4, 5, 6].map((p) => `p${p}=${counts[p] ?? 0}`).join(' ');
console.log(`SCOPE PROPERTY ASSERTIONS  ${pass}/${tests.length} pass, ${fails.length} fail`);
console.log(`  6 properties x ${CASES} cases, seed ${SEED} (replay: PROP_SEED=${SEED} npm test); checks ${caseLine}`);
console.log(`  ${redProof} of them are RED-PROOF: each pins a spelling that once carded two colliding lanes as safe.`);
if (fails.length) {
  throw new Error(`scope-prop-test.mjs: ${fails.length}/${tests.length} assertion(s) failed, seed ${SEED} — see FAIL lines above.`);
}
