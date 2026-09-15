# POLICY — the per-repo facts the router carries, so no lane has to reason them out

> Copy this file to `_handoffs/_lanes/POLICY.md` at your workspace root and edit it.
>
> Machine-read by `src/lib/policy.mjs`. Every table is found by the HTML comment marker above it,
> never by its heading, so you can rewrite all the prose you like and the columns keep parsing.
>
> **A repo that is not in the `repos` table routes nothing.** The allocator refuses to card it and
> says so by name. Guessing a deploy style or a verification method is how a lane ships a change
> nobody proved, so the router does not guess.

## Seats

A **seat** is one dispatcher: a person or an agent session that owns a set of repos and fires lanes
in them. Every repo names exactly one, in the `dispatch` column below, so ownership is a column
rather than prose typed into several places that drift apart.

This table is OPTIONAL. Leave it out and any seat name is accepted, which is what you want on day
one. Declare it once your seats are real, and a typo in the `dispatch` column starts failing loudly
instead of routing work to a seat nobody is sitting in.

<!-- table: seats -->

| seat | who sits in it |
|---|---|
| product | the product dispatcher |
| infra | the infrastructure dispatcher |

## Repos

`tier` is a **scarcity rule only**. On an unconstrained day it gates nothing: everything fires in
parallel. It decides one thing — when capacity is short and something has to yield, the higher tier
number yields first.

`writers` is a real limit at all times: how many sessions may hold this repo at once. A repo above
1 is only safe because the allocator proves every concurrent pair's declared file scopes disjoint
by path comparison (`src/lib/scope.mjs`), never by judgment.

`deploy` is one of `push` (pushing main deploys), `push+fns` (functions ship by a separate command
first, then push), `cli` (push deploys nothing; a command does), `none`.

`verify` is how a close proves the deploy, and the close runs exactly the form named here, never
another one in its place:

* `sha:<path>:<jsonField>` — the url plus path answers JSON whose field names a commit containing
  the lane's commit. Cannot pass on stale bytes.
* `header:<path>:<headerName>` — the same echo, read from one response header.
* `string` — the repo's `liveness` row below: its url must answer 200 and carry its `expect`
  string. Best-effort evidence.
* `script:<name>` — `npm run <name>` in the lane's checkout; the exit code is the grade.
* `none` — nothing to prove; the gate records `n/a`.

Any other value refuses to load, and the error lists these five. When a sha or header probe cannot
reach its endpoint, the gate records skip or no with the reason; it never falls back to the string
probe. The sha and header forms take auth and timeout from the repo's `liveness` row when it has one.

<!-- table: repos -->

| repo | tier | writers | dispatch | port | deploy | verify | url |
|---|---|---|---|---|---|---|---|
| `web` | 1 | 3 | product | 5173 | push | `sha:/api/status:release` | https://web.example.com |
| `api` | 1 | 2 | product | 5174 | push+fns | `string` | https://api.example.com |
| `repo-a` | 2 | 1 | infra | 5175 | cli | `string` | https://repo-a.example.com |
| `docs` | 3 | 1 | infra | - | push | `none` | - |

## Liveness — the probe that proves a merged change is actually serving

OPTIONAL, and the close SKIPS any repo missing from it, out loud, with the reason. A skip is never
a pass: an unmeasured deployment cannot grade DONE.

Columns:

* `url` — the absolute http(s) URL to GET.
* `expect` — a string that must appear in the response body, or `-` for "a 200 is enough".
* `auth` — `-`, `basic:<ENV_VAR>`, `cookie:<ENV_VAR>`, or `header:<Name>:<ENV_VAR>`.
* `timeout` — milliseconds, or `-` for 10000.

**A credential is NAMED here, never written here.** `auth` carries the NAME of an environment
variable; the value is read at probe time and never printed, not in a verdict and not in an error.
If the variable is unset, the gate SKIPS rather than sending the request bare — grading the
resulting 401 would measure the credential instead of the deployment.

The two rows below are the two shapes worth copying: a public URL with no auth, and a URL behind
HTTP basic auth whose `user:password` pair lives in an environment variable you choose.

<!-- table: liveness -->

| repo | url | expect | auth | timeout |
|---|---|---|---|---|
| `web` | https://web.example.com/ | - | - | - |
| `repo-a` | https://repo-a.example.com/health | `build-ok` | `basic:PANDORAS_REPO_A_PROBE_AUTH` | 8000 |

## Surfaces — where a changed file shows up on the deployed site

OPTIONAL. It lets the `string` verify form probe the file a lane actually changed instead of the
site's root URL. `self` means the file is served verbatim at its own path under the site root;
`none` means the path reaches no rendered page at all, so nothing can be probed and the gate is
EXEMPT rather than failed.

A repo with no rows here keeps the root-URL behaviour.

<!-- table: surfaces -->

| repo | path | surface |
|---|---|---|
| `repo-a` | `public/tools` | self |
| `repo-a` | `.github` | none |

## Exclusive paths — the paths a lane must hold alone

OPTIONAL. Some paths are global machinery rather than lane-local files: a numbered migrations
directory is a sequence applied in order, a deploy-all command ships every function in one folder
including a neighbour's half-merged one, and `package.json` merges as text but breaks as semantics.

A lane whose declared scope touches one of these is widened to that path for comparison, so two
lanes sharing the hazard serialize and two lanes sharing nothing still run side by side.

<!-- table: exclusive -->

| repo | path |
|---|---|
| `api` | `db/migrations` |
| `api` | `db/functions` |
| `web` | `package.json` |

## Env — the allowlist for a fresh worktree's `.env.local`

OPTIONAL, and it is the only thing that lets a credential out of a repository. `lane-open` copies
`.env.local` keys into a fresh worktree so a lane's first job doesn't fail cold on a missing
credential, and it copies exactly the keys a row here names — space-separated, names only, no
values live in this file. **A repo absent from this table gets nothing**, and `open` prints one
line naming the row to add. That default used to be the whole file into every checkout; it was
flipped so a credential leaves a repository only because somebody wrote its name down.

<!-- table: env -->

| repo | keys |
|---|---|
| `api` | `DATABASE_URL STRIPE_KEY` |

## Traps — what a lane must know before it opens here

OPTIONAL. Free text, printed on the lane card.

<!-- table: traps -->

| repo | trap |
|---|---|
| `repo-a` | push does not deploy; run the deploy command once and verify by content string |
| `api` | functions do not ship on a push — run the functions deploy FIRST, then push |

## Models

OPTIONAL. The names a brief's `Model:` line may use, and the exact id each resolves to. The code
ships with NO roster: without this table every model line reads as unrecognised on the card, which
is the honest answer. No fuzzy matching, ever; a name not in this table is named as unknown.

<!-- table: models -->

| name | id |
|---|---|
| `large 5` | `vendor-large-5` |
| `medium 5` | `vendor-medium-5` |
| `small 4.5` | `vendor-small-4-5` |
