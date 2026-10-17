# Devoid

A Zcash wallet built around one job: **pay many people at once, privately.** One shielded transaction carries up to 30 recipients; bigger lists are split into sequential transactions of 25. Built for ZECATHON.

## Run it (works now, simulated chain)

```
node server/index.mjs --demo
```
Open the link it prints. The demo uses a simulated engine: no network, no real money; the UI says so in a banner. Node 20+, no dependencies.

## Run it for real

Needs Rust 1.88+ and network access to crates.io:
```
npm run engine:build      # builds engine/target/release/devoid-engine
npm run engine:selftest   # offline checks
node server/index.mjs     # uses the real engine automatically, data in ~/.devoid
```
If your network inspects TLS with its own certificate authority, point `DEVOID_CA_FILE` at a PEM
bundle; those certificates are added to the built-in roots, never replacing them.
Do not pass `--locked` (the lockfile mirrors zcash-devtool, which carries one unused crate that cargo prunes).

## What it does

- Wallet create/restore (24-word phrase), age-encrypted keys, passphrase change, phrase reveal.
- Receive: unified (Ironwood/Orchard), Sapling, transparent, QR codes, fresh addresses.
- Batch send: paste or import CSV (address, amount, memo, label), per-row validation, review with fee, pool, and privacy report. Public disclosures (transparent recipients, pool crossing) require explicit acknowledgement. A fingerprint binds what you reviewed to what is signed.
- Activity with confirmations, memos, per-output detail. Saved lists. Shield transparent funds. Direct, Tor, or SOCKS5 connection.

## Security model

Server binds 127.0.0.1, requires a bearer token (delivered in the URL fragment, never logged), checks Host and Origin, and serves a strict CSP. The passphrase is only sent per request and never stored. The engine is stateless, one process per command.

## Verification status (honest)

See `docs/STATUS.md` for detail. In short, as of 2026-10-17:

- The Rust engine **builds and runs**: `cargo test` passes (11 tests) and `devoid-engine selftest`
  passes all 10 checks, including the bundled Sapling proving parameters.
- Verified against the **real Zcash testnet** (`testnet.zec.rocks`, ECC LightWalletD v0.5.4):
  wallet creation, chain sync to the tip, balance, history, real ZIP 317 fee quotes, and the
  recipient and funding checks that refuse a bad batch.
- Verified here without Rust: 230 JS tests (address/amount/CSV parsing, server API incl. auth and
  a 2-transaction batch), a UI smoke test with screenshots (`npm run test:ui`), and a QR encoder
  decoded by an independent decoder for versions 2-24.
- **No transaction has been broadcast yet.** Building, signing and broadcasting needs funded
  testnet ZEC, so that last step is still unproven. Treat real sends as unverified until you have
  done a testnet run yourself.
- ZIP 318 migration is not implemented (notice only). TEX addresses are rejected. Fonts are
  system fonts.

Layout: `engine/` Rust, `server/` Node API + batch parsing, `mock-engine/` simulator, `ui/`
frontend, `docs/` protocol, `test/` tests.
