// The web wallet's file: encrypted with the passphrase, opened only with it, and tamper-evident.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sealWalletFile, openWalletFile } from '../ui/local/walletfile.js';

const files = [['wallet/keys.json', new TextEncoder().encode('{"age":"…"}')], ['wallet/data.sqlite', Uint8Array.from({ length: 4096 }, (_, i) => i % 251)]];

test('a wallet file opens with its passphrase and gives back the same files', async () => {
  const text = await sealWalletFile(files, 'correct horse battery', { network: 'main' });
  const f = JSON.parse(text);
  assert.equal(f.format, 'devoid-wallet-file');
  assert.equal(f.network, 'main');
  assert.ok(!text.includes('keys.json'), 'file names are inside the encrypted part');
  const opened = await openWalletFile(text, 'correct horse battery');
  assert.equal(opened.network, 'main');
  assert.deepEqual(opened.files.map(([p, b]) => [p, [...b]]), files.map(([p, b]) => [p, [...b]]));
});

test('a wrong passphrase, another file or an edited header is refused', async () => {
  const text = await sealWalletFile(files, 'correct horse battery', { network: 'test' });
  await assert.rejects(openWalletFile(text, 'wrong passphrase'), { code: 'wrong_passphrase' });
  await assert.rejects(openWalletFile('{"hello":1}', 'x'), { code: 'not_a_wallet_file' });
  await assert.rejects(openWalletFile('not json', 'x'), { code: 'not_a_wallet_file' });
  const edited = JSON.stringify({ ...JSON.parse(text), network: 'main' }); // claims another network
  await assert.rejects(openWalletFile(edited, 'correct horse battery'), { code: 'wrong_passphrase' });
});

test('every file gets its own salt and nonce', async () => {
  const a = JSON.parse(await sealWalletFile(files, 'same pass', { network: 'test' }));
  const b = JSON.parse(await sealWalletFile(files, 'same pass', { network: 'test' }));
  assert.notEqual(a.kdf.salt, b.kdf.salt);
  assert.notEqual(a.cipher.iv, b.cipher.iv);
  assert.notEqual(a.data, b.data);
});
