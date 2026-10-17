//! Chain synchronisation.
//!
//! This is zcash-devtool's `wallet sync` and `wallet enhance` (MIT OR Apache-2.0) restructured
//! to run in a time-boxed slice: the engine is a short-lived process, so instead of running until
//! the wallet is caught up (or the user presses Ctrl-C) it works until a [`Budget`] runs out and
//! reports how far it got. The Node server simply starts another slice until `synced` is true.
//!
//! The algorithm is the one the Zcash light-client libraries prescribe:
//!   1. fetch the note-commitment-tree subtree roots for each shielded pool;
//!   2. fetch the chain tip and tell the wallet, which then proposes scan ranges by priority;
//!   3. verify the range overlapping the previous tip (detecting reorgs), then scan the rest in
//!      batches, downloading compact blocks into the on-disk block cache and deleting them again
//!      once scanned;
//!   4. refresh transparent UTXOs and "enhance" transactions (fetch full transactions so memos,
//!      transparent spends and mined status are known).

use std::{
    collections::BTreeSet,
    path::Path,
    time::{Duration, Instant},
};

use anyhow::anyhow;
use futures_util::{StreamExt, TryStreamExt};
use orchard::tree::MerkleHashOrchard;
use prost::Message;
use serde_json::json;
use tokio::{fs::File, io::AsyncWriteExt};
use tonic::{Code, transport::Channel};
use tracing::{debug, error, info, warn};
use transparent::{
    address::Script,
    bundle::{OutPoint, TxOut},
};
use zcash_client_backend::{
    data_api::{
        TransactionDataRequest, TransactionStatus, WalletCommitmentTrees, WalletRead, WalletWrite,
        chain::{ChainState, CommitmentTreeRoot, error::Error as ChainError, scan_cached_blocks},
        scanning::{ScanPriority, ScanRange},
        wallet::{ConfirmationsPolicy, decrypt_and_store_transaction},
    },
    proto::service::{
        self, BlockId, BlockRange, RawTransaction,
        compact_tx_streamer_client::CompactTxStreamerClient,
    },
    wallet::WalletTransparentOutput,
};
use zcash_client_sqlite::{AccountUuid, FsBlockDb, chain::BlockMeta, error::SqliteClientError};
use zcash_keys::encoding::AddressCodec;
use zcash_primitives::{
    block::BlockHash,
    merkle_tree::HashSer,
    transaction::{Transaction, TxId},
};
use zcash_protocol::{
    consensus::{BlockHeight, BranchId, Network},
    value::Zatoshis,
};
use zcash_script::script;

use crate::{
    data::{Db, WalletPaths},
    failure::{Failure, R},
    out,
};

/// Blocks downloaded and scanned per batch. Small enough that a batch finishes within seconds on an
/// ordinary connection, large enough that per-request overhead is negligible.
const BATCH_SIZE: u32 = 5_000;

/// When a reorg is detected, rewind this many blocks below the reorg point before re-scanning, to
/// give a margin for re-crossing the actual fork height.
const REORG_REWIND_MARGIN: u32 = 10;

/// A server that sends nothing for this long while streaming blocks is considered stalled.
const STREAM_STALL_TIMEOUT: Duration = Duration::from_secs(30);

/// Do not start another batch with less time than this left in the budget.
const MIN_TIME_FOR_BATCH: Duration = Duration::from_secs(5);

/// A soft deadline. Work that has already started is allowed to finish; new work is not started
/// once the budget has run out.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Budget {
    deadline: Instant,
}

impl Budget {
    pub(crate) fn from_secs(secs: u64) -> Self {
        Self {
            deadline: Instant::now() + Duration::from_secs(secs),
        }
    }

    pub(crate) fn expired(&self) -> bool {
        Instant::now() >= self.deadline
    }

    pub(crate) fn remaining(&self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }
}

/// What one sync slice achieved.
#[derive(Debug, Default)]
pub(crate) struct SyncReport {
    /// The wallet has scanned everything up to the chain tip it knows.
    pub(crate) synced: bool,
    pub(crate) chain_tip: u32,
    pub(crate) blocks_scanned: u64,
    /// Transactions fetched and decrypted ("enhanced") or whose status was refreshed.
    pub(crate) transactions_fetched: u32,
    /// The slice ended because its time budget ran out, not because there was nothing left to do.
    pub(crate) budget_expired: bool,
}

