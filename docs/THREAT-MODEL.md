# Threat model

What this tool trusts, what it does not, which failures it is built to catch, and which it is not.
Short on purpose. Every claim below points at a file a reviewer can open.

## Trusted

| Party | Why it is trusted | Where that shows |
|---|---|---|
| The dispatcher's machine | Every check runs here: the git reads, the build, the HTTP probe, the ledger writes. A compromised machine defeats every gate at once, and nothing in this repository is designed to survive that. | `src/bin/close.mjs` runs `npm run build` in the lane's checkout; `src/lib/lanes.mjs` appends to a plain file |
| The operator | The unlock phrase is a person typing a phrase. The tool asks a human to confirm an irreversible action; it does not verify who the human is. | `hooks/guard-irreversible.mjs`, top comment |
| The policy files | `POLICY.md`, `PREFIXES.md`, `CLAIMS.md` and `LANES.md` are read as fact. A liveness row can name a URL and an environment variable, so the one defence against a hostile row is the rule that a probe only reads a variable whose name starts with `PANDORAS_`. | `src/lib/liveness.mjs`, section "Where a credential may go" |

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
  is no container, no separate user and no network cut.

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

1. **`open` copies the repo's `.env.local` into every worktree it creates**, mode 600, never
   overwriting one already there. A credential file then exists once per checkout, and removing a
   worktree by hand leaves its copy behind.
2. **`close` runs the branch's own build on the dispatcher's machine**, in the lane's checkout.
   That is what a build gate is, and it means a lane's `package.json` runs code where the close runs.

The README's section on what this touches describes the guards as they are now: Node only, failing
closed on input they cannot read, and an unlock phrase with no default.
