// naming-test.mjs — the fixture suite for the one rule lib/naming.mjs had no word for:
// a leading date is never a lane name.
//
// No filesystem writes, no git, no network. It throws on failure rather than calling
// process.exit(), so the runner that imports every suite in sequence cannot let one file's exit
// code mask another's red.
//
// THE DEFECT THIS SUITE PINS. `laneIdFor()` looks for a word carrying a digit (`ceiling1`, `l2`)
// and falls back to the first two words of the filename when it finds none. A brief named
// `2026-09-09-web-mothball-the-uptime-schedule.md` carries no such word anywhere, so the fallback
// ran with the date still at the front of the stem and returned `2026-09`. A second brief filed the
// same month — `2026-09-09-api-daily-sync-goes-weekly.md` — fell into the same fallback the same
// way and got the same lane id. Two unrelated lanes, one identifier: the close matches a brief
// filename by lane id as a whole token, so one lane's close could rename the other lane's brief,
// and the landing record could name the wrong brief.
//
// A DATE IS RECOGNISED ONLY AT THE FRONT. `Transcripts-SYNC-2026-09-12-catch-up.md` carries a date
// in the middle of its name and must keep deriving from `Transcripts-SYNC` exactly as before. This
// is not "strip any date anywhere", which would be a second and sloppier defect.

import assert from 'node:assert/strict';
import { laneIdFor, slugFor } from '../src/lib/naming.mjs';

const tests = [];
const T = (name, fn) => tests.push({ name, fn });

/** Anything that reads as a bare date fragment: `2026`, `2026-09`, `2026-09-09`. */
const DATE_FRAGMENT = /^\d{4}(-\d{2}){0,2}$/;

// ---------------------------------------------------------------- laneIdFor: the red cases

T('RED-PROOF naming: two unrelated date-prefixed briefs filed the same month derive DIFFERENT lane '
  + 'ids — both once fell to the first-two-words fallback and both read 2026-09', () => {
  const a = laneIdFor('2026-09-09-web-mothball-the-uptime-schedule.md');
  const b = laneIdFor('2026-09-09-api-daily-sync-goes-weekly.md');
  assert.notEqual(a, b, `both filenames derived the lane id "${a}" — a date is not a lane name`);
  assert.notEqual(a, '2026-09');
  assert.notEqual(b, '2026-09');
});

T('RED-PROOF naming: neither date-prefixed lane id is itself a date fragment', () => {
  for (const f of ['2026-09-09-web-mothball-the-uptime-schedule.md', '2026-09-09-api-daily-sync-goes-weekly.md']) {
    const id = laneIdFor(f);
    assert.equal(DATE_FRAGMENT.test(id), false, `"${f}" derived "${id}", which reads as a date`);
  }
});

T('RED-PROOF naming: a bare YYYY-MM prefix with no day is skipped the same way as a full date', () => {
  const id = laneIdFor('2026-09-status-update-for-the-board.md');
  assert.equal(DATE_FRAGMENT.test(id), false, `"${id}" reads as a date`);
  assert.equal(id, 'status-update');
});

// ---------------------------------------------------------------- only a LEADING date

T('naming: a date in the MIDDLE of the filename is left exactly alone', () => {
  assert.equal(laneIdFor('Transcripts-SYNC-2026-09-12-catch-up.md'), 'transcripts-sync');
  // The slug keeps the mid-filename date verbatim, exactly as it did before this rule existed.
  assert.equal(slugFor('Transcripts-SYNC-2026-09-12-catch-up.md'), 'sync-2026-09');
});

// ---------------------------------------------------------------- existing behaviour, unchanged

T('naming: filenames with no leading date derive exactly what they always did', () => {
  assert.equal(laneIdFor('Web-CEILING1-Raise-It-Per-Provider.md'), 'ceiling1');
  assert.equal(laneIdFor('Catalogue-L1-Decision-Queue.md'), 'catalogue-l1');
  assert.equal(laneIdFor('Backup-L2-Keyring-Secret-Injection.md'), 'backup-l2');
  assert.equal(laneIdFor('CHI1-Lanes-That-Run.md'), 'chi1');
});

T('naming: a date-prefixed brief that DOES carry a codename still finds it, date or no date', () => {
  assert.equal(laneIdFor('partial-2026-08-20-web-fact3-get-the-checker.md'), 'fact3');
  assert.equal(laneIdFor('2026-08-20-web-fact3-get-the-checker.md'), 'fact3');
});

// ---------------------------------------------------------------- slugFor, the same rule

T('RED-PROOF naming: the branch slug of a date-prefixed brief never starts with the date', () => {
  const a = slugFor('2026-09-09-web-mothball-the-uptime-schedule.md');
  const b = slugFor('2026-09-09-api-daily-sync-goes-weekly.md');
  assert.equal(/^\d/.test(a), false, `slug "${a}" starts with a date digit`);
  assert.equal(/^\d/.test(b), false, `slug "${b}" starts with a date digit`);
  assert.notEqual(a, b);
});

T('naming: slugs of filenames with no leading date are unchanged', () => {
  assert.equal(slugFor('Web-EPSILON1-Make-Production-Match.md'), 'make-production-match');
});

// ---------------------------------------------------------------- run

let pass = 0;
const fails = [];
for (const t of tests) {
  try { t.fn(); pass++; } catch (e) { fails.push({ name: t.name, message: e.message }); }
}
for (const f of fails) console.log(`FAIL  ${f.name}\n      ${String(f.message).split('\n')[0]}`);
console.log(`NAMING UNIT ASSERTIONS  ${pass}/${tests.length} pass, ${fails.length} fail`);
console.log('  4 of them are RED-PROOF: each feeds a filename that once derived a date as its lane name.');
if (fails.length) {
  throw new Error(`naming-test.mjs: ${fails.length}/${tests.length} assertion(s) failed — see FAIL lines above.`);
}
