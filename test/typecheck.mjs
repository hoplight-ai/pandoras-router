#!/usr/bin/env node
// @ts-check
// typecheck.mjs — runs the TypeScript checker over the JSDoc already in src/, hooks/ and test/.
//
//   npm run typecheck
//
// The package keeps zero dependencies. `npm run typecheck` asks npx for two exact pinned packages,
// the compiler and Node's type declarations, and runs this file inside that npx environment. npx
// puts its own node_modules/.bin first on PATH, so the folder that holds both packages is found
// from PATH here and handed to the compiler as the one place to read type declarations from.
// Run directly with plain `node`, outside npx, it says so and exits red rather than checking
// against whatever TypeScript happens to be installed on the machine.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const entries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
const modules = entries
  .map((bin) => path.dirname(bin))
  .find((nm) => path.basename(nm) === 'node_modules'
    && fs.existsSync(path.join(nm, 'typescript', 'bin', 'tsc'))
    && fs.existsSync(path.join(nm, '@types', 'node', 'package.json')));

if (!modules) {
  console.error('typecheck: run it as `npm run typecheck`; the compiler and Node types come from npx at pinned versions.');
  process.exit(1);
}

const tsc = path.join(modules, 'typescript', 'bin', 'tsc');
const r = spawnSync(process.execPath, [
  tsc, '-p', 'tsconfig.json',
  '--typeRoots', path.join(modules, '@types'),
  '--types', 'node',
  // Anything after `npm run typecheck --` goes to the compiler, e.g. `-- --strict` to count what
  // strict mode would add.
  ...process.argv.slice(2),
], { stdio: 'inherit' });
if (r.error) console.error(`typecheck: ${r.error.message}`);
process.exit(r.status ?? 1);
