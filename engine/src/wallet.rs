//! Creating, restoring, opening and inspecting a wallet.
//!
//! The wallet-creation flow follows zcash-devtool's `wallet init` and `wallet restore-mnemonic`
//! (MIT OR Apache-2.0). Devoid has exactly one account (ZIP 32 account 0) per wallet folder.

use bip0039::{Count, English, Mnemonic};
use secrecy::ExposeSecret;
use serde_json::{Value, json};
use tonic::transport::Channel;
use zcash_client_backend::{
    data_api::{
        Account, AccountBirthday, Balance, WalletRead, WalletWrite, chain::ChainState,
        wallet::ConfirmationsPolicy,
    },
    proto::service::{self, compact_tx_streamer_client::CompactTxStreamerClient},
};
use zcash_client_sqlite::{
    AccountUuid,
    wallet::init::{WalletMigrationError, init_wallet_db},
};
use zcash_keys::{address::Address, keys::UnifiedAddressRequest};
use zcash_protocol::consensus::{BlockHeight, Network, NetworkUpgrade, Parameters};

use crate::{
    data::{Db, WalletPaths, init_dbs, network_name, open_db},
    failure::{Failure, R},
    keystore::{self, Keys},
    remote::Connection,
    sync::clear_block_cache,
};

pub(crate) const DEFAULT_ACCOUNT_NAME: &str = "Devoid";

/// How far below the chain tip a brand-new wallet's birthday is set, as a margin against reorgs.
const NEW_WALLET_BIRTHDAY_MARGIN: u32 = 100;

/// An open wallet: its keys file, network and database.
pub(crate) struct Wallet {
    pub(crate) paths: WalletPaths,
    pub(crate) keys: Keys,
    pub(crate) params: Network,
    pub(crate) db: Db,
}

/// Applies any pending database migrations. Some need the wallet seed; if so this fails with a
/// code the caller can answer by running `upgrade` with the passphrase.
fn migrate(db: &mut Db, seed: Option<secrecy::SecretVec<u8>>) -> R<()> {
    match init_wallet_db(db, seed) {
        Ok(()) => Ok(()),
        Err(schemerz::MigratorError::Migration { error, .. })
            if matches!(error, WalletMigrationError::SeedRequired) =>
        {
            Err(Failure::new(
                "upgrade_needs_passphrase",
                "This wallet's database needs an upgrade that requires your passphrase.",
            ))
        }
        Err(e) => Err(Failure::new(
            "db_migration_failed",
            format!("The wallet database could not be upgraded: {e}"),
        )),
    }
}

impl Wallet {
    /// Opens the wallet in `paths`, upgrading its database if the engine is newer than it.
    pub(crate) fn open(paths: WalletPaths) -> R<Self> {
        let keys = Keys::read(&paths)?;
        let params = keys.network;
        let mut db = open_db(params, &paths)?;
        migrate(&mut db, None)?;
        Ok(Self {
            paths,
            keys,
            params,
            db,
        })
    }

    pub(crate) fn account_id(&self) -> R<AccountUuid> {
        self.db
            .get_account_ids()?
            .into_iter()
            .next()
            .ok_or_else(|| Failure::new("no_account", "This wallet has no account."))
    }

    pub(crate) fn account(&self) -> R<<Db as WalletRead>::Account> {
        let id = self.account_id()?;
        self.db
            .get_account(id)?
            .ok_or_else(|| Failure::new("no_account", "This wallet has no account."))
    }
}

/// True when consensus forbids value flowing into the Orchard pool and shielded funds live in
/// Ironwood instead (NU6.3 and later).
pub(crate) fn ironwood_active_at(params: &Network, height: BlockHeight) -> bool {
    params
        .activation_height(NetworkUpgrade::Nu6_3)
        .is_some_and(|activation| height >= activation)
}

async fn chain_tip(client: &mut CompactTxStreamerClient<Channel>) -> R<u32> {
    let latest = client
        .get_latest_block(service::ChainSpec::default())
        .await
        .map_err(anyhow::Error::from)?
        .into_inner();
    u32::try_from(latest.height).map_err(|_| {
        Failure::new(
            "bad_server",
            "The server reported an impossible chain height.",
        )
    })
}

