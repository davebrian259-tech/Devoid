//! `selftest`: checks, without any network access, that the engine is wired to the Zcash
//! libraries correctly.
//!
//! It creates a throw-away wallet in a temporary folder, then exercises the same code paths a real
//! wallet uses: key encryption, account creation, address derivation, recipient validation, batch
//! payment requests, history, and the refusal to build a payment before the wallet has synced. It
//! also loads the bundled Sapling proving parameters. Nothing here needs a lightwalletd server, so
//! it is the first thing to run after building the engine on a new machine
//! (`node scripts/engine-selftest.mjs`).

use std::path::Path;

use bip0039::{Count, English, Mnemonic};
use secrecy::ExposeSecret;
use serde_json::{Value, json};
use zcash_client_backend::data_api::{AccountBirthday, WalletWrite, chain::ChainState};
use zcash_primitives::block::BlockHash;
use zcash_protocol::consensus::{BlockHeight, Network, NetworkUpgrade, Parameters};
use zip321::TransactionRequest;

use crate::{
    data::{WalletPaths, init_dbs},
    failure::{Failure, R},
    history,
    keystore::{self, Keys},
    out,
    platform::{self, files},
    remote, spend,
    wallet::{self, Wallet, ironwood_active_at},
};

struct Check {
    name: &'static str,
    outcome: Result<String, String>,
}

fn describe(failure: Failure) -> String {
    format!("{}: {}", failure.code, failure.message)
}

/// Runs one check. A panic inside it is a failed check, not a crash of the whole run.
fn run_check(
    checks: &mut Vec<Check>,
    name: &'static str,
    check: impl FnOnce() -> Result<String, String>,
) {
    out::progress("selftest", json!({ "check": name }));
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(check))
        .unwrap_or_else(|_| Err("the check panicked".to_string()));
    checks.push(Check { name, outcome });
}

fn expect_code<T>(result: R<T>, code: &str, what: &str) -> Result<(), String> {
    match result {
        Ok(_) => Err(format!("{what} was accepted but must be refused")),
        Err(failure) if failure.code == code => Ok(()),
        Err(failure) => Err(format!(
            "{what} was refused with {} instead of {code}: {}",
            failure.code, failure.message
        )),
    }
}

// ---------------------------------------------------------------------------------------------
// Checks that need no wallet
// ---------------------------------------------------------------------------------------------

fn check_consensus() -> Result<String, String> {
    let main = Network::MainNetwork
        .activation_height(NetworkUpgrade::Nu6_3)
        .ok_or_else(|| "mainnet has no NU6.3 (Ironwood) activation height".to_string())?;
    let test = Network::TestNetwork
        .activation_height(NetworkUpgrade::Nu6_3)
        .ok_or_else(|| "testnet has no NU6.3 (Ironwood) activation height".to_string())?;
    let before = BlockHeight::from_u32(u32::from(main).saturating_sub(1));
    if !ironwood_active_at(&Network::MainNetwork, main)
        || ironwood_active_at(&Network::MainNetwork, before)
    {
        return Err("Ironwood activation is not detected at the right height".to_string());
    }
    Ok(format!(
        "Ironwood (NU6.3) activates at block {} on mainnet and {} on testnet",
        u32::from(main),
        u32::from(test)
    ))
}

// ---------------------------------------------------------------------------------------------
// Checks on a throw-away wallet
// ---------------------------------------------------------------------------------------------

const PASSPHRASE: &str = "selftest passphrase one";
const OTHER_PASSPHRASE: &str = "selftest passphrase two";

