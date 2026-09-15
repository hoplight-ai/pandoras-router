// @ts-check
// check.mjs — the pure half of `pandoras-router check`.
//
// WHY THIS EXISTS. Today a broken workspace is discovered by whichever command trips over it
// first: `loadPolicy` throws on a duplicate repo row, `loadPrefixes` refuses an invented lifecycle
// word, `parseClaims` and `parseLanes` skip lines they cannot read — each found mid-`alloc` or
// mid-`open`, one at a time, by whoever fired next. This module runs every one of those loaders up
// front, against the same files, and turns every thrown message into a problem line instead of a
// stack trace, so a reader who has just cloned this tool can ask "is my setup right?" without
// firing anything.
//
// PURE. No process.exit, no console.log, no writes of any kind. Unit-testable against a temporary
// directory. Every check below KEEPS GOING after a failure — one broken file does not hide problems
// waiting in the next one.

import fs from 'node:fs';
import path from 'node:path';
import { loadPolicy, policyFile } from './policy.mjs';
import { loadPrefixes, prefixFile, classifyBridge } from './prefixes.mjs';
import { readClaims, CLAIM_ACTIVE_HOURS, sameLaneTwice, claimsFile } from './claims.mjs';
import { readLanes, lanesFile, closedUnrenamedVerdict } from './lanes.mjs';
import { laneIdFor } from './naming.mjs';

const PKG_NAME = 'pandoras-router';
const ORPHAN_OPEN_HOURS = 48;

function rel(root, file) {
  return path.relative(root, file) || file;
}

/**
 * @typedef {{file:string, severity:'error'|'warning', message:string}} Problem
 */

/**
 * Check one workspace: every file the router depends on, read the same way the router itself
 * reads them, every problem kept rather than stopping at the first.
 *
 * @param {string} root  the workspace root — the directory holding `_handoffs/` and the repos
 * @returns {{problems: Problem[], counts: Record<string, number>}}
 */
export function checkWorkspace(root) {
  /** @type {Problem[]} */
  const problems = [];
  const counts = { reposChecked: 0, bridgeFilesChecked: 0, claimLinesChecked: 0, laneRecordsChecked: 0 };

  checkPolicy(root, problems, counts);
  const prefixResult = checkPrefixes(root, problems, counts);
  checkClaims(root, problems, counts);
  checkLanes(root, problems, counts, prefixResult);
  checkShape(root, problems);

  return { problems, counts };
}

// ---------------------------------------------------------------------------------------------- POLICY.md

