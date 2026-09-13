// naming.mjs — every name a lane needs, derived once, from the brief's own filename.
//
// WHY THIS IS A MODULE AND NOT SIX SENTENCES IN A DISPATCH TRANSCRIPT. A dispatcher otherwise
// reasons out branch name, worktree path, report filename and port in prose, per lane. The report
// filename is the one that destroys work: when a brief names one exact output file, the second
// session to finish overwrites the first one's report. Derived names carry the LANE identifier,
// which is what makes two sessions of one brief produce two different filenames.
//
//   brief   Web-CEILING1-Raise-It-Per-Provider.md
//   lane    ceiling1
//   branch  ceiling1-raise-it-per
//   wtree   web-ceiling1
//   report  done-2026-08-18-web-ceiling1-raise-it-per.md
//   session dispatch-lane-ceiling1

const LANE_TOKEN = /^([A-Za-z]+)(\d+)$/;

/** `Catalogue-L1-Decision-Queue.md` -> `catalogue-l1`; `Web-CEILING1-...` -> `ceiling1`. */
export function laneIdFor(filename) {
  const stem = filename.replace(/\.md$/i, '');
  const parts = stem.split('-').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const m = LANE_TOKEN.exec(parts[i]);
    if (!m) continue;
    // A short alpha stem (`L1`, `P1`, `W3`) is not unique on this bridge — there are many `L1`s.
    // Carry the word in front of it so the lane id stays a name and not a collision.
    const short = m[1].length <= 2 && i > 0;
    return (short ? `${parts[i - 1]}-${parts[i]}` : parts[i]).toLowerCase();
  }
  return parts.slice(0, 2).join('-').toLowerCase() || 'lane';
}

/** The words after the lane token, at most three, for a branch that reads like something. */
export function slugFor(filename) {
  const stem = filename.replace(/\.md$/i, '');
  const parts = stem.split('-').filter(Boolean);
  let at = parts.findIndex((p) => LANE_TOKEN.test(p));
  if (at < 0) at = 0;
  const tail = parts.slice(at + 1, at + 4).map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, ''));
  return tail.filter(Boolean).join('-') || 'work';
}

export const branchFor = (lane, slug) => `${lane}-${slug}`;
export const worktreeFor = (repo, lane) => `${repo}-${lane}`;
export const sessionIdFor = (lane) => `dispatch-lane-${lane}`;

/** Report names carry the lane. That is the whole defence against a second session's overwrite. */
// A REPO NAME IS NOT ALWAYS FILENAME-SAFE, and the one exception disables a safety gate.
//
// When the workspace root itself is a lane target, its label may be path-like (`~/work`). Interpolated
// raw that produces `done-2026-08-21-~/work-<lane>.md` — a PATH, not a filename. Nothing can ever exist at
// that name, so the close gate that guards against two sessions writing one report looks for a file
// that cannot be there and answers "free" for EVERY root lane: the collision the whole module
// exists to prevent, with the guard silently switched off.
//
// Flattening the separators makes the generated name a real filename again.
const fileSafeRepo = (repo) => String(repo).replace(/^~\//, '').replace(/[/\\]/g, '-');

export const reportFor = (date, repo, lane, slug) => `done-${date}-${fileSafeRepo(repo)}-${lane}-${slug}.md`;

// THE FILENAME MUST FOLLOW THE GRADE.
//
// `reportFor` above always produces `done-`, because at lane-open nobody knows how the lane will
// grade. If close then records that same name into the ledger whatever the gates decided, a PARTIAL
// lane's close record points at `done-<date>-...` while its report is correctly filed under
// `partial-<date>-...`. The pointer leads to a file that does not exist, which is worse than no
// pointer: it reads as a missing report rather than as a misnamed one.
//
// A LANE MUST NOT BE ABLE TO INVENT A PREFIX. Only the three graded statuses map to a word; an
// unknown status returns the name untouched rather than coining a lifecycle prefix nobody defined.
// `parked-` is deliberately absent: it is a state a human puts a brief into, never a grade a close
// hands out.
export const PREFIX_FOR_STATUS = { DONE: 'done-', PARTIAL: 'partial-', BLOCKED: 'blocked-' };
const REPORT_PREFIXES = ['done-', 'partial-', 'blocked-', 'parked-'];

export function reportNameForStatus(name, status) {
  const want = PREFIX_FOR_STATUS[String(status ?? '').toUpperCase()];
  if (!want || !name) return name;
  const had = REPORT_PREFIXES.find((p) => name.startsWith(p));
  return had ? `${want}${name.slice(had.length)}` : `${want}${name}`;
}

// "TODAY" IS THE OPERATOR'S DAY, NOT UTC'S.
//
// With `toISOString()` the allocator prints `Not-Before 2026-08-25 (today is 2026-08-24)` at 23:19
// local on the 23rd, and generates every report filename as `done-2026-08-24-...`, five hours
// before that day starts where the operator is. A `Not-Before` hold that opens the evening before
// is not a hold; that gate exists for exactly one thing, keeping a brief unfireable until a named
// day. The quieter cost: a report written on Sunday night files under Monday, so the ledger's own
// chronology drifts a day at a time.
//
// So the date comes from a local calendar. The DEFAULT is the machine's own zone, because the
// laptop travels with the operator and "their day" is the thing this function is for. The zone is
// an ARGUMENT so an assertion can pin one instead of silently re-reading its own answer off the
// host clock. A test that does that is not a test.
//
// Built on Intl rather than on date parts for the same reason `toISOString()` was rejected: there is
// no other way to ask for a calendar day in a named zone. `en-CA` is the locale whose short date IS
// `YYYY-MM-DD`; it is a formatting detail, not a statement about Canada.
export const SHOP_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function localDate(d, tz = SHOP_TZ) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

export function todayLocal(now = new Date(), tz = SHOP_TZ) {
  return localDate(now, tz);
}

// Kept so nothing outside this repo breaks on the rename, and named honestly: it is the UTC day and
// it is NOT what the board means by "today". Do not reach for it for a date gate or a filename.
export function todayUTC(now = new Date()) {
  return now.toISOString().slice(0, 10);
}