/// Builds the account birthday: the chain state (note commitment tree frontiers and block hash) as
/// of the block *prior* to the birthday height.
async fn wallet_birthday(
    client: &mut CompactTxStreamerClient<Channel>,
    params: &Network,
    birthday_height: BlockHeight,
    recover_until: Option<BlockHeight>,
) -> R<AccountBirthday> {
    // A shielded wallet's birthday cannot meaningfully precede Sapling activation: there is no
    // note commitment tree before then, and lightwalletd rejects `GetTreeState` for any height
    // below it.
    let sapling_activation = params
        .activation_height(NetworkUpgrade::Sapling)
        .ok_or_else(|| {
            Failure::new(
                "internal",
                "Sapling activation height is not set for this network.",
            )
        })?;
    let birthday_height = birthday_height.max(sapling_activation);

    let birthday = if birthday_height == sapling_activation {
        // Edge case: the block prior to the birthday is the last pre-Sapling block, whose note
        // commitment trees are empty and whose tree state the server cannot serve. Construct an
        // empty chain state directly, taking the prior block's hash from the birthday block's
        // `prev_hash` so block scanning can still verify chain continuity.
        let birthday_block = client
            .get_block(service::BlockId {
                height: u64::from(birthday_height),
                ..Default::default()
            })
            .await
            .map_err(anyhow::Error::from)?
            .into_inner();
        AccountBirthday::from_parts(
            ChainState::empty(
                birthday_height.saturating_sub(1),
                birthday_block.prev_hash(),
            ),
            recover_until,
        )
    } else {
        // Fetch the tree state corresponding to the last block prior to the wallet's birthday
        // height. NOTE: this leaks the birthday height to the server.
        let request = service::BlockId {
            height: u64::from(birthday_height) - 1,
            ..Default::default()
        };
        let treestate = client
            .get_tree_state(request)
            .await
            .map_err(anyhow::Error::from)?
            .into_inner();
        AccountBirthday::from_treestate(treestate, recover_until).map_err(|_| {
            Failure::new(
                "birthday_failed",
                "The server sent an invalid chain state for the wallet birthday.",
            )
        })?
    };

    Ok(birthday)
}

/// Removes every file the engine created in a wallet folder (and nothing else).
pub(crate) fn wipe_wallet_files(paths: &WalletPaths) {
    for name in [
        "keys.json",
        "keys.json.tmp",
        "data.sqlite",
        "data.sqlite-wal",
        "data.sqlite-shm",
        "data.sqlite-journal",
        "blockmeta.sqlite",
        "blockmeta.sqlite-wal",
        "blockmeta.sqlite-shm",
        "blockmeta.sqlite-journal",
    ] {
        let _ = std::fs::remove_file(paths.root().join(name));
    }
    clear_block_cache(paths);
    let _ = std::fs::remove_dir(paths.blocks_dir());
}

pub(crate) struct CreateArgs<'a> {
    pub(crate) network: Network,
    pub(crate) passphrase: &'a str,
    /// `None` generates a new recovery phrase; `Some` restores from it.
    pub(crate) phrase: Option<&'a str>,
    /// First block that may contain the wallet's funds. New wallets default to just below the tip,
    /// restored wallets to Sapling activation.
    pub(crate) birthday_height: Option<u32>,
    pub(crate) account_name: &'a str,
}

