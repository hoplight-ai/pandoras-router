#!/usr/bin/env node
// @ts-check
// typecheck.mjs — runs the TypeScript checker over the JSDoc already in src/, hooks/ and test/.
//
//   npm run typecheck
//
// WHERE THE COMPILER COMES FROM, AND WHY IT IS NOT FETCHED HERE. This used to run inside
// `npx --yes --package=typescript@... --package=@types/node@...`, which resolved and downloaded
// two packages from the registry on every clean machine, with install scripts enabled and with no
// lockfile recording what had been resolved the last time. `npm test` on a fresh clone therefore
// executed whatever the registry served that minute. The compiler is now an ordinary
// devDependency pinned to an exact version, recorded with its integrity hash in the committed
// `package-lock.json`, and installed by `npm ci --ignore-scripts`. Nothing is fetched at test time.
//
// The checker and Node's type declarations are looked for in this repository's own
// `node_modules` first. PATH is only a fallback, for the case where the checkout is nested inside
// another install that hoisted them; it is never a reason to check against whatever TypeScript
// happens to be on the machine, because the version is pinned in both places. With neither
// present the run says what to type and exits red rather than skipping the check.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @param {string} nm @returns {boolean} */
const holdsBoth = (nm) => fs.existsSync(path.join(nm, 'typescript', 'bin', 'tsc'))
  && fs.existsSync(path.join(nm, '@types', 'node', 'package.json'));

const local = path.join(REPO, 'node_modules');
const fromPath = (process.env.PATH || '')
  .split(path.delimiter)
  .filter(Boolean)
  .map((bin) => path.dirname(bin))
  .find((nm) => path.basename(nm) === 'node_modules' && holdsBoth(nm));

const modules = holdsBoth(local) ? local : fromPath;

if (!modules) {
  console.error('typecheck: the pinned compiler is not installed. Run `npm ci --ignore-scripts` in this checkout first, then `npm run typecheck`.');
  process.exit(1);
}

const tsc = path.join(modules, 'typescript', 'bin', 'tsc');
const r = spawnSync(process.execPath, [
  tsc, '-p', path.join(REPO, 'tsconfig.json'),
  '--typeRoots', path.join(modules, '@types'),
  '--types', 'node',
  // Anything after `npm run typecheck --` goes to the compiler, e.g. `-- --strict` to count what
  // strict mode would add.
  ...process.argv.slice(2),
], { stdio: 'inherit' });
if (r.error) console.error(`typecheck: ${r.error.message}`);
process.exit(r.status ?? 1);
