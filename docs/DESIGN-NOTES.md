# Design notes

Three decisions a reviewer asks about first. Each entry says what was decided, what else was
considered, why this won, and what it costs. The cost lines are the useful part.

## a. Markdown tables as state, not SQLite

**Decision.** The four state files (`POLICY.md`, `PREFIXES.md`, `CLAIMS.md`, `LANES.md`) are
Markdown tables and pipe-delimited lines, parsed by `src/lib/md-table.mjs` and the per-file
readers in `src/lib/`. `LANES.md` is append-only: a record is one line added at the end, and a
reader folds OPEN, CLOSE, LAND, NOTE and KIND records into a lane's current state
(`parseLanes` in `src/lib/lanes.mjs`).

**Alternatives.** SQLite, which gives real transactions and a query language. A JSON file per lane,
which is easy to parse and hard to read side by side. Recomputing state from pull-request and CI
facts every time, which is what Agent Orchestrator does and which never goes stale.

**Why this.** Every dispatcher and every reviewer can open the files and read them, with no client
and no schema. A change to them is a diff a person can review. The package has zero dependencies,
and a state store that needs a native module would end that. The append-only rule gives crash
safety without a transaction: a session that dies mid-write loses at most the line it was writing,
and nothing already written is touched.

**Cost.** Parsing is custom, and every column added later sits at the end of the line so older
lines still parse, which is why the CLOSE record's documentation comment and the field order have
to be maintained by hand (`docs/gates.json` records where they currently disagree). Plain files
have no transactions, so every write to `CLAIMS.md` and `LANES.md` goes through one exclusive lock
(`src/lib/lock.mjs`): an atomic create holding the holder's pid, host and time, broken with one
printed line when the holder is dead or the lock is older than five minutes, and a temp-file-then-rename
for the write itself. Opening a lane re-reads claims and re-checks scope inside that lock, so two
dispatchers racing to open overlapping lanes produce one open and one refusal by name;
`test/concurrency-test.mjs` races real processes to prove it. The lock is correct for processes
sharing one local filesystem. It is not a coordinator for several machines or a network filesystem,
which the threat model lists as a non-goal.

## b. Declared paths, not a dependency graph

**Decision.** A lane declares the files it will touch. The allocator lets two lanes share a
repository only when their declared scopes have no path in common after normalisation
(`scopesIntersect` in `src/lib/scope.mjs`); the close then measures whether the lane stayed inside
its declaration (`scopeCompliance` in `src/lib/close.mjs`). Nothing infers a scope from the
brief's wording, and nothing builds a graph of what depends on what.

**Alternatives.** Inferring the scope from the task text, which Bernstein does when none is
declared. Building an import graph and treating any file reachable from the declared set as also
held. Isolation alone, one worktree per agent, and sorting out collisions at merge.

**Why this.** A declared, exactly compared path is a claim the close can check byte for byte. An
inferred scope is a guess about intent, and a graph is a guess about reach; both can be wrong in
the direction that loses work. So the rule is: exclusive paths before dispatch, measurement of the
same paths at close, and every ambiguity widened. A path the parser cannot read becomes the whole
repository. A mid-path glob becomes its parent directory. A path that climbs out of the repository
becomes the whole repository. Widening costs a wait; narrowing costs somebody's work, and it is
never done.

**What disjoint proves, and what it does not.** Disjoint scopes prove that no two lanes running
together will write the same file. That is the whole claim. They do not prove that two lanes cannot
break one another through something a file boundary does not carry: an API shape, a database
schema, a generated file, a shared constant. The reviewers' own example is the right one. Lane A
changes a field name on a server response and declares only the server file. Lane B changes the
client that reads that field and declares only the client file. Both scopes are disjoint, both
lanes close `in-scope=yes`, both builds go green alone, and the combination is broken.

The router's answer is exclusive paths plus close-time measurement, not a graph, and it is honest
to say how far each part reaches on that example. The policy's `exclusive` table lets an operator
name the paths that are global machinery (a migrations directory, a shared types file,
`package.json`) so that any lane touching one holds it alone (`applyExclusive` in
`src/lib/scope.mjs`); if the field's definition lives in a file on that list, the two lanes
serialize. The `merged` gate classifies a path the branch touched that main also changed after the
branch started as `MAIN-MOVED`, grades the lane `no`, and names that path (`classifyPath` and
`gradeMerge` in `src/lib/close.mjs`); that catches two lanes in one file, and it does not fire on
the example, because the two lanes touched different files. The `green` gate builds the lane's own
checkout, not main with both lanes merged. The fresh-base rule (`freshBaseVerdict`) is the
library's mechanism for demanding a build on top of current main, and the shipped close driver does
not call it. So on the example as stated, with no exclusive row, nothing in the shipped driver
stops the pair. The router does not claim it can.

**Cost.** Two lanes that share an interface and no file are not stopped. The operator carries the
knowledge of which paths are global machinery, and an `exclusive` table that is too short lets a
pair run that should have serialized. Widening on doubt means some lanes wait that could have run.

## c. An undeclared scope serializes the whole repository

**Decision.** A brief with no scope line, a `Touches:` line with nothing readable after it, or a
claim with no OPEN record to look up, all read as the whole repository (`WHOLE_REPO` in
`src/lib/scope.mjs`, the `Touches:` reader in `src/lib/briefs.mjs`, `allocate` in
`src/lib/alloc.mjs`). The whole repository intersects everything, so that lane waits for every
other lane in the repo and every other lane waits for it. Only an explicit `Touches: none` means
"writes nothing", and the reader keeps that apart from an empty line on purpose: the two look alike
downstream and mean opposite things.

**Alternatives.** Inferring a scope from the brief's wording or its title. Treating a missing or
empty declaration as "touches nothing" and letting the lane run beside anything. Asking the
dispatcher to fill one in at fire time.

**Why this.** Inference produces a scope nobody wrote and nobody checked, and the close would then
measure the lane against a guess. A missing declaration read as "nothing" is the failure mode the
README calls out in Bernstein: the guard switches itself off exactly when the author forgot it.
Serializing is the answer that cannot lose work. It is also the honest one: the lane's cost is a
wait, printed on its card with the blocking lane named, and a dispatcher who wants parallelism
declares a scope and gets it. The close records `in-scope=n/a` for such a lane, having paid for it
by holding the repository alone.

**Cost.** Throughput. One undeclared lane in a busy repository turns a writer cap of three into a
queue of one until it closes. The allocator prints the reason on the card so the fix is visible:
add a `Touches:` line.
