// @ts-check
// policy.mjs — the per-repo facts, loaded from _handoffs/_lanes/POLICY.md.
//
// A repo that is not in the table routes nothing. Guessing a deploy style or a verification method
// is how a lane ships a change nobody proved; this module returns `null` and the caller says so by
// name rather than falling back to a default.

import fs from 'node:fs';
import path from 'node:path';
import { readTable } from './md-table.mjs';
import { setModels } from './briefs.mjs';
import { parseVerifyHeader } from './liveness.mjs';

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

    // ── THE SAME RULE AS THE LIVENESS TABLE'S URL, AND FOR THE SAME REASON ─────────────────────
    //
    // parseLiveness has refused a non-absolute URL since it was written, naming the repo and the
    // value. This column was taken verbatim, so `example.com/app`, `/app` and `javascript:...`
    // all parsed clean here and were only ever discovered by whatever used them later, with a
    // message about something else. A policy file is trusted input; trusted input still gets to
    // be wrong, and the line that reads it is the cheap place to say so. `-` still means the repo
    // declares no url at all.
    const url = String(r.url ?? '').trim();
    if (url !== '-' && !/^https?:\/\//i.test(url))
      throw new Error(`policy: repo "${r.repo}" has url "${url}"; must be an absolute http(s) URL`);

    repos.set(r.repo, {
      repo: r.repo,
      tier,
      writers,
      dispatch: r.dispatch,
      port: r.port === '-' ? null : Number(r.port),
      deploy: r.deploy,
      verify: parseVerify(r.repo, r.verify),
      // OPTIONAL, and absent means the npm path exactly as before. See parseBuild below.
      build: parseBuild(r.repo, r.build),
      url: url === '-' ? null : url,
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
  // worktree. OPTIONAL, in the same shape as `exclusive` and `traps` above, and this table is the
  // ONLY thing that makes a copy happen: a repo absent from it keeps `env: null` and gets NOTHING,
  // which is the safe default — a credential leaves the repository only because somebody wrote its
  // name down here. A repo present gets exactly the named keys; see copyEnvFile in
  // bin/lane-open.mjs for the disk half and what happens to a listed key the source file lacks.
  // `keys` is a space-separated list read straight off the row.
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

// verify DSL. The close driver dispatches on the kind this returns (gateLive in bin/close.mjs), so the
// column is authoritative: whatever form a row names is the proof the close runs, and nothing else.
//
//   sha:<path>:<jsonField>      GET url+path, read one JSON field, pass when it names a commit that
//                               contains the lane's commit. Cannot pass on stale bytes.
//   header:<path>:<headerName>  the same echo read from one response header. Parsed by
//                               parseVerifyHeader in lib/liveness.mjs, beside its probe.
//   string                      the liveness row's URL-and-string probe. Best-effort evidence.
//   script:<name>               `npm run <name>` in the lane's checkout, graded by exit code.
//   none                        nothing to prove; the gate records n/a.
//
// AN UNKNOWN FORM THROWS AT LOAD, naming every valid form. A row the driver cannot dispatch on must
// never reach the close, because the only thing a close could do with it is guess.
export const VERIFY_FORMS = ['sha:<path>:<jsonField>', 'header:<path>:<headerName>', 'string', 'script:<name>', 'none'];

export function parseVerify(repo, raw) {
  const v = String(raw ?? '').trim();
  if (v === 'none' || v === '-') return { kind: 'none' };
  if (v === 'string') return { kind: 'string' };
  if (v.startsWith('sha:')) {
    const rest = v.slice(4);
    const i = rest.lastIndexOf(':');
    const p = i >= 0 ? rest.slice(0, i) : '';
    const field = i >= 0 ? rest.slice(i + 1) : '';
    if (!p.startsWith('/') || !field) throw new Error(`policy: repo "${repo}" verify "${v}" must be sha:<path>:<jsonField> (an absolute path, then one JSON field name)`);
    return { kind: 'sha', path: p, field };
  }
  const header = parseVerifyHeader(repo, v);
  if (header) return header;
  if (v.startsWith('script:')) {
    const name = v.slice(7).trim();
    if (!name || /\s/.test(name)) throw new Error(`policy: repo "${repo}" verify "${v}" must be script:<name> (one npm script name, no spaces)`);
    return { kind: 'script', name };
  }
  throw new Error(`policy: repo "${repo}" has verify "${v}"; must be one of ${VERIFY_FORMS.join(', ')}`);
}

// ── THE `build` COLUMN — AN ARGUMENT ARRAY, NEVER A COMMAND LINE (BUILDCMD1, 2026-09-15) ────────
//
// The build gate could only build an npm project. A repository built by any other tool had no build
// to run, so the gate was a skip, and a skip is not a pass — a whole class of repository closed with
// its build unproven. The `build` column names that repository's build command, so `pnpm build`,
// `bun run build`, `cargo build --release`, `go build ./...` and `make build` all get a real gate.
//
// THE COLUMN IS READ AS AN ARGUMENT ARRAY: the command, then its arguments, split on whitespace and
// handed to spawn with shell false. It is never a command line and nothing ever re-parses it. That
// matters more here than anywhere else in this file, because the close RUNS this value on the
// dispatcher's machine: three rules are the whole distance between a configuration file and
// arbitrary execution, and all three are enforced here, at parse time, before any close can start.
//
//   1. A blank value is refused. `-` is how a row says "use npm"; a blank cell is an unfinished row,
//      and reading it as "use npm" would hide the difference.
//   2. The first token must be a BARE COMMAND NAME — no path separator, no `~`. The command is
//      looked up on PATH and nowhere else (see resolveOnPath in lib/build.mjs); a path here would be
//      the repository choosing which file the gate executes, and a repository ships its own files.
//   3. No shell metacharacter anywhere in the value: | & ; < > $ ` or a newline. None of them means
//      anything to an argument array, so a value containing one was written by somebody who believed
//      a shell would read it — and the honest answer to that belief is a refusal that says so.
//
// Every refusal says the column is an argument array and not a command line, because that sentence
// is the one the person who hit it needs.
//
// OPTIONAL AND BACKWARD COMPATIBLE. A repos table with no `build` column at all leaves every row's
// value `undefined`, which is null here and today's npm behaviour in the gate. Every policy document
// written before this column existed parses unchanged.
const BUILD_ARRAY_RULE = 'the build column is an argument array, not a command line: the command and its arguments separated by spaces, spawned with no shell';

/** The shell metacharacters refused by name. A newline is spelled out rather than printed. */
const SHELL_METACHARACTERS = [
  ['|', '|'], ['&', '&'], [';', ';'], ['<', '<'], ['>', '>'], ['$', '$'], ['`', '`'], ['\n', 'a newline'], ['\r', 'a newline'],
];

/**
 * One repos-table `build` cell. Returns null for "no declared command, use npm", or the command and
 * its arguments. Throws, naming the repo and the reason, on anything else. Pure.
 *
 * @param {string} repo
 * @param {string|undefined} raw
 * @returns {{command:string, args:string[], label:string}|null}
 */
export function parseBuild(repo, raw) {
  if (raw === undefined || raw === null) return null;
  const value = String(raw);
  if (value.trim() === '-') return null;
  if (value.trim() === '')
    throw new Error(`policy: repo "${repo}" has an empty build value; write \`-\` to mean "use npm", or name a command. ${BUILD_ARRAY_RULE}.`);

  for (const [ch, shown] of SHELL_METACHARACTERS) {
    if (value.includes(ch))
      throw new Error(`policy: repo "${repo}" has build "${printable(value)}", which contains ${shown}. ${BUILD_ARRAY_RULE}, so a shell metacharacter in it means nothing and is refused rather than passed to the command as a literal argument.`);
  }

  const tokens = value.trim().split(/\s+/).filter(Boolean);
  const command = tokens[0];
  if (command.includes('/') || command.includes('\\') || command.startsWith('~'))
    throw new Error(`policy: repo "${repo}" has build "${printable(value)}", whose first token "${command}" is not a bare command name. The command is looked up on PATH only, never inside the repository, so a path here is refused. ${BUILD_ARRAY_RULE}.`);

  return { command, args: tokens.slice(1), label: tokens.join(' ') };
}

/** A value safe to put in one line of an error message. */
function printable(v) {
  return String(v).replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

export function repoPolicy(policy, repo) {
  return policy.repos.get(repo) ?? null;
}
