#!/usr/bin/env node
// gate-matrix-test.mjs: keeps docs/gates.json honest against the close driver.
//
//   node test/gate-matrix-test.mjs
//
// ── WHY A TEST AND NOT A README PARAGRAPH ─────────────────────────────────────────────────────
// Three blind reviewers each rebuilt the same table of which gates run, which are only recorded,
// and which values each can write. Every answer was in a code comment and none was where a reader
// starts. docs/gates.json is that table, written once. This file is what stops it drifting: a gate
// added to the driver, a verdict word that appears or disappears, a ledger column renamed, or a
// test file moved turns the suite red instead of leaving the matrix quietly wrong.
//
// Three families of assertion, matching the brief that produced the matrix:
//   1. every `column` names a real CLOSE-row field in src/lib/lanes.mjs;
//   2. every `tested_in` file exists on disk;
//   3. every `verdicts` set equals the literal verdict strings the named source can write.
// Plus the shape checks that make the other three meaningful (enum values, the driver's own print
// list, the grader's own row list), and a reverse check: every gate-value column the ledger holds
// has a row in the matrix, so a new column cannot arrive unnamed.

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const matrix = JSON.parse(read('docs/gates.json'));
const lanesSrc = read('src/lib/lanes.mjs');
const binSrc = read('src/bin/close.mjs');
const libSrc = read('src/lib/close.mjs');

const tests = [];
const T = (name, fn) => tests.push({ name, fn });

// ── source slicing ────────────────────────────────────────────────────────────────────────────
// Each `source` entry names a region of a file. The verdict words are read from that region only,
// so a `'no'` written by a neighbouring gate in the same file cannot be counted for this one.

const VERDICT_RE = /'(yes|no|skip|skipped|n\/a|exempt|-)'/g;

function sliceFunction(text, name, where) {
  const m = new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm').exec(text);
  assert.ok(m, `${where}: no top-level function named ${name}`);
  const end = text.indexOf('\n}\n', m.index);
  assert.ok(end > m.index, `${where}: function ${name} has no top-level closing brace`);
  return text.slice(m.index, end + 2);
}

function sliceConst(text, name, where) {
  const m = new RegExp(`^export const ${name}\\b.*$`, 'm').exec(text);
  assert.ok(m, `${where}: no exported constant named ${name}`);
  return m[0];
}

function sliceBetween(text, [start, end], where) {
  const a = text.indexOf(start);
  assert.ok(a >= 0, `${where}: start marker not found: ${start}`);
  const b = text.indexOf(end, a + start.length);
  assert.ok(b > a, `${where}: end marker not found after start: ${end}`);
  return text.slice(a, b);
}

function sliceLines(text, needle, where) {
  const lines = text.split('\n').filter((l) => l.includes(needle));
  assert.ok(lines.length > 0, `${where}: no line contains ${needle}`);
  return lines.join('\n');
}

function regionFor(src, where) {
  const text = read(src.file);
  if (src.function) return sliceFunction(text, src.function, `${where} ${src.file}`);
  if (src.const) return sliceConst(text, src.const, `${where} ${src.file}`);
  if (src.between) return sliceBetween(text, src.between, `${where} ${src.file}`);
  if (src.line_contains) return sliceLines(text, src.line_contains, `${where} ${src.file}`);
  throw new Error(`${where}: source entry has no recognised form: ${JSON.stringify(src)}`);
}

function wordsIn(region) {
  const out = new Set();
  for (const m of region.matchAll(VERDICT_RE)) out.add(m[1]);
  return out;
}

// ── the ledger's columns, read from lanes.mjs ─────────────────────────────────────────────────
// The RECORD FORMS comment names the fields in order. recordClose appends `kind` after roadmap;
// the comment does not list it, so the field is added when the append call is seen to write it.

function ledgerColumns() {
  const line = lanesSrc.split('\n').find((l) => /^\/\/\s+CLOSE\s*\|/.test(l));
  assert.ok(line, 'src/lib/lanes.mjs has no RECORD FORMS comment line starting with CLOSE |');
  const cols = line.replace(/^\/\/\s+/, '').split('|').map((s) => s.trim()).filter(Boolean).slice(1);
  const rc = sliceFunction(lanesSrc, 'recordClose', 'lanes');
  if (/r\.kind\s*\?\?\s*'-'/.test(rc)) cols.push('kind');
  return cols;
}

