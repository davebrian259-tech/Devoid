// The Sapling proving parameters the web wallet needs, fetched once from the Zcash download
// server and kept in .cache/sapling-params/. Every file is checked against the BLAKE2b-512 hash
// zcash_proofs pins (and the engine checks it again in the browser), so a damaged or altered
// download is refused rather than served.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = 'https://download.z.cash/downloads/';
export const PARAMS = {
  'sapling-output.params': { bytes: 3592860, blake2b: '657e3d38dbb5cb5e7dd2970e8b03d69b4787dd907285b5a7f0790dcc8072f60bf593b32cc2d1c030e00ff5ae64bf84c5c3beb84ddc841d48264b4a171744d028' },
  'sapling-spend.params': { bytes: 47958396, blake2b: '8270785a1a0d0bc77196f000ee6d221c9c9894f55307bd9357c3f0105d31ca63991ab91324160d8f53e2bbd3c2633a6eb8bdf5205d822e7f3f73edac51b2b70c' },
};

const valid = (name, bytes) => bytes.length === PARAMS[name].bytes && createHash('blake2b512').update(bytes).digest('hex') === PARAMS[name].blake2b;

/** Returns the bytes of a parameter file, downloading it into `cacheDir` the first time. */
export async function saplingParams(name, cacheDir) {
  const file = join(cacheDir, name);
  if (existsSync(file)) {
    const bytes = readFileSync(file);
    if (valid(name, bytes)) return bytes;
  }
  mkdirSync(cacheDir, { recursive: true });
  const r = await fetch(SOURCE + name);
  if (!r.ok) throw new Error(`Downloading ${name} failed: HTTP ${r.status}`);
  const bytes = Buffer.from(await r.arrayBuffer());
  if (!valid(name, bytes)) throw new Error(`${name} does not match its published hash; refusing to use it.`);
  writeFileSync(`${file}.tmp`, bytes);
  renameSync(`${file}.tmp`, file);
  return bytes;
}
