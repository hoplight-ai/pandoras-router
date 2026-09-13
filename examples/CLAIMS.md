# CLAIMS — one line per active lane. The visible lock.
#
# Copy this file to `_handoffs/_lanes/CLAIMS.md` at your workspace root. It ships EMPTY, which is
# the correct starting state: no lane is open yet.
#
# WHY THIS FILE EXISTS
# A dirty working tree proves a writer. A clean tree does NOT prove absence: an agent can be open
# and mid-read for twenty minutes before its first edit, and git cannot see it. This file is that
# missing signal — and it is only as good as the sessions that maintain it, which is why the
# router writes and releases these lines rather than asking anyone to remember.
#
# FORMAT — pipe-separated, nothing else on the line:
#
#   <repo> | <session title> | <ISO 8601 timestamp> | <session id>
#
#   <repo>           the directory name of the repo, or the workspace root's own name
#   <session title>  the lane's own name, so a human reading the board knows who to ask
#   <timestamp>      when the session OPENED, not when it started writing
#   <session id>     the identity that distinguishes TWO SESSIONS OF ONE LANE
#
# THE FOURTH FIELD IS THE WHOLE POINT, and it was learned the expensive way. A claim line that
# names only the LANE looks satisfied to a second session of that same lane, so two agents ran one
# brief and one of them destroyed the other's report. Three fields still parse — they are read as
# WEAK, which is not a pass — and the router says so.
#
# AGE IS A SIGNAL, NOT A VERDICT. A claim past the active window is printed as STALE and stops
# counting against the repo's writer cap, because crashed sessions never come back to clean up
# after themselves. It is never released automatically: a release is a deliberate act with a
# written receipt naming how the session was proved gone.
#
# A RELEASED LINE IS COMMENTED OUT, NEVER REMOVED. This folder is usually not under version
# control, so the commented line is the only undo there is.
#
# Two examples of the shape, both commented out so this file starts genuinely empty:
#
# web | Web CEILING1 | 2026-09-12T14:02:00Z | dispatch-lane-ceiling1
# api | Api DEMO1 | 2026-09-12T14:20:00Z | dispatch-lane-demo1
