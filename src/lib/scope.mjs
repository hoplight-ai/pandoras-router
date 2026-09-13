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
//   folds case there by default; a caller may force either behaviour.

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

export function normalizePath(raw, repo) {
  let t = String(raw ?? '').trim();
  if (!t) return null;
  t = t.replace(/^`|`$/g, '').trim();
  for (const prefix of WORKSPACE_PREFIXES) if (t.startsWith(prefix)) t = t.slice(prefix.length);
  if (repo) {
    if (t === repo) return WHOLE_REPO;
    if (t.startsWith(`${repo}/`)) t = t.slice(repo.length + 1);
  }
  t = t.replace(/^\.\//, '').replace(/^\/+/, '');
  t = t.replace(/\/{2,}/g, '/');
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

export function normalizeScope(list, repo) {
  const out = [];
  for (const raw of list ?? []) {
    const n = normalizePath(raw, repo);
    if (n === null) continue;
    if (n === WHOLE_REPO) return [WHOLE_REPO];
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

const fold = (p, ci) => (ci ? String(p).toLowerCase() : String(p));

function contains(dir, file, ci = CASE_INSENSITIVE_DISK) {
  if (dir === WHOLE_REPO) return true;
  const d = fold(dir, ci), f = fold(file, ci);
  if (d === f) return true;
  return f.startsWith(`${d}/`);
}

/**
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
 * @param {string[]} scope           normalized scope
 * @param {string[]} exclusive       normalized exclusive paths for the repo
 * @returns {{scope:string[], widened:boolean, hits:Array<[string,string]>}}
 */
export function applyExclusive(scope, exclusive) {
  if (!exclusive?.length) return { scope, widened: false, hits: [] };
  const x = scopesIntersect(scope, exclusive);
  if (!x.intersects) return { scope, widened: false, hits: [] };
  const out = [];
  for (const p of scope) {
    // `contains(e, p)` is true only when the exclusive path CONTAINS the declared one, so this
    // only ever widens p. A `.` scope and a scope wider than the exclusive path both fall through
    // to `p` unchanged, which is the safe direction.
    const owner = exclusive.find((e) => contains(e, p));
    const keep = owner ?? p;
    if (!out.includes(keep)) out.push(keep);
  }
  return { scope: out, widened: true, hits: x.pairs };
}
