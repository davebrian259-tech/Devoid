//! What the engine needs from the system it runs on, for the native command-line build.
//!
//! The wallet logic (`sync`, `spend`, `wallet`, `keystore`, `history`, `commands`) is shared with
//! the in-browser build in `web-engine/`, which compiles the same files against its own
//! `platform` module: gRPC-web instead of a gRPC channel, an in-memory block cache instead of
//! block files, storage the page persists instead of a folder. Everything that differs between
//! the two lives behind the names defined here, and nothing else in the shared files may reach
//! for the operating system directly.

use std::{future::Future, path::Path, time::Duration};

use prost::Message;
use tracing::error;
use zcash_client_backend::proto::{
    compact_formats::CompactBlock, service::compact_tx_streamer_client::CompactTxStreamerClient,
};
use zcash_client_sqlite::{
    FsBlockDb,
    chain::{BlockMeta, init::init_blockmeta_db},
};
use zcash_proofs::prover::LocalTxProver;
use zcash_protocol::consensus::BlockHeight;

use crate::{data::WalletPaths, error, failure::R};

pub(crate) use std::time::{Instant, SystemTime, UNIX_EPOCH};
/// The clock the wallet database records times with.
pub(crate) use zcash_client_sqlite::util::SystemClock as WalletClock;

/// The transport under the lightwalletd client.
pub(crate) type Transport = tonic::transport::Channel;
/// A lightwalletd client.
pub(crate) type Client = CompactTxStreamerClient<Transport>;

/// The deadline passed before the future finished.
#[derive(Debug)]
pub(crate) struct Elapsed;

/// Runs `future` for at most `limit`.
pub(crate) async fn timeout<F: Future>(limit: Duration, future: F) -> Result<F::Output, Elapsed> {
    tokio::time::timeout(limit, future)
        .await
        .map_err(|_| Elapsed)
}

/// Writes one line of output for the caller (stdout; see `out`).
pub(crate) fn write_line(text: &str) {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    // A closed stdout means the parent went away; there is nobody left to tell.
    let _ = out.write_all(text.as_bytes());
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}

/// The Sapling prover. The native build carries the parameters inside the binary.
pub(crate) type Prover = LocalTxProver;

/// Returns the Sapling prover. `needs_spend` says whether the transaction spends Sapling notes
/// (the browser build only loads the large spend parameters when it does).
pub(crate) async fn prover(_needs_spend: bool) -> R<Prover> {
    Ok(LocalTxProver::bundled())
}

/// The self-test's name for its prover check.
pub(crate) const PROVER_CHECK: &str = "bundled-prover-parameters";

/// Self-test: the Sapling parameters load. Loading parses and validates them; the proofs
/// themselves are exercised the first time a payment is built.
pub(crate) fn check_prover() -> Result<String, String> {
    let _prover = LocalTxProver::bundled();
    Ok("the Sapling proving parameters are bundled and load".to_string())
}

/// A folder for the self-test's throw-away wallet.
pub(crate) fn scratch_dir() -> std::path::PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("devoid-selftest-{}-{nanos}", std::process::id()))
}

/// Files in the wallet folder.
pub(crate) mod files {
    use std::{fs, io, io::Write, path::Path};

    pub(crate) fn is_file(path: &Path) -> bool {
        path.is_file()
    }

    pub(crate) fn exists(path: &Path) -> bool {
        path.exists()
    }

    pub(crate) fn read_to_string(path: &Path) -> io::Result<String> {
        fs::read_to_string(path)
    }

    pub(crate) fn create_dir_all(path: &Path) -> io::Result<()> {
        fs::create_dir_all(path)
    }

    pub(crate) fn remove_file(path: &Path) -> io::Result<()> {
        fs::remove_file(path)
    }

    pub(crate) fn remove_dir(path: &Path) -> io::Result<()> {
        fs::remove_dir(path)
    }

    pub(crate) fn remove_dir_all(path: &Path) -> io::Result<()> {
        fs::remove_dir_all(path)
    }

    pub(crate) fn rename(from: &Path, to: &Path) -> io::Result<()> {
        fs::rename(from, to)
    }

    #[cfg(unix)]
    fn open_private(path: &Path, create_new: bool) -> io::Result<fs::File> {
        use std::os::unix::fs::OpenOptionsExt;
        let mut options = fs::OpenOptions::new();
        options.write(true).mode(0o600);
        if create_new {
            options.create_new(true);
        } else {
            options.create(true).truncate(true);
        }
        options.open(path)
    }

    #[cfg(not(unix))]
    fn open_private(path: &Path, create_new: bool) -> io::Result<fs::File> {
        let mut options = fs::OpenOptions::new();
        options.write(true);
        if create_new {
            options.create_new(true);
        } else {
            options.create(true).truncate(true);
        }
        options.open(path)
    }

