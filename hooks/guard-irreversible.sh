#!/bin/bash
# ── WHAT THIS IS ──────────────────────────────────────────────────────────────────────────────
# WHAT IT CHECKS: a command or a database statement that cannot be undone by a later commit, and
#                 refuses it unless the operator has typed the unlock phrase in this session.
# LOG:            guard-log.jsonl beside this file, one line per refusal, never on a pass.
#                 (The log is generated at runtime and is not part of the repository.)
# ──────────────────────────────────────────────────────────────────────────────────────────────
#
# THE UNLOCK PHRASE IS CONFIGURABLE. Set $PANDORAS_UNLOCK_PHRASE to whatever your team says out
# loud when it means it; the default is "flyingfish". The phrase must be typed by a real
# USER in this session's transcript, as the WHOLE message or as a line by itself: a phrase quoted
# inside a sentence, a pasted log that happens to carry it, or a brief that mentions the rule does
# not unlock anything. An agent cannot unlock itself by writing the words, which is the entire
# point of reading the transcript rather than a flag. Once typed, the unlock holds for the rest of
# that session; pick a phrase that is not ordinary English.
#
# WHAT IS DELIBERATELY NOT GATED. An ordinary `git push` and an ordinary production deploy. They
# are reversible by a commit and they are how a lane finishes its work. Gating them costs a human
# interruption on every routine deploy and buys nothing a build gate has not already bought — and
# a guard that fires on ordinary work gets muted within a week.
#
# STILL GATED, and deliberately so: none of these are undone by a commit.
#   force-push (every spelling: --force, -f, -fu, +refspec, --force-with-lease, --delete)
#   branch deletion (local or remote, -d/-D/--delete and combined flags), worktree removal
#   history rewrites (reset --hard, rebase, filter-branch, filter-repo, BFG)
#   clean -f, rm with any recursive AND any force flag, a git alias defined on the command line
#   anything that writes schema to a live database, or deletes/updates rows with no narrow WHERE
#
# THE CEILING OF A PATTERN GUARD, stated rather than discovered: a command hidden inside a script
# file, a `sh -c "$(cat x)"`, or SQL sent through a file or a stored procedure walks past this.
# It refuses what it can see. It fails CLOSED when it cannot see: no python3 means no verdict
# means deny.
command -v python3 >/dev/null 2>&1 && python3 -c 'pass' >/dev/null 2>&1 || {
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"guard-irreversible needs python3 to read its input and refuses rather than guess. Install python3 (or put it on PATH) and retry."}}'
  exit 0
}
INPUT=$(cat)
UNLOCK="${PANDORAS_UNLOCK_PHRASE:-flyingfish}"

