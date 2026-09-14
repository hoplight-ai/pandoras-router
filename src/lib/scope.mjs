// @ts-check
// scope.mjs — do two lanes touch the same files?
//
// THIS IS THE ENTIRE SAFETY ARGUMENT FOR TWO CONCURRENT WRITERS IN ONE REPO. If it is a heuristic,
// two lanes edit the same file and one of them loses work. So: paths are normalized to one
// canonical form and then compared exactly, or as directory containment. Nothing here matches on
// similarity, and a scope this module cannot parse is never silently narrowed — the caller is told
// and serializes the lane.
//
// CANONICAL FORM
//   - `<prefix>/<repo>/x`, `<repo>/x`, `./x`, `/x` all become `x`, given the repo name and the
//     configured workspace prefixes (none by default).
//   - trailing `/` dropped; repeated `/` collapsed; `.` and `..` segments resolved, so
//     `src/../lib/x.ts` IS `lib/x.ts`.
//   - a path that still climbs out of the repo after resolution (`../other/x`) is the WHOLE REPO:
//     it cannot be compared to anything inside, and widening is the safe direction.
//   - a trailing `*` or `**` becomes the directory itself: `app/**` -> `app`.
//   - `.` (or an empty scope) means WHOLE REPO and intersects everything.
//
// CONTAINMENT
//   `app` contains `app/widget/page.tsx`. `app` does NOT contain `application/x` — the check is on
//   full path segments, not on string prefix, because `startsWith` says yes to that and is wrong.
//   On a case-insensitive disk (macOS, Windows) `App/x` and `app/x` are ONE file, so the comparison
//   folds case there by default; a caller may force either behaviour. The prefix and repo strips
//   fold the same way, so `Web/x` in repo `web` is `x` on macOS and a folder named `Web` on Linux.
//
// BUILT-IN EXCLUSIVE PATHS
//   Lockfiles, package manifests, migration directories and the router's own ledger are global
//   machinery in every repo, so `applyExclusive` treats them as exclusive with no policy row at
//   all. See BUILTIN_EXCLUSIVE below: a policy row can add to that list, nothing can remove from it.
//
// PROPERTY TESTS
//   test/scope-prop-test.mjs generates thousands of spellings per run and holds six properties
//   over this module (symmetry, reflexivity, containment, raw-spelling identity, first-segment
//   disjointness, widening never disjoins). Two of the rules below were found by it.

import path from 'node:path';

export const WHOLE_REPO = '.';

/** True where the running process's disk treats `App/x` and `app/x` as one file. */
export const CASE_INSENSITIVE_DISK = process.platform === 'darwin' || process.platform === 'win32';

/**
 * Workspace prefixes stripped before a path is compared. Set this to the directory your repos live
 * under if briefs quote paths from the workspace root rather than from the repo root. Ships EMPTY:
 * no particular machine's layout is compiled in.
 * @type {string[]}
 */
export let WORKSPACE_PREFIXES = [];

export function setWorkspacePrefixes(list) {
  WORKSPACE_PREFIXES = (list ?? []).map((p) => (p.endsWith('/') ? p : `${p}/`));
}

const fold = (p, ci) => (ci ? String(p).toLowerCase() : String(p));

/**
 * @param {string} raw     one declared path, as a brief or ledger spells it
 * @param {string|null} [repo]  the repo the path belongs to; a leading repo name is stripped
 * @param {{caseInsensitive?:boolean}} [opts]  defaults to the running disk's behaviour. It decides
 *   whether `Web/x` in repo `web` is the repo (case-insensitive disk) or a folder named `Web`.
 */
