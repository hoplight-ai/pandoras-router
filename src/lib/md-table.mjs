// md-table.mjs — read a markdown table that is tagged with an HTML comment marker.
//
// WHY A MARKER AND NOT "the first table after the heading". Headings get reworded. A policy file
// that changes meaning because someone improved a sentence is worse than no policy file, so the
// machine-read anchor is invisible to the reader and deliberately ugly:
//
//     <!-- table: repos -->
//
//     | repo | tier | ... |
//     |---|---|---|
//     | web  | 1    | ... |
//
// Column names come from the header row, lowercased and trimmed. Cell values are trimmed and
// stripped of surrounding backticks and bold markers, because a human writing a policy table will
// reach for `code style` and should not have to think about whether that breaks the parser.
//
// A missing marker is an ERROR, never an empty result. Silently reading zero rows out of a policy
// file is how a router ends up with no policy and no complaint.

export function stripCell(s) {
  let t = String(s ?? '').trim();
  // `**bold**` then `` `code` ``, in that order, and only when they wrap the WHOLE cell.
  const bold = t.match(/^\*\*(.*)\*\*$/s);
  if (bold) t = bold[1].trim();
  const code = t.match(/^`(.*)`$/s);
  if (code) t = code[1].trim();
  return t;
}

/**
 * @param {string} text  the whole markdown file
 * @param {string} name  the marker name, e.g. "repos"
 * @returns {Array<Record<string,string>>}
 */
export function readTable(text, name) {
  const marker = new RegExp(`<!--\\s*table:\\s*${name}\\s*-->`, 'i');
  const m = marker.exec(text);
  if (!m) throw new Error(`md-table: no <!-- table: ${name} --> marker found`);
  const lines = text.slice(m.index + m[0].length).split('\n');

  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length || !lines[i].trim().startsWith('|'))
    throw new Error(`md-table: marker "${name}" is not followed by a table`);

  const header = splitRow(lines[i]).map((c) => stripCell(c).toLowerCase());
  i++;
  if (i >= lines.length || !/^\|[\s:|-]+\|$/.test(lines[i].trim()))
    throw new Error(`md-table: table "${name}" has no header separator row`);
  i++;

  const rows = [];
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) break;
    const cells = splitRow(line);
    const rec = {};
    header.forEach((h, k) => {
      rec[h] = stripCell(cells[k] ?? '');
    });
    rec.__line = i;
    rows.push(rec);
  }
  if (!rows.length) throw new Error(`md-table: table "${name}" has a header but no rows`);
  return rows;
}

function splitRow(line) {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return t.split('|');
}