fn check_keystore(paths: &WalletPaths, phrase: &str, seed: &[u8]) -> Result<String, String> {
    let mut keys = Keys::read(paths).map_err(describe)?;

    let opened = keys.phrase(PASSPHRASE).map_err(describe)?;
    if opened.expose_secret().as_slice() != phrase.as_bytes() {
        return Err("the recovery phrase did not survive encryption".to_string());
    }
    let derived = keys.seed(PASSPHRASE).map_err(describe)?;
    if derived.expose_secret().as_slice() != seed {
        return Err("the seed derived from the stored phrase differs".to_string());
    }
    expect_code(
        keys.phrase("not the passphrase"),
        "wrong_passphrase",
        "a wrong passphrase",
    )?;
    expect_code(
        keystore::check_passphrase("short"),
        "weak_passphrase",
        "a short passphrase",
    )?;

    keys.change_passphrase(paths, PASSPHRASE, OTHER_PASSPHRASE)
        .map_err(describe)?;
    let reread = Keys::read(paths).map_err(describe)?;
    expect_code(
        reread.phrase(PASSPHRASE),
        "wrong_passphrase",
        "the old passphrase",
    )?;
    let reopened = reread.phrase(OTHER_PASSPHRASE).map_err(describe)?;
    if reopened.expose_secret().as_slice() != phrase.as_bytes() {
        return Err("the phrase changed when the passphrase was changed".to_string());
    }

    // Put the original passphrase back so later checks see the wallet as created.
    let mut reread = reread;
    reread
        .change_passphrase(paths, OTHER_PASSPHRASE, PASSPHRASE)
        .map_err(describe)?;
    Ok(
        "the recovery phrase round-trips, wrong passphrases are refused, passphrase change works"
            .to_string(),
    )
}

fn check_addresses(wallet: &Wallet) -> Result<String, String> {
    let value = wallet::addresses(wallet).map_err(describe)?;
    let shielded = value["shielded"].as_str().ok_or("no shielded address")?;
    let sapling = value["sapling"].as_str().ok_or("no Sapling address")?;
    let transparent = value["transparent"]
        .as_str()
        .ok_or("no transparent address")?;
    if !shielded.starts_with("u1") {
        return Err(format!(
            "the shielded address is not a mainnet unified address: {shielded}"
        ));
    }
    if !sapling.starts_with("zs1") {
        return Err(format!(
            "the Sapling address is not a mainnet Sapling address: {sapling}"
        ));
    }
    if !transparent.starts_with("t1") {
        return Err(format!(
            "the transparent address is not a mainnet one: {transparent}"
        ));
    }
    Ok("shielded (unified), Sapling and transparent addresses derive for mainnet".to_string())
}

fn check_empty_wallet(wallet: &Wallet) -> Result<String, String> {
    let balance = wallet::balance(wallet).map_err(describe)?;
    if balance["total"] != 0 {
        return Err(format!("a new wallet reports a balance: {balance}"));
    }
    let listed = history::history(wallet, &json!({})).map_err(describe)?;
    let transactions = listed["transactions"]
        .as_array()
        .ok_or("history has no transaction list")?;
    if !transactions.is_empty() || listed["hasMore"] != false {
        return Err(format!("a new wallet has history: {listed}"));
    }
    Ok("a new wallet has a zero balance and an empty history".to_string())
}

fn recipient(address: &str, amount: u64, memo: Option<&str>) -> Value {
    match memo {
        Some(memo) => json!({ "address": address, "amountZat": amount, "memo": memo }),
        None => json!({ "address": address, "amountZat": amount }),
    }
}

