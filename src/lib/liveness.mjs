// liveness.mjs — did the merged change actually reach the deployed surface?
//
// THIS IS THE GATE NOTHING ELSE RUNS. Every other check in a close asks a question about the
// repository: did the branch merge, did the build go green, did the lane stay inside its declared
// files. All of those can be true while the thing a person opens in a browser is last week's
// build. "Merged" is not "shipped", and an agent reporting DONE on a change nobody can see is the
// most expensive kind of wrong, because it is indistinguishable from success until someone looks.
//
// So the close GETs a URL and reads what came back.
//
// ── EVERYTHING IS CONFIGURATION ────────────────────────────────────────────────────────────────
//
// No URL, credential, env-file path or product name is compiled in. One row per repo in
// POLICY.md's optional `liveness` table declares all of it (see policy.mjs's parseLiveness):
//
//   url      the absolute http(s) URL to GET
//   expect   a string that must appear in the response body, or nothing for "200 is enough"
//   auth     `-`, `basic:<ENV_VAR>`, `cookie:<ENV_VAR>`, or `header:<Name>:<ENV_VAR>`
//   timeout  milliseconds
//
// A credential is named, never written: `auth` carries the NAME of an environment variable, and
// the value is read at probe time and never printed, not in a verdict, not in an error.
//
// ── WHERE A CREDENTIAL MAY GO ──────────────────────────────────────────────────────────────────
//
// POLICY.md is a trusted file, and still: a row naming an arbitrary environment variable against an
// arbitrary URL would send that variable's value wherever the row says, which turns a shared repo or
// a pull request into an exfiltration path. Three rules, each with a red-proof in the test suite:
//   - the variable NAME must start with `envPrefix` (default `PANDORAS_`), so the only secrets a
//     policy row can reach are the ones minted for this probe;
//   - a probe carrying a credential never follows a redirect (`redirect: 'manual'`), because a
//     cookie or custom header travels with a redirect to whatever host answered, and a 3xx grades
//     `no` with the reason named;
//   - the response body is read to BODY_CAP_BYTES and no further.
//
// ── A SKIP IS NOT A PASS, AND THE GATE SAYS SO OUT LOUD ────────────────────────────────────────
//
// The failure mode that makes a liveness gate worthless is a quiet skip. A repo with no config, a
// missing credential, a socket that never answered — each of those measured NOTHING, and a gate
// that prints a soft dash for them teaches everybody to read the column as green. So the value is
// the literal word `skipped`, the reason is always named, and the sentence "Nothing was measured,
// and a skip is not a pass" is part of the output rather than a convention.
//
// Three values, and they mean three different things:
//   yes      the surface answered 200 and carried what it was supposed to carry
//   no       the surface answered, and it is NOT serving this build — a real red
//   skipped  nothing was measured, for a named reason
//
// ── THREE FORMS, AND THE VERDICT SAYS WHICH ONE IT IS ──────────────────────────────────────────
//
// A yes is not one thing. Ranked by what it proves:
//   sha       the deployment echoes its own commit in a JSON body (POLICY.md `verify: sha:...`,
//             graded in close.mjs's liveShaVerdict). The only proof that cannot pass on stale
//             bytes, because an older build does not contain this branch's commit. Its yes says
//             "deployment identity".
//   header    the same echo, read from ONE response header (`verify: header:<path>:<header-name>`,
//             parsed and probed at the bottom of this file). Same strength, same sentence.
//   string    a marker found in a body (this file's probeLiveness, and the close's string verdict).
//             A cached response, a stale build that happens to carry the string, or an unrelated
//             route all pass it. Its yes says "best-effort evidence" and names what it did not prove.
// The value column stays yes/no/skipped; only the sentence beside it changes. Lead with sha
// wherever the surface can echo its commit; the string form is for surfaces that cannot.
//
// ── THE NETWORK CALL IS INJECTED ───────────────────────────────────────────────────────────────
//
// `fetchImpl` defaults to the global fetch and is an argument, so the whole gate is testable
// without a socket. A test that has to open a port is a test nobody runs.

/** The three verdict values. `skipped` is deliberately not a pass. */
export const LIVE_YES = 'yes';
export const LIVE_NO = 'no';
export const LIVE_SKIPPED = 'skipped';

const NOT_A_PASS = 'Nothing was measured, and a skip is not a pass.';

