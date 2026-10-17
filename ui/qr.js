// Minimal QR Code encoder (byte mode, versions 1-40, error correction L/M/Q/H).
// Based on the algorithm in ISO/IEC 18004; verified against an independent decoder in the test suite.
const ECC = { L: [0, 1], M: [1, 0], Q: [2, 3], H: [3, 2] };
const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const getBit = (x, i) => ((x >>> i) & 1) !== 0;

function numRawDataModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}
const numDataCodewords = (ver, e) => Math.floor(numRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[e][ver] * NUM_ERROR_CORRECTION_BLOCKS[e][ver];

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}
function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
  }
  return result;
}
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

export function encodeQr(text, ecl = 'M', forceMask = -1) {
  const bytes = [...new TextEncoder().encode(text)];
  const [eclIdx, eclFormat] = ECC[ecl];
  let ver = 1; let dataBits = 0;
  for (; ; ver++) {
    if (ver > 40) throw new Error('Too much data for a QR code');
    const cap = numDataCodewords(ver, eclIdx) * 8;
    dataBits = 4 + (ver < 10 ? 8 : 16) + bytes.length * 8;
    if (dataBits <= cap) break;
  }
  const bits = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(0x4, 4); put(bytes.length, ver < 10 ? 8 : 16);
  bytes.forEach((b) => put(b, 8));
  const cap = numDataCodewords(ver, eclIdx) * 8;
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));

  // Split into blocks, add error correction, interleave.
  const nb = NUM_ERROR_CORRECTION_BLOCKS[eclIdx][ver]; const bl = ECC_CODEWORDS_PER_BLOCK[eclIdx][ver];
  const raw = Math.floor(numRawDataModules(ver) / 8);
  const numShort = nb - (raw % nb); const shortLen = Math.floor(raw / nb);
  const blocks = []; const div = rsDivisor(bl);
  for (let i = 0, k = 0; i < nb; i++) {
    const d = data.slice(k, k + shortLen - bl + (i < numShort ? 0 : 1)); k += d.length;
    const ecc = rsRemainder(d, div);
    if (i < numShort) d.push(0);
    blocks.push(d.concat(ecc));
  }
  const all = [];
  for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - bl || j >= numShort) all.push(b[i]); });

  // Matrix
  const size = ver * 4 + 17;
  const mod = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, d) => { mod[y][x] = d; fn[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy)); const x = cx + dx; const y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const apos = [];
  if (ver > 1) {
    const n = Math.floor(ver / 7) + 2;
    const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    const a = [6]; for (let p = size - 7; a.length < n; p -= step) a.splice(1, 0, p);
    a.forEach((x, i) => a.forEach((y, j) => { if (!((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0))) apos.push([x, y]); }));
  }
  apos.forEach(([cx, cy]) => { for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1); });

  const drawFormat = (mask) => {
    const d = (eclFormat << 3) | mask; let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const f = ((d << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) set(8, i, getBit(f, i));
    set(8, 7, getBit(f, 6)); set(8, 8, getBit(f, 7)); set(7, 8, getBit(f, 8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, getBit(f, i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, getBit(f, i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, getBit(f, i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const v = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = getBit(v, i); const a = size - 11 + (i % 3); const b = Math.floor(i / 3);
      set(a, b, bit); set(b, a, bit);
    }
  }

  // Place data
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j; const upward = ((right + 1) & 2) === 0; const y = upward ? size - 1 - vert : vert;
      if (!fn[y][x] && i < all.length * 8) { mod[y][x] = getBit(all[i >>> 3], 7 - (i & 7)); i++; }
    }
  }

  const applyMask = (m) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const inv = [(x + y) % 2 === 0, y % 2 === 0, x % 3 === 0, (x + y) % 3 === 0, (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, ((x * y) % 2) + ((x * y) % 3) === 0, (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (((x + y) % 2) + ((x * y) % 3)) % 2 === 0][m];
      if (!fn[y][x] && inv) mod[y][x] = !mod[y][x];
    }
  };
  const penalty = () => {
    let r = 0;
    const lines = [];
    for (let a = 0; a < size; a++) {
      lines.push(mod[a].map((c) => (c ? '1' : '0')).join(''));
      lines.push(mod.map((row) => (row[a] ? '1' : '0')).join(''));
    }
    for (const line of lines) {
      const runs = line.match(/0+|1+/g);
      for (const run of runs) if (run.length >= 5) r += run.length - 2;
      for (let k = 0; k + 11 <= line.length; k++) {
        const w = line.slice(k, k + 11);
        if (w === '10111010000' || w === '00001011101') r += 40;
      }
    }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) { const c = mod[y][x]; if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) r += 3; }
    let dark = 0; mod.forEach((row) => row.forEach((c) => { if (c) dark++; }));
    r += (Math.ceil(Math.abs(dark * 20 - size * size * 10) / (size * size * 10)) - 1) * 10;
    return r;
  };
  let best = 0; let bestPen = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m); drawFormat(m); const p = penalty(); if (p < bestPen) { best = m; bestPen = p; }
    applyMask(m);
  }
  if (forceMask >= 0) best = forceMask;
  applyMask(best); drawFormat(best);
  return { size, modules: mod, version: ver };
}

/** Returns an SVG string (only numbers and path data; safe to insert as markup). */
export function qrSvgPath(text, ecl = 'M') {
  const { size, modules } = encodeQr(text, ecl);
  let d = '';
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (modules[y][x]) d += `M${x + 4},${y + 4}h1v1h-1z`;
  return { size: size + 8, d };
}