/// Creates a new wallet or restores one from a recovery phrase.
pub(crate) async fn create_or_restore(
    paths: &WalletPaths,
    args: CreateArgs<'_>,
    connection: &Connection,
) -> R<Value> {
    if Keys::exists(paths) || paths.exists() {
        return Err(Failure::new(
            "wallet_exists",
            "A wallet already exists in this folder.",
        ));
    }
    keystore::check_passphrase(args.passphrase)?;

    // Validate the phrase before touching the network or the disk.
    let restoring = args.phrase.is_some();
    let mnemonic: Mnemonic<English> = match args.phrase {
        Some(phrase) => keystore::parse_phrase(phrase)?,
        None => Mnemonic::generate(Count::Words24),
    };

    let mut link = connection.open(args.network, paths).await?;
    let tip = chain_tip(&mut link.client).await?;

    let birthday_height = match (args.birthday_height, restoring) {
        (Some(h), _) => h,
        (None, false) => tip.saturating_sub(NEW_WALLET_BIRTHDAY_MARGIN),
        (None, true) => args
            .network
            .activation_height(NetworkUpgrade::Sapling)
            .map(u32::from)
            .unwrap_or(0),
    };
    if birthday_height > tip {
        return Err(Failure::new(
            "bad_birthday",
            format!("The birthday {birthday_height} is after the current chain height {tip}."),
        ));
    }

    // A restored wallet scans the whole range up to the tip for funds ("recovery"); a new wallet
    // cannot have any history.
    let recover_until = restoring.then(|| BlockHeight::from_u32(tip));
    let birthday = wallet_birthday(
        &mut link.client,
        &args.network,
        BlockHeight::from_u32(birthday_height),
        recover_until,
    )
    .await?;

    let phrase = mnemonic.phrase().to_string();
    let seed = keystore::seed_from_mnemonic(&mnemonic);
    drop(mnemonic);

    // From here on, a failure must not leave a half-created wallet behind.
    let result = (|| -> R<Value> {
        let keys = Keys::create(
            paths,
            args.network,
            u32::from(birthday.height()),
            &phrase,
            args.passphrase,
        )?;
        let mut db = init_dbs(args.network, paths)?;
        let (account_id, _usk) = db.create_account(args.account_name, &seed, &birthday, None)?;
        let account = db
            .get_account(account_id)?
            .ok_or_else(|| Failure::new("internal", "The new account could not be read back."))?;
        Ok(json!({
            "network": network_name(args.network),
            "birthday": keys.birthday,
            "accountId": account_id.expose_uuid().to_string(),
            "addresses": addresses_json(&args.network, &account)?,
            "restored": restoring,
        }))
    })();

    match result {
        Ok(mut value) => {
            if !restoring {
                // The phrase is returned exactly once, to be written down by the person.
                value["phrase"] = Value::String(phrase);
            }
            Ok(value)
        }
        Err(e) => {
            wipe_wallet_files(paths);
            Err(e)
        }
    }
}

/// Offline summary of the folder: whether a wallet exists and what it is.
pub(crate) fn info(paths: &WalletPaths) -> R<Value> {
    if !Keys::exists(paths) {
        return Ok(json!({ "exists": false }));
    }
    let wallet = Wallet::open(paths.clone())?;
    let chain_height = wallet.db.chain_height()?;
    let tip_or_zero = chain_height.unwrap_or(BlockHeight::from_u32(0));
    let ironwood_activation = wallet
        .params
        .activation_height(NetworkUpgrade::Nu6_3)
        .map(u32::from);
    Ok(json!({
        "exists": true,
        "network": network_name(wallet.params),
        "birthday": wallet.keys.birthday,
        "createdAt": wallet.keys.created_at,
        "accountId": wallet.account_id()?.expose_uuid().to_string(),
        "chainHeight": chain_height.map(u32::from),
        "ironwoodActivationHeight": ironwood_activation,
        "ironwoodActive": chain_height.is_some() && ironwood_active_at(&wallet.params, tip_or_zero + 1),
    }))
}

fn balance_json(balance: &Balance) -> Value {
    json!({
        "spendable": balance.spendable_value().into_u64(),
        "pendingChange": balance.change_pending_confirmation().into_u64(),
        "pendingReceived": balance.value_pending_spendability().into_u64(),
        "locked": balance.locked_value().into_u64(),
        "uneconomic": balance.uneconomic_value().into_u64(),
        "total": balance.total().into_u64(),
    })
}