pub(crate) struct SyncOptions {
    /// Also fetch full transactions (memos, spends, mined status). This tells the server which
    /// transactions belong to the wallet, so it can be switched off.
    pub(crate) enhance: bool,
}

/// Runs one sync slice.
pub(crate) async fn sync_slice(
    client: &mut CompactTxStreamerClient<Channel>,
    params: Network,
    paths: &WalletPaths,
    db_data: &mut Db,
    db_cache: &mut FsBlockDb,
    budget: &Budget,
    options: &SyncOptions,
) -> R<SyncReport> {
    let mut report = SyncReport::default();

    // 1) Download note commitment tree data from lightwalletd and hand it to the wallet.
    out::progress("subtrees", json!({}));
    update_subtree_roots(client, db_data).await?;

    // 2..4) Chain tip, reorg handling, scan ranges, download and scan.
    loop {
        if budget.expired() {
            report.budget_expired = true;
            break;
        }
        let again = running(
            client,
            params,
            paths,
            db_data,
            db_cache,
            budget,
            &mut report,
        )
        .await?;
        if !again {
            break;
        }
    }

    // Is there anything left to scan?
    report.synced = !report.budget_expired && db_data.suggest_scan_ranges()?.is_empty();

    // Fetch transactions so memos and statuses are known. Only once scanning is finished: the
    // wallet learns which transactions it needs while scanning.
    if options.enhance && report.synced && !budget.expired() {
        out::progress("enhance", json!({}));
        report.transactions_fetched = enhance_transactions(client, params, db_data, budget).await?;
    }

    if let Some(tip) = db_data.chain_height()? {
        report.chain_tip = u32::from(tip);
    }
    Ok(report)
}

