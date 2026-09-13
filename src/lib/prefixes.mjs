// prefixes.mjs — the bridge filename vocabulary, loaded from _handoffs/_lanes/PREFIXES.md.
//
// THE ONE RULE THIS MODULE ENFORCES: never default an unrecognized name to live.
//
// The vocabulary of lifecycle words on a working bridge always outgrows the list compiled into the
// tool that reads it. Words the tool does not know get read as LIVE, so a closed brief is handed to
// a dispatcher and executed a second time — the same shape as a report overwrite, where two
// sessions do one lane's work because nothing on disk tells the second one it is second.
//
// So the vocabulary is DATA, in PREFIXES.md, and anything outside it is refused rather than
// assumed live.

import fs from 'node:fs';
import path from 'node:path';
import { readTable } from './md-table.mjs';

export function prefixFile(root) {
  return path.join(root, '_handoffs', '_lanes', 'PREFIXES.md');
}

export function loadPrefixes(root) {
  const file = prefixFile(root);
  if (!fs.existsSync(file)) throw new Error(`prefixes: ${file} does not exist — the vocabulary is not loadable, and guessing it is exactly what this module refuses to do`);
  const text = fs.readFileSync(file, 'utf8');
  const rows = readTable(text, 'prefixes').filter((r) => r.token && r.token !== '(none)');
  const denied = new Map(readTable(text, 'denied').map((r) => [r.token.replace(/-$/, '').toLowerCase(), r.why || r['why it is refused'] || '']));

  const prefixes = rows.filter((r) => r.match === 'prefix').map(norm);
  const tokens = rows.filter((r) => r.match === 'token').map(norm);
  const bad = rows.filter((r) => r.match !== 'prefix' && r.match !== 'token');
  if (bad.length) throw new Error(`prefixes: match column must be "prefix" or "token"; got "${bad[0].match}" for ${bad[0].token}`);
  return { prefixes, tokens, denied, words: new Set(prefixes.map((p) => p.word).filter(Boolean)) };
}

function norm(r) {
  const raw = r.token;
  return {
    raw,
    word: /^[a-z]+-$/.test(raw) ? raw.slice(0, -1) : null, // only lowercase lifecycle words get near-miss checks
    match: r.match,
    state: r.state,
    routes: r.routes,
    meaning: r.meaning,
  };
}

export function editDistanceAtMostOne(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0, j = 0, slack = 0;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i++; j++; continue; }
    if (++slack > 1) return false;
    if (s.length === l.length) { i++; j++; } else { j++; }
  }
  return slack + (l.length - j) + (s.length - i) <= 1;
}

/**
 * Classify one bridge filename.
 * @returns {{name:string, state:string, routes:string, token:string|null, refused:boolean, reason:string|null, meant:string|null}}
 */
export function classify(name, vocab) {
  const lead = name.split('-')[0];

  // Furniture first: `_` is a prefix on a name with no hyphen boundary.
  for (const p of vocab.prefixes) {
    if (p.raw === '_') continue;
    if (name.startsWith(p.raw)) return hit(name, p);
  }
  if (name.startsWith('_')) {
    const p = vocab.prefixes.find((x) => x.raw === '_');
    if (p) return hit(name, p);
  }
  for (const t of vocab.tokens) {
    if (name.split(/[-.]/).includes(t.raw)) return hit(name, t);
  }

  // Nothing matched. Is the leading token TRYING to be a lifecycle word?
  const lower = lead.toLowerCase();
  if (lead === lower && /^[a-z]{3,}$/.test(lead)) {
    if (vocab.denied.has(lower))
      return refuse(name, lead, `"${lead}-" is on the denied list: ${vocab.denied.get(lower)}`);
    // Near-miss BEFORE past-tense: most lifecycle words end in `ed`, so testing the participle rule
    // first would swallow every typo of one and answer with the vaguer message.
    for (const w of vocab.words) {
      if (editDistanceAtMostOne(lower, w))
        return refuse(name, lead, `"${lead}-" is one character from "${w}-". A typo in a lifecycle word silently resurrects a closed brief`, `${w}-`);
    }
    if (/ed$/.test(lower))
      return refuse(name, lead, `"${lead}-" is a past participle and is not in the vocabulary — every lifecycle word anyone reaches for is one, so this is refused rather than guessed at`);
  }
  return { name, state: 'live', routes: 'yes', token: null, refused: false, reason: null, meant: null };
}

function hit(name, p) {
  return { name, state: p.state, routes: p.routes, token: p.raw, refused: false, reason: null, meant: null };
}
function refuse(name, lead, reason, meant = null) {
  return { name, state: 'UNKNOWN-PREFIX', routes: 'no', token: `${lead}-`, refused: true, reason, meant };
}

/** Every .md at the ROOT of _handoffs/, classified. Subdirectories are not the bridge. */
export function classifyBridge(root, vocab) {
  const dir = path.join(root, '_handoffs');
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.md')) continue;
    if (!fs.statSync(path.join(dir, name)).isFile()) continue;
    out.push(classify(name, vocab));
  }
  return out;
}
