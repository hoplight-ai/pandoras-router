# Pandora's Router

Run many AI coding agents on one codebase at once: prove their declared file scopes disjoint
before any of them start, then independently verify what each one claims it finished.

## The problem

Every tool in this category that I compared, fourteen at the time of writing, solves parallel agents with isolation. Give each agent its own git
worktree or its own container and they stop fighting over one working directory. That is real and
it is not enough. Two agents in two copies can still rewrite the same file, and nothing notices
until the merge, by which point both pieces of work exist and one of them has to lose.

The second half is quieter. An agent's report that it finished is the least reliable signal in the
system, and it is the one almost every orchestrator takes at face value. Merged is not shipped. A
green build is not a served page. A change nobody can see in a browser is indistinguishable from
success until somebody looks.

So this does two things. Before dispatch it compares declared file scopes by path and refuses to
start two lanes whose scopes intersect. After the work it measures: the content on main, the
build, the deployed URL, the files the branch actually touched against the files it said it would
touch, and the report's own words. Files and git, nothing else.

## Quickstart

From the repo root:

```
npm test
```

600 assertions across 14 suite files, all passing. 235 of them are marked red-proof by their own
suite: each asserts a refusal, or that a weakening turns the suite red, so deleting a guard turns
them red rather than quietly widening what the tool allows. Each suite prints its own count as it
runs: the allocator and scope suite reports 137 of its 318 as red-proof, the shell guards 34 of
50, each fed the exact input that once walked past it, the liveness gate 25 of 53, the close
driver's verify dispatch 10 of 14, each running the real close against a local server, the lock's
concurrency suite 7 of 10, each racing two real processes, and the scope property suite 5 of 15,
over six properties at 3,000 generated cases each.

The runner discovers its suites: every `*-test.mjs` file in `test/` runs, so a new suite needs no
list edited. After the suites, `npm test` runs `npm run typecheck`, which holds the JSDoc in every
file to the code it describes. The checker is fetched on first run through npx at pinned versions
(TypeScript 6.0.3 and Node 22 type declarations) into npx's cache, so the package still has zero
dependencies. Every file under `src/` and `hooks/` starts with `// @ts-check`, so an editor with
Node types available checks it as you type.

Most measurements quoted in the code's comments are from the tool's first four weeks in use on
one operator's board: 511 lane closes across the 25 days from 18 August to the day it was
published, 13 September 2026, an average of 20 a day and a peak of 47, every one graded by these
gates. That board is where each gate earned its place.

Now build a throwaway workspace out of `examples/`. A workspace is any directory holding a
`_handoffs/` bridge and your repos:

```
mkdir -p /tmp/pandoras-demo/_handoffs/_lanes
cp examples/POLICY.md examples/PREFIXES.md examples/CLAIMS.md examples/LANES.md /tmp/pandoras-demo/_handoffs/_lanes/
cp examples/Web-CEILING1-Raise-The-Per-Provider-Cap.md /tmp/pandoras-demo/_handoffs/
PANDORAS_ROOT=/tmp/pandoras-demo node src/bin/router.mjs alloc
```

You get one lane card: the repo, the branch, the worktree, the dev port, the derived report
filename, how that repo deploys, how a deploy gets proved, and the three files the brief declared.
Every field is read from a file. None of it is inferred from the brief's wording.

Add a second brief over the same files and run it again:

```
cp examples/Web-CEILING1-Raise-The-Per-Provider-Cap.md /tmp/pandoras-demo/_handoffs/Web-POOL2-Same-Files.md
PANDORAS_ROOT=/tmp/pandoras-demo node src/bin/router.mjs alloc
```

One card now says FIRE NOW and the other says QUEUED, naming the lane it waits on and the three
paths where the two scopes intersect. That refusal is the whole product.

`node src/bin/router.mjs` with no arguments lists the subcommands: `alloc`, `open`, `close`,
`land`, `claim`, `apply`. `alloc` writes no record; it only produces cards.

