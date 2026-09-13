# CEILING1 — raise the per-provider cap so one slow provider stops throttling the rest

Drop a file like this into `_handoffs/` at your workspace root and it becomes a fireable lane.
Everything the router needs is in the routing block below; everything else on the page is for the
human or agent who executes it. (The marker the parser looks for appears exactly ONCE in a brief —
mentioning it in prose earlier would move the block, so this sentence does not spell it out.)

The filename matters. The router derives the lane id, the branch, the worktree, the session id and
the report filename from it, which is what makes two sessions of one brief produce two DIFFERENT
report names instead of one overwriting the other:

| derived | value |
|---|---|
| lane | `ceiling1` |
| branch | `ceiling1-raise-the-per` |
| worktree | `web-ceiling1` |
| report | `done-<date>-web-ceiling1-raise-the-per.md` |

## RUN THIS IN

- **Folder:** `web`
- **Touches:** `src/providers/pool.ts`, `src/providers/limits.ts`, `test/pool-test.mjs`
- **Model:** medium 5
- **Priority:** 2
- **Filed:** 2026-09-12
- **Runs beside:** `api` (no shared files)

Every field is `**Label:** value`. The colon is required and so is the space after it, because
without them any English sentence starting with the word "touches" is read as a declaration — and
a brief saying "Touches nothing in `web`" would be carded with `web` as its scope, which is the
opposite of what the sentence means.

`Touches:` is the whole safety argument for running this lane beside another one in the same repo.
The allocator compares it against every other open lane's declared scope, by exact path and by
directory containment, and only cards this lane if they are disjoint. The close then checks every
file the branch actually touched against the same declaration, so the promise has teeth at both
ends.

Declaring nothing is allowed and is not free: an undeclared lane holds the WHOLE repo and
serializes against everyone. Declaring `Touches: none` is different again — it means this lane
writes no repo file at all, and the close fails it by name if it writes one.

## The problem

One slow provider currently drains the shared concurrency pool, so every other provider queues
behind it even when it has capacity to spare. The cap is global where it should be per-provider.

## What to do

1. Move the semaphore from the pool to the provider record.
2. Read the per-provider ceiling from config, defaulting to the current global value so nothing
   changes for anyone who has not set one.
3. Write the failing test FIRST: two providers, one of them artificially slow, and assert the fast
   one still completes while the slow one is in flight. Observe it fail before the fix.

## What DONE means here

* the failing test above, observed red, then green
* `npm run build` exits 0
* the deployed surface serves this build (the close probes it — see the `liveness` table in
  POLICY.md)
* every file this branch touched is inside the `Touches:` list above

## The report

Write it to the derived report filename before you close. A close reads the report: a `STATUS:
DONE` with no `Evidence:` line is refused, and so is a `STATUS: DONE` whose own body admits a
skipped step.

Any problem you find along the way that you are not fixing here goes on one line, in this shape,
or the close refuses it:

```
FINDING: <what> | fix: <the fix> | size: small|medium|large | owner: <seat or owner>
```

A finding with no fix beside it is a problem handed to somebody else. A `small` finding owned by
the owner is refused outright: do it in the lane, or name the seat that owns it.
