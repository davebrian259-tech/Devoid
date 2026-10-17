# Engine protocol (version 1)

One process runs one command. Write a single JSON object on stdin; read NDJSON on stdout.

- Progress lines: `{"event":"progress","stage":"connect|scan|build|broadcast",...}`
- Final line: `{"ok":true,"result":...}` or `{"ok":false,"error":{"code","message","details"}}`
- Exit codes: 0 ok, 1 reported failure, 2 usage, 70 crash. Logs go to stderr (`DEVOID_LOG`), never secrets.
- Common fields: `cmd`, `wallet` (folder), `passphrase`, `connection: {servers, mode}` (`mode`: `direct`, `tor`, `socks5://host:port`).

| cmd | needs | returns |
|---|---|---|
| version, selftest | – | engine info / check report |
| info | wallet | `{exists, network, birthday, chainHeight…}` |
| create | passphrase, network, optional phrase | addresses, phrase (new wallets only) |
| balance, addresses, newAddress, history | wallet | per-pool balances / addresses / transactions (`limit`, `offset`, `txid`, `outputs`) |
| revealPhrase, changePassphrase, upgrade, rescan | passphrase | – |
| sync | connection, `budgetSecs` | scan progress |
| propose | `recipients[{address, amountZat, memo?}]`, `fundingPools?` | summary, privacy report, `fingerprint` (offline) |
| send | propose fields + `passphrase`, `fingerprint`, `acknowledge[]` | `txids` |
| shield | `dryRun?`, then `passphrase`, `fingerprint`, `acknowledge[]` | summary / `txids` |
| rebroadcast | `txids?` | per-tx result |

Limits: 30 recipients per transaction (the server sends 25), 100,000 bytes estimated size, memo 512 bytes.
Error codes include `wrong_passphrase`, `insufficient_funds`, `acknowledgement_required`, `proposal_changed`, `bad_recipient`, `too_many_recipients`, `sync_required`.
`fingerprint` is SHA-256 of the canonical (sorted-key) proposal JSON, tag `devoid/proposal/1`; `send` refuses if the rebuilt proposal differs.
The simulated engine (`mock-engine/engine.mjs`) implements the same protocol and always reports `simulated: true`.