## The two ideas

### Declared file scope, before dispatch

A brief declares the files it will write, on one line:

```
- **Touches:** `src/providers/pool.ts`, `src/providers/limits.ts`, `test/pool-test.mjs`
```

The allocator normalizes every declared path to one canonical form, then compares paths exactly or
as directory containment on whole path segments. Never as a string prefix, which says `app`
contains `application/x` and is wrong, and never by similarity. Two lanes may run in one repo only
when their declared scopes have zero intersection.

Undeclared never means probably fine. A brief with no `Touches:` line owns its whole repository
and serializes against everything in it. `Touches: none` is a different claim: that lane writes no
repo file, holds no writer slot, blocks nobody, and its close fails by name if it writes one.
Where a scope cannot be compared exactly, a mid-path glob for instance, it widens to the parent
directory. Widening over-reports overlap, which costs a wait. Narrowing would under-report it,
which costs somebody's work, so narrowing is never done.

Some paths are global machinery rather than lane-local files: a numbered migrations directory, a
deploy-all command that ships every function in one folder, `package.json`. A lane touching one
holds that path alone and leaves the rest of the repo open. 42 of them are exclusive in every repo
with no configuration: the common lockfiles and package manifests across Node, Rust, Go, Python,
Ruby, PHP, the JVM, Swift, Dart and Elixir, the usual migrations directories and schema files, and
the router's own state directory. A repo can add more in its policy file; nothing can remove a built-in one.

The declaration is written into the ledger when the lane opens, which is what lets a second lane
be proved disjoint from a running one instead of assumed to collide. The close then checks every
file the branch actually touched against that same declaration, so the promise has teeth at both
ends.

### Verification, after

An agent says it finished. `close` finds out. The shipped driver measures seven gates:

| gate | what it measures |
|---|---|
| `merged` | every path the branch touched is byte-identical on main, compared blob by blob rather than by git ancestry, because a squash merge throws the fingerprints away |
| `green` | `npm run build` in the lane's own checkout exited 0 |
| `live` | the proof the repo's `verify` policy names ran and passed: a commit echo, a served string, or a script (see below for how strong each is) |
| `renamed` | the brief carries a closed prefix, so the next dispatch does not fire it a second time |
| `in-scope` | every path the branch touched is inside the scope the lane declared at open |
| `findings` | every `FINDING:` line in the report carries a fix, a size and an owner |
| `no-side-files` | no new tracker-shaped file appeared on the bridge and attributed to this lane |

DONE requires all of them. Anything else is PARTIAL with the failing gates named. An eighth input,
the report's own STATUS word, can only lower the grade: a report that says PARTIAL in its own
words is never graded DONE by gates that happened to pass.

Three things stop a close outright and write nothing, whatever the gates say: a report on the
bridge with no STATUS word, a report that says DONE with no `Evidence:` line, and a report that
says DONE beside a skipped or deferred step that no `overruled:` line answers. A close run before
the report exists is not refused; that is the normal order.

`close` measures and prints; `close --apply` also renames the brief, appends the CLOSE record and
releases the lane's claim.

### The liveness gate, and skip is not a pass

`live` is the gate none of those fourteen runs. Every other check asks a question about the
repository, and all of them can be true while the page a person opens is last week's build. So the
close sends a GET and reads what came back.

It returns three values, not two, plus `n/a` for a repo whose policy names no proof:

* `yes` the proof the policy named ran and passed.
* `no` the surface answered and it is not serving this build, or the script failed. A real red.
* `skipped` nothing was measured, for a named reason.

A skip is never a pass, and the grader counts it as a failure. No URL in policy, a named
credential that is unset, a socket that never answered: each of those measured nothing, and a gate
that printed a soft dash for them would teach everybody to read the column as green. That is the
failure mode which makes a liveness check worthless, so the probe's value is the literal word
`skipped`, recorded in the ledger as `skip`, the reason is always named, and the sentence "Nothing was measured, and a skip is not a pass" is
part of the output rather than a convention.