/**
 * THE STRING FORM GRADES ITSELF. A marker found in a body is best-effort evidence: a cached
 * response, a stale build that happens to carry the string, or an unrelated route that echoes it
 * all read the same from here. Only a deployment echoing its own commit (the sha form, or the
 * header form below) proves that the served build IS the merged commit. The verdict value does
 * not change — yes is yes — but every string `yes` says which kind of yes it is, where a reader
 * grades, not only in a comment nobody opens. Exported so the close's own string verdict can say
 * the identical sentence rather than a paraphrase that drifts.
 */
export const STRING_YES_CAVEAT = 'This is best-effort evidence: a body match does not prove that the served build is the merged commit (a cached response, a stale build carrying the string, or an unrelated route reads the same); only a sha or header echo of the commit proves which build is serving.';

/** Only environment variables whose names start with this may be sent by a probe. */
export const DEFAULT_ENV_PREFIX = 'PANDORAS_';

/** The most of a response body a probe reads. A marker past this is reported as not carried. */
export const BODY_CAP_BYTES = 1024 * 1024;

/**
 * Build the request headers for one liveness config, reading credentials from `env` by NAME.
 *
 * @returns {{headers:Record<string,string>, missing:string|null, refused:string|null}}
 *          `missing` names the environment variable that was expected and empty. The gate turns
 *          that into a SKIP rather than sending a bare request and grading the 401 as a failure:
 *          an unsent credential measures the credential, not the deployment.
 *          `refused` names a variable the policy asked for that lies OUTSIDE the probe prefix; its
 *          value is never read.
 */
export function livenessHeaders(auth, env = process.env, envPrefix = DEFAULT_ENV_PREFIX) {
  if (!auth) return { headers: {}, missing: null, refused: null };
  const name = String(auth.envVar ?? '');
  if (envPrefix && !name.startsWith(envPrefix)) return { headers: {}, missing: null, refused: name };
  const raw = env?.[name];
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { headers: {}, missing: name, refused: null };

  if (auth.kind === 'basic') {
    // The env var holds `user:password`. Already-encoded values are accepted as-is so an operator
    // who stored a full `Basic xxx` header is not silently double-encoded.
    const header = /^basic\s/i.test(value) ? value : `Basic ${Buffer.from(value, 'utf8').toString('base64')}`;
    return { headers: { authorization: header }, missing: null };
  }
  if (auth.kind === 'cookie') return { headers: { cookie: value }, missing: null, refused: null };
  if (auth.kind === 'header') return { headers: { [auth.header.toLowerCase()]: value }, missing: null, refused: null };
  return { headers: {}, missing: null, refused: null };
}

/** Read at most `cap` characters of a response body, streaming when the runtime allows it. */
export async function readBodyCapped(res, cap = BODY_CAP_BYTES) {
  const body = res?.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let out = '';
    try {
      while (out.length < cap) {
        const { done, value } = await reader.read();
        if (done) break;
        out += decoder.decode(value, { stream: true });
      }
    } finally {
      try { await reader.cancel(); } catch { /* the stream is being abandoned on purpose */ }
    }
    return out.length > cap ? out.slice(0, cap) : out;
  }
  const text = String(await res.text());
  return text.length > cap ? text.slice(0, cap) : text;
}

/**
 * Grade one probe result. Pure — no network, no clock — so every branch is directly assertable.
 *
 * @param {{status:number, body:string, expect:string|null, url:string, error?:string|null}} p
 * @returns {{value:string, why:string}}
 */
export function gradeLiveness({ status, body, expect, url, error = null }) {
  if (error) {
    return {
      value: LIVE_SKIPPED,
      why: `SKIPPED: ${url} could not be reached (${error}). An unreachable surface is unmeasured, not failed — the deployment may be fine and the network may not be. ${NOT_A_PASS}`,
    };
  }
  if (status >= 300 && status < 400) {
    return {
      value: LIVE_NO,
      why: `${url} answered ${status}, a redirect, which the probe did not follow because a credential was attached and a redirect would carry it to a host the policy did not name. Point the liveness row at the final URL. This is a red, not a skip: something answered and it was not this build.`,
    };
  }
  if (status !== 200) {
    const gated = status === 401 || status === 403;
    return {
      value: LIVE_NO,
      why: gated
        ? `${url} answered ${status}. The probe carried whatever credential the policy named and was still refused, so either the credential is wrong or the surface is not serving. This is a red, not a skip: something answered and it was not this build.`
        : `${url} answered ${status}, not 200. The surface is reachable and it is not serving this build.`,
    };
  }
  if (!expect) {
    return { value: LIVE_YES, why: `${url} answered 200, and this repo's policy asks for nothing more than a 200. ${STRING_YES_CAVEAT}` };
  }
  if (String(body ?? '').includes(expect)) {
    return { value: LIVE_YES, why: `${url} answered 200 and carried "${expect}". ${STRING_YES_CAVEAT}` };
  }
  return {
    value: LIVE_NO,
    why: `${url} answered 200 and did NOT carry "${expect}". Either the deploy has not landed, or the string is in a lazily-loaded chunk this single fetch never asked for — for a bundled app that second case is the common one, and a marker served in the initial response is the reliable form.`,
  };
}

