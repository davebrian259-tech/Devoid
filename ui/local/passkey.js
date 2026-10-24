// Unlocking this browser's wallet with a passkey, instead of typing the passphrase every time.
//
// A passkey normally proves who you are to a server. Devoid has no server, so that would prove
// nothing: the page could simply be told to skip the prompt. What is used here is the WebAuthn PRF
// extension, which has the authenticator derive a secret of its own — held in the device's secure
// hardware, never shown to this page or to anyone else — from which we derive a key (HKDF-SHA-256)
// and encrypt your passphrase (AES-256-GCM) into this browser's storage. "Unlock with your face"
// is then the decryption itself, not a gate in front of it.
//
// Consequences, said plainly in the UI as well:
//  - An authenticator without PRF cannot do this. Enrolment then fails rather than pretending.
//  - Whoever can unlock this device can spend from this wallet. That is the trade being made.
//  - The passphrase still works, is still the only way to see the recovery phrase, and is still
//    what encrypts the keys themselves. A lost passkey costs nothing: the wallet opens as before.
//  - The passkey belongs to this site on this device. Another browser needs its own, set up there
//    after opening the wallet file.
const KEY = 'devoid-web:passkey';  // cleared with the rest by local/backend.js when a wallet is deleted
const FORMAT = 'devoid-passkey';
const PRF_SALT = new TextEncoder().encode('devoid.unlock.v1');   // the input the authenticator mixes with its own secret
const INFO = new TextEncoder().encode('devoid wallet unlock v1');

const b64 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const fail = (code, message) => Object.assign(new Error(message), { code });
const random = (n) => crypto.getRandomValues(new Uint8Array(n));

/** Whether this browser could use a passkey at all (it still has to offer PRF when asked). */
export const passkeyPossible = () => Boolean(globalThis.isSecureContext && globalThis.PublicKeyCredential && navigator.credentials?.create);

/** The passkey set up in this browser, or null. */
export function savedPasskey() {
  try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; }
}
function remember(record) { try { localStorage.setItem(KEY, JSON.stringify(record)); } catch { /* storage blocked: it lasts this visit */ } }
/** Forgets the passkey here. The passkey itself lives on the device; remove it there too if you like. */
export function forgetPasskey() { try { localStorage.removeItem(KEY); } catch { /* nothing stored */ } }

// The authenticator's secret is not a key on its own; HKDF turns it into one, bound to this use.
async function keyFrom(secret, salt) {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: INFO }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Encrypts the passphrase under a secret only this authenticator can produce. Exported for tests. */
export async function sealUnder(secret, passphrase, { id, label }) {
  const salt = random(32); const iv = random(12);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFrom(secret, salt), new TextEncoder().encode(passphrase)));
  return { format: FORMAT, version: 1, id, label, created: new Date().toISOString().slice(0, 10), kdf: { name: 'HKDF-SHA-256', salt: b64(salt) }, cipher: { name: 'AES-256-GCM', iv: b64(iv) }, data: b64(data) };
}

/** Reads the passphrase back out. Throws with code 'damaged' or 'wrong_passkey'. Exported for tests. */
export async function openUnder(secret, record) {
  if (record?.format !== FORMAT || record.version !== 1 || !record.kdf?.salt || !record.cipher?.iv || typeof record.data !== 'string') {
    throw fail('damaged', 'This browser’s passkey record is damaged. Set the passkey up again.');
  }
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(record.cipher.iv) }, await keyFrom(secret, unb64(record.kdf.salt)), unb64(record.data));
    return new TextDecoder().decode(plain);
  } catch {
    throw fail('wrong_passkey', 'That passkey does not open this wallet.');
  }
}

const prfOf = (credential) => {
  const first = credential?.getClientExtensionResults?.().prf?.results?.first;
  return first ? new Uint8Array(first) : null;
};

/** Asks the authenticator for its secret, proving the person is there (face, fingerprint or PIN). */
async function secretFrom(id) {
  let assertion;
  try {
    assertion = await navigator.credentials.get({ publicKey: {
      challenge: random(32),
      allowCredentials: id ? [{ id: unb64(id), type: 'public-key' }] : [],
      userVerification: 'required',
      extensions: { prf: { eval: { first: PRF_SALT } } },
    } });
  } catch (e) {
    throw fail(e?.name === 'NotAllowedError' ? 'cancelled' : 'failed', e?.name === 'NotAllowedError' ? 'The passkey was not used.' : 'This device could not use the passkey.');
  }
  const secret = prfOf(assertion);
  if (!secret) throw fail('no_prf', 'This passkey cannot hold an encryption key, so it cannot unlock the wallet.');
  return secret;
}

/**
 * Sets up a passkey that unlocks this wallet. The passphrase must already have been checked.
 * Throws with code 'unsupported', 'cancelled', 'no_prf' or 'failed'.
 */
export async function enrolPasskey(passphrase, { label = 'This browser' } = {}) {
  if (!passkeyPossible()) throw fail('unsupported', 'This browser cannot use passkeys.');
  let credential;
  try {
    credential = await navigator.credentials.create({ publicKey: {
      challenge: random(32),
      rp: { name: 'Devoid', id: location.hostname },
      user: { id: random(16), name: `Devoid · ${label}`, displayName: 'Devoid wallet' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      attestation: 'none',
      extensions: { prf: { eval: { first: PRF_SALT } } },
    } });
  } catch (e) {
    throw fail(e?.name === 'NotAllowedError' ? 'cancelled' : 'failed', e?.name === 'NotAllowedError' ? 'No passkey was made.' : 'This device could not make a passkey for Devoid.');
  }
  if (!credential?.getClientExtensionResults?.().prf?.enabled) {
    throw fail('no_prf', 'This device’s passkeys cannot hold an encryption key (the WebAuthn PRF extension), so one could not unlock your wallet. Keep using your passphrase.');
  }
  const id = b64(new Uint8Array(credential.rawId));
  // Some browsers hand over the secret when the passkey is made; the rest only when it is used.
  const secret = prfOf(credential) ?? await secretFrom(id);
  const record = await sealUnder(secret, passphrase, { id, label });
  remember(record);
  return record;
}

/** Uses the passkey and returns the passphrase it holds. */
export async function unlockWithPasskey(record = savedPasskey()) {
  if (!record) throw fail('none', 'No passkey is set up in this browser.');
  return openUnder(await secretFrom(record.id), record);
}

/** After the passphrase changes, binds the same passkey to the new one. */
export async function rewrapPasskey(newPassphrase, record = savedPasskey()) {
  if (!record) return null;
  const next = await sealUnder(await secretFrom(record.id), newPassphrase, { id: record.id, label: record.label });
  remember(next);
  return next;
}
