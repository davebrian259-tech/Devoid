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
  sequential send job, saved lists, settings. 241 JS tests in total.
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
  4,465,026 (branch `0x77190AD9`), which only the 0.11 pre-release of the Zcash libraries knows;
  Devoid pins the stable ones, which match **mainnet** (NU6.3). So on testnet today Devoid can sync
  and quote but not send; on mainnet its libraries are the current ones. Before NU7 activates on
  mainnet, Devoid must move to NU7-aware libraries, or sends there will be rejected the same way.
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
- Layout (`scripts/overlap.js`, run on every screenshot of both browser tests): no component may
  overlap another, spill out of its box, scroll the page sideways or sit under the phone tab bar,
  checked from 320px to 1440px wide in light and dark. The test proves the check by planting an
  overlap and expecting it to be caught. The web version refuses a recovery phrase, and keeps the
  demo on testnet, in the UI and again in its backend.

## Still not verified
1. **Sending on testnet**, which needs the NU7-aware (pre-release) Zcash libraries; mainnet will
   need them too once NU7 activates there.
2. **Sapling and transparent spends on mainnet.** The mainnet payments above spent Ironwood
   notes; Sapling spends are proved in the browser's self-check but have not been broadcast.

Also unimplemented: ZIP 318 migration, TEX addresses.

## Notes for other networks
On a network that terminates TLS with its own certificate authority (an inspecting corporate
proxy, some CI sandboxes), set `DEVOID_CA_FILE` to a PEM bundle. Those certificates are added to
the built-in roots rather than replacing them. Tor connections ignore it.
