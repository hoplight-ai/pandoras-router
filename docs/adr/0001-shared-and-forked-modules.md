# 0001. Which modules track the private sibling, and which are forked on purpose

Status: accepted, 2026-09-15.

## Context

This package was extracted from a working dispatch toolchain that still runs, privately, in the
workspace it was written for. Two trees now hold the same ideas, and until this record nothing said
which files are supposed to track each other and which are supposed to differ.

That silence costs both ways. A fix landed on one side and not the other is a bug fixed once and
left standing in the other copy: measured 2026-09-15, two such fixes had been sitting on the private
side unported, and both are the reason this record exists. In the other direction, a file copied
across because it looked like a leaf module carries the private tree's machine layout into a public
repository, which is a disclosure, not a merge.

## Decision

Every module in `src/lib/` belongs to exactly one of four groups. The group decides what happens
when one side changes. All twenty-three are listed; a module missing from this record is a defect in
the record.

### 1. Shared logic — the same statements on both sides, and a difference is drift

`atomic.mjs`, `prefixes.mjs`, `verdict.mjs`, `side-files-gate.mjs`.

Leaf modules with no knowledge of any particular workspace in them. A change to one of these is
expected to land on both sides, and a difference is drift to be explained or repaired.
`npm run shared:check` compares exactly these four and names any that differ.

**It compares statements, not prose.** The public copies are deliberately reworded — private product
names, incident narratives and one machine's layout are stripped, and a `// @ts-check` line is added
because this package type-checks and the private tree does not. The comments will therefore never
match, a byte comparison would report all four as differing forever, and a check that always fires
gets silenced within a week. The mechanism and its limits are in `test/shared-modules-test.mjs`.

### 2. Near-shareable — the same idea today, each carrying a little local knowledge

`naming.mjs`, `finding-lines.mjs`, `scope.mjs`, `gitread.mjs`, `md-table.mjs`, `alloc.mjs`,
`briefs.mjs`, `claims.mjs`, `findings.mjs`, `land.mjs`.

A change here is reviewed on the other side rather than copied into it. The behaviour is meant to
match; the text is not, and each file has a reason of its own:

| module | what makes it local |
|---|---|
| `naming.mjs` | the private copy carries that tree's own report-filename history |
| `finding-lines.mjs` | the owner token and the product alias map are injected here, compiled in there |
| `scope.mjs` | the public copy carries property-tested path handling the private copy has not taken |
| `gitread.mjs` | the public copy imports `root.mjs`, which exists only here |
| `md-table.mjs` | the public copy carries a type cast this package's type-check needs |
| `alloc.mjs`, `briefs.mjs`, `claims.mjs`, `findings.mjs`, `land.mjs` | each reads a state file whose columns are the other tree's, and each names that tree's own paths |

The two fixes upstreamed on 2026-09-15 — a leading date is never a lane name, and only an upper-case
`FINDING:` marker is a finding — were both ported behaviour-first from the private commit into files
that had drifted elsewhere. That is what this group means in practice: read the other side's fix,
understand it, write it here.

### 3. Forked by design — a sync between them would be a bug

`close.mjs`, `lanes.mjs`, `open.mjs`, `policy.mjs`, `root.mjs`.

These carry the shape of one specific workspace: which gates it runs and in what order, what a lane
record means there, what its policy table's columns are, where its root is. The public copies answer
the same questions for somebody else's repositories and answer them differently. A change on one
side is evidence about the other, never a patch for it.

`root.mjs` is the clearest case and has no counterpart file at all: privately the same fact is a
hard-coded label naming one machine's root directory, sitting inside `briefs.mjs`. Extracting it
into a module whose value is the word `root` **is** the fork, and copying either version onto the
other would undo the extraction or publish the path.

### 4. Public only — nothing on the other side to compare

`build.mjs`, `liveness.mjs`, `lock.mjs`, `report-check.mjs`.

No counterpart file exists in the private tree, so there is nothing for a drift check to read.
`lock.mjs` is worth naming: it reads like a leaf module and belongs in group 1 by shape, but the
private tree has no lock of its own, so comparing it is not possible today rather than merely
unnecessary.

## Why the public tree carries none of the private one's specifics

Three things are stripped on the way out, every time, and they are the same three each time.

**The machine layout.** Absolute paths, the names of the folders one operator's repositories sit in,
which project is on which host. This tool has to run against somebody else's checkouts, so a path
that is only true on one machine is not a detail here — it is a bug that reads as a feature.

**The incident narratives.** The private comments name dates, lanes and the exact run that broke.
That history is why a rule exists and it is genuinely useful, but it is a record of one team's week.
What survives the trip is the rule and the measurement behind it, stated so a stranger can check it:
"a board run killed mid-status left an orphaned index lock" rather than the date and the count of
repositories it jammed.

**The product names.** Every fixture, example and error message here uses `web`, `api`, `repo-a`.
Real product names would tell a reader what is being built, by whom and in what order, and none of
that is any part of what this tool does.

## This is a report, never a sync

**No script copies files between the two trees, and none may be written.** Five of these modules are
supposed to differ and four have nothing to differ from. A sync would quietly undo a deliberate fork
and carry private material into a public repository in the same pass. `npm run shared:check` reports
a difference and stops there. A person decides what it means.

## Consequences

Drift is now visible instead of assumed, and only for the four modules where drift is actually
wrong. The cost is that group 1 is small: everything carrying any local knowledge sits in group 2,
where the check cannot help and a human has to read both sides. That is the honest boundary, and a
wider one would be a check that lies.

The brief that commissioned this record listed seven modules in group 1, including `gitread.mjs`,
`md-table.mjs`, `lock.mjs` and `root.mjs`. Measured on 2026-09-15 against both trees: `gitread.mjs`
and `md-table.mjs` each carry one public-only line and belong in group 2; `lock.mjs` has no private
counterpart and `root.mjs`'s counterpart is a constant inside another file. The four that remain are
the four the check can actually hold to.
