# Prior art

The README's comparison (its section "Prior art, and how this differs", written there as prose),
kept here as a table so it can be extended one row at a time. The honest version is more useful than a claim of novelty: most of the field solves parallel agents
with isolation alone, one worktree or container per agent, and this project does not improve on
that. It addresses the case isolation leaves open, two agents rewriting the same file in separate
copies where the collision surfaces at merge.

| tool | scope before dispatch | verify after | checks the change is live at a URL | how it differs from this project |
|---|---|---|---|---|
| [Bernstein](https://github.com/sipyourdrink-ltd/bernstein) | yes, declared owned files, overlapping jobs refused | yes, completions verified | no | The closest thing to this that exists, and it got there first. Bernstein is demoting file-overlap checking to a legacy fallback in favour of an author-declared `parallel_safe` flag; it infers a job's file scope from the task's wording when none is declared; an empty declaration silently disables its guard; and a scope violation raises a question rather than refusing. Here an undeclared scope is the whole repository and serializes, an unparseable scope widens rather than narrows, and a violation is a refusal with the overlapping paths named. Those are judgment calls about false positives against lost work, not a claim that one design is correct. |
| [Agent Orchestrator](https://github.com/Untrivial-ai/agent-orchestrator) | no | recomputed from pull-request and CI facts on every ask | no | Never stores a status at all, so a stored status can never go stale against reality. A cleaner idea than a ledger, worth reading for its own sake. This project keeps an append-only ledger because it needs a lane's declared scope and its open timestamp recorded at the moment of dispatch, which no PR or CI fact carries. |
| isolation-only tools (a worktree or container per agent) | no | no | no | A real fix for a real problem. They do not address two agents editing one file in two copies. |

Of the three entries above, none did both scope-before-dispatch and verify-after, and none checked
that a merged change is actually live at a URL. That gap, rather than either half on its own, is
what this project fills.

**Three is what this table shows, and the number was corrected down to it on 2026-09-15.** The
README and this note both used to say that fourteen tools had been compared before publishing.
Nothing recording those fourteen could be found: the research store that files this kind of
comparison run holds 777 rows and none of them is that comparison. A claim about a survey nobody
can produce is worth less than a short table somebody can check, so the count now matches the rows.
If the record of the wider comparison turns up, the rows belong here rather than the number
belonging back in the sentence.

## A row not added: Clash

The brief for this document asked for one row on Clash, described as conflict prediction between
git worktrees, at `mvanhorn/clash`, on the condition that its README could be read and the
description verified. On 2026-09-14 `https://github.com/mvanhorn/clash` answered 404 to a plain
fetch, and the GitHub API returned Not Found for `repos/mvanhorn/clash`. Nothing could be verified, so the row is left out rather than written from
a description. If the repository exists under another name or owner, add the row with the README
as its source.