/**
 * Probe one repo's deployed surface.
 *
 * @param {object} o
 * @param {object|null} o.config     a parsed liveness row, or null when the repo declares none
 * @param {string} [o.repo]          for the SKIPPED sentence when there is no config
 * @param {object} [o.env]           where credential NAMES are resolved
 * @param {Function} [o.fetchImpl]   injected for testing; defaults to the global fetch
 * @param {string}   [o.envPrefix]   the prefix a credential variable's NAME must carry
 * @returns {Promise<{value:string, why:string}>}
 */
export async function probeLiveness({ config, repo = 'this repo', env = process.env, fetchImpl = globalThis.fetch, envPrefix = DEFAULT_ENV_PREFIX } = {}) {
  if (!config) {
    return {
      value: LIVE_SKIPPED,
      why: `SKIPPED: ${repo} has no row in POLICY.md's liveness table, so there is no URL to ask. ${NOT_A_PASS} Add a liveness row to turn this column into a measurement.`,
    };
  }
  if (typeof fetchImpl !== 'function') {
    return {
      value: LIVE_SKIPPED,
      why: `SKIPPED: no fetch implementation is available in this runtime, so ${config.url} was never asked. ${NOT_A_PASS}`,
    };
  }

  const { headers, missing, refused } = livenessHeaders(config.auth, env, envPrefix);
  if (refused) {
    return {
      value: LIVE_SKIPPED,
      why: `SKIPPED: ${repo}'s liveness row asks for ${config.auth.kind} auth from $${refused}, and a probe may only send a variable whose name starts with ${envPrefix}. That value was never read and the probe was NOT sent. Mint a ${envPrefix}-prefixed variable for this probe and name it in the row. ${NOT_A_PASS}`,
    };
  }
  if (missing) {
    return {
      value: LIVE_SKIPPED,
      why: `SKIPPED: ${repo}'s liveness row asks for ${config.auth.kind} auth from $${missing}, and that variable is unset or empty. The probe was NOT sent bare, because grading the resulting 401 would measure the credential rather than the deployment. ${NOT_A_PASS}`,
    };
  }

  // A hung socket must not hang a close. The timeout is the policy's, not this module's.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let status = 0;
  let body = '';
  let error = null;
  try {
    // A credentialed probe never follows a redirect: the cookie or header would travel with it.
    const redirect = config.auth ? 'manual' : 'follow';
    const res = await fetchImpl(config.url, { redirect, headers, signal: controller.signal });
    status = res.status;
    body = status === 200 ? await readBodyCapped(res, BODY_CAP_BYTES) : '';
  } catch (e) {
    error = e?.name === 'AbortError'
      ? `no answer within ${config.timeoutMs}ms`
      : String(e?.message ?? e).slice(0, 120);
  } finally {
    clearTimeout(timer);
  }

  return gradeLiveness({ status, body, expect: config.expect, url: config.url, error });
}

// ── THE HEADER ECHO FORM ───────────────────────────────────────────────────────────────────────
//
// `verify: header:<path>:<header-name>` in POLICY.md's repos table. GET url+path, read ONE
// response header, pass when its value contains the lane's merge commit. It is the sha form for a
// deployment that names its release in a header rather than a JSON body (a CDN's release tag, a
// platform's deployment id header, an app that sets one on purpose), and it carries the sha form's
// strength: a stale build does not know a commit it does not contain, so this cannot pass on stale
// bytes. That is the whole reason it exists beside the string form rather than as a variant of it.
//
// THE BODY IS NEVER READ. Not capped, not sampled, not touched: a body that happens to carry the
// sha counts for nothing here, because the row said "header" and a proof that quietly widens what
// it accepts is a proof that quietly weakens. Reading zero bytes is inside the 1 MB cap by
// construction. The redirect rule and the credential rule are the liveness probe's, unchanged.
//
// WHERE THE PARSER LIVES. POLICY.md's `verify` column is parsed in policy.mjs (parseVerify), which
// another lane holds, so the header form is parsed HERE and offered through `parseVerifyWithHeader`,
// a one-line adapter that tries this form first and hands everything else to the policy parser.
// The allowance policy.mjs needs, when its lane is free, is one line inside parseVerify:
//   if (v.startsWith('header:')) return parseVerifyHeader(repo, v);
// The `auth` column's `header:<Name>:<ENV_VAR>` is a different column and never reaches this parser.