const COLUMNS = ledgerColumns();
const gates = matrix.gates;
const byName = new Map(gates.map((g) => [g.name, g]));

// ── 0. shape ──────────────────────────────────────────────────────────────────────────────────

T('matrix: every row carries the eight required fields and a source list', () => {
  const required = ['name', 'column', 'enforced_by', 'verdicts', 'external_dependency', 'tested_in', 'what_it_proves', 'what_it_does_not_prove', 'source'];
  for (const g of gates) {
    for (const k of required) assert.ok(k in g, `${g.name ?? '?'}: missing field ${k}`);
    assert.ok(Array.isArray(g.source) && g.source.length > 0, `${g.name}: source must name at least one region`);
    assert.ok(typeof g.what_it_proves === 'string' && g.what_it_proves.length > 20, `${g.name}: what_it_proves is not a sentence`);
    assert.ok(typeof g.what_it_does_not_prove === 'string' && g.what_it_does_not_prove.length > 20, `${g.name}: what_it_does_not_prove is not a sentence`);
  }
});

T('matrix: gate names are unique and enum fields hold declared values only', () => {
  assert.equal(new Set(gates.map((g) => g.name)).size, gates.length, 'duplicate gate name');
  for (const g of gates) {
    assert.ok(matrix.schema.enforced_by.includes(g.enforced_by), `${g.name}: enforced_by ${g.enforced_by}`);
    assert.ok(matrix.schema.external_dependency.includes(g.external_dependency), `${g.name}: external_dependency ${g.external_dependency}`);
    for (const v of g.verdicts) assert.ok(matrix.schema.verdict_words.includes(v), `${g.name}: verdict word ${v} is not in the schema`);
  }
});

T('matrix: no em dash anywhere in the document a reader starts from', () => {
  assert.ok(!read('docs/gates.json').includes('—'), 'docs/gates.json carries an em dash');
});

// ── 1. columns ────────────────────────────────────────────────────────────────────────────────

T('columns: every non-null column in the matrix is a real CLOSE-row field in src/lib/lanes.mjs', () => {
  for (const g of gates) {
    if (g.column === null) continue;
    assert.ok(COLUMNS.includes(g.column), `${g.name}: column "${g.column}" is not in the CLOSE row (${COLUMNS.join(', ')})`);
  }
});

T('columns: every gate-value column the ledger holds has exactly one matrix row', () => {
  for (const col of matrix.ledger.gate_value_columns) {
    assert.ok(COLUMNS.includes(col), `ledger list names "${col}" but lanes.mjs does not write it`);
    const rows = gates.filter((g) => g.column === col);
    assert.equal(rows.length, 1, `column "${col}" is claimed by ${rows.length} rows`);
  }
});

T('columns: the matrix agrees with lanes.mjs about the comment columns and the appended field', () => {
  const fromComment = COLUMNS.filter((c) => !matrix.ledger.columns_appended_by_recordClose.includes(c));
  assert.deepEqual(fromComment, matrix.ledger.columns_from_comment);
  for (const c of matrix.ledger.columns_appended_by_recordClose) assert.ok(COLUMNS.includes(c), `recordClose no longer appends ${c}`);
});

T('RED-PROOF columns: a row with no ledger column is one the reason text alone carries, and the matrix says so', () => {
  for (const g of gates.filter((x) => x.column === null && x.enforced_by === 'close')) {
    assert.match(g.note ?? '', /No ledger column/, `${g.name}: an enforced gate with no column must say so in its note`);
    const camel = g.name.replace(/-(\w)/g, (_, c) => c.toUpperCase());
    assert.ok(!sliceFunction(lanesSrc, 'recordClose', 'lanes').includes(`r.${camel}`), `${g.name}: recordClose now writes r.${camel}; give this gate a column`);
  }
});

// ── 2. tested_in ──────────────────────────────────────────────────────────────────────────────

T('tested_in: every named test file exists, and "none" is spelled out rather than left blank', () => {
  for (const g of gates) {
    const list = g.tested_in === 'none' ? [] : (Array.isArray(g.tested_in) ? g.tested_in : [g.tested_in]);
    if (g.tested_in !== 'none') assert.ok(list.length > 0, `${g.name}: tested_in is empty; write "none"`);
    for (const f of list) {
      assert.ok(fs.existsSync(path.join(REPO, f)), `${g.name}: tested_in names a file that does not exist: ${f}`);
      assert.ok(f.startsWith('test/') && f.endsWith('-test.mjs'), `${g.name}: ${f} is not a suite test/run.mjs discovers`);
    }
  }
});

