# How the liveness gate reads a response

`live` is the one gate that measures something outside the repository: the close sends an HTTP
GET and reads what came back. This note says exactly what the code does with the answer. Every
sentence traces to `src/lib/liveness.mjs` or to the liveness functions in `src/lib/close.mjs`, and
the first section says which of those the shipped driver actually calls.

## What the shipped driver runs

`src/bin/close.mjs` calls `probeLiveness` and nothing else. It reads the repo's row from the
`liveness` table in `POLICY.md` (url, expect, auth, timeout), sends one request, and grades the
answer with `gradeLiveness`. A `--proof "<string>"` flag on the command line replaces the row's
`expect` string for that run. The driver never reads the repo's `verify` column, so however that
column is set, the shipped close runs the URL-and-string probe.

The library also exports a richer set of pure functions: the sha form (`liveShaVerdict` in
`src/lib/close.mjs`), the header echo form (`parseVerifyHeader`, `gradeHeaderEcho` and
`probeHeaderEcho` in `src/lib/liveness.mjs`), the proof-string novelty rule (`proofStringNovel`),
the surfaces table and per-file probing (`surfaceReach`, `liveStringVerdict`), and the second ask
(`deployProbePlan`, `verifyProdVerdict`, `obsProbeVerdict`). They are tested in
`test/router-test.mjs` and `test/liveness-test.mjs`, and this driver does not call them. They are
described below because reviewers asked about them, and each section says which set it belongs to.

## The three values

The gate writes one of three words, and the driver turns the library's `skipped` into `skip`
before the grader or the ledger sees it.

| value | meaning |
|---|---|
| `yes` | the surface answered 200 and carried what the policy asked for |
| `no` | the surface answered, and it is not serving this build; a real red |
| `skip` | nothing was measured, for a named reason; never a pass |

Every skip reason ends with the sentence "Nothing was measured, and a skip is not a pass." The
grader (`gradeGates`) counts `skip` as a failure, so an unmeasured deployment cannot grade DONE.

A `yes` is not one thing, and its sentence says which kind it is. The value stays `yes` in every
case; only the words beside it change. A yes from a commit echo (the sha or header form) begins
"deployment identity". A yes from a body match (the string form, which is what the shipped driver
runs) ends with a fixed caveat, `STRING_YES_CAVEAT`, calling it best-effort evidence and naming
what it did not prove. The close library's string verdict appends the same constant, so the two
cannot drift into different wording.

## The sha form, and why it is the strong one

Library only. `liveShaVerdict` takes the release the deployment reports about itself and the
branch's head commit. It passes when the two are equal, or when the served release contains the
branch head by git ancestry. It fails when the deployment answered with no release field, or when
the served release neither matches nor contains the head. It skips when the served release is a
commit this checkout does not know, with the instruction to fetch and close again. Ancestry rather
than equality because with several writers the last push wins the alias, and a lane whose work
landed would otherwise read `no` whenever a neighbour deployed after it.

It is the strong form because it cannot pass on stale bytes: an older build does not contain this
branch's commit. `POLICY.md` expresses it as `sha:<path>:<field>` in the repo's `verify` column.
The second ask's status route, `obsProbeVerdict`, defaults to `/api/status` (`STATUS_ROUTE`,
changeable with `setStatusRoute`) and grades what it reads with the same function.

## The header echo form

Library only. The same proof as the sha form, read from one response header instead of a JSON
body, for a deployment that names its release in a header. The row would read
`header:<path>:<header-name>`. `gradeHeaderEcho` passes when that header contains the full commit,
or a prefix of it at least seven hex characters long that ends where the hex ends, because
platforms abbreviate. A 200 with the header missing or naming another commit is `no`. The body is
never read, so a body that happens to carry the commit counts for nothing. The credential and
redirect rules below apply unchanged.

The policy parser does not accept this form yet. `parseVerify` in `src/lib/policy.mjs` still
refuses anything but `sha:`, `string`, `script:` and `none`; the header form is offered through a
one-line adapter, `parseVerifyWithHeader`, until the policy file's owner adds it.

## The string form and its novelty rule

