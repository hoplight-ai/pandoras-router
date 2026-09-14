# LANES — the append-only ledger of every lane this router opened and closed.
#
# Copy this file to `_handoffs/_lanes/LANES.md` at your workspace root. It ships EMPTY.
#
# Written by `pandoras-router open`, `land` and `close`. NEVER edit a line that is already here:
# this folder is usually not under version control, so a rewrite is unrecoverable. Corrections are
# APPENDED as a new record, never made in place.
#
# THE RECORD TYPES
#
#   OPEN  | lane | repo | branch | worktree | port | report | scope | session | ISO | base
#   LAND  | lane | repo | branch | tip | merge | brief | report | ISO
#   CLOSE | lane | status | merged | green | live | renamed | report-free | ISO | reason
#         | owner-way | in-scope | roadmap | kind | findings | side-files
#   NOTE  | lane | text | ISO
#   KIND  | lane | scope|clerical | note | ISO
#
# Every gate value is `yes` | `no` | `skip` | `n/a` | `exempt`.
#
#   yes / n/a / exempt  pass. `n/a` means there was nothing to measure; `exempt` means the surface
#                       answered and refusing was the correct answer.
#   no                  a real red: it was measured and it failed.
#   skip                NOTHING WAS MEASURED. **A skip is not a pass** and never grades DONE.
#
# A field added after some lines were written reads as `-` on the older ones. A `-` means "this
# gate did not exist when that line was written". It is not a pass either.
#
# WHY OPEN CARRIES `scope`. A claim line says which repo is held; it does not say which FILES. An
# allocator reading only the claims must treat every open lane as holding the whole repo — safe,
# and it makes any writer cap above 1 unusable the moment one lane is open. The OPEN record
# carries the scope the lane actually declared, so a second lane can be PROVED disjoint from it
# rather than assumed to collide. A lane with no OPEN record still reads as whole-repo.
#
# WHY LAND EXISTS. Everything a lane produces already exists — the brief, the report, this row,
# the commits — except the LINK from a change on main back to the lane that made it. One merge
# commit per lane, recorded here, turns every question into one lookup: change on main -> merge
# commit -> lane -> report. Undoing a lane is then `git revert -m 1 <merge>`.