function checkPolicy(root, problems, counts) {
  const file = rel(root, policyFile(root));
  let policy;
  try {
    policy = loadPolicy(root);
  } catch (e) {
    // Every thrown message — a duplicate repo, an invalid deploy style, a table naming a repo with
    // no row in the repos table — becomes one problem line. loadPolicy stops at its first error, so
    // this reports exactly that one; a workspace with several policy defects surfaces them one fix
    // at a time, the same way `loadPolicy` already forces a reader to.
    problems.push({ file, severity: 'error', message: e.message });
    return;
  }
  for (const r of policy.repos.values()) {
    counts.reposChecked++;
    if (r.url && r.verify.kind === 'none') {
      problems.push({
        file,
        severity: 'warning',
        message: `repo "${r.repo}" has a url (${r.url}) but verify is "none" — nothing can ever prove a deploy to it; set a verify form or drop the url`,
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------- PREFIXES.md

function checkPrefixes(root, problems, counts) {
  const file = rel(root, prefixFile(root));
  let vocab;
  try {
    vocab = loadPrefixes(root);
  } catch (e) {
    problems.push({ file, severity: 'error', message: e.message });
    return null;
  }
  let entries;
  try {
    entries = classifyBridge(root, vocab);
  } catch (e) {
    // `_handoffs/` itself is unreadable — a shape defect, but this check ran into it first, so name
    // it here rather than swallowing it. checkShape below still names the directory by itself.
    problems.push({ file: '_handoffs/', severity: 'error', message: `bridge filenames could not be read: ${e.message}` });
    return { vocab, entries: [] };
  }
  for (const entry of entries) {
    counts.bridgeFilesChecked++;
    if (entry.refused) {
      // entry.reason already names the correct word: the denied-list reason reads "... means
      // `done-`", the near-miss reason reads "... one character from `done-`", so quoting it whole
      // is the same information `loadPrefixes` would print, never re-derived.
      problems.push({ file: `_handoffs/${entry.name}`, severity: 'error', message: entry.reason });
    }
  }
  return { vocab, entries };
}

// ---------------------------------------------------------------------------------------------- CLAIMS.md

function checkClaims(root, problems, counts) {
  const file = rel(root, claimsFile(root));
  const { rows } = readClaims(root);
  const repos = new Set();
  for (const row of rows) {
    counts.claimLinesChecked++;
    if (row.malformed) {
      problems.push({ file, severity: 'error', message: `line ${row.lineNo}: does not parse as a claim (need at least repo | chat | timestamp): "${row.raw}"` });
      continue;
    }
    repos.add(row.repo);
    if (row.stale) {
      problems.push({
        file,
        severity: 'warning',
        message: `line ${row.lineNo}: claim on "${row.repo}" ("${row.chat}") is older than the ${CLAIM_ACTIVE_HOURS}h active window (opened ${row.stamp})`,
      });
    }
  }
  // sameLaneTwice is scoped to one repo; run it once per repo actually named in the file, rather
  // than reimplementing what it already answers.
  for (const repo of repos) {
    for (const dup of sameLaneTwice(rows, repo)) {
      const lines = dup.rows.map((r) => r.lineNo).join(', ');
      problems.push({
        file,
        severity: 'error',
        message: `lane "${dup.lane}" holds two claims on repo "${repo}" at once (lines ${lines})`,
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------- LANES.md

// Minimum field count per record kind, mirroring parseLanes' own thresholds (lib/lanes.mjs) exactly
// — a line short of these is silently dropped by parseLanes rather than surfaced, which is the gap
// this raw scan exists to close.
const RECORD_MIN_FIELDS = { OPEN: 10, CLOSE: 9, LAND: 9, NOTE: 3, KIND: 3 };

function checkLanesFieldCounts(root, file, problems) {
  const full = lanesFile(root);
  if (!fs.existsSync(full)) return;
  const text = fs.readFileSync(full, 'utf8');
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const parts = line.split('|').map((p) => p.trim());
    const kind = parts[0];
    const min = RECORD_MIN_FIELDS[kind];
    if (min === undefined) return; // not a recognised record kind — not this check's job
    if (parts.length < min) {
      problems.push({
        file,
        severity: 'error',
        message: `line ${i + 1}: a ${kind} record needs at least ${min} fields, has ${parts.length}: "${line}"`,
      });
    }
  });
}

function checkLanes(root, problems, counts, prefixResult) {
  const file = rel(root, lanesFile(root));
  checkLanesFieldCounts(root, file, problems);

  const lanes = readLanes(root);
  const now = Date.now();
  for (const l of lanes) {
    counts.laneRecordsChecked++;
    if (l.status === 'OPEN') {
      const openedAt = Date.parse(l.opened);
      if (!Number.isNaN(openedAt) && (now - openedAt) / 3_600_000 > ORPHAN_OPEN_HOURS) {
        problems.push({
          file,
          severity: 'warning',
          message: `lane "${l.lane}" is an open lane with no CLOSE record, opened ${l.opened} (over ${ORPHAN_OPEN_HOURS}h ago)`,
        });
      }
    }
  }

  // A CLOSE whose brief was never renamed: every live (unprefixed) brief still sitting on the
  // bridge is checked against the ledger by the same lane-identity logic lane-alloc already uses.
  if (prefixResult?.entries?.length) {
    for (const entry of prefixResult.entries) {
      if (entry.refused || entry.state !== 'live') continue;
      const laneId = laneIdFor(entry.name);
      const verdict = closedUnrenamedVerdict(laneId, lanes);
      if (verdict) {
        problems.push({ file, severity: 'warning', message: `${verdict.headline} (brief: _handoffs/${entry.name})` });
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------- workspace shape

function checkShape(root, problems) {
  const handoffs = path.join(root, '_handoffs');
  if (!fs.existsSync(handoffs)) {
    problems.push({ file: '_handoffs/', severity: 'error', message: '_handoffs/ does not exist — create it at the workspace root before routing anything' });
  } else {
    const lanesDir = path.join(handoffs, '_lanes');
    if (!fs.existsSync(lanesDir)) {
      problems.push({ file: '_handoffs/_lanes/', severity: 'error', message: '_handoffs/_lanes/ does not exist — create it and copy POLICY.md, PREFIXES.md, CLAIMS.md, LANES.md from examples/ into it' });
    } else {
      for (const name of ['POLICY.md', 'PREFIXES.md', 'CLAIMS.md', 'LANES.md']) {
        const p = path.join(lanesDir, name);
        if (!fs.existsSync(p)) {
          problems.push({ file: `_handoffs/_lanes/${name}`, severity: 'error', message: `${name} does not exist — copy it from examples/${name} and edit it for this workspace` });
          continue;
        }
        try {
          fs.accessSync(p, fs.constants.R_OK);
        } catch {
          problems.push({ file: `_handoffs/_lanes/${name}`, severity: 'error', message: `${name} exists but is not readable — check its file permissions` });
        }
      }
    }
  }

  // The workspace root is not the package's own install directory. A repo whose own package.json
  // still carries this tool's own name is a strong signal PANDORAS_ROOT was left unset (or pointed
  // at this checkout) rather than at a real workspace.
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg && pkg.name === PKG_NAME) {
        problems.push({
          file: 'workspace',
          severity: 'error',
          message: `${root} is this package's own install directory (package.json name "${PKG_NAME}") — point PANDORAS_ROOT at your workspace, the folder holding _handoffs/ and your repos, never at this checkout`,
        });
      }
    } catch {
      // an unreadable or unparseable package.json at the workspace root is not this check's concern
    }
  }
}