export function normalizePath(raw, repo, { caseInsensitive = CASE_INSENSITIVE_DISK } = {}) {
  let t = String(raw ?? '').trim();
  if (!t) return null;
  t = t.replace(/^`|`$/g, '').trim();
  // Repeated slashes collapse FIRST. The property suite (PROP1, 2026-09-14) reached
  // `~/work//web/app`: collapsed after the prefix and repo strips, the doubled slash defeated both
  // and the path read as `web/app`, a folder that does not exist, disjoint from a lane declaring
  // `app`. Silent narrowing, the one thing this header forbids.
  t = t.replace(/\/{2,}/g, '/');
  // The prefix and repo strips fold case exactly as the comparison does. The same suite reached
  // `Web/app` in repo `web`: on a case-insensitive disk that IS `app`, and an exact strip left it
  // as `Web/app`, disjoint from `app`. On a case-sensitive disk `Web` is a real folder and the
  // strip stays exact.
  const ci = caseInsensitive;
  for (const prefix of WORKSPACE_PREFIXES) if (fold(t, ci).startsWith(fold(prefix, ci))) t = t.slice(prefix.length);
  if (repo) {
    if (fold(t, ci) === fold(repo, ci)) return WHOLE_REPO;
    if (fold(t, ci).startsWith(`${fold(repo, ci)}/`)) t = t.slice(repo.length + 1);
  }
  t = t.replace(/^\.\//, '').replace(/^\/+/, '');
  t = t.replace(/\/(\*\*|\*)$/, '');
  t = t.replace(/\/+$/, '');
  if (t === '' || t === '.' || t === '*' || t === '**') return WHOLE_REPO;
  // TRAVERSAL. Two lanes declaring `src/../lib/x.ts` and `lib/x.ts` will write the same file, and a
  // textual comparison called them disjoint. Resolve `.` and `..` first. A path that still begins
  // with `..` has left the repo; nothing inside can be proved disjoint from it, so it is the whole
  // repo — over-reporting, which costs a wait, never under-reporting, which costs somebody's work.
  t = path.posix.normalize(t).replace(/^\.\//, '').replace(/\/+$/, '');
  if (t === '' || t === '.') return WHOLE_REPO;
  if (t === '..' || t.startsWith('../')) return WHOLE_REPO;
  if (t.includes('*'))
    // A mid-path glob (`app/*/page.tsx`) cannot be compared exactly, and widening it to its parent
    // directory is the SAFE direction: it over-reports overlap, so lanes serialize rather than
    // collide. Narrowing would be the unsafe direction and is never done.
    t = t.split('/').slice(0, t.split('/').findIndex((s) => s.includes('*'))).join('/') || WHOLE_REPO;
  return t;
}

export function normalizeScope(list, repo, opts = {}) {
  const out = [];
  for (const raw of list ?? []) {
    const n = normalizePath(raw, repo, opts);
    if (n === null) continue;
    if (n === WHOLE_REPO) return [WHOLE_REPO];
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

function contains(dir, file, ci = CASE_INSENSITIVE_DISK) {
  if (dir === WHOLE_REPO) return true;
  const d = fold(dir, ci), f = fold(file, ci);
  if (d === f) return true;
  return f.startsWith(`${d}/`);
}

/**
 * @param {string} a  one normalized path
 * @param {string} b  another normalized path
 * @param {{caseInsensitive?:boolean}} [opts]  defaults to the running disk's behaviour
 */
export function pathsIntersect(a, b, { caseInsensitive = CASE_INSENSITIVE_DISK } = {}) {
  return contains(a, b, caseInsensitive) || contains(b, a, caseInsensitive);
}

/**
 * @param {{caseInsensitive?:boolean}} [opts]  defaults to the running disk's behaviour
 * @returns {{intersects:boolean, pairs:Array<[string,string]>}}  pairs are reported as declared
 */
export function scopesIntersect(scopeA, scopeB, opts = {}) {
  /** @type {Array<[string,string]>} */
  const pairs = [];
  for (const a of scopeA) for (const b of scopeB) if (pathsIntersect(a, b, opts)) pairs.push([a, b]);
  return { intersects: pairs.length > 0, pairs };
}

/**
 * EXCLUSIVE PATHS. Some paths are global machinery rather than lane-local files: a numbered
 * migrations directory is a sequence applied in order, a deploy-all command ships EVERY function in
 * a directory including a neighbour's half-merged one, and `package.json`/`package-lock.json` merge
 * as text but break as semantics. A lane whose scope touches one of these must hold THAT PATH alone.
 *
 * The widening is to the exclusive path itself, not to the whole repo. Widening to the repo is
 * stricter than any of those hazards requires, and it makes a repo's writer cap unreachable in
 * practice: every lane that touches one exclusive path widens to `.` and they all serialize.
 *
 * A declared path that sits INSIDE an exclusive path is promoted to that path — `fns/_shared` and
 * `fns/run-job` both become `fns`, so they still serialize against each other, because the
 * deploy-all command genuinely does ship both. A migrations lane and a functions lane no longer
 * collide, because neither hazard is shared between them.
 *
 * Every original hazard still serializes: two lanes touching migrations share the numbered
 * sequence, two touching functions share the deploy-all command, two touching `package.json` share
 * the semantic merge. What no longer serializes is a pair that shares none of them.
 *
 * TWO NARROWING CASES ARE REFUSED, because narrowing is the unsafe direction:
 *   - a whole-repo scope (`.`) is never promoted down to an exclusive path; it stays `.`.
 *   - a declared path WIDER than the exclusive path (`db`, against `db/migrations`)
 *     keeps its own wider form, which already covers the exclusive path and more.
 *
 * The declared scope itself is untouched — reports and cards still print what the lane declared.
 *
 * THE BUILT-IN LIST IS ALWAYS IN PLAY. `exclusive` is the policy's rows for the repo; the entries
 * of BUILTIN_EXCLUSIVE are merged in here, so no caller has to know the list exists. When more
 * than one exclusive path contains a declared path, the WIDEST wins, whatever order the merged
 * list is in: widening is the safe direction, and a policy row `db` must beat the built-in
 * `db/migrations` even when the built-in entry comes first.
 *
 * `hits` names the pairs that changed the comparison scope: each declared path with the exclusive
 * path that contains it. A `.` scope, or a scope wider than an exclusive path, is not widened and
 * reports no hit — with forty-odd built-in entries, listing every one on an undeclared lane's
 * card would say nothing.
 *
 * @param {string[]} scope           normalized scope
 * @param {string[]} [exclusive]     normalized exclusive paths from the repo's policy row, if any
 * @returns {{scope:string[], widened:boolean, hits:Array<[string,string]>}}
 */
export function applyExclusive(scope, exclusive) {
  const all = withBuiltinExclusive(exclusive);
  /** @type {Array<[string,string]>} */
  const hits = [];
  for (const p of scope) for (const e of all) if (contains(e, p)) hits.push([p, e]);
  if (!hits.length) return { scope, widened: false, hits: [] };
  const out = [];
  for (const p of scope) {
    // `contains(e, p)` is true only when the exclusive path CONTAINS the declared one, so this
    // only ever widens p. A `.` scope and a scope wider than the exclusive path both fall through
    // to `p` unchanged, which is the safe direction.
    const owners = all.filter((e) => contains(e, p)).sort((a, b) => width(a) - width(b));
    const keep = owners[0] ?? p;
    if (!out.includes(keep)) out.push(keep);
  }
  return { scope: out, widened: true, hits };
}

const width = (p) => (p === WHOLE_REPO ? 0 : p.split('/').length);

/** The policy's exclusive rows plus every built-in entry, deduplicated, policy rows first. */
export function withBuiltinExclusive(exclusive) {
  const out = [...(exclusive ?? [])];
  for (const e of BUILTIN_EXCLUSIVE) if (!out.includes(e)) out.push(e);
  return out;
}

/**
 * BUILT-IN EXCLUSIVE PATHS. The policy's exclusive table names one repo's own global machinery.
 * These are the file kinds that are global machinery in EVERY repo, so they are exclusive with no
 * policy row at all: a lane whose scope touches one holds that path alone, exactly as a policy row
 * would make it. A reviewer's note (PROP1, 2026-09-14): two lanes with disjoint source paths still
 * collide through a lockfile, a schema directory or the router's own ledger.
 *
 * CONSERVATIVE IN ONE DIRECTION ONLY. A match widens a scope to sole occupancy of that path;
 * nothing here ever narrows. A policy row can add an entry; no policy row, option or caller can
 * remove one, because the two costs are not symmetric: a missing entry lets two lanes write one
 * numbered sequence or regenerate one lockfile and somebody's work is lost, while a false positive
 * makes a lane wait for a neighbour. The array is frozen so nothing edits it away at runtime.
 *
 * Root-relative canonical paths, matched exactly or by containment. A monorepo's
 * `packages/x/package.json` is NOT matched: name it in the policy's exclusive table.
 */
export const BUILTIN_EXCLUSIVE = Object.freeze([
  // node
  'package.json',          // dependency and script edits merge as text and break as semantics
  'package-lock.json',     // regenerated whole by npm; two regenerations never merge
  'npm-shrinkwrap.json',   // the published form of the same lockfile, same regeneration
  'yarn.lock',             // regenerated whole by yarn
  'pnpm-lock.yaml',        // regenerated whole by pnpm
  'bun.lockb',             // binary lockfile; git cannot merge it at all
  'bun.lock',              // bun's text lockfile, regenerated whole
  'deno.lock',             // regenerated whole by deno
  // rust
  'Cargo.toml',            // manifest; two dependency edits resolve as one document
  'Cargo.lock',            // regenerated whole by cargo
  // go
  'go.mod',                // manifest; `go mod tidy` rewrites it whole
  'go.sum',                // checksum list rewritten whole alongside go.mod
  // python
  'pyproject.toml',        // manifest for every modern python tool
  'poetry.lock',           // regenerated whole by poetry
  'uv.lock',               // regenerated whole by uv
  'Pipfile',               // manifest for pipenv
  'Pipfile.lock',          // regenerated whole by pipenv
  'requirements.txt',      // pinned versions; two pins of one package cannot both land
  // ruby
  'Gemfile',               // manifest; two gem edits resolve as one
  'Gemfile.lock',          // regenerated whole by bundler
  // php
  'composer.json',         // manifest
  'composer.lock',         // regenerated whole by composer
  // jvm
  'pom.xml',               // manifest; one dependency tree resolved as one document
  'build.gradle',          // manifest, same hazard
  'build.gradle.kts',      // manifest, same hazard
  // swift, dart, elixir
  'Package.swift',         // manifest
  'Package.resolved',      // regenerated whole by swift package manager
  'pubspec.yaml',          // manifest
  'pubspec.lock',          // regenerated whole by pub
  'mix.exs',               // manifest
  'mix.lock',              // regenerated whole by mix
  // database schema and migrations, by their conventional directory names
  'migrations',            // a numbered sequence applied in order; two lanes mint the same number
  'db/migrations',         // the same sequence, the knex and node convention
  'db/migrate',            // the same sequence, the rails convention
  'db/schema.rb',          // rails dumps it whole after every migration
  'db/structure.sql',      // rails dumps it whole after every migration
  'supabase/migrations',   // the same numbered sequence, applied in order by the supabase cli
  'prisma/migrations',     // the same numbered sequence, prisma migrate
  'prisma/schema.prisma',  // one schema document every prisma migration derives from
  'drizzle',               // drizzle-kit's generated migration folder and its journal
  'alembic/versions',      // alembic's revision chain; two heads refuse to upgrade
  // the router's own state
  '_handoffs/_lanes',      // LANES.md, CLAIMS.md, POLICY.md: the ledger every open and close rewrites
]);
