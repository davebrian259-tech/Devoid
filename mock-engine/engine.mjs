#!/usr/bin/env node
// Simulated Devoid engine, as a command. Speaks exactly the protocol of the Rust engine (one JSON
// request on stdin, NDJSON on stdout, last line is the result) and keeps its simulated chain in
// <wallet>/mock.json. The simulation itself is in core.mjs, shared with the web app.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createSimEngine } from './core.mjs';

export const SIMULATED = true;

const file = (wallet) => join(String(wallet ?? ''), 'mock.json');
const engine = createSimEngine({
  exists: (wallet) => Boolean(wallet) && existsSync(file(wallet)),
  read: (wallet) => readFileSync(file(wallet), 'utf8'),
  write: (wallet, text) => {
    mkdirSync(wallet, { recursive: true });
    const tmp = `${file(wallet)}.tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, file(wallet));
  },
  random: (n) => Uint8Array.from(randomBytes(n)),
});

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

async function main() {
  const arg = process.argv[2];
  let req;
  if (arg === 'version' || arg === '--version') req = { cmd: 'version' };
  else if (arg === 'selftest') req = { cmd: 'selftest' };
  else {
    let buf = '';
    for await (const chunk of process.stdin) buf += chunk;
    try { req = JSON.parse(buf); } catch { out({ ok: false, error: { code: 'bad_request', message: 'The request is not valid JSON.', details: null } }); process.exit(1); }
  }
  const res = engine.run(req, out);
  out(res);
  if (!res.ok) process.exit(1);
}
main();
