# Status: what works, what is blocked

Last verified 2026-10-19 on Linux, Rust 1.97.0, Node 22.

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
  sequential send job, saved lists, settings, the web wallet file. 245 JS tests in total.
- A real engine that fails its self-test is refused; the simulated engine is always flagged in
  the UI and in `/api/status`.
- UI end to end against the simulated engine (`npm run test:ui`, screenshots in `shots/`): every
  screen and feature, light, dark and phone, failing on any console error or leaked `null`.
- The web wallet's engine (the same Rust code, compiled to WebAssembly) runs in the browser:
  verified live against the testnet through ChainSafe's gRPC-web proxy, in Chromium (`npm run
  test:live`): create a wallet, sync to the tip, balance, history, addresses, passphrase checks and
  changes, revealing the phrase, server info, an exact fee quote refused for lack of funds, and the
  wallet persisting across reloads. Its self-test passes 10 of 10, and a full transaction with
  Sapling and Orchard proofs is built and proved in the browser (about a minute) in
  `npm run test:web`. Still unproven there too: a real broadcast, which needs funded testnet ZEC.
- **First broadcast, testnet** (2026-10-19): with 1.125 TAZ from a faucet, a 2-recipient batch
  with memos (one unified, one Sapling recipient) was proposed (fee 0.0002 TAZ, a pool-crossing
  acknowledgement correctly required), built, proved and signed in 7 s, and broadcast as
  `fe3f530ffc399636cca88e6063ef28faae661ccc5f40db3253c2be334a8f78d5`. The node rejected it:
  *transaction uses an incorrect consensus branch id*. Testnet activated **NU7** at block
  4,465,026 (branch `0x77190AD9`), which the libraries pinned at the time did not know. Fixed by
  the NU7 upgrade below; this attempt expired unmined, and nothing was spent.
- Transactions the engine cannot parse (like testnet's NU7 ones) no longer stop a sync: they are
  logged and skipped, and balances still come from the compact blocks.
- **Mainnet, read-only, both engines** (2026-10-19): a new mainnet wallet created, synced to the
  tip (block 3,522,707 natively through zec.rocks; 3,522,711 in the browser through ChainSafe's
  mainnet gRPC-web proxy, through the UI) and an exact ZIP 317 fee quote refused for lack of
  funds. The web wallet offers mainnet behind an explicit "real ZEC" confirmation.
- **Mainnet payments, both engines** (2026-10-19), with 0.0032 ZEC received by a new wallet
  (`2f6c81a1…`, block 3,522,773):
  - **Native engine, a 2-recipient batch with memos**: 0.001 ZEC to an outside unified address
    and 0.001 ZEC to a fresh address of the same wallet, fully shielded (Ironwood to Ironwood,
    privacy level "private", no acknowledgement needed). Fee 0.00015 ZEC, the exact ZIP 317 fee
    for three actions (two payments and change) quoted before signing. Broadcast through
    zec.rocks as `82731e0e0e7d007c1ebdd9d0eef4ea2566e1fce2053f32216169340462c88339` and mined in
    block 3,522,904; the wallet's history and balance matched the proposal.
  - **Web engine, in Chromium under the site's real CSP**: the same wallet's files loaded into
    the WebAssembly engine, synced through ChainSafe's mainnet gRPC-web proxy, and everything
    left (0.00195 ZEC from two notes, fee 0.0001 ZEC, no change) sent back to the outside address,
    proved in the browser in 60 s, broadcast as
    `f95a784645e6258406d01c218ab28720f3b7583c8e9232d8aae776f70e81044d` and mined in block
    3,522,951.
  - The first web attempt found a bug no offline test had reached: after proving, the library
    stamps the new transaction with `time::OffsetDateTime::now_utc()`, which aborts in a browser
    unless the `time` crate reads the clock through JavaScript. Nothing was broadcast. Fixed by
    enabling `time`'s `wasm-bindgen` feature; the in-browser proving check now reads that clock
    too, so `npm run test:web` catches it.
  - With that, mainnet is open in the web wallet (`WEB_MAINNET` in `ui/lib.js`).
- Web wallet UI (`npm run test:web`): the built site served with its real `_headers`, from the front
  page's Open the wallet to a sent batch, a reload, a reset, and a phone screen. Fails on any
  console error, CSP violation or network request.
- Layout (`scripts/overlap.js`, run on every screenshot of both browser tests and on every landing
  page by `npm run test:site`): no component may overlap another, spill out of its box, scroll the
  page sideways or sit under the phone tab bar, checked from 320px to 1440px wide in light and
  dark. Decoration lifted out of the flow is held to the same rule: two absolutely positioned
  siblings may not overlap, and a picture may not cover text in the flow, unless the overlay is
  marked `data-overlap-ok` (the balance bar that carries "Tap to reveal" on top of itself). Each
  test proves the check by planting an overlap and expecting it to be caught.
- The web version refuses a recovery phrase, and keeps the demo on testnet, in the UI and again in
  its backend.
- **Staying in the wallet, and installing it** (2026-10-24): the web wallet can be added to a home
  screen (`ui/manifest.webmanifest`, `ui/sw.js`), where it opens in its own window and opens with no
  connection. The service worker holds one whole version at a time — `scripts/build-site.mjs` stamps
  it with a hash of every file and lists the shell (about 490 KB); the 15 MB WebAssembly engine is
  kept only once it is first used, and the Sapling parameters never. Unlocking can be a passkey
  rather than the passphrase (`ui/local/passkey.js`), through the WebAuthn PRF extension: the
  authenticator derives a secret, HKDF-SHA-256 turns it into an AES-256-GCM key, and that encrypts
  the passphrase into this browser. An authenticator without PRF is refused, the passphrase keeps
  working, revealing the recovery phrase still asks for it, changing it re-seals or removes the
  passkey, and deleting the wallet takes the passkey record with it. `npm run test:web` drives both
  against a virtual authenticator and with the network switched off.
- **Padding, so a batch does not show its headcount** (2026-10-24): a shielded transaction hides
  who was paid and how much, but the number of outputs is public and a ZIP 317 fee is 5,000
  zatoshis per logical action, so the fee narrows the recipient count. `padOutputs` rounds a
  transaction's payments up to 5, 10 or 25 (`PAD_BUCKETS` in `engine/src/spend.rs`, mirrored in
  `mock-engine/core.mjs` and `ui/calc.js`) with zero-value payments to the wallet's own shielded
  address — real outputs, indistinguishable on chain. Each costs one action: 0.0001 ZEC to pad
  three recipients up to five, quoted in the review before signing, and nothing at all for a
  transaction already at 25. The padding is excluded from the recipient list and the amounts, and
  included in the fingerprint, so what was reviewed is what is signed. The `shape_visible` finding
  changes from naming the leak to describing what padding did and what is still visible. Limit,
  stated in the app and on the site: it covers one transaction, so a batch split across several
  still shows roughly how large it was. Confirmed on testnet:
  `4fbde3662e5c7b179eae8bd8e09a34da10510f412a4f80e0c2767ff4273ea129`, mined in block 4,536,660,
  pays three people with the six outputs (five payments and change) a payment to five would have,
  fee 0.0003 TAZ.
- **NU7 libraries, and the first confirmed broadcasts** (2026-10-24): the whole librustzcash
  stack moved to the NU7-aware 0.11 release — `zcash_protocol` 0.11, `zcash_client_backend` 0.25,
  `zcash_client_sqlite` 0.23, `zcash_keys` 0.17, `zcash_primitives`/`zcash_proofs` 0.31,
  `orchard` 0.16, `sapling-crypto` 0.9, `zcash_transparent` 0.11 — with `rand` 0.10 (whose
  `OsRng` is gone; `UnwrapErr(SysRng)` replaces it) and the jubjub 0.11 / bls12_381 0.9 /
  secp256k1 0.33 that stack requires. `create_proposed_transactions` also gained explicit clock
  and rng arguments. The existing wallet database migrated in place (`upgrade`).
  With that, **sending on testnet works**, from both engines, each confirmed on chain:
  - native engine, a 2-recipient shielded batch with memos, fee 0.00015 TAZ as quoted:
    `ba406e5bf48a377b41a3897e0bc14571967d13ce5aeb283e8cde47eecf16ad50`, mined in block 4,534,144;
  - the WebAssembly engine in Chromium, through ChainSafe's testnet gRPC-web proxy, fee
    0.0001 TAZ: `e454e9c19eda5bde4a95a2aacdcd2f427205b6a74ab7cba0c99a92fe878a55cc`, mined in
    block 4,534,177.
  Mainnet activates NU7 at block 3,543,405 (expected 2026-11-05), so this had to land first:
  on the old libraries every mainnet send would have been rejected from that block on.

## Still not verified
1. **Sapling and transparent spends on mainnet.** The mainnet payments above spent Ironwood
   notes; Sapling spends are proved in the browser's self-check but have not been broadcast.
2. **A mainnet send after NU7 activates** (block 3,543,405, expected 2026-11-05). The NU7
   libraries are in and proven on testnet, which has run NU7 since block 4,465,026, but no
   mainnet transaction has yet been built under NU7 rules because mainnet is still on NU6.3.

Also unimplemented: ZIP 318 migration, TEX addresses.

## Notes for other networks
On a network that terminates TLS with its own certificate authority (an inspecting corporate
proxy, some CI sandboxes), set `DEVOID_CA_FILE` to a PEM bundle. Those certificates are added to
the built-in roots rather than replacing them. Tor connections ignore it.