Credentials are named, never stored. Policy carries the name of an environment variable; the value
is read at probe time and never printed, not in a verdict and not in an error. If the variable is
empty the probe is not sent bare, because grading the resulting 401 would measure the credential
rather than the deployment.

The close runs the proof the repo's `verify` column in the policy names, and only that one. A sha
echo (`sha:<path>:<jsonField>`) reads a JSON field in which the deployment names its own commit,
and passes when that commit contains the lane's, so a neighbour deploying on top does not turn a
landed lane red. A header echo (`header:<path>:<headerName>`) reads the same from one response
header and never the body. Both say "deployment identity" beside their `yes`, and neither can pass
on stale bytes. The string form (`string`) reads the repo's row in the `liveness` table, sends one
GET, and passes on a 200 that carries the row's expected string; `--proof` swaps in a different
string for one run. Its `yes` says in its own sentence that it is best-effort evidence, because a
cached response, a stale build that carries the string, or an unrelated route reads the same.
`script:<name>` runs that npm script in the lane's checkout and grades the exit code. `none`
records n/a. Every verdict names the form that ran. When a sha or header endpoint cannot be reached
or names no commit, the gate records that skip or no with the reason and never falls back to the
string probe, and an unknown form refuses to load. The details, including 401s, redirects, CDN
caches and the 1 MB body cap, are in [`docs/LIVENESS.md`](docs/LIVENESS.md).

Full gate reference, including the three gates the grader supports but this driver records as
unmeasured: the gate matrix, [`docs/gates.json`](docs/gates.json), which
`test/gate-matrix-test.mjs` holds to the code.

## What this proves, and what it does not

Disjoint declared scopes prove one thing: no two lanes running together will write the same file.
The close then proves by measurement that a lane stayed inside what it declared, that its bytes are
on main, that its own checkout builds, and that its URL answered with what the policy asked for.
That is the whole claim.

It does not prove that two lanes cannot break each other through something a file boundary does
not carry: an API shape, a database schema, a generated file, a shared constant. Lane A renames a
field on a server response and declares only the server file. Lane B changes the client that reads
that field and declares only the client file. Both scopes are disjoint, both lanes close
`in-scope=yes`, both builds go green on their own, and the combination is broken. If the field's
definition lives in a path on the exclusive list, the two lanes serialize. Otherwise nothing in the
shipped driver stops the pair: `merged` catches two lanes in one file, not in two, and `green`
builds each lane's checkout, not main with both merged. The router does not claim it can.

It is built for one shared machine. The ledger, the claims file, the lock and the worktrees are
local files, so two dispatchers on two machines, or on a network filesystem, share none of the
guarantees. It trusts that machine, the operator and the policy files. It does not trust an agent's
branch or its report, and its command guards stop a slip, not a determined adversary.

Read further:

- [Design notes](docs/DESIGN-NOTES.md): Markdown tables as state, declared paths instead of a
  dependency graph, and why an undeclared scope serializes.
- [Threat model](docs/THREAT-MODEL.md): what is trusted, what is not, and the non-goals.
- [Gate matrix](docs/gates.json): every gate, the ledger column it writes, the values it can write,
  what it proves and what it does not. `test/gate-matrix-test.mjs` keeps it honest.
- [How the liveness gate reads a response](docs/LIVENESS.md)
- [Prior art](docs/PRIOR-ART.md)

## Prior art, and how this differs

Worth saying plainly, because the honest version is more useful than a claim of novelty.

Most of the field solves parallel agents with isolation alone: a git worktree or a container each.
That is a real fix for a real problem and this project does not improve on it. It just does not
address two agents rewriting the same file in separate copies, where the collision surfaces at
merge.

