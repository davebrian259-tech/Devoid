//! Wallet directory layout and database set-up.
//!
//! Follows zcash-devtool's data.rs (MIT OR Apache-2.0), restricted to mainnet and testnet. A
//! wallet is one directory:
//!
//! ```text
//! <wallet dir>/
//!   keys.json          network, birthday and the passphrase-encrypted recovery phrase
//!   data.sqlite        the wallet database (zcash_client_sqlite)
//!   blockmeta.sqlite   metadata for cached compact blocks
//!   blocks/            compact blocks waiting to be scanned (deleted after scanning)
//!   tor/               state of the built-in Tor client
//! ```

use std::path::{Path, PathBuf};

use rand::rngs::OsRng;
use zcash_client_sqlite::{
    WalletDb, chain::BlockMeta, util::SystemClock, wallet::init::init_wallet_db,
};
use zcash_protocol::consensus::Network;

use crate::{
    failure::{Failure, R},
    platform::{BlockCache, files},
};

const BLOCKS_FOLDER: &str = "blocks";
const DATA_DB: &str = "data.sqlite";
const TOR_DIR: &str = "tor";

/// The wallet database type used throughout the engine.
pub(crate) type Db = WalletDb<rusqlite::Connection, Network, SystemClock, OsRng>;

pub(crate) fn parse_network(name: &str) -> R<Network> {
    match name {
        "main" => Ok(Network::MainNetwork),
        "test" => Ok(Network::TestNetwork),
        other => Err(Failure::new(
            "bad_request",
            format!("Unsupported network {other:?}: expected \"main\" or \"test\"."),
        )),
    }
}

pub(crate) fn network_name(network: Network) -> &'static str {
    match network {
        Network::MainNetwork => "main",
        Network::TestNetwork => "test",
    }
}

/// Where the files of one wallet live.
#[derive(Clone, Debug)]
pub(crate) struct WalletPaths {
    root: PathBuf,
}

impl WalletPaths {
    pub(crate) fn new(root: impl AsRef<Path>) -> Self {
        Self {
            root: root.as_ref().to_owned(),
        }
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn data_db(&self) -> PathBuf {
        self.root.join(DATA_DB)
    }

    pub(crate) fn blocks_dir(&self) -> PathBuf {
        self.root.join(BLOCKS_FOLDER)
    }

    pub(crate) fn tor_dir(&self) -> PathBuf {
        self.root.join(TOR_DIR)
    }

    pub(crate) fn block_path(&self, meta: &BlockMeta) -> PathBuf {
        meta.block_file_path(&self.blocks_dir())
    }

    pub(crate) fn exists(&self) -> bool {
        files::is_file(&self.data_db())
    }
}

/// Opens (creating and migrating if necessary) the wallet database and the block cache metadata
/// database, and returns the wallet database.
pub(crate) fn init_dbs(params: Network, paths: &WalletPaths) -> R<Db> {
    files::create_dir_all(paths.root())?;
    BlockCache::init(paths)?;
    let mut db_data = WalletDb::for_path(paths.data_db(), params, SystemClock, OsRng)?;
    init_wallet_db(&mut db_data, None)?;
    Ok(db_data)
}

/// Opens an existing wallet database (without running migrations).
pub(crate) fn open_db(params: Network, paths: &WalletPaths) -> R<Db> {
    if !paths.exists() {
        return Err(Failure::new(
            "no_wallet",
            "There is no wallet in this folder yet.",
        ));
    }
    Ok(WalletDb::for_path(
        paths.data_db(),
        params,
        SystemClock,
        OsRng,
    )?)
}

/// Opens the block cache (creating `blocks/` if it is missing).
pub(crate) fn open_block_cache(paths: &WalletPaths) -> R<BlockCache> {
    BlockCache::open(paths)
}
