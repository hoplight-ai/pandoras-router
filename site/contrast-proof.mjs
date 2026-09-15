#!/usr/bin/env node
// Reads the colour tokens out of style.css and measures every foreground against the two grounds
// it is actually painted on, in both modes. WCAG 2.2 AA: 4.5:1 for text, 3:1 for lines and marks.
// Run: node site/contrast-proof.mjs
// Exits 1 and names every pair that misses its floor.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const css = await readFile(join(here, 'style.css'), 'utf8');

/** Pull one block's custom properties. `after` anchors the search past earlier blocks. */
function tokens(selector) {
  const at = css.indexOf(selector);
  if (at < 0) throw new Error(`selector not found in style.css: ${selector}`);
  const open = css.indexOf('{', at);
  const body = css.slice(open + 1, css.indexOf('}', open));
  const out = {};
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*--([a-z-]+):\s*(#[0-9A-Fa-f]{6})\s*;/);
    if (m) out[m[1]] = m[2].toUpperCase();
  }
  return out;
}

const light = tokens(':root {');
const dark = tokens(':root[data-theme="dark"] {');

const channels = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const linear = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const luminance = (h) => { const [r, g, b] = channels(h); return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b); };
const ratio = (a, b) => {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/** [what is painted, token, ground token, floor] */
const pairs = [
  ['body text on the page', 'ink', 'paper', 4.5],
  ['body text on the panel', 'ink', 'panel', 4.5],
  ['secondary text on the page', 'muted', 'paper', 4.5],
  ['secondary text on the panel', 'muted', 'panel', 4.5],
  ['stage note in the drawing', 'muted', 'panel', 4.5],
  ['link and gate text on the page', 'accent-ink', 'paper', 4.5],
  ['pass text in the drawing', 'accent-ink', 'panel', 4.5],
  ['refusal text on the page', 'refuse', 'paper', 4.5],
  ['refusal text in the drawing', 'refuse', 'panel', 4.5],
  ['filled button text', 'paper', 'ink', 4.5],
  ['code block text', 'code-fg', 'code-bg', 4.5],
  ['the spine line', 'accent-ink', 'panel', 3],
  ['the stage node ring', 'accent-ink', 'panel', 3],
  ['a refusal branch line', 'refuse', 'panel', 3],
  ['the terminal node', 'ink', 'panel', 3],
  ['the focus ring on the page', 'accent-ink', 'paper', 3],
];

const rows = [];
let failures = 0;
for (const [mode, set] of [['light', light], ['dark', dark]]) {
  for (const [what, fg, bg, floor] of pairs) {
    if (!set[fg] || !set[bg]) throw new Error(`missing token ${fg} or ${bg} in ${mode}`);
    const r = ratio(set[fg], set[bg]);
    const ok = r >= floor;
    if (!ok) failures++;
    rows.push({ mode, what, fg: set[fg], bg: set[bg], ratio: r.toFixed(2), floor, ok });
  }
}

// The two colours that carry refusal and pass must stay apart from each other as well as from
// their ground, so the drawing does not depend on hue alone. Position and wording carry the
// meaning too: a refusal branches off the spine and ends, a pass sits on it.
for (const [mode, set] of [['light', light], ['dark', dark]]) {
  const r = ratio(set.refuse, set['accent-ink']);
  const ok = r >= 1.5;
  if (!ok) failures++;
  rows.push({ mode, what: 'refusal red against the gold', fg: set.refuse, bg: set['accent-ink'], ratio: r.toFixed(2), floor: 1.5, ok });
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad('mode', 6)} ${pad('what is painted', 34)} ${pad('colour', 9)} ${pad('ground', 9)} ${pad('ratio', 7)} ${pad('floor', 6)} verdict`);
for (const r of rows) {
  console.log(`${pad(r.mode, 6)} ${pad(r.what, 34)} ${pad(r.fg, 9)} ${pad(r.bg, 9)} ${pad(r.ratio, 7)} ${pad(r.floor, 6)} ${r.ok ? 'clears' : 'MISSES'}`);
}
console.log(`\n${rows.length} pairs measured, ${failures} below floor.`);
process.exit(failures === 0 ? 0 : 1);
