# Status: what works, what is blocked

Last verified 2026-10-17 on Linux, Rust 1.97.0, Node 22.

## Verified against the real Zcash testnet
The Rust engine now builds and runs. Against `testnet.zec.rocks:443`
(ECC LightWalletD v0.5.4), with the real `devoid-engine` binary:

- `cargo build --release` compiles clean; `cargo test --release` passes (11 tests).
- `devoid-engine selftest` passes all 10 checks, including the bundled Sapling proving
  parameters, the keystore round trip, and a 30-recipient ZIP 321 batch request.
- `create` derives a real testnet wallet (unified, Sapling and transparent addresses) using the
  live chain tip for its birthday.
- `sync` scans to the chain tip and reports progress; `balance` and `history` read back.
- `propose` computes real ZIP 317 fees and refuses correctly: `insufficient_funds` (with the
  shortfall), `bad_recipient` for a wrong-network address, `too_many_recipients` past 30.
- `verifyPassphrase` accepts the right passphrase and refuses a wrong one.
- The Node server starts against the real engine only after that self-test passes, and reports
  `simulated: false, engineVerified: true`.

## Works and is tested (no Rust needed)
- Address, amount and CSV parsing (Zcash test vectors included).
- Local server: token auth, Host/Origin checks, CSP, batch planning (25 per transaction),
  sequential send job, saved lists, settings. 241 JS tests in total.
- A real engine that fails its self-test is refused; the simulated engine is always flagged in
  the UI and in `/api/status`.
- UI end to end against the simulated engine (`npm run test:ui`, screenshots in `shots/`): every
  screen and feature, light, dark and phone, failing on any console error or leaked `null`.
- Web demo (`npm run test:web`): the built site served with its real `_headers`, from the front
  page's Open the wallet to a sent batch, a reload, a reset, and a phone screen. Fails on any
  console error, CSP violation or network request. The web demo is testnet only and refuses a
  recovery phrase, in the UI and again in its backend.

## Still not verified
1. **A real broadcast.** No testnet transaction has been built, signed and broadcast from here:
   that needs funded testnet ZEC, and the faucets are web forms. Everything up to the proposal is
   exercised against the live chain; the signing and broadcast path is not.
2. **Mainnet.** Only after 1, and then with a small amount first.

Also unimplemented: ZIP 318 migration, TEX addresses.

## Notes for other networks
On a network that terminates TLS with its own certificate authority (an inspecting corporate
proxy, some CI sandboxes), set `DEVOID_CA_FILE` to a PEM bundle. Those certificates are added to
the built-in roots rather than replacing them. Tor connections ignore it.