# One line per refusal. A logging failure must never change a verdict, hence the trailing || true.
# A call with no chat id attached is a synthetic one from the assertion suite, not a real refusal,
# and is not logged: one test run would otherwise add twenty-odd refusals that never happened and
# drown the real ones. The harness always supplies a chat id on a live call.
guard_log() {
  [ -z "$3" ] && return 0
  python3 - "$(dirname "$0")/guard-log.jsonl" "guard-irreversible" "$1" "$2" "$3" <<'PY' 2>/dev/null || true
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
TOOL=$(echo "$INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('tool_name',''))" 2>/dev/null)
CMD=$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tool_input',{}).get('command',''))" 2>/dev/null)
TRANSCRIPT=$(echo "$INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('transcript_path',''))" 2>/dev/null)
SQL=$(echo "$INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('tool_input',{}).get('query',''))" 2>/dev/null)

# NORMALISE BEFORE MATCHING. grep is line-based, so `DELETE⏎FROM` never matched `delete +from`,
# and a `/* comment */` or a `-- comment` between the words hid them too. Comments are stripped
# and every run of whitespace becomes one space, so the greps below see one line. A `--` inside a
# string literal is stripped along with the rest of its line, which can only make the guard
# refuse MORE, never less. A backslash-newline in a shell command is a continuation and joins;
# any other newline is a command boundary and becomes ` ; `.
norm_sql() {
  python3 -c '
import re, sys
s = sys.stdin.read()
s = re.sub(r"--[^\n]*", " ", s)
s = re.sub(r"/\*.*?\*/", " ", s, flags=re.S)
sys.stdout.write(re.sub(r"\s+", " ", s))
' 2>/dev/null
}
norm_cmd() {
  python3 -c '
import re, sys
s = sys.stdin.read().replace("\\\n", " ")
sys.stdout.write(re.sub(r"[\r\n]+", " ; ", s))
' 2>/dev/null
}
N=$(printf '%s' "$SQL" | norm_sql); [ -n "$N" ] && SQL="$N"
N=$(printf '%s' "$CMD" | norm_cmd); [ -n "$N" ] && CMD="$N"

# `WHERE true` and `WHERE 1=1` are the shape of a WHERE with none of the narrowing.
has_narrow_where() {
  echo "$1" | grep -qiE '[^_[:alnum:]]where[^_[:alnum:]]' || return 1
  echo "$1" | grep -qiE '[^_[:alnum:]]where +(true|1 *= *1)([^_[:alnum:]]|$)' && return 1
  return 0
}

# Any git global option may sit between `git` and the verb: `-C <dir>`, `--no-pager`, `-c k=v`,
# `--git-dir=…`. Every git pattern below starts with this so none of them can be skipped that way.
G='git( +-[^ ]+( +[^- ][^ ]*)?)*'

DANGER=0
case "$TOOL" in
  *apply_migration*) DANGER=1 ;;
  # An `execute_sql` tool is commonly auto-approved in a settings file, and this database may hold
  # everything the operator runs, so the statement classes below want the unlock phrase rather
  # than a click.
  #
  # READS ARE NOT GATED and must not be: SELECT against this database is how a lane
  # measures anything, and gating it would push sessions toward guessing instead.
  *execute_sql*)
    # schema, privileges, and the two statements that quietly destroy rows
    echo "$SQL" | grep -qiE '(^|[^_[:alnum:]])(drop|truncate|alter|grant|revoke)([^_[:alnum:]]|$)' && DANGER=1
    echo "$SQL" | grep -qiE '(^|[^_[:alnum:]])create +(or +replace +)?(table|view|function|trigger|policy|index|schema|type)' && DANGER=1
    # DELETE / UPDATE are only safe with a narrow WHERE
    echo "$SQL" | grep -qiE '(^|[^_[:alnum:]])delete +from' && ! has_narrow_where "$SQL" && DANGER=1
    echo "$SQL" | grep -qiE '(^|[^_[:alnum:]])update +[a-z_."]+ +set' && ! has_narrow_where "$SQL" && DANGER=1
    ;;
  Bash)
    # AMENDED. DESCRIBING a dangerous command is not RUNNING one.
    #
    # This gate greps the whole command string, so a commit message that named the bug it was
    # fixing tripped it: `git commit -am "...close ran git worktree remove..."` was refused as
    # an irreversible operation. The cost is not the interruption — a lane that hits
    # "irreversible operation blocked" on a plain commit reasonably concludes it cannot commit at
    # all and stops. It is also self-defeating: a workspace that requires commit messages to
    # explain the failure being fixed finds the failures worth fixing are exactly these words.
    #
    # So the VALUE of a message-carrying flag is blanked before matching. NARROWLY, and never
    # quoted text in general: `bash -c "git push --force"` must still be caught, and the test
    # suite asserts that it is. A git commit message is never executed; a -c argument is. That
    # difference is the whole basis for this being safe — with ONE exception the scrubber checks
    # first: a `$(...)` or a backtick inside the quoted value IS executed by the shell before git
    # ever sees the message, so a value carrying either is DANGER before anything is blanked.
    SCAN=$(printf '%s' "$CMD" | python3 -c '
import re, sys
s = sys.stdin.read()
# Only these flags, only their quoted value, quote-type aware, backslash-escape aware.
pat = re.compile(r"""(?:(?<=\s)|^)(-m|-am|--message|--body|--title)(=|\s+)(["\x27])(?:\\.|(?!\3).)*\3""", re.S)
danger = any(("$(" in m.group(0)) or ("`" in m.group(0)) for m in pat.finditer(s))
sys.stdout.write(("DANGER:" if danger else "") + pat.sub(lambda m: m.group(1) + m.group(2) + m.group(3) * 2, s))
' 2>/dev/null) || SCAN="$CMD"
    [ -z "$SCAN" ] && SCAN="$CMD"    # a scrubber failure must never blind the gate
    case "$SCAN" in DANGER:*) DANGER=1; SCAN="${SCAN#DANGER:}" ;; esac
    CMD="$SCAN"
    # history rewrites / force pushes / deletions
    echo "$CMD" | grep -qE "${G} +push[^|;&]*(--force|--force-with-lease|--delete| :|( |^)-[a-zA-Z]*f[a-zA-Z]*( |$)| \+[^ ])" && DANGER=1
    echo "$CMD" | grep -qE "${G} +(reset +--hard|rebase|filter-branch|filter-repo|reflog +(delete|expire))" && DANGER=1
    echo "$CMD" | grep -qE "${G} +branch( +[^|;&]*)? +(--delete|-[a-zA-Z]*[dD][a-zA-Z]*)( |$)" && DANGER=1
    echo "$CMD" | grep -qE "${G} +worktree +remove" && DANGER=1
    echo "$CMD" | grep -qE "${G} +clean +[^|;&]*-[a-z]*f" && DANGER=1
    echo "$CMD" | grep -qE "${G} +config +[^|;&]*alias\." && DANGER=1
    echo "$CMD" | grep -qE 'bfg|--strip-blobs|--replace-text' && DANGER=1
    # destructive filesystem: any recursive flag AND any force flag on one rm, in any spelling
    # `rm` counts wherever it is not the tail of another word: at the start, after `;`, `&&`, `|`,
    # a quote (`bash -c "rm -rf x"`) or a path (`/bin/rm`).
    RMSEG=$(echo "$CMD" | grep -oE '(^|[^[:alnum:]_-])rm +[^|;&]*')
    if [ -n "$RMSEG" ] && echo "$RMSEG" | grep -qE '( |^)(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)( |$)' \
       && echo "$RMSEG" | grep -qE '( |^)(-[a-zA-Z]*f[a-zA-Z]*|--force)( |$)'; then DANGER=1; fi
    # schema against a live database
    echo "$CMD" | grep -qE '(db push|db reset|migration up|migrate deploy|(projects|branches) +(delete|rm))' && DANGER=1
    echo "$CMD" | grep -qiE 'psql[^|;&]*(drop|truncate|delete +from)' && DANGER=1
    ;;
