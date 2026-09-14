# How the liveness gate reads a response

`live` is the one gate that measures something outside the repository: the close sends an HTTP
GET and reads what came back. This note says exactly what the code does with the answer. Every
sentence traces to `src/lib/liveness.mjs` or to the liveness functions in `src/lib/close.mjs`, and
the first section says which of those the shipped driver actually calls.

## What the shipped driver runs

`src/bin/close.mjs` runs the proof the repo's `verify` column in `POLICY.md` names, and only that
one. `gateLive` reads the column and dispatches on it:

| verify | what the close runs |
|---|---|
| `sha:<path>:<jsonField>` | `probeShaEcho`: GET the repo's url plus path, read one JSON field, grade it with `liveShaVerdict` and a git ancestry check |
| `header:<path>:<headerName>` | `probeHeaderEcho`: the same echo, read from one response header, with the same ancestry check |
| `string` | `probeLiveness` on the repo's `liveness` row (url, expect, auth, timeout); `--proof "<string>"` replaces the row's expect string |
| `script:<name>` | `npm run <name>` in the lane's checkout, graded by its exit code with `scriptProofVerdict` |
| `none` | nothing; the gate records `n/a` |

Every verdict sentence starts with the form that ran and the row that named it, for example
"sha form (verify sha:/api/status:release)", so the printed row and the ledger reason say which
proof stands behind a `yes`.

The sha and header forms compare against the lane's commit, chosen by `laneCommitFor` in
`src/lib/close.mjs`: the merge commit a LAND record names when the checkout knows it, otherwise the
lane branch's tip. They pass on containment, so a deploy a neighbour pushed on top of this lane
still passes. Auth and timeout for them come from the repo's `liveness` row when it has one.

The close never falls back to the string probe. When the policy names sha or header and that probe
cannot reach its endpoint, gets a non-200, or reads no commit, the gate records that probe's own
`skip` or `no` with the reason. A `--proof` flag given under any form but `string` is not used, and
the verdict says so.

An unknown form never reaches the close: `parseVerify` in `src/lib/policy.mjs` throws when
`POLICY.md` loads, and the error lists the five valid forms.

The library still exports pure functions this driver does not call: the proof-string novelty rule
(`proofStringNovel`), the surfaces table and per-file probing (`surfaceReach`, `liveStringVerdict`),
and the second ask (`deployProbePlan`, `verifyProdVerdict`, `obsProbeVerdict`). They are tested in
`test/router-test.mjs` and `test/liveness-test.mjs`, and the sections below say which ones are
library only. The driver's dispatch is tested end to end in `test/verify-driver-test.mjs`, which
runs the close as a child process against a local HTTP server for each form.

## The values

The gate writes one of four words, and the driver turns the library's `skipped` into `skip`
before the grader or the ledger sees it.

| value | meaning |
|---|---|
| `yes` | the proof the policy named ran and passed |
| `no` | the surface answered, and it is not serving this build, or the script failed; a real red |
| `skip` | nothing was measured, for a named reason; never a pass |
| `n/a` | the policy's verify column is `none`, so there is no proof to run |

Every skip reason ends with the sentence "Nothing was measured, and a skip is not a pass." The
grader (`gradeGates`) counts `skip` as a failure, so an unmeasured deployment cannot grade DONE.

A `yes` is not one thing, and its sentence says which kind it is. The value stays `yes` in every
case; only the words beside it change. A yes from a commit echo (the sha or header form) says
"deployment identity". A yes from a body match (the string form) ends with a fixed caveat,
`STRING_YES_CAVEAT`, calling it best-effort evidence and naming what it did not prove. The close
library's string verdict appends the same constant, so the two cannot drift into different wording.
A yes from the script form says its grade is the script's exit code and nothing else.

## The sha form, and why it is the strong one

The driver runs it when the verify column says `sha:`. `probeShaEcho` reads the JSON body (to the
1 MB cap), takes the named field (a dotted name walks nested objects), and hands the value to
`liveShaVerdict`, which takes the release the deployment reports about itself and the lane's
commit. It passes when the two are equal, or when the served release contains the lane's commit by
git ancestry. It fails when the body is not JSON, when the field is absent, or when the served
release neither matches nor contains the commit. It skips when the served release is a commit this
checkout does not know, with the instruction to fetch and close again. Ancestry rather than
equality because with several writers the last push wins the alias, and a lane whose work landed
would otherwise read `no` whenever a neighbour deployed after it.

It is the strong form because it cannot pass on stale bytes: an older build does not contain this
branch's commit. `POLICY.md` expresses it as `sha:<path>:<field>` in the repo's `verify` column.
The second ask's status route, `obsProbeVerdict`, defaults to `/api/status` (`STATUS_ROUTE`,
changeable with `setStatusRoute`) and grades what it reads with the same function.

## The header echo form

The driver runs it when the verify column says `header:`. The same proof as the sha form, read from
one response header instead of a JSON body, for a deployment that names its release in a header.
The row reads `header:<path>:<headerName>`. `gradeHeaderEcho` passes when that header contains the
full commit, or a prefix of it at least seven hex characters long that ends where the hex ends,
because platforms abbreviate. Given the driver's ancestry check, it also passes when the header
names a later commit that contains the lane's commit, and skips when every commit id in the header
is one this checkout does not know. A 200 with the header missing, or naming a known commit that
does not contain the lane's, is `no`. The body is never read, so a body that happens to carry the
commit counts for nothing. The credential and redirect rules below apply unchanged.

`parseVerify` in `src/lib/policy.mjs` accepts the form by calling `parseVerifyHeader`. The one-line
adapter `parseVerifyWithHeader` that stood in before is still exported and gives the same answer.

## The script form

The driver runs it when the verify column says `script:<name>`. It runs `npm run <name>` in the
lane's checkout and grades the exit code: 0 is `yes`, anything else is `no` with the last line of
output. A checkout whose `package.json` does not declare the script is `skip` naming it, because
npm's "Missing script" exit would otherwise blame the deployment for a policy row. A run stopped by
a signal or unable to start is also `skip`.

## The string form and its novelty rule

The driver runs the string form's simplest shape when the verify column says `string`. If the
liveness row's `expect` is set, the body must contain it; if `expect` is `-`, a 200 alone passes,
because that is what the policy asked for.
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

In the string probe (`gradeLiveness`) and in the sha and header forms (`gradeShaEcho`,
`gradeHeaderEcho`), a 401 or 403 is
`no`: the probe carried whatever credential the policy named and was still refused, so either the
credential is wrong or the surface is not serving. The sentence says "This is a red, not a skip:
something answered and it was not this build."

In the library's string verdict (`liveStringVerdict`), a walled URL is `skip`: the gated pages
refused an unauthenticated probe, the string may well be behind the wall, and the close will not
call a surface it could not open.

`exempt` is one more word the grader accepts as a pass. The ledger header in `src/lib/lanes.mjs`
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
marker past the cap is reported as not carried. A non-200 body is not read at all. The sha form
reads its JSON body to the same cap, and the header form reads no body. The sha and header forms
take the timeout and auth from the repo's liveness row, and 10000 ms with no credential when it has
none.

## The second ask

Library only. `deployProbePlan` fires only when the value is `skip`. It runs the repo's own
`verify:prod` script if `package.json` has one, grading by exit code; otherwise, if the policy
gives a URL, it asks the deployment's status route and grades by the sha form; otherwise the skip
stands with the reason named. It can turn an unmeasured gate into a measured one and can never
turn a `no` into a pass.