/// One pass of the sync loop. Returns `true` if the caller should run another pass because the
/// set of suggested scan ranges changed underneath it.
async fn running(
    client: &mut CompactTxStreamerClient<Channel>,
    params: Network,
    paths: &WalletPaths,
    db_data: &mut Db,
    db_cache: &mut FsBlockDb,
    budget: &Budget,
    report: &mut SyncReport,
) -> R<bool> {
    // 3) Download chain tip metadata from lightwalletd.
    // 4) Notify the wallet of the updated chain tip.
    let (chain_tip, tip_hash) = update_chain_tip(client, db_data).await?;
    report.chain_tip = u32::from(chain_tip);

    // The wallet's `update_chain_tip` intentionally does nothing when the reported tip is below
    // our maximum scanned height: it leaves reorg detection to the scanner's block-continuity
    // check. But when we are already fully synced there are no ranges left to scan, so a reorg
    // that shortens the chain below our scanned height would go unnoticed until the chain grew
    // back past it. Detect that case here, but only for a *genuine* reorg: a reported tip below
    // our scanned height is either a real reorg or merely a lagging server. Distinguish them by
    // comparing the node's tip hash against our stored hash at that height, and rewind only when
    // the hashes actually differ (or we no longer hold that block).
    if let Some(max_scanned) = db_data.block_max_scanned()?.map(|b| b.block_height()) {
        let diverged = chain_tip < max_scanned
            && db_data.block_metadata(chain_tip)?.map(|m| m.block_hash()) != Some(tip_hash);
        if diverged {
            let rewind_height = chain_tip.saturating_sub(REORG_REWIND_MARGIN);
            warn!(
                "Chain tip {} diverges from our history (max scanned {}); reorg detected, rewinding to {}",
                chain_tip, max_scanned, rewind_height,
            );
            rewind(
                db_data,
                db_cache,
                paths,
                chain_tip,
                rewind_height,
                chain_tip,
            )?;
        }
    }

    // Refresh UTXOs for the accounts in the wallet.
    for account_id in db_data.get_account_ids()? {
        info!("Refreshing UTXOs for {:?}", account_id);
        refresh_utxos(&params, client, db_data, account_id, BlockHeight::from(0)).await?;
    }

    // 5) Get the suggested scan ranges from the wallet database.
    info!("Fetching scan ranges");
    let mut scan_ranges = db_data.suggest_scan_ranges()?;
    info!("Fetched {} scan ranges", scan_ranges.len());
    emit_scan_progress(db_data, chain_tip, scan_ranges.first());
    if budget.expired() {
        report.budget_expired = true;
        return Ok(false);
    }

    // 6) Run the following loop until the wallet's view of the chain tip as of the previous
    //    wallet session is valid.
    loop {
        // If there is a range of blocks that needs to be verified, it will always be returned as
        // the first element of the vector of suggested ranges.
        match scan_ranges.first() {
            Some(scan_range) if scan_range.priority() == ScanPriority::Verify => {
                // Download the blocks in `scan_range` into the block source, overwriting any
                // existing blocks in this range.
                let block_meta =
                    download_blocks(client, paths, db_cache, scan_range, budget).await?;
                let chain_state =
                    download_chain_state(client, scan_range.block_range().start - 1).await?;

                // Scan the downloaded blocks and check for scanning errors that indicate the
                // wallet's chain tip is out of sync with blockchain history.
                let scan_ranges_updated = scan_blocks(
                    params,
                    paths,
                    db_cache,
                    db_data,
                    &chain_state,
                    scan_range,
                    chain_tip,
                    report,
                )?;

                // Delete the now-scanned blocks, because keeping the entire chain in
                // CompactBlock files on disk is horrendous for the filesystem.
                delete_cached_blocks(paths, block_meta).await;

                if scan_ranges_updated {
                    // The suggested scan ranges have been updated, so we re-request.
                    scan_ranges = db_data.suggest_scan_ranges()?;
                    emit_scan_progress(db_data, chain_tip, scan_ranges.first());
                    if budget.expired() {
                        report.budget_expired = true;
                        return Ok(false);
                    }
                } else {
                    // At this point, the cache and scanned data are locally consistent (though
                    // not necessarily consistent with the latest chain tip - this would be
                    // discovered the next time this code path is executed after new blocks are
                    // received) so we can break out of the loop.
                    break;
                }
            }
            _ => {
                // Nothing to verify; break out of the loop.
                break;
            }
        }
    }

    // 7) Loop over the remaining suggested scan ranges, retrieving the requested data and calling
    //    `scan_cached_blocks` on each range.
    let scan_ranges = db_data.suggest_scan_ranges()?;
    debug!("Suggested ranges: {:?}", scan_ranges);
    emit_scan_progress(db_data, chain_tip, scan_ranges.first());

    for scan_range in scan_ranges.into_iter().flat_map(|r| {
        // Limit the number of blocks we download and scan at any one time.
        (0..).scan(r, |acc, _| {
            if acc.is_empty() {
                None
            } else if let Some((cur, next)) = acc.split_at(acc.block_range().start + BATCH_SIZE) {
                *acc = next;
                Some(cur)
            } else {
                let cur = acc.clone();
                let end = acc.block_range().end;
                *acc = ScanRange::from_parts(end..end, acc.priority());
                Some(cur)
            }
        })
    }) {
        if budget.remaining() < MIN_TIME_FOR_BATCH {
            report.budget_expired = true;
            return Ok(false);
        }

        // Download the blocks in `scan_range` into the block source.
        let block_meta = download_blocks(client, paths, db_cache, &scan_range, budget).await?;
        let chain_state = download_chain_state(client, scan_range.block_range().start - 1).await?;

        // Scan the downloaded blocks.
        let scan_ranges_updated = scan_blocks(
            params,
            paths,
            db_cache,
            db_data,
            &chain_state,
            &scan_range,
            chain_tip,
            report,
        )?;

        // Delete the now-scanned blocks.
        delete_cached_blocks(paths, block_meta).await;

        if scan_ranges_updated {
            // The suggested scan ranges have been updated (either due to a continuity error or
            // because a higher priority range has been added), so ask again.
            return Ok(true);
        }
    }

    Ok(false)
}

fn ratio(numerator: u64, denominator: u64) -> f64 {
    if denominator == 0 {
        1.0
    } else {
        (numerator as f64 / denominator as f64).clamp(0.0, 1.0)
    }
}