fn check_recipients(wallet: &Wallet) -> Result<String, String> {
    let params = Network::MainNetwork;
    let value = wallet::addresses(wallet).map_err(describe)?;
    let ua = value["shielded"].as_str().ok_or("no shielded address")?;
    let sapling = value["sapling"].as_str().ok_or("no Sapling address")?;
    let transparent = value["transparent"]
        .as_str()
        .ok_or("no transparent address")?;

    for (label, address, memo) in [
        ("unified address with a memo", ua, Some("hello from Devoid")),
        (
            "Sapling address with a memo",
            sapling,
            Some("héllo — ünïcode ✓"),
        ),
        ("transparent address", transparent, None),
    ] {
        spend::parse_recipient(&params, 0, &recipient(address, 100_000, memo))
            .map_err(|f| format!("{label}: {}", describe(f)))?;
    }

    expect_code(
        spend::parse_recipient(
            &params,
            0,
            &recipient(transparent, 100_000, Some("no memos here")),
        ),
        "bad_recipient",
        "a memo to a transparent address",
    )?;
    expect_code(
        spend::parse_recipient(&params, 0, &recipient(ua, 0, None)),
        "bad_recipient",
        "a zero amount",
    )?;
    expect_code(
        spend::parse_recipient(&params, 0, &recipient(transparent, 10, None)),
        "bad_recipient",
        "a dust-sized transparent payment",
    )?;
    let long_memo = "x".repeat(513);
    expect_code(
        spend::parse_recipient(&params, 0, &recipient(ua, 100_000, Some(&long_memo))),
        "bad_recipient",
        "a 513-byte memo",
    )?;
    let max_memo = "y".repeat(512);
    spend::parse_recipient(&params, 0, &recipient(ua, 100_000, Some(&max_memo)))
        .map_err(|f| format!("a 512-byte memo: {}", describe(f)))?;
    expect_code(
        spend::parse_recipient(&params, 0, &recipient("not an address", 100_000, None)),
        "bad_recipient",
        "garbage instead of an address",
    )?;

    // A mainnet address must not be accepted by a testnet wallet.
    match spend::parse_recipient(&Network::TestNetwork, 0, &recipient(ua, 100_000, None)) {
        Ok(_) => return Err("a mainnet address was accepted on testnet".to_string()),
        Err(f) if f.code == "bad_recipient" && f.message.contains("mainnet") => {}
        Err(f) => {
            return Err(format!(
                "wrong-network refusal was unclear: {}",
                describe(f)
            ));
        }
    }

    Ok("shielded, Sapling and transparent recipients validate; bad amounts, memos and networks are refused"
        .to_string())
}

fn check_batch_request(wallet: &Wallet) -> Result<String, String> {
    let params = Network::MainNetwork;
    let value = wallet::addresses(wallet).map_err(describe)?;
    let ua = value["shielded"].as_str().ok_or("no shielded address")?;
    let sapling = value["sapling"].as_str().ok_or("no Sapling address")?;
    let transparent = value["transparent"]
        .as_str()
        .ok_or("no transparent address")?;

    let build = |count: usize| -> Vec<Value> {
        (0..count)
            .map(|i| {
                let amount = 50_000 + i as u64;
                match i % 3 {
                    0 => recipient(ua, amount, Some("batch")),
                    1 => recipient(sapling, amount, Some("batch")),
                    _ => recipient(transparent, amount, None),
                }
            })
            .collect()
    };

    let limit = spend::MAX_RECIPIENTS_PER_TX;
    let parsed = spend::parse_transfer_request(&params, &json!({ "recipients": build(limit) }))
        .map_err(describe)?;
    let request = spend::transaction_request(&parsed.recipients).map_err(describe)?;
    if request.payments().len() != limit {
        return Err(format!(
            "expected {limit} payments in the request, found {}",
            request.payments().len()
        ));
    }
    let expected: u64 = (0..limit as u64).map(|i| 50_000 + i).sum();
    let total = request
        .total()
        .map_err(|e| format!("the request total overflowed: {e:?}"))?
        .map(u64::from);
    if total != Some(expected) {
        return Err(format!(
            "the request totals {total:?} zatoshis, expected {expected}"
        ));
    }
    let uri = request.to_uri();
    let back = TransactionRequest::from_uri(&uri)
        .map_err(|e| format!("the ZIP 321 URI did not parse back: {e}"))?;
    if back != request {
        return Err("the ZIP 321 request changed on a round trip".to_string());
    }

    expect_code(
        spend::parse_transfer_request(&params, &json!({ "recipients": build(limit + 1) })),
        "too_many_recipients",
        "one more recipient than a transaction may carry",
    )?;
    expect_code(
        spend::parse_transfer_request(&params, &json!({ "recipients": [] })),
        "bad_request",
        "an empty batch",
    )?;

    Ok(format!(
        "a {limit}-recipient batch becomes one ZIP 321 request and survives a round trip; {} is refused",
        limit + 1
    ))
}

fn check_refuses_unsynced_payment(wallet: &mut Wallet) -> Result<String, String> {
    let value = wallet::addresses(wallet).map_err(describe)?;
    let ua = value["shielded"]
        .as_str()
        .ok_or("no shielded address")?
        .to_string();
    let request = json!({ "recipients": [recipient(&ua, 100_000, Some("not yet"))] });
    expect_code(
        spend::propose(wallet, &request),
        "sync_required",
        "a payment before the wallet has synced",
    )?;
    Ok("a payment is refused until the wallet has synced".to_string())
}

