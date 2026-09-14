// policy.mjs — the per-repo facts, loaded from _handoffs/_lanes/POLICY.md.
//
// A repo that is not in the table routes nothing. Guessing a deploy style or a verification method
// is how a lane ships a change nobody proved; this module returns `null` and the caller says so by
// name rather than falling back to a default.

import fs from 'node:fs';
import path from 'node:path';
import { readTable } from './md-table.mjs';
import { setModels } from './briefs.mjs';

export function policyFile(root) {
  return path.join(root, '_handoffs', '_lanes', 'POLICY.md');
}

const DEPLOY = new Set(['push', 'cli', 'push+fns', 'none']);

// ── DISPATCH SEATS ────────────────────────────────────────────────────────────────────────────
//
// A "seat" is one dispatcher: a person or agent session that owns a set of repos and fires lanes
// in them. Every repo in the repos table names exactly one, so ownership is a column rather than
// prose typed into several command files that drift apart.
//
// The set of valid seat names is declared by the policy file's OPTIONAL `seats` table. When that
// table is absent the set is EMPTY, which means "any seat name is allowed" — a fresh install works
// without inventing an org chart first. Declare the table once your seats are real and a typo in
// the dispatch column starts failing loudly instead of routing to a seat nobody is sitting in.
//
// Exported so other tooling validates a seat name against the SAME set the repos table is
// validated against, rather than against whatever the routing table happens to name today.
export let SEATS = new Set();

/** Replace the allowed seat set. Pass an empty list to mean "any seat allowed". */
export function setSeats(list) {
  SEATS = new Set((list ?? []).map((s) => String(s).trim()).filter(Boolean));
  return SEATS;
}

/** True when `name` is an acceptable seat. An empty SEATS set accepts anything non-blank. */
export function seatAllowed(name) {
  if (!name) return false;
  if (SEATS.size === 0) return true;
  return SEATS.has(name);
}