**[Bernstein](https://github.com/sipyourdrink-ltd/bernstein)** does declare owned files, refuse
overlapping jobs, and verify completions. It is the closest thing to this that exists, and it got
there first. The differences are in where each one puts the burden of proof. Bernstein is demoting
file-overlap checking to a legacy fallback in favour of an author-declared `parallel_safe` flag;
it infers a job's file scope from the task's wording when none is declared; an empty declaration
silently disables its guard; and a scope violation raises a question rather than refusing. Here,
an undeclared scope is the whole repository and serializes, an unparseable scope widens rather
than narrows, and a violation is a refusal with the overlapping paths named. Those are judgment
calls about false positives against lost work, not a claim that one design is correct.

**[Agent Orchestrator](https://github.com/Untrivial-ai/agent-orchestrator)** never stores a status
at all. It recomputes state from pull-request and CI facts every time it is asked, so a stored
status can never go stale against reality. That is a cleaner idea than a ledger and it is worth
reading for its own sake. This project keeps an append-only ledger instead, because it needs a
lane's declared scope and its open timestamp recorded at the moment of dispatch, which no PR or CI
fact carries.

Of the fourteen tools compared, none did both scope-before-dispatch and
verify-after, and none checked that a merged change is actually live at a URL. That gap, rather
than either half on its own, is what this fills.

## Install

Node 22 or newer, per the `engines` field. Verified here on Node 25.9.0.

Zero npm dependencies: Node builtins and `git`. No build step, no lockfile to audit, nothing to
install before `npm test` runs. The type check at the end of `npm test` fetches TypeScript through
npx on its first run, so that one step needs the network once.

```
git clone https://github.com/hoplight-ai/pandoras-router
cd pandoras-router
npm test
```

The package declares a `pandoras-router` binary pointing at `src/bin/router.mjs`, so an install or
a link puts that name on your path. Running `node src/bin/router.mjs <subcommand>` from the repo
is equivalent and needs no install at all.

Every driver resolves the workspace root, the directory holding `_handoffs/` and your repos, from
`$PANDORAS_ROOT`, falling back to the current directory. The package's own install location is
never treated as the workspace root.

## Configuration

Four files under `_handoffs/_lanes/` at your workspace root, all of them tables read by code and
prose read by people. Copy them from `examples/` and edit:

| file | what it holds |
|---|---|
| `POLICY.md` | one row per repo: writer cap, deploy style, how a deploy is proved, the liveness URL, exclusive paths, the `.env.local` key allowlist, traps |
| `PREFIXES.md` | the filename vocabulary. An unrecognized lifecycle word routes nothing and is named on stdout, rather than defaulting to live |
| `CLAIMS.md` | the visible lock, one line per active lane. Ships empty |
| `LANES.md` | the append-only ledger of every lane opened, landed and closed. Ships empty |

A repo with no row in `POLICY.md` routes nothing, and the allocator says so by name. Guessing a
deploy style or a verification method is how a change ships that nobody proved, so it does not
guess.

`examples/liveness.env.example` shows the three credential shapes the liveness probe understands
and where the values live. The probe only reads an environment variable whose name starts with
`PANDORAS_`, so a policy row can reach a secret minted for the probe and nothing else; a probe
carrying a credential never follows a redirect, and reads at most 1 MB of the response.

Three more things are configuration rather than code, and each ships empty or neutral:

| what | where | default |
|---|---|---|
| the workspace root's key in the repos table | `root` (see `src/lib/root.mjs`) | `root` |
| the spellings a brief may use for the root, and the prefix stripped from quoted paths | `setRootAliases()` in `briefs.mjs`, `setWorkspacePrefixes()` in `scope.mjs` | none |
| the model names a brief's `Model:` line may use | an optional `models` table in `POLICY.md`, columns `name` and `id` | empty, so every model line reads as unrecognised until you declare one |

## What this touches on your machine

Read this before wiring anything in. None of it is hidden in the code, and none of it should be a
surprise on the day it matters.

- **`open` copies the repo's `.env.local` into every worktree it creates**, mode 600, never
  overwriting one that is already there. It copies the whole file, unless the repo has a row in
  the policy's `env` table naming an allowlist; then only those keys are copied, and a listed key
  the file lacks is reported missing by name rather than written empty. A fresh checkout has no
  credential otherwise and a lane fails cold on its first job. The cost is that a credential file,
  or the allowed slice of one, now exists once per checkout; removing a worktree by hand leaves its
  copy behind unless you delete it too.
- **The state directory carries a lock file, `_handoffs/_lanes/.lock`.** Every write to
  `CLAIMS.md` and `LANES.md` happens while one process holds it, and `open` re-checks the board
  under it, so two dispatchers opening overlapping lanes at the same moment get one open and one
  refusal. The file holds the holder's pid, host, start time and script name. A caller waits up to
  60 seconds for a live holder, then refuses and names it. A lock whose holder is dead on this host,
  or that is older than five minutes, is broken with one printed line saying whose it was. A
  short-lived `.lock.break` file guards the break. It is a lock for one local filesystem, not for a
  network share.
- **`close` runs the branch's own `npm run build` on the dispatcher's machine**, in the lane's
  checkout, with a 15-minute timeout. That is what a build gate is, and it means a lane's
  `package.json` runs code where the close runs, with the close's permissions and no sandbox. Do not
  close a branch you would not build. A checkout with no `build` script records `n/a`; one with no
  `node_modules`, or a close run with `--no-build`, records `skip`, which is not a pass.
- **The two command guards in `hooks/`, `guard-irreversible.mjs` and `guard-report-overwrite.mjs`,
  are Node pattern matchers.** They use Node built-ins only and need nothing else on the path: no
  bash, no Python. The irreversible-action guard refuses what it can see on the command line or in
  the SQL string: every spelling of force-push, branch deletion, worktree removal and history
  rewrite, `git clean -f`, `rm` with a recursive and a force flag, schema and unbounded row
  changes, and a git alias defined on the same line. A command hidden in a script file, a
  `sh -c "$(cat x)"`, or SQL sent through a file or a stored procedure walks past it. Both guards
  fail closed on input they cannot read as a JSON object.
- **The unlock phrase has no default.** It is a human-confirmation protocol, not a secret: the way
  a person, not an agent, says yes to one action no commit can undo. Set `PANDORAS_UNLOCK_PHRASE` to
  a phrase of your own. With it unset or blank, nothing unlocks the guard in that session and every
  gated command is refused with the reason named. The phrase counts only when a person types it in
  the session as a whole message or on a line by itself; an agent writing the words, a brief
  quoting the rule or a pasted log does not unlock anything. Once typed it holds for the rest of
  that session. Pick a phrase that is not ordinary English.
- **The report-overwrite guard** refuses a whole-file `Write` onto an existing `.md` at the root
  of `_handoffs/`, except the bridge's own furniture: `README.md` and `_STANDING_ORDERS.md` by
  default, or the space-separated list in `PANDORAS_BRIDGE_FURNITURE`.
- **The wide-read guard, `guard-wide-read.mjs`,** refuses a whole-file `Read` of a text file over
  12,000 bytes, about 3,000 tokens, and tells the caller to name a range. It never truncates, and a
  read that names a range always passes. Unlike the other two it fails open on input it cannot
  parse. `CLAUDE_WIDE_READ_BYTES` retunes the threshold and `0` turns it off.
  `hooks/measure-wide-read.mjs` reruns the measurement behind that number on your own transcripts
  and prints no transcript file name, project name or prompt text.
- All three guards append one line per refusal to `hooks/guard-log.jsonl` (gitignored) when the
  harness supplies a session id, and nothing on a pass.

## License

MIT. See [LICENSE](LICENSE).

Contributors are expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