fn check_new_address(wallet: &mut Wallet) -> Result<String, String> {
    let value = wallet::new_address(wallet).map_err(describe)?;
    let ua = value["shielded"].as_str().ok_or("no address returned")?;
    if !ua.starts_with("u1") {
        return Err(format!("a fresh address is not a unified address: {ua}"));
    }
    Ok("a fresh diversified shielded address is generated".to_string())
}

/// Creates the throw-away wallet and runs every check that needs one.
fn offline_wallet(checks: &mut Vec<Check>, dir: &Path) -> Result<(), String> {
    let params = Network::MainNetwork;
    let paths = WalletPaths::new(dir);

    let mnemonic: Mnemonic<English> = Mnemonic::generate(Count::Words24);
    let phrase = mnemonic.phrase().to_string();
    let seed = keystore::seed_from_mnemonic(&mnemonic);
    drop(mnemonic);

    // An account whose birthday is a recent mainnet height with empty note commitment trees: this
    // never touches the network, and the empty state is only used for the wallet database.
    let birthday_height = BlockHeight::from_u32(3_000_000);
    Keys::create(
        &paths,
        params,
        u32::from(birthday_height),
        &phrase,
        PASSPHRASE,
    )
    .map_err(|f| format!("creating the keys file: {}", describe(f)))?;
    let mut db =
        init_dbs(params, &paths).map_err(|f| format!("creating the database: {}", describe(f)))?;
    let birthday =
        AccountBirthday::from_parts(ChainState::empty(birthday_height, BlockHash([0; 32])), None);
    db.create_account(wallet::DEFAULT_ACCOUNT_NAME, &seed, &birthday, None)
        .map_err(|e| format!("creating the account: {e}"))?;
    drop(db);

    let mut wallet =
        Wallet::open(paths.clone()).map_err(|f| format!("opening the wallet: {}", describe(f)))?;

    run_check(checks, "keystore", || {
        check_keystore(&paths, &phrase, seed.expose_secret())
    });
    run_check(checks, "addresses", || check_addresses(&wallet));
    run_check(checks, "empty-wallet", || check_empty_wallet(&wallet));
    run_check(checks, "recipient-validation", || check_recipients(&wallet));
    run_check(checks, "batch-payment-request", || {
        check_batch_request(&wallet)
    });
    run_check(checks, "refuses-unsynced-payment", || {
        check_refuses_unsynced_payment(&mut wallet)
    });
    run_check(checks, "new-address", || check_new_address(&mut wallet));
    Ok(())
}

pub(crate) async fn run(_req: &Value) -> R<Value> {
    let mut checks: Vec<Check> = Vec::new();

    run_check(&mut checks, "consensus-parameters", check_consensus);
    run_check(&mut checks, "connection-settings", remote::check_settings);
    run_check(&mut checks, platform::PROVER_CHECK, platform::check_prover);

    let dir = platform::scratch_dir();
    let setup = offline_wallet(&mut checks, &dir);
    let _ = files::remove_dir_all(&dir);
    if let Err(why) = setup {
        checks.push(Check {
            name: "offline-wallet-setup",
            outcome: Err(why),
        });
    }

    let failed = checks.iter().filter(|c| c.outcome.is_err()).count();
    let list: Vec<Value> = checks
        .iter()
        .map(|check| match &check.outcome {
            Ok(detail) => json!({ "name": check.name, "ok": true, "detail": detail }),
            Err(why) => json!({ "name": check.name, "ok": false, "error": why }),
        })
        .collect();
    let report = json!({
        "engine": env!("CARGO_PKG_VERSION"),
        "passed": checks.len() - failed,
        "failed": failed,
        "checks": list,
    });

    if failed > 0 {
        return Err(Failure::new(
            "selftest_failed",
            format!("{failed} of {} self-test checks failed.", checks.len()),
        )
        .with_details(report));
    }
    Ok(report)
}