/// Offline balances per pool, with the wallet's sync progress.
pub(crate) fn balance(wallet: &Wallet) -> R<Value> {
    let account_id = wallet.account_id()?;
    let chain_height = wallet.db.chain_height()?;
    let ironwood_active = chain_height
        .map(|h| ironwood_active_at(&wallet.params, h + 1))
        .unwrap_or(false);

    let summary = wallet
        .db
        .get_wallet_summary(ConfirmationsPolicy::default())?;
    let Some(summary) = summary else {
        return Ok(json!({
            "ready": false,
            "chainHeight": chain_height.map(u32::from),
            "ironwoodActive": ironwood_active,
            "total": 0,
            "spendable": 0,
        }));
    };
    let Some(balance) = summary.account_balances().get(&account_id) else {
        return Err(Failure::new(
            "internal",
            "The wallet summary does not include the account.",
        ));
    };

    let scan = summary.progress().scan();
    let recovery = summary.progress().recovery();
    let (scan_n, scan_d) = (*scan.numerator(), *scan.denominator());
    let (rec_n, rec_d) = recovery
        .map(|r| (*r.numerator(), *r.denominator()))
        .unwrap_or((0, 0));
    let fraction = if scan_d + rec_d == 0 {
        1.0
    } else {
        ((scan_n + rec_n) as f64 / (scan_d + rec_d) as f64).clamp(0.0, 1.0)
    };

    Ok(json!({
        "ready": true,
        "chainHeight": u32::from(summary.chain_tip_height()),
        "fullyScannedHeight": u32::from(summary.fully_scanned_height()),
        "scanFraction": fraction,
        "ironwoodActive": ironwood_active,
        "total": balance.total().into_u64(),
        "spendable": balance.spendable_value().into_u64(),
        "pendingChange": balance.change_pending_confirmation().into_u64(),
        "pendingReceived": balance.value_pending_spendability().into_u64(),
        "pools": {
            "ironwood": balance_json(balance.ironwood_balance()),
            "orchard": balance_json(balance.orchard_balance()),
            "sapling": balance_json(balance.sapling_balance()),
            "transparent": balance_json(&balance.unshielded_balance()),
        },
    }))
}

/// The wallet's receiving addresses.
///
/// * `shielded`: a unified address with Orchard and Sapling receivers and no transparent one, so
///   nothing sent to it can land in the transparent pool;
/// * `sapling`: the same account's bare Sapling address, for senders that cannot use unified
///   addresses;
/// * `transparent`: a transparent address, for exchanges that cannot pay shielded addresses (funds
///   arriving there must be shielded before they can be sent privately).
pub(crate) fn addresses_json(params: &Network, account: &impl Account) -> R<Value> {
    let uivk = account.uivk();
    let (shielded, _) = uivk
        .default_address(UnifiedAddressRequest::SHIELDED)
        .map_err(|e| {
            Failure::new(
                "internal",
                format!("Could not derive the shielded address: {e:?}"),
            )
        })?;
    let (all, _) = uivk
        .default_address(UnifiedAddressRequest::AllAvailableKeys)
        .map_err(|e| Failure::new("internal", format!("Could not derive the address: {e:?}")))?;

    let transparent = all
        .transparent()
        .map(|addr| Address::from(*addr).encode(params));
    let sapling = all
        .sapling()
        .map(|addr| Address::from(*addr).encode(params));

    Ok(json!({
        "shielded": shielded.encode(params),
        "sapling": sapling,
        "transparent": transparent,
    }))
}

pub(crate) fn addresses(wallet: &Wallet) -> R<Value> {
    let account = wallet.account()?;
    addresses_json(&wallet.params, &account)
}

/// Generates a fresh diversified shielded address (never reused for the same payer by accident).
pub(crate) fn new_address(wallet: &mut Wallet) -> R<Value> {
    let account_id = wallet.account_id()?;
    let (ua, _) = wallet
        .db
        .get_next_available_address(account_id, UnifiedAddressRequest::SHIELDED)?
        .ok_or_else(|| Failure::new("no_account", "This wallet has no account."))?;
    Ok(json!({ "shielded": ua.encode(&wallet.params) }))
}

