# Threat model

What this tool trusts, what it does not, which failures it is built to catch, and which it is not.
Short on purpose. Every claim below points at a file a reviewer can open.

## Trusted

| Party | Why it is trusted | Where that shows |
|---|---|---|
| The dispatcher's machine | Every check runs here: the git reads, the build, the HTTP probe, the ledger writes. A compromised machine defeats every gate at once, and nothing in this repository is designed to survive that. | `src/bin/close.mjs` runs `npm run build` in the lane's checkout; `src/lib/lanes.mjs` appends to a plain file |
| The operator | The unlock phrase is a person typing a phrase. The tool asks a human to confirm an irreversible action; it does not verify who the human is. | `hooks/guard-irreversible.mjs`, top comment |
| The policy files | `POLICY.md`, `PREFIXES.md`, `CLAIMS.md` and `LANES.md` are read as fact. A liveness row can name a URL and an environment variable, and a repos row can name a build command the close will run, so two rules stand in for trust: a probe only reads a variable whose name starts with `PANDORAS_`, and a build value is an argument array resolved on PATH (see "The build column" below). | `src/lib/liveness.mjs`, section "Where a credential may go"; `parseBuild` in `src/lib/policy.mjs` |

## Untrusted

| Input | How it is treated |
|---|---|
| An agent's output (its branch) | Measured, never believed. `merged` compares bytes on main; `in-scope` compares touched paths to the declaration; `green` builds it. |
| A brief | A parsed document. An unreadable scope line widens to the whole repository and serializes the lane (`src/lib/briefs.mjs`, `src/lib/scope.mjs`); a lane id must match the filename as a whole token (`briefMatchesLaneOrKey` in `src/lib/close.mjs`). |
| An agent's own report | The least reliable signal in the system. Its STATUS word can lower a grade and never raise one (`gradeGates` in `src/lib/close.mjs`). Three refusals stop a close outright, writing nothing, when the report on the bridge carries no STATUS word, says DONE with no `Evidence:` line, or says DONE beside a skipped or deferred step that no `overruled:` line answers (`closeReportRefusal`, which reads the report through `src/lib/report-check.mjs` and hands the answers to `doneReportRefusal`). A close that runs before the report is written is not refused. `docs/gates.json` records this under `close_refusals`. |
| A deployed response | Read to 1 MB and no further, never followed through a redirect while a credential is attached, and graded as `skip` when nothing answered. A string match is labelled best-effort evidence in its own verdict. See `docs/LIVENESS.md`. |

## In scope

Three failures this tool exists to catch.

1. **An honest mistake by an agent.** It edits a file it did not declare, builds something that
   does not compile, or merges half of what it wrote. `in-scope`, `green` and `merged` each name
   the file or the reason.
2. **Two agents colliding.** Two lanes declare overlapping paths, or one writes where the other's
   report goes. The allocator refuses the overlap before either opens (`src/lib/alloc.mjs`), the
   derived report name carries the lane id (`src/lib/naming.mjs`), and the report-overwrite hook
   refuses a whole-file write onto an existing bridge report (`hooks/guard-report-overwrite.mjs`).
3. **An agent claiming done.** The close measures seven gates, a skip is never a pass, and DONE
   requires every one of them. The report's own words can only lower the result.

## Out of scope

Stated as non-goals, each with the one line of reasoning behind it.

