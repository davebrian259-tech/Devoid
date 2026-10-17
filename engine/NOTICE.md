# Notices

`devoid-engine` is original code for Devoid, built on the Zcash Foundation / Electric Coin Company
libraries and written following the patterns of the reference command-line wallet.

## zcash-devtool

The way the engine creates and restores accounts, connects to lightwalletd (direct, SOCKS5 and the
built-in Tor client), scans compact blocks, enhances transactions, proposes and builds transactions
and encrypts the recovery phrase with `age` follows the code of
[zcash/zcash-devtool](https://github.com/zcash/zcash-devtool), used under the terms of
**MIT OR Apache-2.0**. Several modules (`data.rs`, `error.rs`, `remote.rs`, `sync.rs`, parts of
`wallet.rs` and `spend.rs`) say so at the top. `Cargo.toml` mirrors that project's dependency list
and `Cargo.lock` is that project's lock file, so that every transitive crate resolves to a version
that is already known to build together. Cargo drops the entries Devoid does not use the first time
it runs (do not build with `--locked` until the lock file has been regenerated once).

## Libraries

* [librustzcash](https://github.com/zcash/librustzcash) (`zcash_client_backend`,
  `zcash_client_sqlite`, `zcash_primitives`, `zcash_keys`, `zcash_address`, `zcash_protocol`,
  `zcash_proofs`, `zip321`, ...), [orchard](https://github.com/zcash/orchard) and
  [sapling-crypto](https://github.com/zcash/sapling-crypto): **MIT OR Apache-2.0**.
* [age](https://github.com/str4d/rage) (passphrase encryption): **MIT OR Apache-2.0**.
* `zcash_proofs` with the `bundled-prover` feature embeds the public Sapling proving parameters
  produced by the Zcash Sapling multi-party computation ceremony.
* tokio, tonic, prost, rusqlite (bundled SQLite), serde_json, sha2, tracing and the other crates
  listed in `Cargo.toml` are used under their own permissive licences.

## What was not copied

Devoid's batch planner, privacy analysis, proposal fingerprinting, acknowledgement checks, history
reader and the JSON protocol are written for this project.