pub(crate) fn reveal_phrase(wallet: &Wallet, passphrase: &str) -> R<Value> {
    let phrase = wallet.keys.phrase(passphrase)?;
    let text = std::str::from_utf8(phrase.expose_secret())
        .map_err(|_| Failure::new("keys_unreadable", "The stored recovery phrase is not text."))?;
    Ok(json!({ "phrase": text }))
}

/// Checks a passphrase by decrypting the keystore, and returns nothing but the verdict.
/// The server uses this before a batch send so it never has to ask for the phrase itself.
pub(crate) fn verify_passphrase(wallet: &Wallet, passphrase: &str) -> R<Value> {
    wallet.keys.phrase(passphrase)?;
    Ok(json!({ "verified": true }))
}

pub(crate) fn change_passphrase(wallet: &mut Wallet, old: &str, new: &str) -> R<Value> {
    wallet.keys.change_passphrase(&wallet.paths, old, new)?;
    Ok(json!({ "changed": true }))
}

/// Applies database upgrades that need the wallet seed.
pub(crate) fn upgrade(paths: &WalletPaths, passphrase: &str) -> R<Value> {
    let keys = Keys::read(paths)?;
    let mut db = open_db(keys.network, paths)?;
    let seed = keys.seed(passphrase)?;
    migrate(&mut db, Some(seed))?;
    Ok(json!({ "upgraded": true }))
}

/// Throws away everything the wallet has learned about the chain and rebuilds it from the
/// birthday. Keys are kept. Used to recover from a damaged database or a very deep reorg.
pub(crate) async fn rescan(
    paths: &WalletPaths,
    passphrase: &str,
    connection: &Connection,
) -> R<Value> {
    let keys = Keys::read(paths)?;
    let seed = keys.seed(passphrase)?;
    let mut link = connection.open(keys.network, paths).await?;
    let tip = chain_tip(&mut link.client).await?;
    let birthday = wallet_birthday(
        &mut link.client,
        &keys.network,
        BlockHeight::from_u32(keys.birthday),
        Some(BlockHeight::from_u32(tip)),
    )
    .await?;

    // Move the old state aside until the new one exists, so a failure loses nothing.
    let backup = paths.root().join("rescan-backup");
    let _ = std::fs::remove_dir_all(&backup);
    std::fs::create_dir_all(&backup)?;
    for name in [
        "data.sqlite",
        "data.sqlite-wal",
        "data.sqlite-shm",
        "blockmeta.sqlite",
    ] {
        let from = paths.root().join(name);
        if from.exists() {
            std::fs::rename(&from, backup.join(name))?;
        }
    }
    clear_block_cache(paths);

    let rebuilt = (|| -> R<()> {
        let mut db = init_dbs(keys.network, paths)?;
        db.create_account(DEFAULT_ACCOUNT_NAME, &seed, &birthday, None)?;
        Ok(())
    })();

    match rebuilt {
        Ok(()) => {
            let _ = std::fs::remove_dir_all(&backup);
            Ok(json!({ "rescanFrom": keys.birthday }))
        }
        Err(e) => {
            // Put the old database back.
            for name in [
                "data.sqlite",
                "data.sqlite-wal",
                "data.sqlite-shm",
                "blockmeta.sqlite",
            ] {
                let _ = std::fs::remove_file(paths.root().join(name));
                let saved = backup.join(name);
                if saved.exists() {
                    let _ = std::fs::rename(&saved, paths.root().join(name));
                }
            }
            let _ = std::fs::remove_dir_all(&backup);
            Err(e)
        }
    }
}

/// Connects and reports what the server says about itself.
pub(crate) async fn server_info(
    paths: &WalletPaths,
    network: Network,
    connection: &Connection,
) -> R<Value> {
    let link = connection.open(network, paths).await?;
    let mut info = link.info_json();
    info["mode"] = Value::String(connection.mode().name());
    Ok(info)
}