esac
[ "$DANGER" -eq 0 ] && exit 0
if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
  if grep -l "$UNLOCK" "$TRANSCRIPT" >/dev/null 2>&1 && \
     python3 - "$TRANSCRIPT" "$UNLOCK" <<'PY'
import json,sys
phrase=sys.argv[2]
ok=False
for line in open(sys.argv[1], errors="replace"):
    try: o=json.loads(line)
    except: continue
    if o.get('type')!='user' or o.get('isMeta'): continue
    c=o.get('message',{}).get('content')
    txt=c if isinstance(c,str) else ' '.join(b.get('text','') for b in c if isinstance(b,dict)) if isinstance(c,list) else ''
    # the WHOLE trimmed message, or a line by itself: never a substring of a sentence
    if txt.strip()==phrase or phrase in [l.strip() for l in txt.splitlines()]: ok=True
sys.exit(0 if ok else 1)
PY
  then exit 0; fi
fi
guard_log "deny" "irreversible, unlock phrase not in this session: ${CMD:-$SQL}" "$SESSION"
python3 - "$UNLOCK" <<'PY'
import json, sys
phrase = sys.argv[1]
print(json.dumps({"hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": (
        "Irreversible operation blocked (force-push, history rewrite, deletion, or live schema "
        f"change): nobody has typed \"{phrase}\" as a message of its own in this session. Ask the "
        "operator, then retry once they have."
    ),
}}))
PY
exit 0
