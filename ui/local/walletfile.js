// The web wallet's file: everything the wallet keeps in this browser, encrypted with its passphrase,
// so it can be opened again in another browser, on another device, or after this one's data is
// cleared. It is not a recovery phrase and never contains one in the clear: the keys inside are
// already age-encrypted with the passphrase, and the whole file is encrypted again here
// (PBKDF2-SHA-256, 600,000 rounds, then AES-256-GCM), because the wallet database holds the
// viewing keys and the payment history.
const FORMAT = 'devoid-wallet-file';
const ROUNDS = 600_000;

const b64 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function keyFor(passphrase, salt, rounds) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: rounds }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Encrypts the wallet's files ([path, bytes] pairs) into the text of a wallet file. */
export async function sealWalletFile(files, passphrase, { network } = {}) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify({ files: files.map(([path, bytes]) => [path, b64(bytes)]) }));
  const header = { format: FORMAT, version: 1, network: network ?? null, created: new Date().toISOString().slice(0, 10) };
  // The header is bound to the ciphertext, so its network cannot be edited without breaking the file.
  const aad = new TextEncoder().encode(JSON.stringify(header));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, await keyFor(passphrase, salt, ROUNDS), plain));
  return JSON.stringify({ ...header, kdf: { name: 'PBKDF2-SHA-256', rounds: ROUNDS, salt: b64(salt) }, cipher: { name: 'AES-256-GCM', iv: b64(iv) }, data: b64(sealed) });
}

/**
 * Opens a wallet file's text with its passphrase. Returns { network, files } or throws an Error
 * whose `code` is 'not_a_wallet_file' or 'wrong_passphrase'.
 */
export async function openWalletFile(text, passphrase) {
  const fail = (code, message) => Object.assign(new Error(message), { code });
  let f;
  try { f = JSON.parse(text); } catch { throw fail('not_a_wallet_file', 'This is not a Devoid wallet file.'); }
  if (f?.format !== FORMAT || f.version !== 1 || !f.kdf?.salt || !f.cipher?.iv || typeof f.data !== 'string') throw fail('not_a_wallet_file', 'This is not a Devoid wallet file.');
  if (!Number.isInteger(f.kdf.rounds) || f.kdf.rounds < 100_000 || f.kdf.rounds > 10_000_000) throw fail('not_a_wallet_file', 'This wallet file is damaged.');
  const header = { format: f.format, version: f.version, network: f.network, created: f.created };
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(f.cipher.iv), additionalData: new TextEncoder().encode(JSON.stringify(header)) },
      await keyFor(passphrase, unb64(f.kdf.salt), f.kdf.rounds), unb64(f.data));
  } catch {
    throw fail('wrong_passphrase', 'That passphrase does not open this wallet file.');
  }
  const { files } = JSON.parse(new TextDecoder().decode(plain));
  return { network: f.network, files: files.map(([path, data]) => [path, unb64(data)]) };
}