export function loadPolicy(root) {
  const file = policyFile(root);
  if (!fs.existsSync(file)) throw new Error(`policy: ${file} does not exist`);
  const text = fs.readFileSync(file, 'utf8');

  // SEATS (optional). Absent means "any seat name is allowed"; present means the dispatch column is
  // validated against exactly these names.
  if (/<!--\s*table:\s*seats\s*-->/i.test(text)) {
    setSeats(readTable(text, 'seats').map((s) => s.seat));
  } else {
    setSeats([]);
  }

  const repos = new Map();
  for (const r of readTable(text, 'repos')) {
    if (!r.repo) continue;
    if (repos.has(r.repo)) throw new Error(`policy: repo "${r.repo}" appears twice in the repos table`);
    if (!DEPLOY.has(r.deploy)) throw new Error(`policy: repo "${r.repo}" has deploy "${r.deploy}"; must be one of ${[...DEPLOY].join(', ')}`);
    const writers = Number(r.writers);
    if (!Number.isInteger(writers) || writers < 1) throw new Error(`policy: repo "${r.repo}" has writers "${r.writers}"; must be a positive integer`);
    const tier = Number(r.tier);
    if (!Number.isInteger(tier) || tier < 1) throw new Error(`policy: repo "${r.repo}" has tier "${r.tier}"; must be a positive integer`);
    // ── SEAT OWNERSHIP IS A COLUMN, NOT PROSE IN A COMMAND FILE ────────────────────────────────
    //
    // Which dispatcher owns a repo is easy to write as a list inside each dispatcher's own
    // instructions. Several files enumerating overlapping repo lists is a drift class: a repo added
    // to one file and not the others is owned by everyone and nobody, and nothing detects it.
    //
    // One row here re-partitions the board, the allocator and every command file at once.
    //
    // REQUIRED, and validated against the seat names when a seats table is declared. A blank would
    // be the failure this replaces — an unowned repo that routes to whoever looks first.
    if (!r.dispatch) throw new Error(`policy: repo "${r.repo}" has no dispatch seat; every repo names exactly one`);
    if (!seatAllowed(r.dispatch)) throw new Error(`policy: repo "${r.repo}" names dispatch "${r.dispatch}"; must be one of ${[...SEATS].join(', ')}`);

    repos.set(r.repo, {
      repo: r.repo,
      tier,
      writers,
      dispatch: r.dispatch,
      port: r.port === '-' ? null : Number(r.port),
      deploy: r.deploy,
      verify: parseVerify(r.repo, r.verify),
      url: r.url === '-' ? null : r.url,
      traps: [],
      owner: null,
      exclusive: [],
      surfaces: [],
      liveness: null,
      env: null,
    });
  }

  // SURFACES (2026-08-23). Where a changed file shows up on the deployed site, so gate 3's `string`
  // form can probe the file the lane actually changed instead of the repo's root url. OPTIONAL in
  // exactly the way the exclusive table is: no marker means no repo declares one and every repo
  // keeps the old root-url behaviour, but a marker present with a broken table is still an error.
  //
  // `self` = served verbatim at its own path under the site root. `none` = not served, and renders
  // into no page. Nothing else parses, because a third value would be a guess about a surface.
  if (/<!--\s*table:\s*surfaces\s*-->/i.test(text)) {
    for (const s of readTable(text, 'surfaces')) {
      const rec = repos.get(s.repo);
      if (!rec) throw new Error(`policy: surfaces table names "${s.repo}", which is not in the repos table`);
      if (!s.path) throw new Error(`policy: surfaces table has a row for "${s.repo}" with no path`);
      if (s.surface !== 'self' && s.surface !== 'none')
        throw new Error(`policy: surfaces row "${s.repo} ${s.path}" has surface "${s.surface}"; must be self or none`);
      rec.surfaces.push({ path: s.path, surface: s.surface });
    }
  }

  // LIVENESS (optional). What the close gate probes to prove a merged change is actually serving.
  // Everything is declared here; nothing about a URL, a credential or a timeout is compiled in.
  //
  //   repo     the repo this row configures (one row per repo)
  //   url      absolute http(s) URL to GET
  //   expect   a string that must appear in the response body, or `-` for "200 is enough"
  //   auth     `-` | `basic:<ENV_VAR>` | `cookie:<ENV_VAR>` | `header:<Name>:<ENV_VAR>`
  //            the value is read from that environment variable at probe time, never from the table
  //   timeout  milliseconds, or `-` for the default
  //
  // A repo with no row here is UNCONFIGURED, and the gate SKIPS it and says so. A skip is not a
  // pass, and the gate prints the difference.
  if (/<!--\s*table:\s*liveness\s*-->/i.test(text)) {
    for (const l of readTable(text, 'liveness')) {
      const rec = repos.get(l.repo);
      if (!rec) throw new Error(`policy: liveness table names "${l.repo}", which is not in the repos table`);
      if (rec.liveness) throw new Error(`policy: repo "${l.repo}" appears twice in the liveness table`);
      rec.liveness = parseLiveness(l.repo, l);
    }
  }

  // EXCLUSIVE PATHS. A lane whose declared scope touches one of these holds that path ALONE — the
  // allocator widens its scope for comparison, so the existing intersection logic serializes it
  // both ways. The table is OPTIONAL (absence means no repo has exclusive paths), but a marker that
  // is present with a broken table is still an error — silence and malformation are not the same.
  if (/<!--\s*table:\s*exclusive\s*-->/i.test(text)) {
    for (const e of readTable(text, 'exclusive')) {
      const rec = repos.get(e.repo);
      if (!rec) throw new Error(`policy: exclusive table names "${e.repo}", which is not in the repos table`);
      if (!e.path) throw new Error(`policy: exclusive table has a row for "${e.repo}" with no path`);
      rec.exclusive.push(e.path);
    }
  }

  // TRAPS (optional). Free-text warnings printed on the lane card for a repo.
  if (/<!--\s*table:\s*traps\s*-->/i.test(text)) {
    for (const t of readTable(text, 'traps')) {
      const rec = repos.get(t.repo);
      if (!rec) throw new Error(`policy: traps table names "${t.repo}", which is not in the repos table`);
      rec.traps.push(t.trap);
    }
  }

  // OWNERSHIP (optional). Overrides the dispatch column for a repo temporarily lent to another seat.
  if (/<!--\s*table:\s*ownership\s*-->/i.test(text)) {
    for (const o of readTable(text, 'ownership')) {
      const rec = repos.get(o.repo);
      if (!rec) throw new Error(`policy: ownership table names "${o.repo}", which is not in the repos table`);
      rec.owner = o.dispatch === '-' ? null : o.dispatch;
    }
  }

  // ENV (Router ENV1, 2026-09-14). A per-repo allowlist of `.env.local` variable NAMES — never
  // values, only names, and this file never sees a value — that `lane-open` copies into a fresh
  // worktree. OPTIONAL, in the same shape as `exclusive` and `traps` above: a repo absent from this
  // table gets today's behaviour, unchanged — the whole file is copied. A repo present here gets
  // ONLY the named keys; see copyEnvFile in bin/lane-open.mjs for the disk half and what happens to
  // a listed key the source file lacks. `keys` is a space-separated list read straight off the row.
  if (/<!--\s*table:\s*env\s*-->/i.test(text)) {
    for (const e of readTable(text, 'env')) {
      const rec = repos.get(e.repo);
      if (!rec) throw new Error(`policy: env table names "${e.repo}", which is not in the repos table`);
      if (rec.env) throw new Error(`policy: repo "${e.repo}" appears twice in the env table`);
      const keys = String(e.keys ?? '').trim().split(/\s+/).filter(Boolean);
      if (!keys.length) throw new Error(`policy: env table has a row for "${e.repo}" with no keys`);
      rec.env = keys;
    }
  }

  // MODELS (optional). The friendly-name-to-exact-id roster a brief's `Model:` line resolves
  // against. Absent means an EMPTY roster and every model line reads as unrecognised.
  setModels(parseModels(text));

  return { repos, file };
}

