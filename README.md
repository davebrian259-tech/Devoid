# Devoid

A Zcash wallet built around one job: **pay many people at once, privately.** One shielded transaction carries up to 30 recipients; bigger lists are split into sequential transactions of 25.

## Try it in a browser (no install)

Open the product page and press **Open the wallet**: the full app runs at `/app/` on any phone or
computer, with the wallet itself running in the browser. Choose:

- **Testnet wallet**: the real Devoid engine (the Rust code in `engine/`, compiled to WebAssembly
  in `web-engine/`) in a Web Worker. It creates a wallet, syncs with the Zcash testnet through a
  gRPC-web lightwalletd proxy, quotes exact fees and builds and proves payments, all in the page.
  Keys are encrypted with your passphrase in the browser's storage. Mainnet follows once web
  payments are verified on testnet.
- **Demo**: the simulated engine with play money, offline.

Either way there is no Devoid server, and the web version never asks for a recovery phrase.
Build the site with `npm run build:site` (writes `dist/`); rebuild the engine with
`npm run build:engine` (needs Rust and wasm-bindgen; see `scripts/build-web-engine.mjs`).

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

On Windows, use WSL: [`docs/WSL.md`](docs/WSL.md) walks through everything from a fresh machine.

## Deploy

The product page (`site/`) and the web wallet (`ui/`, at `/app/`) deploy to Cloudflare as static
files: `wrangler.jsonc` runs `scripts/build-site.mjs` and a GitHub workflow publishes on merge once
two secrets are set. The wallet is non-custodial and never runs on a server. Steps, Cloudflare settings and variables: [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Roadmap

- **Testnet broadcast**, then mainnet with small amounts.
- **Mainnet on the web**, once testnet payments from the web wallet are verified. Faster proving
  with threads (WebAssembly threads need cross-origin isolation).
- **Restore on the web**, if it can be done without teaching people to type a phrase into sites.
- **Chrome extension** on the same in-browser engine, for the Chrome Web Store.

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
- **Navigation**: a sidebar with grouped sections, live counts (pending payments, lists, contacts),
  the wallet's network, balance and sync state, and a light/dark switch. It collapses to an icon
  rail (`[`), and the keyboard gets you anywhere: `N` new batch, `G` then a letter to jump, `T`
  theme, `.` show or hide balances, `?` for the list.
- Light and dark themes (follow the system or pick one), a phone layout with a bottom tab bar.
  Testnet is marked on every screen.

## Design

Type is Righteous for the wordmark, Outfit for the interface (chosen for true tabular figures) and
JetBrains Mono for addresses, all SIL OFL and vendored in `ui/fonts`. Icons are generated from
Lucide's SVG sources (ISC). There are still no runtime dependencies: the UI is plain ES modules
served under a strict CSP.

A product page lives in `site/` (static, deployed with the web wallet, see Deploy). Its images come from the real UI on
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
- Verified here without Rust: 241 JS tests (address/amount/CSV parsing, SHA-256 against FIPS
  vectors, fee and ZIP 321 helpers, server API incl. auth and a 2-transaction batch, the web
  backend's testnet-only and no-phrase rules), a browser test that drives every screen and
  feature and fails on any console error or leaked `null` (`npm run test:ui`, screenshots in
  `shots/`), a browser test of the built site and web wallet under its real CSP on desktop and
  phone, including the WebAssembly engine's self-test and a transaction proved in the browser
  (`npm run test:web`), a live test of the web wallet against the testnet (`npm run test:live`), and a QR encoder decoded by an independent decoder for versions 2-24.
- **No transaction has been broadcast yet.** Building, signing and broadcasting needs funded
  testnet ZEC, so that last step is still unproven. Treat real sends as unverified until you have
  done a testnet run yourself.
- ZIP 318 migration is not implemented (notice only). TEX addresses are rejected. Fonts are
  system fonts.

Layout: `engine/` Rust, `server/` Node API + batch parsing, `mock-engine/` simulator, `ui/`
frontend (`ui/local/` is the web wallet's in-page backend, `ui/engine/` the compiled engine and
its worker), `web-engine/` the engine's browser build, `site/` product page, `docs/` protocol, `test/` tests.