    /// Creates a file readable only by its owner; fails with `AlreadyExists` if there is one.
    pub(crate) fn write_new_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
        let mut file = open_private(path, true)?;
        file.write_all(bytes)?;
        file.sync_all()
    }

    /// Replaces a file readable only by its owner, atomically: the new content is written next to
    /// it and renamed over it, so a failure leaves the old file intact.
    pub(crate) fn replace_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
        let mut name = path.file_name().unwrap_or_default().to_os_string();
        name.push(".tmp");
        let tmp = path.with_file_name(name);
        let result = (|| {
            let mut file = open_private(&tmp, false)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            fs::rename(&tmp, path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        result
    }
}

/// Compact blocks waiting to be scanned: one file per block under `blocks/`, indexed in
/// `blockmeta.sqlite`, and deleted again once scanned.
pub(crate) struct BlockCache {
    db: FsBlockDb,
    paths: WalletPaths,
}

impl BlockCache {
    /// Creates the cache's index for a new wallet.
    pub(crate) fn init(paths: &WalletPaths) -> R<()> {
        let mut db = FsBlockDb::for_path(paths.root()).map_err(error::Error::from)?;
        init_blockmeta_db(&mut db)?;
        Ok(())
    }

    pub(crate) fn open(paths: &WalletPaths) -> R<Self> {
        Ok(Self {
            db: FsBlockDb::for_path(paths.root()).map_err(error::Error::from)?,
            paths: paths.clone(),
        })
    }

    /// What `scan_cached_blocks` reads from.
    pub(crate) fn source(&self) -> &FsBlockDb {
        &self.db
    }

    /// Stores one downloaded block and returns its metadata. It is scanned only after `index`.
    pub(crate) async fn store(&self, block: CompactBlock) -> anyhow::Result<BlockMeta> {
        use tokio::io::AsyncWriteExt;
        let meta = block_meta(&block);
        let encoded = block.encode_to_vec();
        let mut file = tokio::fs::File::create(self.paths.block_path(&meta)).await?;
        file.write_all(&encoded).await?;
        Ok(meta)
    }

    /// Makes stored blocks visible to the scanner.
    pub(crate) fn index(&mut self, metas: &[BlockMeta]) -> R<()> {
        self.db
            .write_block_metadata(metas)
            .map_err(error::Error::from)?;
        Ok(())
    }

    /// Deletes blocks that have been scanned, because keeping the entire chain in compact block
    /// files on disk is horrendous for the filesystem.
    pub(crate) async fn discard(&mut self, metas: Vec<BlockMeta>) {
        for meta in metas {
            if let Err(e) = tokio::fs::remove_file(self.paths.block_path(&meta)).await {
                // A file already removed (e.g. by a reorg rewind that deleted the orphaned
                // suffix) is not an error worth reporting.
                if e.kind() != std::io::ErrorKind::NotFound {
                    error!("Failed to remove {:?}: {}", meta, e);
                }
            }
        }
    }

    /// Forgets every block above `height` (after a reorg).
    pub(crate) fn truncate_to_height(&mut self, height: BlockHeight) -> R<()> {
        delete_block_files_above(&self.paths.blocks_dir(), height);
        self.db
            .truncate_to_height(height)
            .map_err(|e| anyhow::anyhow!("{:?}", e))?;
        Ok(())
    }

    /// Removes every cached block file; used when a wallet is reset or rescanned.
    pub(crate) fn clear(paths: &WalletPaths) {
        if let Ok(entries) = std::fs::read_dir(paths.blocks_dir()) {
            for entry in entries.flatten() {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// The metadata the cache's index keeps for a block.
pub(crate) fn block_meta(block: &CompactBlock) -> BlockMeta {
    let (sapling_outputs_count, orchard_actions_count) = block
        .vtx
        .iter()
        .map(|tx| (tx.outputs.len() as u32, tx.actions.len() as u32))
        .fold((0, 0), |(acc_sapling, acc_orchard), (sapling, orchard)| {
            (acc_sapling + sapling, acc_orchard + orchard)
        });
    BlockMeta {
        height: block.height(),
        block_hash: block.hash(),
        block_time: block.time,
        sapling_outputs_count,
        orchard_actions_count,
    }
}

/// Deletes cached compact-block files whose height is above `height`, tolerating files that are
/// already gone. Files are named `<height>-<hash>-compactblock`, so the height is the leading
/// component.
fn delete_block_files_above(dir: &Path, height: BlockHeight) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let file_height = entry
            .file_name()
            .to_str()
            .and_then(|n| n.split('-').next())
            .and_then(|h| h.parse::<u32>().ok());
        if file_height.is_some_and(|h| h > u32::from(height)) {
            if let Err(e) = std::fs::remove_file(entry.path())
                && e.kind() != std::io::ErrorKind::NotFound
            {
                error!("Failed to delete cached block {:?}: {}", entry.path(), e);
            }
        }
    }
}
