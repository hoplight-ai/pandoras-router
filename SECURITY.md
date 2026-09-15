# Security policy

## Reporting a vulnerability

Email **whit@hoplight.ai** with `pandoras-router` in the subject line. Please do not open a public
issue for a vulnerability; an issue is visible to everyone the moment it is filed, including to
anyone who would rather use the finding than read about it.

**You will get a reply within seven days** — an acknowledgement and a first read, not necessarily a
fix. If seven days pass with no answer, assume the mail went astray and send it again rather than
assuming it was ignored. If a report turns out to be a bug rather than a vulnerability, it is
moved to a public issue and you are told that it has been.

Useful in a report, in rough order of how much it saves: the version or commit you were on, the
command or configuration that reaches it, what an attacker gets out of it, and anything that
reproduces it. A rough report of a real problem is worth much more than a polished report of a
theoretical one, so send the rough one.

Nothing here is a bug bounty. There is no payment, and there is no legal threat either: work on
your own machine or one you are allowed to test, do not pull other people's data into it, and this
project will not come after you for looking.

## What is covered

| version | covered |
|---|---|
| `main` | yes |
| anything else | no |

There are no tagged releases and no published npm package yet, so there is exactly one supported
version: the current default branch. A fix ships as a commit on `main`, and the report is answered
with the commit that closes it. When releases start being cut, this table gains rows and says how
far back support reaches.

## What counts, and what is already written down

The threat model in [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) is the honest version of what
this tool does and does not defend against, and it is the first thing to read before deciding
whether something is a finding. Three limits are named there deliberately and are not
vulnerabilities on their own:

- **The command guards are pattern matchers.** A command hidden inside a script file, or SQL sent
  through a file or a stored procedure, walks past them. That ceiling is stated in
  `hooks/guard-irreversible.mjs` and in the README. A concrete input that a guard *claims* to catch
  and does not, on the other hand, is a finding and is worth reporting.
- **`close` runs a branch's own `npm run build` on the machine that runs the close.** That is what
  a build gate is. The run is bounded — no shell, an argument array, a time limit, a capped output
  buffer — but it is not a sandbox, and the README says so under "What this touches on your
  machine". Closing a branch you would not build is the operator's decision, not a defect.
- **The unlock phrase is a human-confirmation protocol, not a secret.** It has no default on
  purpose. Its only job is to make a person, rather than an agent, say yes to something no commit
  can undo.

Findings that are very much wanted: anything that lets one lane read or write another lane's files
or credentials; a policy file that can make the liveness probe send a credential somewhere the
`PANDORAS_` prefix rule was supposed to stop; a way to make a gate report a pass it did not
measure; and anything in the install or build chain that would execute code nobody reviewed.

## Supply chain

The package has zero runtime dependencies. The two dev dependencies, the TypeScript compiler and
Node's type declarations, are pinned to exact versions and recorded with their integrity hashes in
the committed `package-lock.json`; CI installs them with `npm ci --ignore-scripts`. CI's own
actions are pinned to commit SHAs rather than moving tags. If you find a path by which a build or
a test run fetches something none of that covers, that is a finding.