/** A header NAME per RFC 7230: a token, no spaces, no colons. Anything else is refused, never trimmed into shape. */
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** The fewest hex characters a header may abbreviate the commit to and still be read as naming it. */
export const HEADER_SHA_MIN_PREFIX = 7;

/**
 * Parse `header:<path>:<header-name>`. Returns null for any form that is not this one, so an
 * adapter can fall through to the policy parser; THROWS on a malformed header form, in the policy
 * parser's own voice, because a row that half-parses would probe a path nobody wrote.
 *
 * @returns {{kind:'header', path:string, header:string}|null}
 */
export function parseVerifyHeader(repo, raw) {
  const v = String(raw ?? '').trim();
  if (!v.startsWith('header:')) return null;
  const rest = v.slice(7);
  const i = rest.lastIndexOf(':');
  const path = i >= 0 ? rest.slice(0, i) : '';
  const header = i >= 0 ? rest.slice(i + 1) : '';
  if (!path.startsWith('/') || !header || !HEADER_TOKEN.test(header))
    throw new Error(`policy: repo "${repo}" verify "${v}" must be header:<path>:<header-name> (an absolute path, then one header name with no spaces)`);
  return { kind: 'header', path, header: header.toLowerCase() };
}

/** The one-line adapter: this form first, every other form to the policy parser it is handed. */
export const parseVerifyWithHeader = (repo, raw, parseVerify) => parseVerifyHeader(repo, raw) ?? parseVerify(repo, raw);

/**
 * Does a header value name this commit? Containment, the same rule the sha form applies to its
 * body field: the full sha anywhere in the value passes, and so does a prefix of at least
 * HEADER_SHA_MIN_PREFIX hex characters, because platforms abbreviate. Hex is case-insensitive.
 *
 * @returns {{named:boolean, abbreviated:boolean}}
 */
export function headerNamesCommit(headerValue, sha) {
  const value = String(Array.isArray(headerValue) ? headerValue.join(', ') : headerValue ?? '').toLowerCase();
  const full = String(sha ?? '').trim().toLowerCase();
  if (!value || !full) return { named: false, abbreviated: false };
  if (value.includes(full)) return { named: true, abbreviated: false };
  // The longest prefix of the sha that the value carries, provided it is long enough to be an identity
  // and sits on a hex boundary (so `abc1234` inside `abc12345678` of some OTHER commit is not credited).
  for (let n = Math.min(full.length - 1, 40); n >= HEADER_SHA_MIN_PREFIX; n--) {
    const prefix = full.slice(0, n);
    const at = value.indexOf(prefix);
    if (at === -1) continue;
    const after = value[at + n];
    if (after === undefined || !/[0-9a-f]/.test(after)) return { named: true, abbreviated: true };
  }
  return { named: false, abbreviated: false };
}

/**
 * Grade one header-echo probe. Pure — no network, no clock.
 *
 * @param {{status:number, headerValue:string|string[]|null, header:string, sha:string, url:string, error?:string|null}} p
 * @returns {{value:string, why:string}}
 */
export function gradeHeaderEcho({ status, headerValue, header, sha, url, error = null }) {
  if (error) {
    return {
      value: LIVE_SKIPPED,
      why: `SKIPPED: ${url} could not be reached (${error}). An unreachable surface is unmeasured, not failed — the deployment may be fine and the network may not be. ${NOT_A_PASS}`,
    };
  }
  if (status >= 300 && status < 400) {
    return {
      value: LIVE_NO,
      why: `${url} answered ${status}, a redirect, which the probe did not follow because a credential was attached and a redirect would carry it to a host the policy did not name. Point the verify path at the final URL. This is a red, not a skip: something answered and it was not this build.`,
    };
  }
  if (status !== 200) {
    const gated = status === 401 || status === 403;
    return {
      value: LIVE_NO,
      why: gated
        ? `${url} answered ${status}. The probe carried whatever credential the policy named and was still refused, so either the credential is wrong or the surface is not serving. This is a red, not a skip: something answered and it was not this build.`
        : `${url} answered ${status}, not 200. The surface is reachable and it is not serving this build.`,
    };
  }
  const raw = Array.isArray(headerValue) ? headerValue.join(', ') : headerValue;
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return {
      value: LIVE_NO,
      why: `${url} answered 200 with no \`${header}\` header, so the build cannot identify itself. The body was not read and would not count: the row asked for a header echo, and a surface that stops naming its release has stopped proving anything.`,
    };
  }
  const shown = String(raw).slice(0, 80);
  const { named, abbreviated } = headerNamesCommit(raw, sha);
  if (named) {
    return {
      value: LIVE_YES,
      why: `deployment identity: ${url} answered 200 and its \`${header}\` header (${shown}) names the merge commit ${String(sha).slice(0, 8)}${abbreviated ? ', abbreviated' : ''}. The deployment named its own commit, so this cannot have passed on stale bytes. The body was not read.`,
    };
  }
  return {
    value: LIVE_NO,
    why: `${url} answered 200 and its \`${header}\` header (${shown}) does NOT contain the merge commit ${String(sha).slice(0, 8)}. The alias is serving a build that names another commit — the deploy has not landed, or a neighbour's deploy replaced it. The body was not read and would not count.`,
  };
}

