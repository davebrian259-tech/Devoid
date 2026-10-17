#!/usr/bin/env node
// Regenerates test/fixtures/zcash-vectors.json from a librustzcash checkout.
//
//   node scripts/gen-vectors.mjs /path/to/librustzcash
//
// The vectors are Zcash's own (zcash-test-vectors for Unified Addresses and F4Jumble, and
// zcash/zcash's base58_keys_valid.json for transparent addresses), so the address validator is
// checked against the reference implementation's data rather than against itself.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2];
if (!root) {
  console.error('usage: node scripts/gen-vectors.mjs /path/to/librustzcash');
  process.exit(2);
}
const read = (p) => readFileSync(join(root, p), 'utf8');
const hexOf = (text) => (text.match(/0x[0-9a-fA-F]{2}/g) ?? []).map((h) => h.slice(2).toLowerCase()).join('');

// --- Unified Address vectors -------------------------------------------------------------------
const uaSrc = read('components/zcash_address/src/kind/unified/address/test_vectors.rs');
const uaBlocks = uaSrc.split(/\n\s*TestVector \{/).slice(1);
const field = (block, name) => {
  const m = new RegExp(`${name}:\\s*(None|Some\\((?:\\[|&\\[)?([\\s\\S]*?)(?:\\]\\))?,?\\s*\\n?\\s*[a-z_]+:)`).exec(block);
  return m;
};
const unified = uaBlocks.map((block) => {
  const grab = (name) => {
    const re = new RegExp(`${name}:\\s*(None|Some\\()`);
    const m = re.exec(block);
    if (!m || m[1] === 'None') return null;
    const start = m.index + m[0].length;
    const end = block.indexOf(']', start);
    return hexOf(block.slice(start, end));
  };
  const typecode = /unknown_typecode:\s*Some\((\d+)\)/.exec(block);
  const addr = /unified_addr:\s*"([^"]+)"/.exec(block);
  return {
    p2pkh: grab('p2pkh_bytes'),
    p2sh: grab('p2sh_bytes'),
    sapling: grab('sapling_raw_addr'),
    orchard: grab('orchard_raw_addr'),
    unknownTypecode: typecode ? Number(typecode[1]) : null,
    unknownBytes: grab('unknown_bytes'),
    address: addr[1],
  };
});
void field;

// --- F4Jumble vectors (skip the 16 KB ones to keep the fixture small) ----------------------------
const fjSrc = read('components/f4jumble/src/test_vectors.rs');
const f4 = [...fjSrc.matchAll(/normal:\s*&\[([\s\S]*?)\],\s*jumbled:\s*&\[([\s\S]*?)\],/g)]
  .map((m) => ({ normal: hexOf(m[1]), jumbled: hexOf(m[2]) }))
  .filter((v) => v.normal.length / 2 <= 600);

// --- Transparent addresses (zcash/zcash base58_keys_valid.json, public-key entries only) --------
const tSrc = read('zcash_keys/src/keys/transparent/test_vectors.rs');
const transparent = [...tSrc.matchAll(/base58_encoding:\s*"([^"]+)",\s*raw_bytes_hex:\s*"([^"]+)",\s*kind:\s*VectorKind::(Pubkey|Privkey \{[^}]*\}),\s*network:\s*NetworkType::(\w+)/g)]
  .map((m) => ({ encoding: m[1], hex: m[2], kind: m[3].startsWith('Pubkey') ? 'pubkey' : 'privkey', network: m[4].toLowerCase() }));

const out = { source: 'librustzcash components + zcash_keys test vectors', unified, f4jumble: f4, transparent };
const dest = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'zcash-vectors.json');
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, `${JSON.stringify(out, null, 1)}\n`);
console.log(`unified=${unified.length} f4jumble=${f4.length} transparent=${transparent.length} -> ${dest}`);
