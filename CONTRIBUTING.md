# Contributing

Thanks for looking. This is a small tool with a very opinionated test suite, and almost everything
below exists to keep that suite worth trusting.

## Running the suite

Node 22 or newer. From the repo root:

```
npm ci --ignore-scripts
npm test
```

`npm test` runs two things: every `test/*-test.mjs` file, and then the type check. The install is
only needed by the type check; `node test/run.mjs` runs the whole assertion suite on its own with
nothing installed at all.

The runner discovers its suites, so a new `test/whatever-test.mjs` file runs with no list to edit
anywhere. Each suite prints its own count and throws rather than calling `process.exit`, so one
suite's red can never mask another's. The last line of the run is the one to read.

To run one suite while you work on it:

```
node test/env-copy-test.mjs
```

The property suite prints its seed and how to replay it (`PROP_SEED=... npm test`). Quote that
seed if you are reporting a property failure, because without it nobody can reproduce your run.

CI runs the same two commands on Node 22 and 24, on Ubuntu, macOS and Windows — six cells. They
are all required on `main`, so a change lands by opening a pull request and getting it green; a
red cell on one operating system is a real result and not something to re-run until it passes.

## Every reported bug gets a failing test first

**Write the test that reproduces the bug, run it, watch it go red, and only then write the fix.**
Put the observed failure in the pull request.

This is not a formality. A test written after the fix proves only that the code you just wrote
does what you just wrote; it has never seen the defect, so it cannot tell anyone when the defect
comes back. Writing it first is also the cheapest way to find out you were about to fix the wrong
thing.

The one exception is a bug whose reproduction genuinely needs data nobody else has. Then the pull
request carries a written reproduction recipe instead, plus one line saying why a test was not
possible.

A related rule, learned the hard way: **never write an assertion that pins a workaround in place.**
A suite that asserts "this value is still dropped" passes forever and reads from the outside
exactly like coverage. If you find yourself asserting that a known compromise is still there,
that is the signal to fix the compromise.

## What a pull request needs

- **One change per pull request.** A refactor riding along with a fix makes both harder to review
  and impossible to revert separately.
- **A failing test, observed failing, for anything that is a defect** — with the red line quoted.
  A new capability gets assertions too, including at least one that asserts a refusal where the
  capability is allowed to say no.
- **A green run of all six CI cells.** Not five.
- **A description that says what was true before and what is true now.** If the change reverses a
  decision, say which one and why; the comments in this codebase carry their reasons on purpose,
  and a change that removes a reason without giving one is the thing hardest to review later.
- **The comments updated with the code.** Long explanatory comments are the house style here,
  which means a stale one is a lie rather than a nit. The same goes for the README and
  `docs/`: a document this repository ships that describes behaviour the code no longer has is a
  defect in the same pull request, not a follow-up.
- **Commit subjects in the shape `pandoras-router: <plain sentence> [<class>]`**, where the class
  is one of `feature`, `fix`, `proof`, `content`, `infra` or `chore`.

## Reviews and objections

When a reviewer, a linter or another contributor objects to a change, there are exactly two
answers: fix the thing, or write one line saying you overruled the objection and why — naming the
objection, the file and the reason. Silence is not a third option; an objection dropped without a
word looks in the history exactly like one nobody ever read.

## Dependencies

The runtime dependency count is zero and the intention is to keep it there. The two dev
dependencies exist for the type check, are pinned to exact versions, and are recorded in the
committed `package-lock.json`. A pull request that adds a dependency needs to say what it does
that Node's built-ins cannot, and expect that question to be asked seriously.

## Security

Do not open an issue or a pull request for a vulnerability. [`SECURITY.md`](SECURITY.md) says
where to send it and what happens next.

## Conduct

Everyone here follows the [Code of Conduct](CODE_OF_CONDUCT.md).
