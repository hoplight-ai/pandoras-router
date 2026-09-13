// side-files-gate.mjs — gate `no-side-files`. The problem it answers, in one sentence: a project
// already has a tracker, so why is every lane proliferating more surfaces for it to go stale in.
//
// A lane that gains a new `_handoffs/REFERENCE-*.md`, `_handoffs/SWEEP-*.md` or
// `_handoffs/TRIAGE-*.md` file during its own open/close window fails this gate, by filename — a
// second static surface next to the tracker is exactly that drift, and the fix is a tracker row,
// not a document. The escape hatch is explicit and printed, never inferred: a brief
// whose header carries `Side-file: allowed` (with a reason) turns the gate `n/a` rather than `no`,
// because the brief's author is the one place a genuine exception gets recorded.
//
// WINDOW IS NOT ATTRIBUTION. The first cut of this gate treated every matching file whose mtime
// fell inside a lane's [opened, now) window as that lane's fault. Many lanes run in parallel, so
// the window alone punishes the wrong lane: measured, one lane's dry run failed on a REFERENCE
// file a DIFFERENT lane had written while both were open. A file now only counts against a lane if it is ATTRIBUTABLE to that lane:
//   (a) the file's body mentions the lane's codename or the brief's own title (case-insensitive), or
//   (b) the file sits under the lane's own worktree diff (its path appears among the files the
//       lane's branch actually changed), or
//   (c) the lane's own done-file (partial-/blocked- included) names the side file.
// A file that falls in the window but is not attributable by any of the three prints one
// `WARN side file in window, not attributed: <name>` line and does not fail the gate — it is still
// worth a human's eye (something new landed on the bridge during this lane's life), but it is not
// this lane's file to answer for. This does not try to prove which lane's commits created a file in
// the strict sense gate 7 attributes repo files — the bridge itself is not a git repo gate 1/7 ever
// diff — it asks the three simple, sufficient questions above. A false WARN costs nothing (a human
// reads one line); a false attributable-fail costs a lane its close.

export const SIDE_FILE_RE = /^(REFERENCE|SWEEP|TRIAGE)-.*\.md$/;

/**
 * Whether a brief's header opts a lane out of this gate, and why. `Side-file: allowed` on its own
 * line, optionally followed by `- <reason>` or `: <reason>` on the same line. No reason given is
 * still allowed — the gate does not grade the QUALITY of the exception, only whether one was named.
 */
export function sideFileAllowed(briefText) {
  const m = String(briefText ?? '').match(/^\s*Side-file:\s*allowed\b\s*(?:[-:]\s*(.*))?$/im);
  if (!m) return { value: false, reason: null };
  return { value: true, reason: (m[1] || '').trim() || null };
}

/**
 * A brief's own title: the text of its first `# ` markdown heading. Returns null when the brief
 * text is missing or carries no such heading — callers must treat that as "no title to match on",
 * never as a reason to skip the gate.
 */
export function extractBriefTitle(briefText) {
  const m = String(briefText ?? '').match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

const norm = (s) => String(s ?? '').toLowerCase();

/**
 * Is one in-window side file attributable to this lane?
 *
 * @param {{name:string, body?:string|null}} file
 * @param {{laneId?:string|null, briefTitle?:string|null, worktreeDiffPaths?:string[], doneFileText?:string|null}} ctx
 */
export function sideFileAttributable(file, ctx = {}) {
  const { laneId = null, briefTitle = null, worktreeDiffPaths = [], doneFileText = null } = ctx;
  const body = norm(file?.body);

  // (a) the file's own body names this lane, by codename or by the brief's title.
  if (body) {
    if (laneId && body.includes(norm(laneId))) return true;
    if (briefTitle && body.includes(norm(briefTitle))) return true;
  }

  // (b) the file is under the lane's own worktree diff — its path (or basename) is among the
  // files the lane's branch actually changed against its base.
  if (Array.isArray(worktreeDiffPaths)) {
    const name = file?.name;
    if (name && worktreeDiffPaths.some((p) => p === name || String(p ?? '').endsWith(`/${name}`))) {
      return true;
    }
  }

  // (c) the lane's own done-file (or partial-/blocked- equivalent) references the side file by
  // filename.
  if (doneFileText && file?.name && norm(doneFileText).includes(norm(file.name))) return true;

  return false;
}

/**
 * Gate `no-side-files`'s verdict.
 *
 * @param {object} p
 * @param {Array<{name:string, mtimeIso:string|null, body?:string|null}>} p.files  the bridge
 *   root's own listing; `body` is only needed (and only read by the caller) for files matching
 *   SIDE_FILE_RE, since attribution test (a) reads it.
 * @param {{start:string|null, end:string}} p.window   this lane's [opened, now)
 * @param {{value:boolean, reason:string|null}} p.allowed   sideFileAllowed()'s return
 * @param {string|null} [p.laneId]   this lane's codename, for attribution test (a)
 * @param {string|null} [p.briefTitle]   this lane's brief title, for attribution test (a)
 * @param {string[]} [p.worktreeDiffPaths]   files changed in this lane's own branch diff, for (b)
 * @param {string|null} [p.doneFileText]   this lane's own report text (done-/partial-/blocked-), for (c)
 */
export function noSideFilesVerdict({ files, window, allowed, laneId = null, briefTitle = null, worktreeDiffPaths = [], doneFileText = null }) {
  if (allowed?.value) {
    return {
      value: 'n/a',
      offenders: [],
      warnings: [],
      note: `Side-file: allowed${allowed.reason ? ` — ${allowed.reason}` : ' (no reason given)'}. This gate is not evaluated.`,
    };
  }
  if (!window?.start) {
    return {
      value: 'skip',
      offenders: [],
      warnings: [],
      note: 'SKIP: this lane has no recorded open time, so the window this gate checks cannot be established. Nothing was measured, and a skip is not a pass.',
    };
  }
  const startMs = Date.parse(window.start);
  const endMs = Date.parse(window.end);
  const inWindow = (files ?? []).filter(
    (f) => SIDE_FILE_RE.test(f.name) && f.mtimeIso && Date.parse(f.mtimeIso) >= startMs && Date.parse(f.mtimeIso) <= endMs,
  );

  const offenders = [];
  const warnings = [];
  const ctx = { laneId, briefTitle, worktreeDiffPaths, doneFileText };
  for (const f of inWindow) {
    if (sideFileAttributable(f, ctx)) {
      offenders.push(f.name);
    } else {
      warnings.push(`WARN side file in window, not attributed: ${f.name}`);
    }
  }

  if (offenders.length) {
    return {
      value: 'no',
      offenders,
      warnings,
      note: [
        `${offenders.length} new side file(s) attributable to this lane appeared on the bridge during its open/close window: ${offenders.join(', ')}. `
          + 'We have a loop tracker; file a `FINDING:` line or a `Roadmap row:` instead of a new prose surface, '
          + 'or add `Side-file: allowed` to the brief\'s header with a reason.',
        ...warnings,
      ].join('\n'),
    };
  }
  return {
    value: 'yes',
    offenders: [],
    warnings,
    note: [
      'no REFERENCE-/SWEEP-/TRIAGE- file attributable to this lane appeared on the bridge during its window.',
      ...warnings,
    ].join('\n'),
  };
}