/**
 * The optional `models` table: `| name | id |`, one row per model a brief may name.
 * Pure; returns an empty Map when the marker is absent.
 * @returns {Map<string,string>}
 */
export function parseModels(text) {
  const out = new Map();
  if (!/<!--\s*table:\s*models\s*-->/i.test(String(text ?? ''))) return out;
  for (const m of readTable(text, 'models')) {
    const name = String(m.name ?? '').trim().toLowerCase();
    const id = String(m.id ?? '').trim();
    if (!name || !id) throw new Error('policy: models table has a row with an empty name or id');
    if (out.has(name)) throw new Error(`policy: model "${name}" appears twice in the models table`);
    out.set(name, id);
  }
  return out;
}

const AUTH_FORMS = 'one of "-", "basic:<ENV_VAR>", "cookie:<ENV_VAR>", "header:<Name>:<ENV_VAR>"';

/**
 * Parse one liveness row into the shape the close gate probes with. No value here is a credential:
 * `auth.envVar` is the NAME of an environment variable, read at probe time.
 */
export function parseLiveness(repo, row) {
  const url = String(row.url ?? '').trim();
  if (!/^https?:\/\//i.test(url))
    throw new Error(`policy: liveness row for "${repo}" has url "${url}"; must be an absolute http(s) URL`);

  const expectRaw = String(row.expect ?? '').trim();
  const expect = expectRaw === '' || expectRaw === '-' ? null : expectRaw;

  const timeoutRaw = String(row.timeout ?? '').trim();
  let timeoutMs = 10000;
  if (timeoutRaw && timeoutRaw !== '-') {
    timeoutMs = Number(timeoutRaw);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1)
      throw new Error(`policy: liveness row for "${repo}" has timeout "${timeoutRaw}"; must be a positive integer of milliseconds`);
  }

  const authRaw = String(row.auth ?? '').trim();
  let auth = null;
  if (authRaw && authRaw !== '-') {
    const [kind, ...rest] = authRaw.split(':');
    if (kind === 'basic' || kind === 'cookie') {
      if (rest.length !== 1 || !rest[0])
        throw new Error(`policy: liveness row for "${repo}" has auth "${authRaw}"; must be ${AUTH_FORMS}`);
      auth = { kind, envVar: rest[0] };
    } else if (kind === 'header') {
      if (rest.length !== 2 || !rest[0] || !rest[1])
        throw new Error(`policy: liveness row for "${repo}" has auth "${authRaw}"; must be ${AUTH_FORMS}`);
      auth = { kind: 'header', header: rest[0], envVar: rest[1] };
    } else {
      throw new Error(`policy: liveness row for "${repo}" has auth "${authRaw}"; must be ${AUTH_FORMS}`);
    }
  }

  return { repo, url, expect, auth, timeoutMs };
}

// verify DSL. `sha:` is the only form that cannot pass on stale bytes, which is why it is preferred
// wherever the surface can echo its own commit.
export function parseVerify(repo, raw) {
  const v = String(raw ?? '').trim();
  if (v === 'none' || v === '-') return { kind: 'none' };
  if (v === 'string') return { kind: 'string' };
  if (v.startsWith('sha:')) {
    const rest = v.slice(4);
    const i = rest.lastIndexOf(':');
    if (i < 1) throw new Error(`policy: repo "${repo}" verify "${v}" must be sha:<path>:<jsonfield>`);
    return { kind: 'sha', path: rest.slice(0, i), field: rest.slice(i + 1) };
  }
  if (v.startsWith('script:')) return { kind: 'script', name: v.slice(7) };
  throw new Error(`policy: repo "${repo}" has verify "${v}"; must be sha:<path>:<field>, string, script:<name>, or none`);
}

export function repoPolicy(policy, repo) {
  return policy.repos.get(repo) ?? null;
}