/// Emits a progress event with the wallet's scan and recovery progress.
fn emit_scan_progress(db_data: &Db, chain_tip: BlockHeight, next_range: Option<&ScanRange>) {
    let summary = match db_data.get_wallet_summary(ConfirmationsPolicy::MIN) {
        Ok(Some(summary)) => summary,
        _ => return,
    };
    let scan = summary.progress().scan();
    let (scan_n, scan_d) = (*scan.numerator(), *scan.denominator());
    let recovery = summary.progress().recovery();
    let (rec_n, rec_d) = recovery
        .map(|r| (*r.numerator(), *r.denominator()))
        .unwrap_or((0, 0));
    out::progress(
        "scan",
        json!({
            "fraction": ratio(scan_n + rec_n, scan_d + rec_d),
            "scanFraction": ratio(scan_n, scan_d),
            "recoveryFraction": recovery.map(|_| ratio(rec_n, rec_d)),
            "fullyScannedHeight": u32::from(summary.fully_scanned_height()),
            "chainTip": u32::from(chain_tip),
            "nextRangeStart": next_range.map(|r| u32::from(r.block_range().start)),
        }),
    );
}

async fn update_subtree_roots(
    client: &mut CompactTxStreamerClient<Channel>,
    db_data: &mut Db,
) -> R<()> {
    let mut request = service::GetSubtreeRootsArg::default();
    request.set_shielded_protocol(service::ShieldedProtocol::Sapling);
    let sapling_roots: Vec<CommitmentTreeRoot<sapling::Node>> = client
        .get_subtree_roots(request)
        .await
        .map_err(anyhow::Error::from)?
        .into_inner()
        .and_then(|root| async move {
            let root_hash = sapling::Node::read(&root.root_hash[..])?;
            Ok(CommitmentTreeRoot::from_parts(
                BlockHeight::from_u32(root.completing_block_height as u32),
                root_hash,
            ))
        })
        .try_collect()
        .await
        .map_err(anyhow::Error::from)?;

    info!("Sapling tree has {} subtrees", sapling_roots.len());
    db_data.put_sapling_subtree_roots(0, &sapling_roots)?;

    let mut request = service::GetSubtreeRootsArg::default();
    request.set_shielded_protocol(service::ShieldedProtocol::Orchard);
    let orchard_roots: Vec<CommitmentTreeRoot<MerkleHashOrchard>> = client
        .get_subtree_roots(request)
        .await
        .map_err(anyhow::Error::from)?
        .into_inner()
        .and_then(|root| async move {
            let root_hash = MerkleHashOrchard::read(&root.root_hash[..])?;
            Ok(CommitmentTreeRoot::from_parts(
                BlockHeight::from_u32(root.completing_block_height as u32),
                root_hash,
            ))
        })
        .try_collect()
        .await
        .map_err(anyhow::Error::from)?;

    info!("Orchard tree has {} subtrees", orchard_roots.len());
    db_data.put_orchard_subtree_roots(0, &orchard_roots)?;

    // Ironwood note commitments are Orchard-shaped, so its subtree roots use the same hash type.
    // A server that predates Ironwood activation simply streams none.
    let mut request = service::GetSubtreeRootsArg::default();
    request.set_shielded_protocol(service::ShieldedProtocol::Ironwood);
    let ironwood_roots: Vec<CommitmentTreeRoot<MerkleHashOrchard>> = client
        .get_subtree_roots(request)
        .await
        .map_err(anyhow::Error::from)?
        .into_inner()
        .and_then(|root| async move {
            let root_hash = MerkleHashOrchard::read(&root.root_hash[..])?;
            Ok(CommitmentTreeRoot::from_parts(
                BlockHeight::from_u32(root.completing_block_height as u32),
                root_hash,
            ))
        })
        .try_collect()
        .await
        .map_err(anyhow::Error::from)?;

    info!("Ironwood tree has {} subtrees", ironwood_roots.len());
    db_data.put_ironwood_subtree_roots(0, &ironwood_roots)?;

    Ok(())
}

