#!/bin/bash
# ── WHAT THIS IS ──────────────────────────────────────────────────────────────────────────────
# WHAT IT CHECKS: a whole-file Write aimed at a report that already exists on the handoff bridge,
#                 and refuses it so a second agent cannot erase the first one's report.
# LOG:            guard-log.jsonl beside this file, one line per refusal, never on a pass.
#                 (The log is generated at runtime and is not part of the repository.)
# ──────────────────────────────────────────────────────────────────────────────────────────────
# Refuses a Write that would land on top of an existing report on the handoff bridge.
#
# WHY THIS EXISTS. Two sessions once ran one brief at the same time. The brief named one exact
# output filename, so the second session to finish wrote its report to that name and landed on top
# of the first session's report. That report's receipts, its defect list with owners, its
# escalations and its record of what it deliberately left untouched were gone and were never
# recovered. The bridge is not under version control, so there was no copy. The only warning anyone
# got was the Write tool answering "has been updated successfully" instead of "created", which is
# far too quiet for what it means.
#
# The other half of the fix is in lib/naming.mjs: a derived report filename carries the LANE, so
# two sessions of one brief cannot produce the same name in the first place. This hook is the
# backstop for every path that does not go through it.
#
# WHAT IT GUARDS. Write (whole-file replace) to an existing .md at the ROOT of _handoffs/. That is
# where reports and briefs live and where the collision happened. The path is normalised first, so
# `_handoffs/./x.md` and `_handoffs/_lanes/../x.md` are the same file as `_handoffs/x.md`, and the
# extension is matched in any case, because on a case-insensitive disk `x.MD` lands on `x.md`.
#
# WHAT IT DELIBERATELY DOES NOT GUARD, so it stays worth having:
#   - Edit. A targeted edit is not a silent replace; it fails loudly if its anchor is missing.
#   - Files that do not exist yet. Creating is the normal case and must stay frictionless.
#   - Anything in a subdirectory of _handoffs/ (assets, _lanes, archive) or outside the bridge.
#   - The bridge's own furniture, edited in place by design: `README.md` and `_STANDING_ORDERS.md`
#     by default; set $PANDORAS_BRIDGE_FURNITURE to a space-separated list to name your own.
# A guard that fires on ordinary work gets muted within a week, and a muted guard protects nothing.
#
# The refusal names the -2 variant rather than only saying no, because the lane on the other end of
# it has a finished report in hand and needs somewhere to put it in the next ten seconds.
command -v python3 >/dev/null 2>&1 && python3 -c 'pass' >/dev/null 2>&1 || {
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"guard-report-overwrite needs python3 to read its input and refuses rather than guess. Install python3 (or put it on PATH) and retry."}}'
  exit 0
}
INPUT=$(cat)

# One line per refusal. A logging failure must never change a verdict, hence the trailing || true.
# A call with no chat id attached is a synthetic one from the assertion suite, not a real refusal,
# and is not logged: one test run would otherwise add refusals that never happened and drown the
# real ones. The harness always supplies a chat id on a live call.
guard_log() {
  [ -z "$3" ] && return 0
  python3 - "$(dirname "$0")/guard-log.jsonl" "guard-report-overwrite" "$1" "$2" "$3" <<'PY' 2>/dev/null || true
import json, sys, datetime
path, hook, verdict, reason, session = sys.argv[1:6]
rec = {
    "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    "hook": hook, "verdict": verdict, "reason": reason[:200], "session": session,
}
with open(path, "a") as fh:
    fh.write(json.dumps(rec) + "\n")
PY
}
SESSION=$(echo "$INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null)

FILE=$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('file_path',''))" 2>/dev/null)
[ -n "$FILE" ] || exit 0
# Normalise `.` and `..` segments so the directory test below sees the real parent.
FILE=$(python3 -c 'import os,sys; print(os.path.normpath(sys.argv[1]))' "$FILE" 2>/dev/null)
[ -n "$FILE" ] || exit 0
[ -f "$FILE" ] || exit 0

DIR=$(dirname "$FILE")
BASE=$(basename "$FILE")

case "$DIR" in
  */_handoffs) ;;
  *) exit 0 ;;
esac
case "$BASE" in
  *.[mM][dD]) ;;
  *) exit 0 ;;
esac

# The bridge's own furniture is edited in place by design and is not a lane's report.
FURNITURE="${PANDORAS_BRIDGE_FURNITURE:-README.md _STANDING_ORDERS.md}"
for f in $FURNITURE; do
  [ "$BASE" = "$f" ] && exit 0
done

STEM="${BASE%.[mM][dD]}"
SUGGEST="$DIR/$STEM-2.md"
N=2
while [ -f "$SUGGEST" ]; do
  N=$((N + 1))
  SUGGEST="$DIR/$STEM-$N.md"
done

guard_log "deny" "report already on the bridge, whole-file Write refused: $BASE" "$SESSION"

python3 - "$BASE" "$SUGGEST" <<'PY'
import json, sys
base, suggest = sys.argv[1], sys.argv[2]
reason = (
    f"Refused: '{base}' already exists on the handoff bridge and Write would replace it whole.\n\n"
    "This is the guard for the incident where a second session running the same brief silently "
    "overwrote the first session's finished report and its receipts were never recovered. If a "
    "file is already at the name your brief told you to use, YOU ARE THE SECOND SESSION.\n\n"
    "Do this instead:\n"
    f"  1. Read '{base}' first. If it is another lane's report, do not touch it.\n"
    f"  2. Write yours to: {suggest}\n"
    "  3. Record the collision in your incident log, naming both sessions.\n\n"
    "If you genuinely mean to revise your OWN report, use Edit rather than Write — a targeted edit "
    "cannot silently erase a report you have not read."
)
print(json.dumps({"hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": reason,
}}))
PY
exit 0
