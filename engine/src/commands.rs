//! Command dispatch: turns one JSON request into one JSON result.
//!
//! Every request is an object with a `cmd` and, for everything that touches a wallet, a `wallet`
//! folder. Secrets (`passphrase`, `newPassphrase`, `phrase`) travel inside the request on stdin and
//! are used only for the lifetime of the process. See `docs/ENGINE_PROTOCOL.md` for the full
//! command list with request and result shapes.

use serde_json::{Value, json};

use crate::{
    data::{WalletPaths, open_block_cache, parse_network},
    failure::{Failure, R},
    history,
    keystore::Keys,
    out,
    remote::Connection,
    selftest, spend,
    sync::{Budget, SyncOptions, sync_slice},
    wallet::{self, CreateArgs, Wallet},
};

/// Bumped whenever a request or result shape changes incompatibly.
pub(crate) const PROTOCOL_VERSION: u64 = 1;

const DEFAULT_SYNC_BUDGET_SECS: u64 = 25;
const MAX_SYNC_BUDGET_SECS: u64 = 300;
const MIN_SYNC_BUDGET_SECS: u64 = 5;

pub(crate) const COMMANDS: &[&str] = &[
    "version",
    "selftest",
    "info",
    "create",
    "balance",
    "addresses",
    "newAddress",
    "revealPhrase",
    "verifyPassphrase",
    "changePassphrase",
    "upgrade",
    "rescan",
    "serverInfo",
    "sync",
    "propose",
    "send",
    "rebroadcast",
    "shield",
    "history",
];

pub(crate) fn version() -> Value {
    json!({
        "engine": "devoid-engine",
        "version": env!("CARGO_PKG_VERSION"),
        "protocol": PROTOCOL_VERSION,
        "networks": ["main", "test"],
        "maxRecipientsPerTx": spend::MAX_RECIPIENTS_PER_TX,
        "maxTxBytes": spend::MAX_STANDARD_TX_BYTES,
        "commands": COMMANDS,
    })
}

fn bad_request(message: impl Into<String>) -> Failure {
    Failure::new("bad_request", message)
}

fn text_field<'a>(req: &'a Value, key: &str) -> Option<&'a str> {
    req.get(key).and_then(Value::as_str)
}

fn required_text<'a>(req: &'a Value, key: &str) -> R<&'a str> {
    text_field(req, key)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| bad_request(format!("The request is missing \"{key}\".")))
}

fn wallet_paths(req: &Value) -> R<WalletPaths> {
    Ok(WalletPaths::new(required_text(req, "wallet")?))
}

fn open_wallet(req: &Value) -> R<Wallet> {
    Wallet::open(wallet_paths(req)?)
}

/// The network of the wallet in the request's folder, or the one the request names when there is
/// no wallet yet (so the server can be tested before creating one).
fn network_of(req: &Value, paths: &WalletPaths) -> R<zcash_protocol::consensus::Network> {
    if Keys::exists(paths) {
        return Ok(Keys::read(paths)?.network);
    }
    parse_network(text_field(req, "network").unwrap_or("main"))
}

fn optional_height(req: &Value, key: &str) -> R<Option<u32>> {
    match req.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .map(Some)
            .ok_or_else(|| bad_request(format!("{key} must be a block height."))),
    }
}

async fn create(req: &Value) -> R<Value> {
    let paths = wallet_paths(req)?;
    let network = parse_network(text_field(req, "network").unwrap_or("main"))?;
    let passphrase = required_text(req, "passphrase")?;
    let phrase = text_field(req, "phrase")
        .map(str::trim)
        .filter(|p| !p.is_empty());
    let connection = Connection::from_json(req.get("connection"), network)?;
    wallet::create_or_restore(
        &paths,
        CreateArgs {
            network,
            passphrase,
            phrase,
            birthday_height: optional_height(req, "birthdayHeight")?,
            account_name: text_field(req, "accountName").unwrap_or(wallet::DEFAULT_ACCOUNT_NAME),
        },
        &connection,
    )
    .await
}

