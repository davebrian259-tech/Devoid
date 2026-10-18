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

- **Overview**: balance behind a redaction bar, where the money sits across pools (and how much is
  shielded), recent activity, contacts to pay in one tap, saved lists.
- **Batch send**: paste or import CSV (address, amount, memo, label), or pick from contacts and
  saved lists. Rows are checked as you type. A live summary shows recipients, total, estimated fee,
  shielded balance left, and why funds fall short. Tools: one amount for everyone, split a total to
  the zatoshi, remove bad rows.
- **Review and send**: a confirm sheet with the total, source pools, network, fee and a privacy
  report. Public disclosures (transparent recipients, pool crossing) need explicit acknowledgement.
  A fingerprint binds what you reviewed to what is signed. After sending: transaction IDs and a
  receipt CSV that marks who was paid if a multi-transaction batch stops halfway.
- **Receive**: unified, Sapling and transparent addresses with QR codes, fresh addresses, and ZIP 321
  payment requests (amount, encrypted memo, message) as a link and QR.
- **Activity**: pending, confirmed and expired, grouped by day, filterable, per-output detail,
  CSV export.
- **Contacts and lists**: an address book checked against the wallet's network; reusable lists for
  payroll, grants and DAO payouts (rename, duplicate, export).
- **Setup**: create or restore (24 words), a backup check of three random words, testnet or
  mainnet. Settings: theme, connection (direct, Tor, SOCKS5), phrase reveal, passphrase change,
  shielding.
- Light and dark themes, a phone layout with a bottom tab bar. Testnet is marked on every screen.

## Design

Type is Righteous for the wordmark, Outfit for the interface (chosen for true tabular figures) and
JetBrains Mono for addresses, all SIL OFL and vendored in `ui/fonts`. Icons are generated from
Lucide's SVG sources (ISC). There are still no runtime dependencies: the UI is plain ES modules
served under a strict CSP.

A product page lives in `site/` (static, ready for GitHub Pages). Its images come from the real UI on
the simulated engine: `python3 scripts/site-shots.py`.

## Security model

Server binds 127.0.0.1, requires a bearer token (delivered in the URL fragment, never logged), checks Host and Origin, and serves a strict CSP. The passphrase is only sent per request and never stored. The engine is stateless, one process per command.

## Verification status (honest)

See `docs/STATUS.md` for detail. In short, as of 2026-10-18:

- The Rust engine **builds and runs**: `cargo test` passes (11 tests) and `devoid-engine selftest`
  passes all 10 checks, including the bundled Sapling proving parameters.
- Verified against the **real Zcash testnet** (`testnet.zec.rocks`, ECC LightWalletD v0.5.4):
  wallet creation, chain sync to the tip, balance, history, real ZIP 317 fee quotes, and the
  recipient and funding checks that refuse a bad batch.
- Verified here without Rust: 236 JS tests (address/amount/CSV parsing, fee and ZIP 321 helpers,
  server API incl. auth and a 2-transaction batch), a browser test that drives every screen and
  feature and fails on any console error or leaked `null` (`npm run test:ui`, screenshots in
  `shots/`), and a QR encoder decoded by an independent decoder for versions 2-24.
- **No transaction has been broadcast yet.** Building, signing and broadcasting needs funded
  testnet ZEC, so that last step is still unproven. Treat real sends as unverified until you have
  done a testnet run yourself.
- ZIP 318 migration is not implemented (notice only). TEX addresses are rejected. Fonts are
  system fonts.

Layout: `engine/` Rust, `server/` Node API + batch parsing, `mock-engine/` simulator, `ui/`
frontend, `docs/` protocol, `test/` tests.
