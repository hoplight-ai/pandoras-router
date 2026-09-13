# PREFIXES — the filename vocabulary, in one place, read by code

> Copy this file to `_handoffs/_lanes/PREFIXES.md` at your workspace root and edit it.
>
> Machine-read by `src/lib/prefixes.mjs`. Human-read by anyone naming a file in `_handoffs/`.
> Invent a name that is not in the table below and the router refuses to route the file, and says
> so by name. **That refusal is the point.**

## Why this file exists

The bridge encodes a brief's whole lifecycle in its filename, which means the vocabulary of
lifecycle words is load-bearing data. On any working bridge it outgrows whatever list was compiled
into the tool that reads it — and the words the tool does not know get read as **live**, so a
closed brief is handed to a dispatcher and executed a second time. That is the same class of
failure as a report overwrite: two agents doing one lane's work, because nothing on disk told the
second one it was second.

The rule that follows: **never default an unrecognized name to live.** A name the vocabulary does
not know routes nothing and is named on stdout.

## The vocabulary

`match` is `prefix` (the token starts the filename) or `token` (the token appears anywhere in the
filename, hyphen-delimited). `routes` says what the allocator may do with the file.

<!-- table: prefixes -->

| token | match | state | routes | meaning |
|---|---|---|---|---|
| `(none)` | prefix | live | yes | No lifecycle word. With a RUN THIS IN block it is a fireable brief; without one it is a document and routes nothing. |
| `partial-` | prefix | remainder | remainder | A lane's report whose scope did not all close. **Never execute its body.** The allocator surfaces its unfinished scope as fireable and leaves the file named as it is. |
| `done-` | prefix | closed | no | A lane's report. Its name is dead: new work on that slice needs a new brief. |
| `consumed-` | prefix | closed | no | The brief was executed. Same dead-name rule. |
| `blocked-` | prefix | closed | no | Carries `Reason:` and `Re-route:`. |
| `parked-` | prefix | closed | no | Deliberately not executed. |
| `superseded-` | prefix | closed | no | A newer brief replaced it. |
| `retired-` | prefix | closed | no | Withdrawn; the work is no longer wanted. |
| `resolved-` | prefix | closed | no | An incident or a question that now has an answer. |
| `proposed-` | prefix | proposal | no | A draft awaiting a decision. Not fireable until it is renamed with no prefix. |
| `REFERENCE-` | prefix | reference | no | Standing reference material, not work. |
| `INCIDENT-` | prefix | incident | no | A failure report. Read it; never execute it. |
| `SWEEP-` | prefix | sweep | no | A cross-repo hygiene pass's own record. |
| `SOURCE` | token | reference | no | Source material carried alongside a lane (`VOICE1-SOURCE-notes.md`). |
| `_` | prefix | furniture | no | Bridge furniture and templates: `_STANDING_ORDERS.md`, `_lanes/`. |

## Three detectors that catch an invented word

An unknown leading token is usually a repo or lane name (`web-v13-assets.md`) and is harmless. An
unknown leading token that is TRYING to be a lifecycle word is the dangerous one. Three rules, all
data, no fuzzy matching:

1. **Denied list.** A word that means something already in the vocabulary is refused by name, and
   the refusal says which word to use instead.

<!-- table: denied -->

| token | why it is refused |
|---|---|
| `finished-` | means `done-` |
| `closed-` | means `done-` |
| `merged-` | means `done-`; also invites reading git ancestry as proof |
| `shipped-` | means `done-` |
| `complete-` | means `done-` |
| `completed-` | means `done-` |
| `archived-` | means `retired-`; archiving is a move into `archive/`, not a rename |
| `abandoned-` | means `retired-` |
| `cancelled-` | means `retired-` |
| `canceled-` | means `retired-` |
| `deferred-` | means `parked-` |
| `pending-` | says nothing about whether it is fireable |
| `wip-` | says nothing about whether it is fireable |
| `draft-` | means `proposed-` |
| `todo-` | means no prefix |
| `old-` | means `superseded-` |
| `final-` | means nothing |

2. **Past-tense rule.** Any leading lowercase token ending in `ed` that is not in the vocabulary is
   refused. Every lifecycle word anyone reaches for is a past participle, so this catches the ones
   nobody thought to list.

3. **Near-miss rule.** Any leading lowercase token within one character edit of a vocabulary word is
   refused (`comsumed-`, `dones-`, `blocke-`). A typo in a lifecycle word silently resurrects a
   closed brief, which is the exact failure this file exists to stop.

A refused name **routes nothing** and is printed with the reason and the word it should have been.