/// Runs one time-budgeted slice of synchronisation.
async fn sync(req: &Value) -> R<Value> {
    let mut wallet = open_wallet(req)?;
    let connection = Connection::from_json(req.get("connection"), wallet.params)?;
    let budget_secs = req
        .get("budgetSecs")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_SYNC_BUDGET_SECS)
        .clamp(MIN_SYNC_BUDGET_SECS, MAX_SYNC_BUDGET_SECS);
    let enhance = req.get("enhance").and_then(Value::as_bool).unwrap_or(true);

    out::progress("connect", json!({}));
    let mut link = connection.open(wallet.params, &wallet.paths).await?;
    let mut cache = open_block_cache(&wallet.paths)?;
    let report = sync_slice(
        &mut link.client,
        wallet.params,
        &wallet.paths,
        &mut wallet.db,
        &mut cache,
        &Budget::from_secs(budget_secs),
        &SyncOptions { enhance },
    )
    .await?;

    Ok(json!({
        "synced": report.synced,
        "chainTip": report.chain_tip,
        "blocksScanned": report.blocks_scanned,
        "transactionsFetched": report.transactions_fetched,
        "budgetExpired": report.budget_expired,
        "server": link.server,
    }))
}

/// Executes the command in `req`.
pub(crate) async fn run(req: Value) -> R<Value> {
    let cmd = text_field(&req, "cmd").ok_or_else(|| bad_request("The request has no \"cmd\"."))?;
    match cmd {
        "version" => Ok(version()),
        "selftest" => selftest::run(&req).await,

        "info" => wallet::info(&wallet_paths(&req)?),
        "create" => create(&req).await,
        "balance" => wallet::balance(&open_wallet(&req)?),
        "addresses" => wallet::addresses(&open_wallet(&req)?),
        "newAddress" => wallet::new_address(&mut open_wallet(&req)?),
        "history" => history::history(&open_wallet(&req)?, &req),

        "revealPhrase" => {
            let wallet = open_wallet(&req)?;
            wallet::reveal_phrase(&wallet, required_text(&req, "passphrase")?)
        }
        "verifyPassphrase" => {
            let wallet = open_wallet(&req)?;
            wallet::verify_passphrase(&wallet, required_text(&req, "passphrase")?)
        }
        "changePassphrase" => {
            let mut wallet = open_wallet(&req)?;
            wallet::change_passphrase(
                &mut wallet,
                required_text(&req, "passphrase")?,
                required_text(&req, "newPassphrase")?,
            )
        }
        "upgrade" => wallet::upgrade(&wallet_paths(&req)?, required_text(&req, "passphrase")?),
        "rescan" => {
            let paths = wallet_paths(&req)?;
            let network = network_of(&req, &paths)?;
            let connection = Connection::from_json(req.get("connection"), network)?;
            wallet::rescan(&paths, required_text(&req, "passphrase")?, &connection).await
        }
        "serverInfo" => {
            let paths = wallet_paths(&req)?;
            let network = network_of(&req, &paths)?;
            let connection = Connection::from_json(req.get("connection"), network)?;
            wallet::server_info(&paths, network, &connection).await
        }
        "sync" => sync(&req).await,

        "propose" => spend::propose(&mut open_wallet(&req)?, &req),
        "send" => {
            let mut wallet = open_wallet(&req)?;
            let connection = Connection::from_json(req.get("connection"), wallet.params)?;
            spend::send(
                &mut wallet,
                &req,
                required_text(&req, "passphrase")?,
                &connection,
            )
            .await
        }
        "rebroadcast" => {
            let wallet = open_wallet(&req)?;
            let connection = Connection::from_json(req.get("connection"), wallet.params)?;
            spend::rebroadcast(&wallet, &req, &connection).await
        }
        "shield" => {
            let mut wallet = open_wallet(&req)?;
            if req.get("dryRun").and_then(Value::as_bool).unwrap_or(false) {
                return spend::propose_shield(&mut wallet, &req);
            }
            let connection = Connection::from_json(req.get("connection"), wallet.params)?;
            spend::shield(
                &mut wallet,
                &req,
                required_text(&req, "passphrase")?,
                &connection,
            )
            .await
        }

        other => Err(Failure::new(
            "unknown_command",
            format!("The engine has no command {other:?}."),
        )),
    }
}
