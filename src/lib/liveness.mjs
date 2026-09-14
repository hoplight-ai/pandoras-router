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
