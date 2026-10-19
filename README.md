<p align="center"><img src="ui/mark.svg" width="72" height="72" alt=""></p>

<h1 align="center">Devoid</h1>

<p align="center"><b>Pay everyone at once. Privately.</b><br>
A non-custodial Zcash wallet that pays a whole list of people in one shielded transaction.</p>

<p align="center">
  <img alt="Zcash mainnet: payments confirmed" src="https://img.shields.io/badge/Zcash_mainnet-payments_confirmed-f4b728?labelColor=231f20">
  <img alt="Engine: Rust, librustzcash" src="https://img.shields.io/badge/engine-Rust_%C2%B7_librustzcash-b7410e">
  <img alt="Web: WebAssembly" src="https://img.shields.io/badge/web-WebAssembly-654ff0">
  <img alt="Tests: 241 passing" src="https://img.shields.io/badge/tests-241_passing-2ea44f">
  <img alt="Runtime dependencies: 0" src="https://img.shields.io/badge/runtime_deps-0-555">
  <img alt="Licence: MIT" src="https://img.shields.io/badge/licence-MIT-555">
</p>

<p align="center">
  <a href="https://devoid-site.davebrian259.workers.dev/app/"><b>Open the web wallet</b></a> ·
  <a href="https://devoid-site.davebrian259.workers.dev/">Product page</a> ·
  <a href="docs/STATUS.md">What is verified</a> ·
  <a href="docs/ENGINE_PROTOCOL.md">Engine protocol</a>
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="site/img/overview-dark.jpg">
  <img alt="Devoid's overview: balance, where the money sits across pools, recent activity and contacts" src="site/img/overview.jpg">
</picture>

Payroll, grants and DAO payouts mean paying many people at once. On a transparent chain that
publishes who was paid and how much. One transaction per person costs more and links every
payment to the same sender. Devoid builds **one shielded Zcash transaction for up to 25
recipients**: the chain sees that a transaction happened and its size, never who got what. A
list of up to 2,000 people goes out as a few transactions, in order.

## Proven on mainnet

On 2026-10-19 a fresh wallet received 0.0032 ZEC. It then paid out through **both** of
Devoid's engines, and every step was mined:

| Step | Engine | What happened | Fee (quoted before signing) | Transaction | Block |
|---|---|---|---|---|---|
| 1 | — | 0.0032 ZEC received | — | [`2f6c81a1…`](https://blockchair.com/zcash/transaction/2f6c81a11077472d5d91b386dfcc25ad0c3a9355ac0314c8728fdabad1287835) | 3,522,773 |
| 2 | Native (Rust) | A shielded batch to 2 recipients with memos | 0.00015 ZEC, exact | [`82731e0e…`](https://blockchair.com/zcash/transaction/82731e0e0e7d007c1ebdd9d0eef4ea2566e1fce2053f32216169340462c88339) | 3,522,904 |
| 3 | Web (WebAssembly, in the browser) | The rest sent back, proved in the page in 60 s | 0.0001 ZEC, exact | [`f95a7846…`](https://blockchair.com/zcash/transaction/f95a784645e6258406d01c218ab28720f3b7583c8e9232d8aae776f70e81044d) | 3,522,951 |

```mermaid
pie showData title Where the 0.0032 ZEC went
    "Back to the sender" : 0.00295
    "Network fees (ZIP 317)" : 0.00025
```

The full log, including a bug this run caught before it reached anyone, is in
[`docs/STATUS.md`](docs/STATUS.md).

## Why one transaction

Zcash fees follow ZIP 317: 5,000 zatoshi per logical action, with a minimum of two. A batch pays
for each recipient plus one change output. Separate payments pay the two-action minimum every time,
and each one is a fresh link back to the payer.

```mermaid
xychart-beta
    title "Network fee in thousand zatoshi: separate payments (bars) vs one Devoid batch (line)"
    x-axis "Recipients" [1, 5, 10, 15, 20, 25]
    y-axis "Thousand zatoshi" 0 --> 260
    bar [10, 50, 100, 150, 200, 250]
    line [10, 30, 55, 80, 105, 130]
```

| Recipients | One transaction each | One Devoid batch | Saved |
|---:|---:|---:|---:|
| 5 | 0.0005 ZEC | 0.0003 ZEC | 40% |
| 10 | 0.001 ZEC | 0.00055 ZEC | 45% |
| 25 | 0.0025 ZEC | 0.0013 ZEC | 48% |

The quote shown before signing is the engine's own, built from the real notes the wallet would
spend, and it is the fee the transaction pays.

## The workflow

<table>
  <tr>
    <td width="58%"><img alt="Send to many: one card per recipient, each checked as you type, with the live total and fee" src="docs/img/send.jpg"></td>
    <td><img alt="Review: total, source pools, network fee and a privacy report before signing" src="site/img/review.jpg"></td>
  </tr>
  <tr>
    <td><b>1. Add recipients</b> one card at a time, or paste or import a CSV of up to 2,000.
    Every address is checked as you type and shows the pool it will be paid into.</td>
    <td><b>2. Review</b> the exact fee and what the chain will reveal. Anything public, like a
    transparent recipient, needs an explicit acknowledgement.</td>
  </tr>
  <tr>
    <td><img alt="Activity: every payment in and out, with its status on chain" src="docs/img/activity.jpg"></td>
    <td><img alt="Devoid on a phone" src="site/img/phone.jpg" width="260"></td>
  </tr>
  <tr>
    <td><b>3. Send and track.</b> One passphrase, one signature. A fingerprint ties what you reviewed
    to what is signed. Activity follows each payment from pending to confirmed.</td>
    <td><b>Anywhere.</b> The same app on a phone, with nothing to install: the wallet runs
    in the browser.</td>
  </tr>
</table>

```mermaid
sequenceDiagram
    autonumber
    actor You
    participant UI as Devoid UI
    participant E as Wallet engine (Rust)
    participant L as lightwalletd
    You->>UI: Recipients (cards, paste or CSV)
    UI->>E: propose
    E->>E: Select notes, build ZIP 317 proposal, privacy report
    E-->>UI: Exact fee, pools, findings, fingerprint
    You->>UI: Review, acknowledge, passphrase
    UI->>E: send (fingerprint, passphrase)
    E->>E: Rebuild and compare fingerprint, prove (Orchard, Sapling), sign
    E->>L: Broadcast
    L-->>E: Accepted
    E-->>UI: txid, receipt CSV
```

## How it works

The wallet engine is one Rust codebase built on **librustzcash** (`zcash_client_backend`,
`zcash_client_sqlite`, Orchard, Sapling). It compiles to a native binary for the desktop and
to **WebAssembly** for the browser. A per-platform module swaps in storage, network, clock and
prover. Both builds speak the same JSON protocol to the same UI and request core.

```mermaid
flowchart LR
    subgraph Browser["Any browser (phone or computer)"]
        UI1["Devoid UI<br/>(plain ES modules)"] --> C1["Request core<br/>server/core.mjs"]
        C1 --> W["Web Worker"]
        W --> WE["devoid-engine<br/>WebAssembly"]
        WE --- IDB[("IndexedDB<br/>keys encrypted (age)")]
    end
    subgraph Desktop["Desktop"]
        UI2["Devoid UI"] --> S["Local server<br/>127.0.0.1, token, CSP"]
        S --> NE["devoid-engine<br/>native binary"]
        NE --- FS[("~/.devoid<br/>SQLite + keys")]
    end
    WE -- "gRPC-web" --> P["ChainSafe gRPC-web proxy"] --> LWD["lightwalletd"]
    NE -- "gRPC (direct, Tor or SOCKS5)" --> LWD
    LWD --> Z(("Zcash<br/>mainnet / testnet"))
```

The hard parts of the browser build:

- **librustzcash in a browser tab, single-threaded.** Multicore proving in halo2 and bellman is
  switched off, and rayon jobs are run on the calling thread so scanning never deadlocks.
- **SQLite in memory, saved to IndexedDB.** A small shim replaces `libsqlite3-sys` with
  `sqlite-wasm-rs`. After every command that changes the wallet, the files are saved.
- **Every clock goes through JavaScript.** `SystemTime` panics in WebAssembly; the wallet
  database, sync deadlines and transaction timestamps read `Date.now()` instead. The mainnet run
  found the last one.
- **Sapling parameters on demand.** The 48 MB spend parameters download only when a payment
  spends Sapling notes. They are served in two parts and checked against the published BLAKE2b
  hashes.
- **A strict CSP.** The page may only talk to its own origin and the gRPC-web servers
  (`script-src 'self' 'wasm-unsafe-eval'`). There is no Devoid server, and the web version never
  asks for a recovery phrase.

## What stays private

| | The chain | The lightwalletd server | Only you |
|---|:-:|:-:|:-:|
| That a transaction happened, its size and fee | ✓ | ✓ | ✓ |
| Recipients, amounts, memos (shielded) | — | — | ✓ |
| Your IP address | — | ✓ (desktop: hide it with Tor) | ✓ |
| Keys and recovery phrase | — | — | ✓, encrypted with your passphrase |
| Transparent recipients or pool crossings | ✓ | ✓ | flagged before you sign |

## Try it

**In a browser, nothing to install.** [Open the web wallet](https://devoid-site.davebrian259.workers.dev/app/)
on a phone or computer and choose:
- a **real wallet** on mainnet (it asks you to confirm that it holds real ZEC) or testnet;
- a **demo** with play money on a simulated chain.

**On your computer, simulated chain** (Node 20+, no dependencies):
```
npm run demo        # node server/index.mjs --demo, then open the link it prints
```

**On your computer, for real** (Rust 1.88+):
```
npm run engine:build      # engine/target/release/devoid-engine
npm run engine:selftest   # 10 offline checks, including the Sapling proving parameters
npm start                 # uses the real engine, data in ~/.devoid
```
If your network inspects TLS with its own certificate authority, set `DEVOID_CA_FILE` to a PEM
bundle; those certificates are added to the built-in roots, never replacing them. On Windows, use
WSL: [`docs/WSL.md`](docs/WSL.md).

**Build and deploy the site.** Run `npm run build` to write `dist/`. Run `npm run build:engine`
to rebuild the WebAssembly engine (needs Rust and wasm-bindgen). Cloudflare settings are in
[`docs/DEPLOY.md`](docs/DEPLOY.md).

## Features

- **Batch send**: one card per recipient, paste a list, import CSV, or pick contacts and saved
  lists. Tools: one amount for everyone, split a total to the zatoshi, remove bad rows. Up to 25
  recipients per transaction and 2,000 per batch.
- **Review**: total, source pools, network, exact fee and a privacy report. Public disclosures
  need explicit acknowledgement. A receipt CSV marks who was paid, even if a multi-transaction
  batch stops halfway.
- **Receive**: unified, Sapling and transparent addresses with QR codes, fresh addresses, and
  ZIP 321 payment requests.
- **Activity**: pending, confirmed and expired, grouped by day, with per-output detail and CSV
  export.
- **Contacts and lists** for payroll, grants and DAO payouts.
- **Setup and settings**: create (or restore, on the desktop), a backup check, passphrase change,
  phrase reveal, shielding of transparent funds, and Tor or SOCKS5 on the desktop.
- **Light and dark**, a phone layout, keyboard shortcuts, and the network marked on every screen.

## Verification

| Check | How |
|---|---|
| 241 unit and API tests: Zcash address test vectors, amounts, CSV, SHA-256 (FIPS), fees, ZIP 321, server auth, web backend rules | `npm test` |
| Every screen and feature in a browser, failing on any console error or leaked `null` | `npm run test:ui` |
| The built site under its real CSP, desktop and phone, 320–1440 px, light and dark. Fails on any overlap, CSP violation or unexpected request. Includes the WebAssembly engine's self-test and a transaction proved in the browser | `npm run test:web` |
| A live wallet through the UI on testnet and mainnet: create, sync to the tip, exact fee quote, persistence | `npm run test:live` |
| Engine: 11 Rust tests and a 10-check self-test | `cargo test`, `npm run engine:selftest` |
| Real payments on mainnet, from both engines | [`docs/STATUS.md`](docs/STATUS.md) |

Not yet: sending on testnet, which needs the NU7-aware (pre-release) Zcash libraries; ZIP 318
migration; TEX addresses.

## Project layout

```
engine/        Rust wallet engine (librustzcash), native binary, JSON protocol over stdin/stdout
web-engine/    the same engine built for WebAssembly: platform layer, gRPC-web, SQLite shim
ui/            the app: plain ES modules, no build step; ui/local/ is the in-browser backend,
               ui/engine/ the compiled engine and its worker
server/        local server for the desktop app, request core shared with the web, batch parsing
mock-engine/   simulated engine for the demo
site/          product page and privacy policy
scripts/       site build, engine build, browser tests, screenshots
test/          unit and API tests
docs/          protocol, status, deployment, Windows
```

## Roadmap

- **NU7**: move to the NU7-aware Zcash libraries (already needed to send on testnet) before NU7
  activates on mainnet.
- **Faster proving on the web** with WebAssembly threads, which need cross-origin isolation.
- **A Chrome extension** on the same in-browser engine.

## Design and licences

Type: Righteous, Outfit and JetBrains Mono (SIL OFL), vendored in `ui/fonts`. Icons: Lucide (ISC).
The app is MIT. The engine is MIT or Apache-2.0 and builds on librustzcash from the Electric
Coin Company and the Zcash Foundation. Screens in this README show demo data from the simulated
engine; the mainnet proof above is real.
