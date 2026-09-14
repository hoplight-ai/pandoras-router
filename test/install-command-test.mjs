// install-command-test.mjs — `open --install` runs npm ci the same way the build gate runs npm:
// npm's own script through Node, no shell, so it works on Windows where npm is npm.cmd.
import assert from 'node:assert/strict';
import { installCommand } from '../src/bin/lane-open.mjs';

const tests = [];
const T = (name, fn) => tests.push({ name, fn });

T('RED-PROOF on Windows, npm ci runs npm-cli.js through node, never the bare npm name', () => {
  const cmd = installCommand({ env: {}, execPath: 'C:\\node\\node.exe', platform: 'win32', exists: (p) => p.endsWith('npm-cli.js') });
  assert.equal(cmd.command, 'C:\\node\\node.exe');
  assert.deepEqual(cmd.args, ['C:\\node\\node_modules\\npm\\bin\\npm-cli.js', 'ci']);
});

T('RED-PROOF on Windows with no npm found, there is no command and every place looked is named', () => {
  const cmd = installCommand({ env: {}, execPath: 'C:\\node\\node.exe', platform: 'win32', exists: () => false });
  assert.equal(cmd.command, null);
  assert.ok(cmd.tried.length > 0, 'the places looked are not named');
});

T('on POSIX with npm_execpath set, npm ci runs that script through node', () => {
  const cmd = installCommand({ env: { npm_execpath: '/opt/npm/bin/npm-cli.js' }, execPath: '/usr/bin/node', platform: 'linux', exists: () => true });
  assert.equal(cmd.command, '/usr/bin/node');
  assert.deepEqual(cmd.args, ['/opt/npm/bin/npm-cli.js', 'ci']);
});

let fails = 0;
for (const t of tests) {
  try { await t.fn(); } catch (e) { fails++; console.log(`FAIL  ${t.name}\n      ${String(e.message).split('\n')[0]}`); }
}
console.log(`INSTALL COMMAND ASSERTIONS  ${tests.length - fails}/${tests.length} pass, ${fails} fail`);
console.log(`  2 of them are RED-PROOF: each asserts the Windows install never falls back to a bare npm a shell would be needed for.`);
if (fails) throw new Error(`install-command-test.mjs: ${fails}/${tests.length} assertion(s) failed.`);
