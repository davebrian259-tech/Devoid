#!/usr/bin/env node
// Builds the wallet engine for the browser (web-engine/) and writes it to ui/engine/:
//   devoid_web_engine_bg.wasm  the engine (the same Rust wallet code as engine/)
//   devoid_web_engine.js       its JavaScript bindings, loaded by ui/engine/worker.js
//
// Needs Rust with the wasm32-unknown-unknown target and wasm-bindgen-cli at the version in
// web-engine/Cargo.lock:
//   rustup target add wasm32-unknown-unknown
//   cargo install wasm-bindgen-cli --version <version>
// wasm-opt (binaryen) is used when it is installed; it shrinks the file and is optional.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CRATE = join(ROOT, 'web-engine');
const OUT = join(ROOT, 'ui', 'engine');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const has = (cmd) => { try { execFileSync(cmd, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } };

const lock = readFileSync(join(CRATE, 'Cargo.lock'), 'utf8');
const bindgen = /name = "wasm-bindgen"\nversion = "([^"]+)"/.exec(lock)?.[1];
if (!has('wasm-bindgen')) {
  console.error(`wasm-bindgen is not installed. Run: cargo install wasm-bindgen-cli --version ${bindgen}`);
  process.exit(1);
}
const installed = execFileSync('wasm-bindgen', ['--version'], { encoding: 'utf8' }).trim().split(' ').pop();
if (installed !== bindgen) {
  console.error(`wasm-bindgen ${installed} is installed, but the engine uses ${bindgen}. Run: cargo install wasm-bindgen-cli --version ${bindgen}`);
  process.exit(1);
}

run('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown'], { cwd: CRATE });
const wasm = join(CRATE, 'target', 'wasm32-unknown-unknown', 'release', 'devoid_web_engine.wasm');
run('wasm-bindgen', ['--target', 'web', '--no-typescript', '--out-dir', OUT, wasm]);

const built = join(OUT, 'devoid_web_engine_bg.wasm');
if (has('wasm-opt')) {
  // Speed matters more than size here: proving runs in this code.
  run('wasm-opt', ['-O3', '--enable-bulk-memory', '--enable-nontrapping-float-to-int', '--enable-sign-ext', '--enable-mutable-globals', '-o', built, built]);
} else {
  console.log('wasm-opt is not installed; skipping the optional size optimisation.');
}
console.log(`Built ui/engine/devoid_web_engine_bg.wasm (${(statSync(built).size / 1e6).toFixed(1)} MB).`);