/**
 * Probe one repo's header echo.
 *
 * @param {object} o
 * @param {{url:string, verify:{kind:'header',path:string,header:string}, auth?:object|null, timeoutMs?:number}} o.config
 *                                  the repo's url and parsed verify row; auth and timeout as the liveness row spells them
 * @param {string}   o.sha          the lane's merge commit; with none there is nothing to compare and the probe is not sent
 * @param {string}   [o.repo]
 * @param {object}   [o.env]
 * @param {Function} [o.fetchImpl]
 * @param {string}   [o.envPrefix]
 * @returns {Promise<{value:string, why:string}>}
 */
export async function probeHeaderEcho({ config, sha, repo = 'this repo', env = process.env, fetchImpl = globalThis.fetch, envPrefix = DEFAULT_ENV_PREFIX } = {}) {
  const verify = config?.verify;
  if (!config?.url || verify?.kind !== 'header') {
    return {
      value: LIVE_SKIPPED,
      why: `SKIPPED: ${repo} has no url and header verify row to probe, so nothing was asked. ${NOT_A_PASS}`,
    };
  }
  const url = `${String(config.url).replace(/\/+$/, '')}${verify.path}`;
  if (!String(sha ?? '').trim()) {
    return {
      value: LIVE_SKIPPED,
      why: `SKIPPED: no merge commit was supplied for ${repo}, so there is nothing for the \`${verify.header}\` header at ${url} to be compared against and the probe was not sent. ${NOT_A_PASS}`,
    };
  }
  if (typeof fetchImpl !== 'function') {
    return {
      value: LIVE_SKIPPED,
      why: `SKIPPED: no fetch implementation is available in this runtime, so ${url} was never asked. ${NOT_A_PASS}`,
    };
  }

  const { headers, missing, refused } = livenessHeaders(config.auth, env, envPrefix);
  if (refused) {
    return {
      value: LIVE_SKIPPED,
      why: `SKIPPED: ${repo}'s row asks for ${config.auth.kind} auth from $${refused}, and a probe may only send a variable whose name starts with ${envPrefix}. That value was never read and the probe was NOT sent. Mint a ${envPrefix}-prefixed variable for this probe and name it in the row. ${NOT_A_PASS}`,
    };
  }
  if (missing) {
    return {
      value: LIVE_SKIPPED,
      why: `SKIPPED: ${repo}'s row asks for ${config.auth.kind} auth from $${missing}, and that variable is unset or empty. The probe was NOT sent bare, because grading the resulting 401 would measure the credential rather than the deployment. ${NOT_A_PASS}`,
    };
  }

  const timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 10000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let status = 0;
  let headerValue = null;
  let error = null;
  try {
    const redirect = config.auth ? 'manual' : 'follow';
    const res = await fetchImpl(url, { redirect, headers, signal: controller.signal });
    status = res.status;
    // Only the one header. `res.headers` is a Headers object on a real fetch and may be a plain
    // object on an injected one; neither path reads the body.
    const h = res.headers;
    headerValue = typeof h?.get === 'function' ? h.get(verify.header) : (h?.[verify.header] ?? null);
  } catch (e) {
    error = e?.name === 'AbortError'
      ? `no answer within ${timeoutMs}ms`
      : String(e?.message ?? e).slice(0, 120);
  } finally {
    clearTimeout(timer);
  }

  return gradeHeaderEcho({ status, headerValue, header: verify.header, sha, url, error });
}