- **A determined adversarial agent.** The shell guards are pattern matchers. They refuse what they
  can see on the command line or in the SQL string, and a command hidden in a script file, a
  `sh -c "$(cat x)"`, or SQL sent through a file or a stored procedure walks past them. They stop a
  slip, not a plan. The guard says so in its own header (`hooks/guard-irreversible.mjs`, "The
  ceiling of a pattern guard"). Both guards fail closed on input they cannot parse.
- **A malicious `package.json` at close.** The build gate runs the branch's own `npm run build` on
  the dispatcher's machine. A branch can put anything in that script. The README discloses this and
  gives the rule: do not close a branch you would not build.
- **Multi-machine dispatch.** The ledger, the claims file and the worktrees are local files. Two
  dispatchers on two machines share none of them, so nothing here proves anything across machines.
- **Secret brokering.** A credential is named in policy and read from the environment at probe
  time. The tool never stores, mints, rotates or distributes one; it only refuses to send a variable
  whose name lacks the `PANDORAS_` prefix.
- **Sandboxed builds.** The build runs where the close runs, with the close's own permissions. There
  is no container, no separate user and no network cut. The time limit and the output cap bound how
  long it runs and how much of its output the close holds; they do not bound what it does.

## The unlock phrase is a protocol, not a secret

There is no default phrase. The operator sets `PANDORAS_UNLOCK_PHRASE`; with it unset or blank,
nothing unlocks the irreversible-action guard in that session and every gated command is refused
with the reason named (`hooks/guard-irreversible.mjs`, top comment). A published default would let
any adopter's agent read the word off the internet, which is why none ships.

The phrase works because a person must type it, as a whole message or on a line by itself, in this
session's own transcript. An agent that writes the words does not unlock anything, a brief that
quotes the rule does not, and a pasted log that happens to contain it does not. Once typed, it holds
for the rest of that session. Knowing the phrase buys nothing; a human choosing to type it is the
whole mechanism. Pick one that is not ordinary English so it cannot appear by accident.

## Two operational risks the README already discloses

Both are under "What this touches on your machine" in the README, and both are deliberate.

1. **`open` copies a credential into a new worktree only when the policy's `env` table names the
   keys**, and copies nothing for a repo with no row there. The copy holds exactly those keys, is
   created at mode 600 rather than created and then made private, and never overwrites an
   `.env.local` already in the worktree. Where a row exists, that slice of a credential file then
   exists once per checkout, and removing a worktree by hand leaves the slice behind.
2. **`close` runs the branch's own build on the dispatcher's machine**, in the lane's checkout.
   That is what a build gate is, and it means a lane's `package.json` runs code where the close runs.
   The run is bounded, not contained (`src/lib/build.mjs`): no shell on any OS. npm is resolved to
   its JavaScript entry point and run by the close's own Node as an argument array,
   `node <npm-cli.js> run build`, with npm-cli.js taken from `npm_execpath` when that names an
   existing `.js` or `.cjs` file, else from beside the running Node; only on macOS and Linux does it
   fall back to the plain `npm` executable on PATH. On Windows `npm` is `npm.cmd`, which Node will
   not start without a shell, and a shell would reintroduce the argument re-parsing this design
   removes, so Windows has no bare fallback. After 15 minutes by default, or
   `PANDORAS_BUILD_TIMEOUT_MS` when set, the build is killed with what it started and the gate
   records `no`: on macOS and Linux the build leads its own process group, which gets SIGTERM and
   then SIGKILL 2 seconds later; on Windows, which has no process groups, `taskkill /pid <pid> /T /F`
   runs (by full path under SystemRoot, argument array, no shell) and ends the process tree. Only
   the last 64 KB of combined output is kept, so a build that prints without end cannot exhaust the
   close's memory. A build that exits 0 inside the limit is the only `yes`. npm that resolves to
   nothing is `skip`, naming every path tried. Before any of that, a branch that lacks commits on
   main other than its own landing merge grades `no` and the build is not started. None of these
   limits stops what the script does while it runs: it can still read files, open the network or
   spawn a process that leaves the group (or, on Windows, detaches from the tree).

The README's section on what this touches describes the guards as they are now: Node only, failing
closed on input they cannot read, and an unlock phrase with no default.

## The build column: the close runs a command a policy row names

Since 2026-09-15 the policy's repos table has a `build` column, so a repository npm cannot build
gets a real build gate instead of a skip. Say the consequence plainly: **the close now runs a command
that comes from a configuration file rather than from a constant in the code.** Three rules are the
whole distance between that file and arbitrary execution on the dispatcher's machine, and all three
are in `parseBuild` (`src/lib/policy.mjs`) and `resolveOnPath` (`src/lib/build.mjs`):

1. **The value is an argument array, never a command line.** The command and its arguments,
   separated by spaces, spawned with `shell: false`. Nothing re-parses it, so quoting, globbing and
   substitution never happen.
2. **Shell metacharacters are refused when the policy file loads.** `|`, `&`, `;`, `<`, `>`, `$`, a
   backtick and a newline each refuse by name, before the close starts anything. A value containing
   one was written by somebody expecting a shell, and the honest answer to that expectation is a
   refusal that says so rather than a literal argument that silently does nothing.
3. **The command is resolved on PATH and nowhere else.** The first token must be a bare command name
   (no path separator, no `~`), and only absolute PATH entries are searched, because a relative one
   resolves against the build's working directory, which is the repository being built. Nothing
   inside the checkout is ever consulted, and the spawn is handed the absolute path the lookup
   returned, which also closes the Windows search order where a bare name finds the current directory
   before PATH. On Windows only `.exe` and `.com` are run; a command that exists only as `.cmd`,
   `.bat` or `.ps1` is a `skip` naming the file, because starting it would need a shell.

What this does NOT defend against is the same thing the npm build never defended against: the
declared command can do anything the dispatcher can do while it runs. There is no container, no
separate user and no network cut. The limits are the same ones the npm path has: a 15-minute
default overridable only by `PANDORAS_BUILD_TIMEOUT_MS` in the dispatcher's own environment, the
process-group kill on macOS and Linux and the `taskkill /T /F` tree kill on Windows, and the last
64 KB of output. **None of those may be set from the policy file**; a per-repository time limit was
deliberately left out, because a repository that can lengthen its own limit has reopened the hole.
The rule the README gives still governs: do not close a branch you would not build.