async fn update_chain_tip(
    client: &mut CompactTxStreamerClient<Channel>,
    db_data: &mut Db,
) -> R<(BlockHeight, BlockHash)> {
    let latest = client
        .get_latest_block(service::ChainSpec::default())
        .await
        .map_err(anyhow::Error::from)?
        .into_inner();
    let tip_height = u32::try_from(latest.height)
        .map(BlockHeight::from_u32)
        .map_err(|_| anyhow!("the server reported an impossible chain height"))?;
    let tip_hash = BlockHash(
        latest
            .hash
            .as_slice()
            .try_into()
            .map_err(|_| anyhow!("chain tip block hash was not 32 bytes"))?,
    );

    info!("Latest block height is {}", tip_height);
    db_data.update_chain_tip(tip_height)?;

    Ok((tip_height, tip_hash))
}

/// Recovers from a chain reorg detected at `at_height` (the height whose linkage contradicts our
/// stored history) by rewinding the wallet and block cache to `requested` (typically
/// `at_height - REORG_REWIND_MARGIN`).
///
/// `truncate_to_height` can only rewind to a height carrying a note-commitment-tree checkpoint, so
/// if `requested` has none we retry at `at_height - 2` (strictly below the stale block at
/// `at_height - 1`, which also guarantees forward progress). If even that has no checkpoint the
/// reorg is deeper than our rewindable history and we return an actionable error rather than
/// silently wedging.
fn rewind(
    db_data: &mut Db,
    db_cache: &mut FsBlockDb,
    paths: &WalletPaths,
    at_height: BlockHeight,
    requested: BlockHeight,
    chain_tip: BlockHeight,
) -> R<()> {
    // Rewind the wallet, retrying shallower if `requested` has no checkpoint.
    let rewind_height = match db_data.truncate_to_height(requested) {
        Ok(h) => h,
        Err(SqliteClientError::RequestedRewindInvalid { .. }) => {
            let bound = at_height.saturating_sub(2);
            match db_data.truncate_to_height(bound) {
                Ok(h) => {
                    info!("Requested rewind to {requested} had no checkpoint; rewound to {h}");
                    h
                }
                Err(SqliteClientError::RequestedRewindInvalid { .. }) => {
                    return Err(Failure::new(
                        "reorg_too_deep",
                        format!(
                            "The chain changed at block {at_height}, further back than this wallet can rewind. \
                             Use \"Rescan from birthday\" in settings to rebuild the wallet's view of the chain."
                        ),
                    ));
                }
                Err(e) => return Err(e.into()),
            }
        }
        Err(e) => return Err(e.into()),
    };

    // Delete cached compact-block files above the rewind height, then truncate the block
    // metadata to match.
    delete_block_files_above(paths, rewind_height);
    db_cache
        .truncate_to_height(rewind_height)
        .map_err(|e| anyhow!("{:?}", e))?;

    // Re-apply the chain tip. `truncate_to_height` trims the scan queue down to the rewound
    // height, so without this the wallet would believe it has nothing left to scan and would stop
    // at the rewind height instead of re-scanning the replacement chain up to the tip.
    db_data.update_chain_tip(chain_tip)?;

    Ok(())
}

