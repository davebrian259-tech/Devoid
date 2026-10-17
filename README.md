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
Do not pass `--locked` (the lockfile mirrors zcash-devtool, which carries one unused crate that cargo prunes).

## What it does

- Wallet create/restore (24-word phrase), age-encrypted keys, passphrase change, phrase reveal.
- Receive: unified (Ironwood/Orchard), Sapling, transparent, QR codes, fresh addresses.
- Batch send: paste or import CSV (address, amount, memo, label), per-row validation, review with fee, pool, and privacy report. Public disclosures (transparent recipients, pool crossing) require explicit acknowledgement. A fingerprint binds what you reviewed to what is signed.
- Activity with confirmations, memos, per-output detail. Saved lists. Shield transparent funds. Direct, Tor, or SOCKS5 connection.

## Security model

Server binds 127.0.0.1, requires a bearer token (delivered in the URL fragment, never logged), checks Host and Origin, and serves a strict CSP. The passphrase is only sent per request and never stored. The engine is stateless, one process per command.

## Verification status (honest)

See `docs/STATUS.md` for the exact blocked list. Real transactions are **not** claimed to work until the engine builds and passes `selftest`.


- Verified here: 229 JS tests (address/amount/CSV parsing, server API incl. auth and 2-transaction batch), a UI smoke test with screenshots (`python3 scripts/ui-smoke.py`), QR encoder decoded by an independent decoder for versions 2–24.
- **The Rust engine has not been compiled or run.** The build sandbox had no crates.io access. It was written against librustzcash 0.24 sources and reviewed by reading only. Expect to fix some compile errors on first build; the protocol and tests (`engine/src/*` unit tests, `selftest`) will tell you quickly.
- ZIP 318 migration is not implemented (notice only). TEX addresses are rejected. Fonts are system fonts.

Layout: `engine/` Rust, `server/` Node API + batch parsing, `mock-engine/` simulator, `ui/` frontend, `docs/` protocol, `test/` tests.