T('tested_in: a gate marked none has no exported function to test, and says why in its note', () => {
  for (const g of gates.filter((x) => x.tested_in === 'none')) {
    assert.match(g.note ?? '', /not exported/, `${g.name}: tested_in is none but the note does not explain it`);
    for (const s of g.source) {
      if (!s.function) continue;
      assert.ok(!new RegExp(`^export (?:async )?function ${s.function}\\(`, 'm').test(read(s.file)), `${g.name}: ${s.function} is exported now; it can be tested, so tested_in cannot stay none`);
    }
  }
});

// ── 3. verdicts ───────────────────────────────────────────────────────────────────────────────

T('verdicts: every source region named in the matrix resolves to real text', () => {
  for (const g of gates) for (const s of g.source) assert.ok(regionFor(s, g.name).length > 0, `${g.name}: empty region ${JSON.stringify(s)}`);
});

T('verdicts: for every close and recorded-only gate, the set equals the literals its source can write', () => {
  for (const g of gates.filter((x) => x.enforced_by === 'close' || x.enforced_by === 'recorded-only')) {
    const found = new Set();
    for (const s of g.source) for (const w of wordsIn(regionFor(s, g.name))) found.add(w);
    // src/lib/liveness.mjs writes `skipped`; gateLive in src/bin/close.mjs rewrites it to `skip`
    // before the grader or the ledger sees it. The matrix records what reaches the ledger.
    if (found.has('skipped')) {
      assert.ok(/LIVE_SKIPPED \? 'skip'/.test(sliceFunction(binSrc, 'gateLive', 'bin')), `${g.name}: the skipped-to-skip rewrite in gateLive is gone; the matrix must now list skipped`);
      found.delete('skipped');
      found.add('skip');
    }
    assert.deepEqual([...found].sort(), [...g.verdicts].sort(), `${g.name}: matrix says [${g.verdicts}] but the source writes [${[...found]}]`);
  }
});

T('verdicts: an allocator or open row has an empty set, because its outcome is a card field and not a word', () => {
  for (const g of gates.filter((x) => x.enforced_by === 'alloc' || x.enforced_by === 'open')) {
    assert.deepEqual(g.verdicts, [], `${g.name}: an ${g.enforced_by} row cannot carry ledger verdict words`);
    assert.equal(g.column, null, `${g.name}: an ${g.enforced_by} row has no CLOSE column`);
  }
});

T('RED-PROOF verdicts: skip is never listed as a pass, and every enforced gate that can skip says skip is a failure', () => {
  assert.ok(matrix.schema.fails.includes('skip') && !matrix.schema.passes.includes('skip'));
  assert.ok(/const PASS = new Set\(\['yes', 'n\/a', 'exempt'\]\)/.test(libSrc), 'gradeGates PASS set changed; update docs/gates.json schema.passes');
  assert.deepEqual([...matrix.schema.passes].sort(), ['exempt', 'n/a', 'yes']);
});

// ── the driver and the grader agree with the matrix about which gates exist ──────────────────

