# Pandora's Router

Built by Whit Pendergast at Hoplight (https://hoplight.ai).

Site: https://pandoras-router.vercel.app

Run many AI coding agents on one codebase at once: prove their declared file scopes disjoint
before any of them start, then independently verify what each one claims it finished.

## The problem

Most of the field solves parallel agents with isolation: a git worktree or a container each. That's
real and it isn't enough. Two agents in two copies can still rewrite the same file, and nothing
notices until the merge, by which point one of the two pieces of work has to lose. The second half
is quieter: an agent's report that it finished is the least reliable signal in the system, and it's
the one almost every orchestrator takes at face value. Merged is not shipped. A green build is not a
served page.

So this compares declared file scopes by path before dispatch and refuses to start two lanes whose
scopes intersect, then after the work measures the content on main, the build, the deployed URL, the
files the branch actually touched against the files it said it would, and the report's own words.
Files and git, nothing else. The argument in full is on the
[site](https://pandoras-router.vercel.app).

## Quickstart

From the repo root:

```
npm ci --ignore-scripts
npm test
```

CI runs those same two commands on every push and pull request, on Node 22 and 24, on Ubuntu,
macOS and Windows (six matrix cells, `.github/workflows/ci.yml`). The install is only for the type
check at the end; see [Install](#install) for what it fetches and what pins it.

Every suite prints its assertion count as it runs, and how many are red-proof: each asserts a
refusal, or that a weakening turns the suite red, so deleting a guard turns them red rather than
quietly widening what the tool allows. The counts aren't copied here because they grow with every
change; the run is the record. The heaviest suites are the allocator and scope suite, the shell
guards (each fed the exact input that once walked past it), the liveness gate, the close driver's
verify dispatch (a real close against a local server), the build gate (a real close against a fake
npm), the lock's concurrency suite (two real processes racing), and the scope property suite (six
properties over thousands of generated cases).

The runner discovers its suites: every `*-test.mjs` file in `test/` runs, so a new suite needs no
list edited. After them, `npm test` runs `npm run typecheck`, which holds the JSDoc in every file to
the code it describes. That needs the TypeScript compiler and Node's type declarations, so run
`npm ci --ignore-scripts` once first; both are dev dependencies pinned to an exact version and the
run itself downloads nothing. Every file under `src/` and `hooks/` starts with `// @ts-check`.

Most measurements quoted in the code's comments come from the tool's first four weeks on one
operator's board: 511 lane closes across the 25 days from 18 August to publication on 13 September
2026, an average of 20 a day and a peak of 47, every one graded by these gates.

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
Every field is read from a file, never inferred from the brief's wording.

Add a second brief over the same files and run it again:

```
cp examples/Web-CEILING1-Raise-The-Per-Provider-Cap.md /tmp/pandoras-demo/_handoffs/Web-POOL2-Same-Files.md
PANDORAS_ROOT=/tmp/pandoras-demo node src/bin/router.mjs alloc
```

One card now says FIRE NOW and the other says QUEUED, naming the lane it waits on and the three
paths where the two scopes intersect. That refusal is the whole product.

Before firing anything, ask whether the workspace itself is sound:

```
PANDORAS_ROOT=/tmp/pandoras-demo node src/bin/router.mjs check
```

It reads `POLICY.md`, `PREFIXES.md`, `CLAIMS.md` and `LANES.md` the same way every other subcommand
does, and every bridge filename against the vocabulary, then prints one line per problem grouped by
file and a final count. Against the demo workspace it prints `OK` and exits 0. It reads and never
writes, and exits non-zero the moment there's anything to fix, so `check && alloc` is a safe chain.

`board` asks the same workspace what's going on in it right now, in four labelled sections, oldest
and most informative first: **active claims** (who holds what, flagged when one has aged past the
adjudication threshold or one lane holds two claims on one repo), **open lanes** (every OPEN record
with no CLOSE beside it, oldest first, because age is the signal), **recent closes** (everything
that finished in the last 48 hours, marked when the same lane closed twice, a sign its brief was
never renamed and fired again), and **orphaned lanes** (an open lane whose worktree or branch is
gone, whose report already landed, whose record outlived the active window with no CLOSE, or that
holds no claim while still reading OPEN). An empty section prints one sentence saying so: a quiet
board, not a proven-clean one. `board` reads CLAIMS.md, LANES.md, the bridge and, for each open
lane, the filesystem and git; it writes nothing, the same as `alloc`.

`land` puts a lane on main as one merge commit and writes a LAND record carrying the branch tip and
the merge sha, so undoing it later is one lookup and one command. `revert <lane>` is that command:
it finds the LAND record, reverses the merge with `git revert -m 1 <merge>`, and writes a REVERT
record. **It adds a commit; it never rewrites history.** It never force-pushes and never deletes a
branch, because the lane's branch tip is still the record of what the lane wrote and reverting on
main doesn't make it untrue. It doesn't push either: it stops after the local commit and prints the
one line to run next, which is to push the lane's own branch and open a pull request.

`node src/bin/router.mjs` with no arguments lists the subcommands: `board`, `alloc`, `open`,
`close`, `land`, `revert`, `claim`, `apply`, `check`. `alloc` and `board` write no record, and
`check` writes nothing at all.

## The two ideas

**Declared file scope, before dispatch.** A brief declares the files it will write on one
`**Touches:**` line. The allocator normalizes every declared path, then compares paths exactly or as
directory containment on whole path segments, never as a string prefix and never by similarity; two
lanes may run in one repo only when their declared scopes have zero intersection. Undeclared never
means probably fine: a brief with no line owns its whole repository and serializes, `Touches: none`
means the lane writes no repo file and its close fails by name if it writes one, and a scope that
can't be compared exactly widens to the parent directory rather than narrowing, because widening
costs a wait and narrowing costs somebody's work. 42 paths are exclusive in every repo with no
configuration: the common lockfiles and package manifests across Node, Rust, Go, Python, Ruby, PHP,
the JVM, Swift, Dart and Elixir, the usual migrations directories and schema files, and the router's
own state directory. A repo can add more but can't remove a built-in one.

**Verification, after.** An agent says it finished; `close` finds out. The shipped driver measures
seven gates (`merged`, `green`, `live`, `renamed`, `in-scope`, `findings`, `no-side-files`) and
DONE requires all of them, so anything else is PARTIAL with the failing gates named; the report's
own STATUS word is an eighth input that can only lower the grade. Three things stop a close outright
and write nothing: no STATUS word, DONE with no `Evidence:` line, and DONE beside a skipped or
deferred step that no `overruled:` line answers. `close` measures and prints; `close --apply` also
renames the brief, appends the CLOSE record and releases the claim. `live` is the gate none of the
tools in [docs/PRIOR-ART.md](docs/PRIOR-ART.md) runs: it sends a GET and grades what came back, in
the one form the repo's `verify` column names: a commit echo in a JSON field or a response header
(neither can pass on stale bytes), a served string (best-effort, and its verdict says so), an npm
script, or `none`. A skip is never a pass.
**[Every gate, and what each one refuses](https://pandoras-router.vercel.app/gates.html)**; the full
matrix is [`docs/gates.json`](docs/gates.json), held to the code by `test/gate-matrix-test.mjs`, and
[`docs/LIVENESS.md`](docs/LIVENESS.md) covers 401s, redirects, CDN caches and the 1 MB body cap.

## What this proves, and what it does not

Disjoint declared scopes prove one thing: no two lanes running together will write the same file.
The close then proves by measurement that a lane stayed inside what it declared, that its bytes are
on main, that its own checkout builds, and that its URL answered with what the policy asked for.
That's the whole claim.

It doesn't prove two lanes can't break each other through something a file boundary doesn't carry:
an API shape, a database schema, a generated file, a shared constant. Both scopes can be disjoint,
both lanes close `in-scope=yes`, both builds go green alone, and the combination is broken. If the
shared definition lives on the exclusive list the two lanes serialize; otherwise nothing in the
shipped driver stops the pair, and the router doesn't claim it can. It's also built for one shared
machine: the ledger, the claims file, the lock and the worktrees are local files, so two dispatchers
on two machines, or on a network filesystem, share none of the guarantees. It trusts that machine,
the operator and the policy files; it doesn't trust an agent's branch or its report, and its command
guards stop a slip, not a determined adversary.

Read further: [Design notes](docs/DESIGN-NOTES.md), [Threat model](docs/THREAT-MODEL.md),
[Gate matrix](docs/gates.json), [How the liveness gate reads a response](docs/LIVENESS.md),
[which modules track the private tree this was extracted from and which are forked on
purpose](docs/adr/0001-shared-and-forked-modules.md), where `npm run shared:check` compares the four
meant to match and names any that differ (it reports, it never copies), and
[Prior art](docs/PRIOR-ART.md).

## Prior art

Most of the field solves parallel agents with isolation alone, and this project doesn't improve on
that. [Bernstein](https://github.com/sipyourdrink-ltd/bernstein) declares owned files, refuses
overlapping jobs and verifies completions: the closest thing to this that exists, and it got there
first, differing in where each puts the burden of proof.
[Agent Orchestrator](https://github.com/Untrivial-ai/agent-orchestrator) never stores a status at
all, recomputing state from pull-request and CI facts every time it's asked, which is a cleaner idea
than a ledger. Of the three entries written up in [docs/PRIOR-ART.md](docs/PRIOR-ART.md), none did
both scope-before-dispatch and verify-after, and none checked that a merged change is actually live
at a URL. That gap, rather than either half on its own, is what this fills. Three is what's written
down and shown; it isn't a survey, and a fourth entry that does both halves would be worth a row.
The side-by-side is on the [site](https://pandoras-router.vercel.app).

## Install

Node 22 or newer, per the `engines` field. Verified here on Node 25.9.0.

**What the tool itself depends on, and what you're trusting when you install it.** At run time:
nothing but Node's own built-in modules and the `git` already on your machine. The `dependencies`
field is empty and there's no build step, so nothing third-party executes when the router runs.

Two dev-only packages exist, and they're there for one job: the type check at the end of
`npm test`. Both are pinned to an exact version, never a range:

| package | version | what it is for |
|---|---|---|
| `typescript` | 6.0.3 | the compiler that checks the JSDoc against the code |
| `@types/node` | 22.20.2 | Node's own type declarations, so `fs` and `path` are known |

`package-lock.json` is committed, so those two and their one transitive package (`undici-types`)
are recorded with the exact tarball URL and integrity hash that were reviewed. `npm ci` installs
that file and nothing else, and fails outright if the manifest and the lockfile disagree.
`--ignore-scripts` means no package's install hooks run. Both flags are what CI uses, on every one
of the six matrix cells.

```
git clone https://github.com/hoplight-ai/pandoras-router
cd pandoras-router
npm ci --ignore-scripts
npm test
```

The install is the only step that touches the network. If you'd rather not run it, `node
test/run.mjs` runs the whole assertion suite on its own with nothing installed; only the type check
needs the compiler.

**Nothing is published to npm.** `npm install pandoras-router` fetches nothing today: no release has
been tagged and no package has been pushed to the registry, so the name in `package.json` is a
placeholder for a release that hasn't been cut. The repository above is the only place this installs
from.

So run it out of the clone. `node src/bin/router.mjs <subcommand>` works with nothing installed at
all, and is how every example in this README is run. The package does declare a `pandoras-router`
binary pointing at that file, so `npm link` inside the clone, or an install straight from the git
URL, puts that name on your path. Both take the code from this repository, not from the registry.
When a release is cut, this section will say so and name the version.

Every driver resolves the workspace root, the directory holding `_handoffs/` and your repos, from
`$PANDORAS_ROOT`, falling back to the current directory. The package's own install location is never
treated as the workspace root.

## Configuration

Four files under `_handoffs/_lanes/` at your workspace root, all of them tables read by code and
prose read by people. Copy them from `examples/` and edit:

| file | what it holds |
|---|---|
| `POLICY.md` | one row per repo: writer cap, deploy style, how a deploy is proved, the liveness URL, the build command when npm isn't the builder, exclusive paths, traps. Its `env` table names the `.env.local` keys a new worktree may receive; a repo with no row there receives none |
| `PREFIXES.md` | the filename vocabulary. An unrecognized lifecycle word routes nothing and is named on stdout, rather than defaulting to live |
| `CLAIMS.md` | the visible lock, one line per active lane. Ships empty |
| `LANES.md` | the append-only ledger of every lane opened, landed and closed. Ships empty |

A repo with no row in `POLICY.md` routes nothing, and the allocator says so by name. Guessing a
deploy style or a verification method is how a change ships that nobody proved, so it doesn't guess.

`examples/liveness.env.example` shows the three credential shapes the liveness probe understands and
where the values live. The probe only reads an environment variable whose name starts with
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

- **`open` copies a credential into a new worktree only when the policy names the keys, and copies
  nothing otherwise.** A repo with no row in the policy's `env` table gets no `.env.local` at all,
  and `open` says so in one line naming the row to add. With a row, exactly those keys are copied:
  comments and unlisted keys are dropped, and a listed key the file lacks is reported missing by
  name rather than written empty. The copy is created at mode 600, created private rather than made
  private a moment later, and an existing `.env.local` is never overwritten. Switching it on means
  the allowed slice of a credential file exists once per checkout, and removing a worktree by hand
  leaves that slice behind unless you delete it too. Leaving it off means a lane whose first job
  needs a credential fails until you add the row.
- **The state directory carries a lock file, `_handoffs/_lanes/.lock`.** Every write to `CLAIMS.md`
  and `LANES.md` happens while one process holds it, and `open` re-checks the board under it, so two
  dispatchers opening overlapping lanes at the same moment get one open and one refusal. The file
  holds the holder's pid, host, start time and script name. A caller waits up to 60 seconds for a
  live holder, then refuses and names it. A lock whose holder is dead on this host, or that's older
  than five minutes, is broken with one printed line saying whose it was, and a short-lived
  `.lock.break` file guards the break. It's a lock for one local filesystem, not a network share.
- **`close` runs the branch's own `npm run build` on the dispatcher's machine**, in the lane's
  checkout, with a 15-minute time limit (`PANDORAS_BUILD_TIMEOUT_MS` overrides it). No shell is involved
  on any OS: npm runs as `node <npm-cli.js> run build`, with npm-cli.js found from `npm_execpath`,
  then beside the running Node, then (macOS and Linux only) the plain `npm` on PATH. That's how
  Windows builds too, where `npm` is a batch file Node won't start without a shell. Past the limit
  the build is killed with everything it started and the gate records `no`: on macOS and Linux its
  process group gets SIGTERM then SIGKILL, on Windows `taskkill /pid <pid> /T /F` ends the process
  tree. Only the last 64 KB of output is kept, and the close prints that tail when the build fails.
  So a lane's `package.json` runs code where the close runs, with the close's permissions and no
  sandbox: don't close a branch you wouldn't build. A green build only counts on a fresh base: a
  branch missing commits that landed on main, other than its own landing merge, records `no` with
  those commits named and the build isn't run. A checkout with no `build` script records `n/a`; one
  with no `node_modules`, an npm that can't be found by those three routes (the skip names each path
  tried), or a close run with `--no-build`, records `skip`, which is not a pass.
- **A repo that npm can't build names its own build command in the policy's `build` column**, and
  the close runs that instead: `pnpm build`, `bun run build`, `cargo build --release`,
  `go build ./...`, `make build`. The value is an argument array, never a command line: the command
  and its arguments separated by spaces, handed to the operating system as a list. A value carrying
  `|`, `&`, `;`, `<`, `>`, `$`, a backtick or a newline is refused by name when the policy file
  loads, before any close starts anything; so is a first token that isn't a bare command name. The
  command is looked up on PATH and nowhere else, never inside the repository being built, so a
  repository can't ship the executable its own gate runs; one that isn't on PATH records `skip`
  naming it, and npm is never a fallback for it. Everything else matches the npm build: the same
  checkout, the same time limit and kill (both the dispatcher's, not settable from the policy file),
  the same 64 KB tail, the same verdicts. The gate's line names the command that ran. A repo whose
  column says `-`, or a policy file with no `build` column, is built with npm exactly as before.
- **The two command guards in `hooks/`, `guard-irreversible.mjs` and `guard-report-overwrite.mjs`,
  are Node pattern matchers.** They use Node built-ins only: no bash, no Python. The
  irreversible-action guard refuses what it can see on the command line or in the SQL string: every
  spelling of force-push, branch deletion, worktree removal and history rewrite, `git clean -f`,
  `rm` with a recursive and a force flag, schema and unbounded row changes, and a git alias defined
  on the same line. A command hidden in a script file, a `sh -c "$(cat x)"`, or SQL sent through a
  file or a stored procedure walks past it. Both guards fail closed on input they can't read as a
  JSON object.
- **The unlock phrase has no default.** It's a human-confirmation protocol, not a secret: the way a
  person, not an agent, says yes to one action no commit can undo. Set `PANDORAS_UNLOCK_PHRASE` to a
  phrase of your own; unset or blank, nothing unlocks the guard in that session and every gated
  command is refused with the reason named. The phrase counts only when a person types it in the
  session as a whole message or on a line by itself. An agent writing the words, a brief quoting the
  rule or a pasted log doesn't unlock anything. Once typed it holds for the rest of that session.
  Pick a phrase that isn't ordinary English.
- **The report-overwrite guard** refuses a whole-file `Write` onto an existing `.md` at the root of
  `_handoffs/`, except the bridge's own furniture: `README.md` and `_STANDING_ORDERS.md` by default,
  or the space-separated list in `PANDORAS_BRIDGE_FURNITURE`.
- **The wide-read guard, `guard-wide-read.mjs`,** refuses a whole-file `Read` of a text file over
  12,000 bytes, about 3,000 tokens, and tells the caller to name a range. It never truncates, and a
  read that names a range always passes. Unlike the other two it fails open on input it can't parse.
  `CLAUDE_WIDE_READ_BYTES` retunes the threshold and `0` turns it off.
  `hooks/measure-wide-read.mjs` reruns the measurement behind that number on your own transcripts
  and prints no transcript file name, project name or prompt text.
- All three guards append one line per refusal to `hooks/guard-log.jsonl` (gitignored) when the
  harness supplies a session id, and nothing on a pass.

### Switching the three guards on

Nothing in `hooks/` runs on its own. Each is a `PreToolUse` hook: the harness hands it one JSON
object on stdin describing the call it's about to make, and the hook answers allow or deny. Wire
them in your harness's settings file, `.claude/settings.json` inside a project or
`~/.claude/settings.json` for every project, replacing `<path-to-this-repo>` with wherever this
repository sits (inside a project that *is* this repository, `$CLAUDE_PROJECT_DIR` needs no
editing):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "node \"<path-to-this-repo>/hooks/guard-irreversible.mjs\"" }]
      },
      {
        "matcher": "Write",
        "hooks": [{ "type": "command", "command": "node \"<path-to-this-repo>/hooks/guard-report-overwrite.mjs\"" }]
      },
      {
        "matcher": "Read",
        "hooks": [{ "type": "command", "command": "node \"<path-to-this-repo>/hooks/guard-wide-read.mjs\"" }]
      }
    ]
  }
}
```

Three notes on the matchers, because each one is a choice rather than an obvious default:

- **The irreversible-action guard reads SQL as well as shell.** The `Bash` matcher above covers the
  command line. If your harness also reaches a database through a tool of its own, add a second
  entry whose matcher is that tool's name. The guard looks for `execute_sql` and `apply_migration`
  in the name it's given and reads the statement out of the call's `query` field. A database tool
  you don't list is a database tool this guard never sees.
- **`Write`, not `Write|Edit`, for the report guard.** It exists to stop a whole-file replace
  landing on top of an existing report; a targeted edit to your own report is the thing it tells you
  to do instead, so matching `Edit` would refuse the fix along with the mistake.
- **`Read` alone for the wide-read gate**, which refuses only a whole-file read of a large text file
  and always allows a read that names a range.

Then set `PANDORAS_UNLOCK_PHRASE` in your environment to a phrase of your own, or the
irreversible-action guard has no unlock at all and refuses every gated command. That's a safe state,
not a broken one, but it isn't the state most people want.

## Contributing, and reporting a security problem

[CONTRIBUTING.md](CONTRIBUTING.md) covers how to run the suite, what a pull request needs, and the
rule that every reported bug gets a failing test before it gets a fix.

Found a vulnerability? Please don't open an issue. [SECURITY.md](SECURITY.md) has the address, the
seven-day reply window, and which versions are covered.

## License

MIT. See [LICENSE](LICENSE).

Contributors are expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