/// Deletes cached compact-block files whose height is above `height`, tolerating files that are
/// already gone. Files are named `<height>-<hash>-compactblock`, so the height is the leading
/// component.
fn delete_block_files_above(paths: &WalletPaths, height: BlockHeight) {
    let Ok(entries) = std::fs::read_dir(paths.blocks_dir()) else {
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

/// Downloads the blocks of `scan_range` into the block cache and returns their metadata.
async fn download_blocks(
    client: &mut CompactTxStreamerClient<Channel>,
    paths: &WalletPaths,
    db_cache: &FsBlockDb,
    scan_range: &ScanRange,
    budget: &Budget,
) -> R<Vec<BlockMeta>> {
    info!("Fetching {}", scan_range);
    let mut start = service::BlockId::default();
    start.height = scan_range.block_range().start.into();
    let mut end = service::BlockId::default();
    end.height = (scan_range.block_range().end - 1).into();
    let range = service::BlockRange {
        start: Some(start),
        end: Some(end),
        pool_types: Default::default(),
    };

    // The whole download must finish within the time left (plus a grace period), so a connection
    // that crawls cannot hold the process forever.
    let limit = budget.remaining().max(Duration::from_secs(20)) + Duration::from_secs(60);

    let paths_for_stream = paths.clone();
    let download = async {
        let block_meta_stream = client
            .get_block_range(range)
            .await
            .map_err(anyhow::Error::from)?
            .into_inner()
            .and_then(|block| {
                let paths = paths_for_stream.clone();
                async move {
                    let (sapling_outputs_count, orchard_actions_count) = block
                        .vtx
                        .iter()
                        .map(|tx| (tx.outputs.len() as u32, tx.actions.len() as u32))
                        .fold((0, 0), |(acc_sapling, acc_orchard), (sapling, orchard)| {
                            (acc_sapling + sapling, acc_orchard + orchard)
                        });

                    let meta = BlockMeta {
                        height: block.height(),
                        block_hash: block.hash(),
                        block_time: block.time,
                        sapling_outputs_count,
                        orchard_actions_count,
                    };

                    let encoded = block.encode_to_vec();
                    let mut block_file = File::create(paths.block_path(&meta)).await?;
                    block_file.write_all(&encoded).await?;

                    Ok(meta)
                }
            });
        tokio::pin!(block_meta_stream);

        let mut block_meta = vec![];
        loop {
            let next = tokio::time::timeout(STREAM_STALL_TIMEOUT, block_meta_stream.try_next())
                .await
                .map_err(|_| anyhow!("the server stopped sending blocks"))?
                .map_err(anyhow::Error::from)?;
            match next {
                Some(block) => block_meta.push(block),
                None => break,
            }
        }
        Ok::<_, anyhow::Error>(block_meta)
    };

    let block_meta = tokio::time::timeout(limit, download)
        .await
        .map_err(|_| anyhow!("downloading blocks took too long"))??;

    db_cache
        .write_block_metadata(&block_meta)
        .map_err(crate::error::Error::from)?;
    Ok(block_meta)
}

async fn download_chain_state(
    client: &mut CompactTxStreamerClient<Channel>,
    block_height: BlockHeight,
) -> R<ChainState> {
    let tree_state = client
        .get_tree_state(BlockId {
            height: block_height.into(),
            hash: vec![],
        })
        .await
        .map_err(anyhow::Error::from)?;

    Ok(tree_state
        .into_inner()
        .to_chain_state()
        .map_err(anyhow::Error::from)?)
}

async fn delete_cached_blocks(paths: &WalletPaths, block_meta: Vec<BlockMeta>) {
    for meta in block_meta {
        if let Err(e) = tokio::fs::remove_file(paths.block_path(&meta)).await {
            // A file already removed (e.g. by a reorg rewind that deleted the orphaned suffix) is
            // not an error worth reporting.
            if e.kind() != std::io::ErrorKind::NotFound {
                error!("Failed to remove {:?}: {}", meta, e);
            }
        }
    }
}

/// Scans the given block range and checks for scanning errors that indicate the wallet's chain tip
/// is out of sync with blockchain history.
///
/// Returns `true` if scanning these blocks materially changed the suggested scan ranges.
#[allow(clippy::too_many_arguments)]
fn scan_blocks(
    params: Network,
    paths: &WalletPaths,
    db_cache: &mut FsBlockDb,
    db_data: &mut Db,
    initial_chain_state: &ChainState,
    scan_range: &ScanRange,
    chain_tip: BlockHeight,
    report: &mut SyncReport,
) -> R<bool> {
    info!("Scanning {}", scan_range);
    let scan_result = scan_cached_blocks(
        &params,
        db_cache,
        db_data,
        scan_range.block_range().start,
        initial_chain_state,
        scan_range.len(),
    );

    match scan_result {
        Err(ChainError::Scan(err)) if err.is_continuity_error() => {
            // Pick a height to rewind to, which must be at least one block before the height at
            // which the error occurred, but may be an earlier height determined based on
            // heuristics such as the platform, available bandwidth, size of recent
            // CompactBlocks, etc.
            let rewind_height = err.at_height().saturating_sub(REORG_REWIND_MARGIN);
            info!(
                "Chain reorg detected at {}, rewinding to {} (scan error: {:?})",
                err.at_height(),
                rewind_height,
                err,
            );

            rewind(
                db_data,
                db_cache,
                paths,
                err.at_height(),
                rewind_height,
                chain_tip,
            )?;

            // The database was truncated, invalidating prior suggested ranges.
            Ok(true)
        }
        Ok(_) => {
            report.blocks_scanned += scan_range.len() as u64;

            let latest_ranges = db_data.suggest_scan_ranges()?;
            emit_scan_progress(db_data, chain_tip, latest_ranges.first());

            // If scanning these blocks caused a suggested range to be added that has a higher
            // priority than the current range, invalidate the current ranges.
            Ok(if let Some(range) = latest_ranges.first() {
                range.priority() > scan_range.priority()
            } else {
                false
            })
        }
        Err(e) => Err(Failure::new(
            "scan_failed",
            format!("Scanning blocks {} failed: {:?}", scan_range, e),
        )),
    }
}

/// Refreshes the given account's view of UTXOs that exist starting at the given height.
///
/// ## Note about UTXO tracking
///
/// (Extracted from a comment in the Android SDK, via zcash-devtool.)
///
/// We no longer clear UTXOs here, as `WalletDb::put_received_transparent_utxo` now uses an upsert
/// instead of an insert. This means that now-spent UTXOs would previously have been deleted, but
/// now are left in the database (like shielded notes).
///
/// Due to the fact that the `lightwalletd` query only returns _current_ UTXOs, we don't learn
/// about recently-spent UTXOs here, so the transparent balance does not get updated here.
///
/// Instead, when a received shielded note is "enhanced" by downloading the full transaction, we
/// mark any UTXOs spent in that transaction as spent in the database. This relies on two current
/// properties:
/// - UTXOs are only ever spent in shielding transactions.
/// - At least one shielded note from each shielding transaction is always enhanced.
async fn refresh_utxos(
    params: &Network,
    client: &mut CompactTxStreamerClient<Channel>,
    db_data: &mut Db,
    account_id: AccountUuid,
    start_height: BlockHeight,
) -> R<()> {
    let addresses = db_data
        .get_transparent_receivers(account_id, true, true)?
        .into_keys()
        .map(|addr| addr.encode(params))
        .collect::<Vec<_>>();

    if addresses.is_empty() {
        return Ok(());
    }

    let request = service::GetAddressUtxosArg {
        addresses,
        start_height: start_height.into(),
        max_entries: 0,
    };

    client
        .get_address_utxos_stream(request)
        .await
        .map_err(anyhow::Error::from)?
        .into_inner()
        .map_err(anyhow::Error::from)
        .and_then(|reply| async move {
            WalletTransparentOutput::from_parts(
                OutPoint::new(reply.txid[..].try_into()?, reply.index.try_into()?),
                TxOut::new(
                    Zatoshis::from_nonnegative_i64(reply.value_zat)?,
                    Script(script::Code(reply.script)),
                ),
                Some(BlockHeight::from(u32::try_from(reply.height)?)),
                // A UTXO fetched from lightwalletd carries no wallet-account context; the wallet
                // associates it on store.
                None,
                None,
                None,
            )
            .ok_or(anyhow!(
                "Received UTXO that doesn't correspond to a valid P2PKH or P2SH address"
            ))
        })
        .try_for_each(|output| {
            let res = db_data.put_received_transparent_utxo(&output).map(|_| ());
            async move { res.map_err(anyhow::Error::from) }
        })
        .await?;

    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Enhancement: fetching full transactions the wallet asks for.
// ---------------------------------------------------------------------------------------------

fn parse_raw_transaction(
    params: &Network,
    chain_tip: BlockHeight,
    tx: RawTransaction,
) -> anyhow::Result<(Transaction, Option<BlockHeight>)> {
    let mined_height = (tx.height > 0 && tx.height <= u64::from(u32::MAX))
        .then(|| BlockHeight::from_u32(u32::try_from(tx.height).unwrap()));

    let tx = Transaction::read(
        &tx.data[..],
        // We assume unmined transactions are created with the current consensus branch ID.
        BranchId::for_height(params, mined_height.unwrap_or(chain_tip)),
    )?;

    Ok((tx, mined_height))
}

async fn fetch_transaction(
    client: &mut CompactTxStreamerClient<Channel>,
    params: &Network,
    chain_tip: BlockHeight,
    txid: TxId,
) -> anyhow::Result<Option<(Transaction, Option<BlockHeight>)>> {
    let request = service::TxFilter {
        hash: txid.as_ref().to_vec(),
        ..Default::default()
    };

    let raw_tx = match client.get_transaction(request).await {
        Ok(response) => Ok(Some(response.into_inner())),
        Err(status) => {
            if status.code() == Code::NotFound {
                Ok(None)
            } else {
                Err(status)
            }
        }
    }?;

    raw_tx
        .map(|raw_tx| parse_raw_transaction(params, chain_tip, raw_tx))
        .transpose()
}

/// Satisfies the wallet's outstanding transaction data requests (statuses, full transactions to
/// decrypt, and transactions involving transparent addresses). Returns how many requests were
/// satisfied. Stops, without error, when the budget runs out; the requests that remain are
/// served by the next slice.
async fn enhance_transactions(
    client: &mut CompactTxStreamerClient<Channel>,
    params: Network,
    db_data: &mut Db,
    budget: &Budget,
) -> R<u32> {
    let chain_tip = db_data.chain_height()?.ok_or_else(|| {
        Failure::new(
            "sync_required",
            "The chain height is not known yet; sync first.",
        )
    })?;

    let mut satisfied_requests = BTreeSet::new();
    let mut fetched = 0u32;
    loop {
        let mut new_request_encountered = false;
        for data_request in db_data.transaction_data_requests()? {
            if satisfied_requests.contains(&data_request) {
                continue;
            }
            if budget.expired() {
                return Ok(fetched);
            }
            new_request_encountered = true;

            info!("Fetching data for request {:?}", data_request);
            match &data_request {
                TransactionDataRequest::GetStatus(txid) => {
                    let status = fetch_transaction(client, &params, chain_tip, *txid)
                        .await?
                        .map_or(TransactionStatus::TxidNotRecognized, |(_, mined_height)| {
                            mined_height
                                .map_or(TransactionStatus::NotInMainChain, TransactionStatus::Mined)
                        });
                    info!("Got status {:?}", status);
                    db_data.set_transaction_status(*txid, status)?;
                }
                TransactionDataRequest::Enhancement(txid) => {
                    match fetch_transaction(client, &params, chain_tip, *txid).await? {
                        None => {
                            info!("Txid not recognized {:?}", txid);
                            db_data.set_transaction_status(
                                *txid,
                                TransactionStatus::TxidNotRecognized,
                            )?;
                        }
                        Some((tx, mined_height)) => {
                            info!(
                                "Enhancing tx {:?} with mined height {:?}",
                                txid, mined_height
                            );
                            decrypt_and_store_transaction(&params, db_data, &tx, mined_height)?;
                        }
                    }
                }
                TransactionDataRequest::TransactionsInvolvingAddress(tia) => {
                    let address = tia.address().encode(&params);
                    let request = service::TransparentAddressBlockFilter {
                        address: address.clone(),
                        range: Some(BlockRange {
                            start: Some(service::BlockId {
                                height: u64::from(tia.block_range_start()),
                                ..Default::default()
                            }),
                            end: tia.block_range_end().map(|h| service::BlockId {
                                height: u64::from(h - 1), // `BlockRange` end is inclusive.
                                ..Default::default()
                            }),
                            pool_types: Default::default(),
                        }),
                    };

                    let mut stream = client
                        .get_taddress_txids(request)
                        .await
                        .map_err(anyhow::Error::from)?
                        .into_inner();
                    while let Some(raw_tx) = stream.next().await {
                        let (tx, mined_height) = parse_raw_transaction(
                            &params,
                            chain_tip,
                            raw_tx.map_err(anyhow::Error::from)?,
                        )?;
                        info!(
                            "Found tx {:?} for address {} with mined height {:?}",
                            tx.txid(),
                            address,
                            mined_height
                        );
                        decrypt_and_store_transaction(&params, db_data, &tx, mined_height)?
                    }
                }
            }

            fetched += 1;
            satisfied_requests.insert(data_request);
        }

        if !new_request_encountered {
            break;
        }
    }

    Ok(fetched)
}

/// Removes every cached block file; used when a wallet is reset.
pub(crate) fn clear_block_cache(paths: &WalletPaths) {
    let dir: &Path = &paths.blocks_dir();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}
