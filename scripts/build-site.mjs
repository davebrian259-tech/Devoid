#!/usr/bin/env node
// Builds what Cloudflare serves into dist/: the product page (site/) at the root, and the web
// version of the wallet at /app. The web app is the same UI as the desktop app, marked with
// <meta name="devoid-backend" content="web"> so it runs the request core and the simulated engine
// in the page instead of calling a local server. Those shared modules are copied under /app/lib
// with .mjs renamed to .js, so every host serves them with a JavaScript content type.
//
//   node scripts/build-site.mjs [outDir]     (default: dist)
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, process.argv[2] ?? 'dist');
const APP = join(OUT, 'app');

const toJs = (src) => src.replace(/(from\s+'\.{1,2}\/[^']+)\.mjs'/g, "$1.js'");

rmSync(OUT, { recursive: true, force: true });
cpSync(join(ROOT, 'site'), OUT, { recursive: true });
cpSync(join(ROOT, 'ui'), APP, { recursive: true });

// The shared modules the web backend imports, keeping their relative layout.
const modules = [['server/core.mjs'], ['mock-engine/core.mjs'], ...readdirSync(join(ROOT, 'server/batch')).filter((f) => f.endsWith('.mjs')).map((f) => [`server/batch/${f}`])];
for (const [rel] of modules) {
  const dest = join(APP, 'lib', rel.replace(/\.mjs$/, '.js'));
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, toJs(readFileSync(join(ROOT, rel), 'utf8')));
}
const backend = join(APP, 'local/backend.js');
writeFileSync(backend, toJs(readFileSync(backend, 'utf8')).replaceAll("from '../../server/", "from '../lib/server/").replaceAll("from '../../mock-engine/", "from '../lib/mock-engine/"));

// Mark the page as the web version, and give it a title and description of its own.
const indexPath = join(APP, 'index.html');
let index = readFileSync(indexPath, 'utf8');
const marker = '<meta name="devoid-backend" content="web">';
if (!index.includes('<meta name="referrer"')) throw new Error('ui/index.html changed: cannot place the web marker');
index = index.replace('<meta name="referrer"', `${marker}\n<meta name="referrer"`)
  .replace('<title>Devoid</title>', '<title>Devoid web demo</title>')
  .replace(/<meta name="description" content="[^"]*">/, '<meta name="description" content="Try Devoid in your browser: a testnet demo of private batch payments on Zcash.">');
writeFileSync(indexPath, index);

// Every relative import in the app must resolve to a file in dist, or the page fails to load.
const missing = [];
(function check(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { check(p); continue; }
    if (!p.endsWith('.js')) continue;
    for (const [, spec] of readFileSync(p, 'utf8').matchAll(/(?:from\s+|import\()\s*'(\.{1,2}\/[^']+)'/g)) {
      try { readFileSync(resolve(dirname(p), spec)); } catch { missing.push(`${p.slice(OUT.length + 1)} -> ${spec}`); }
    }
  }
})(APP);
if (missing.length) { console.error(`Unresolved imports:\n  ${missing.join('\n  ')}`); process.exit(1); }

console.log(`Built ${OUT.slice(ROOT.length + 1) || OUT}: site at /, web app at /app/ (${modules.length} shared modules).`);