The shipped probe is the string form's simplest shape. If the row's `expect` is set, the body must
contain it; if `expect` is `-`, a 200 alone passes, because that is what the policy asked for.
Either way the yes carries the best-effort caveat. The driver applies no novelty rule: a string
that was already on main passes if it is served.

The library's `proofStringNovel` is the rule reviewers asked about. It refuses a proof string
unless it appears as an added line in the branch's own diff. A string found only as context or as
a removed line is already on main, so finding it live proves nothing about this deploy; a string
that does not appear in the diff at all cannot fail, and an assertion that cannot fail is
decoration. `liveStringVerdict` then grades the probed URLs in a fixed order. Any URL carrying the
string is `yes`, with the caveat. Otherwise one walled URL (401 or 403) makes the whole reading
`skip`, even beside a dozen that answered 200, because the string may be behind the wall. Otherwise,
if at least one URL answered 200 without the string, the reading is `no`. If nothing answered
readably, it is `skip`.

## A lazily-loaded chunk

Both sets say the same thing in their `no` sentence. When a 200 does not carry the string, either
the deploy has not landed or the string sits in a chunk this single fetch never asked for. For a
bundled application the second case is the common one, so a marker served in the initial response
is the reliable string, and a commit echo is the reliable proof. The probe fetches one URL and does
not follow script or link tags.

## A CDN cache

The probe sends no cache-busting header or query string and reads whatever the URL answers, so a
cached response reads the same as a fresh one. The caveat on every string yes names "a cached
response" as one of the things a body match cannot rule out. A commit echo is the answer here too:
a cached older build names an older commit, which grades `no` rather than `yes`.

## A 401 or a 403

Two different readings, and neither is `exempt`.

In the shipped probe (`gradeLiveness`) and in the header form (`gradeHeaderEcho`), a 401 or 403 is
`no`: the probe carried whatever credential the policy named and was still refused, so either the
credential is wrong or the surface is not serving. The sentence says "This is a red, not a skip:
something answered and it was not this build."

In the library's string verdict (`liveStringVerdict`), a walled URL is `skip`: the gated pages
refused an unauthenticated probe, the string may well be behind the wall, and the close will not
call a surface it could not open.

`exempt` is a fourth word the grader accepts as a pass. The ledger header in `src/lib/lanes.mjs`
defines it as a surface that answered and correctly refused an unauthenticated probe, and
`site/gates.html` describes it the same way. No function in this repository writes it. The
`surfaces` table in `POLICY.md` can declare a path `none`, and `surfaceReach` then reports the
change as `unreachable`, which is the reading `exempt` was designed for; turning that into the word
itself is left to a driver outside this repository.

## A credential that is missing or misnamed

The probe is not sent bare. If the row names an environment variable that is unset or empty, the
result is `skip` naming the variable, because grading the resulting 401 would measure the
credential rather than the deployment. If the variable's name does not start with `PANDORAS_`
(configurable), its value is never read and the probe is not sent, also `skip`. A credential value
never appears in a verdict or an error; the test suite asserts that.

## A redirect when a credential is attached

A probe carrying a credential is sent with `redirect: 'manual'` and never follows a 3xx, because a
cookie or a custom header would travel with the redirect to whatever host answered. The 3xx grades
`no`, with the instruction to point the row at the final URL. A bare probe, one with no
credential, may follow redirects, because there is nothing to leak.

## The timeout and the body cap

The row's `timeout` (10000 ms when the row gives `-`, set in `parseLiveness`) aborts the request;
an abort or any other network error is `skip`, since an unreachable surface is unmeasured rather
than failed. A 200 body is read to `BODY_CAP_BYTES`, 1 MB, and no further: the reader streams and
stops at the cap. The cap is counted on the decoded text, so it is about one million characters. A
marker past the cap is reported as not carried. A non-200 body is not read at all, and the header
form reads no body.

## The second ask

Library only. `deployProbePlan` fires only when the value is `skip`. It runs the repo's own
`verify:prod` script if `package.json` has one, grading by exit code; otherwise, if the policy
gives a URL, it asks the deployment's status route and grades by the sha form; otherwise the skip
stands with the reason named. It can turn an unmeasured gate into a measured one and can never
turn a `no` into a pass.
