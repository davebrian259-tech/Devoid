# Status: what works, what is blocked

## Works and is tested (no Rust needed)
- Address, amount and CSV parsing (228 tests incl. Zcash test vectors).
- Local server: token auth, Host/Origin checks, CSP, batch planning (25 per transaction), sequential send job, saved lists, settings. 6 server tests.
- Engine selection: the server uses the real `devoid-engine` if built and **refuses to start with it if its self-test fails**. `/api/status` reports `engineVerified`.
- UI end to end against the **simulated** engine (`npm run test:ui`, screenshots in `shots/`).
- Simulated engine is only used with `--demo`/`--mock` or when no real binary exists, and the UI shows a banner whenever it is active.

## Blocked: needs crates.io access
Nothing below has been run. Do not treat real transactions as working until all pass:
1. `cargo build --release --manifest-path engine/Cargo.toml` compiles (expect some first-build fixes).
2. `cargo test --manifest-path engine/Cargo.toml` passes.
3. `devoid-engine selftest` passes.
4. A testnet run: create wallet, sync, receive faucet funds, send a 2-recipient batch, confirm on an explorer.
5. Mainnet only after 4, with a small amount.

Also unimplemented: ZIP 318 migration, TEX addresses.

## How to get 1-3 without a computer
Push this folder to a GitHub repo; `.github/workflows/ci.yml` builds the engine, runs its tests and self-test, and uploads the Linux binary. Open the Actions tab in the GitHub app or Safari to see results.