T('driver: every gate enforced by close is in the close driver\'s own print list, and nothing else is', () => {
  const printed = [...sliceBetween(binSrc, ['const rows = [', '];'], 'bin').matchAll(/\['([a-z-]+)',/g)].map((m) => m[1]);
  const enforced = gates.filter((g) => g.enforced_by === 'close').map((g) => g.name);
  assert.deepEqual(printed.sort(), enforced.sort(), 'the driver prints a different gate list than the matrix enforces');
});

T('grader: every close and recorded-only gate is a row gradeGates knows by the same name', () => {
  const grader = sliceFunction(libSrc, 'gradeGates', 'lib');
  const known = [...grader.matchAll(/\['([a-z-]+)', g\./g)].map((m) => m[1]);
  for (const g of gates.filter((x) => x.enforced_by === 'close' || x.enforced_by === 'recorded-only')) {
    assert.ok(known.includes(g.name), `${g.name}: gradeGates has no row by that name (it knows ${known.join(', ')})`);
  }
  for (const name of known) assert.ok(byName.has(name), `gradeGates grades "${name}" and the matrix has no row for it`);
});

T('RED-PROOF recorded-only: the driver writes the fixed value the matrix claims, and never a measurement', () => {
  for (const g of gates.filter((x) => x.enforced_by === 'recorded-only')) {
    assert.equal(g.verdicts.length, 1, `${g.name}: a recorded-only gate writes exactly one fixed value`);
    const lit = g.source.find((s) => s.line_contains);
    assert.ok(lit, `${g.name}: a recorded-only row must point at the literal line the driver writes`);
    assert.ok(binSrc.includes(lit.line_contains), `${g.name}: ${lit.line_contains} is no longer in src/bin/close.mjs; the gate may be measured now`);
  }
});

T('refusals: the three close refusals are named in doneReportRefusal and this driver passes doneHonestWarn as false', () => {
  const body = sliceFunction(libSrc, 'doneReportRefusal', 'lib');
  for (const n of matrix.close_refusals.names) assert.ok(body.includes(`'${n}'`), `doneReportRefusal no longer names ${n}`);
  assert.ok(/doneHonestWarn: false/.test(binSrc), 'the driver now supplies doneHonestWarn; update close_refusals.note');
});

T('refusals: the matrix says the refusals are inert here, and the driver\'s call still omits present, which is why', () => {
  // doneReportRefusal returns ok at once unless handed `present: true`. The driver's call does not
  // pass it, so none of the three refusals can fire. When someone fixes the call this goes red, and
  // close_refusals.note and docs/THREAT-MODEL.md must be rewritten to say the refusals are live.
  assert.match(sliceFunction(libSrc, 'doneReportRefusal', 'lib'), /if \(!present\) return \{ ok: true/, 'doneReportRefusal no longer short-circuits on a missing present flag');
  const call = sliceBetween(binSrc, ['refusal = doneReportRefusal({', '});'], 'bin');
  assert.ok(!/\bpresent\b/.test(call), 'the driver now passes present to doneReportRefusal; the refusals can fire, so update close_refusals.note and docs/THREAT-MODEL.md');
  assert.match(matrix.close_refusals.note, /None of the three can fire/);
});

// ── the prose documents point at files that exist ────────────────────────────────────────────
// A hook renamed from .sh to .mjs left three stale paths in these documents once. A path a reader
// cannot open is a claim nobody can check, so every repo path the documents name must exist.

T('docs: every repository path named in docs/ exists on disk', () => {
  const docs = ['docs/gates.json', 'docs/THREAT-MODEL.md', 'docs/DESIGN-NOTES.md', 'docs/LIVENESS.md', 'docs/PRIOR-ART.md'];
  const PATH_RE = /\b(?:src|hooks|test|examples|site|docs)\/[A-Za-z0-9_./-]+\.(?:mjs|sh|html|md|json|example)\b/g;
  for (const d of docs) {
    assert.ok(fs.existsSync(path.join(REPO, d)), `${d} is missing`);
    for (const m of read(d).matchAll(PATH_RE)) {
      assert.ok(fs.existsSync(path.join(REPO, m[0])), `${d} names ${m[0]}, which does not exist`);
    }
  }
});

T('docs: no em dash in any of the prose documents', () => {
  for (const d of ['docs/THREAT-MODEL.md', 'docs/DESIGN-NOTES.md', 'docs/LIVENESS.md', 'docs/PRIOR-ART.md']) {
    assert.ok(!read(d).includes('—'), `${d} carries an em dash`);
  }
});

// ── run ───────────────────────────────────────────────────────────────────────────────────────

let pass = 0;
const fails = [];
for (const t of tests) {
  try { t.fn(); pass++; } catch (e) { fails.push(`${t.name}\n    ${String(e.message).split('\n')[0]}`); }
}
const red = tests.filter((t) => t.name.startsWith('RED-PROOF')).length;
for (const f of fails) console.log(`  FAIL ${f}`);
console.log(`GATE MATRIX ASSERTIONS  ${pass}/${tests.length} pass, ${fails.length} fail`);
console.log(`  ${red} of them are RED-PROOF: each asserts that a weakening (a skip read as a pass, a recorded-only gate quietly measured, a column dropped) turns the suite red.`);
console.log(`  matrix: ${gates.length} rows, ${gates.filter((g) => g.enforced_by === 'close').length} enforced by close, ${gates.filter((g) => g.enforced_by === 'recorded-only').length} recorded-only, ${gates.filter((g) => g.enforced_by === 'alloc').length} alloc, ${gates.filter((g) => g.enforced_by === 'open').length} open.`);
if (fails.length) throw new Error(`gate-matrix-test.mjs: ${fails.length}/${tests.length} assertion(s) failed.`);
