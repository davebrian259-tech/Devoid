#!/usr/bin/env node
// Test runner. Runs every `*.test.mjs` under test/ through node:test, one process, so a single
// command (`npm test`) covers unit tests, simulated-engine contract tests and API tests.
//
//   node scripts/test.mjs            run everything
//   node scripts/test.mjs address    run files whose name contains "address"
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const testDir = join(root, 'test');
const filter = process.argv.slice(2).filter((a) => !a.startsWith('-'));

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.test.mjs')) out.push(p);
  }
  return out;
}

const files = walk(testDir)
  .filter((f) => filter.length === 0 || filter.some((x) => relative(testDir, f).includes(x)))
  .sort();

if (files.length === 0) {
  console.error('no test files matched');
  process.exit(1);
}

const res = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, NODE_NO_WARNINGS: '1' },
});
process.exit(res.status ?? 1);
