//! What the engine needs from the system it runs on, for the browser build. The native build's
//! version of this module (engine/src/platform.rs) documents the contract; this one keeps it with:
//!
//! * gRPC-web over `fetch` instead of a gRPC channel (lightwalletd needs a gRPC-web endpoint);
//! * the wallet folder held in memory: small files in a map, SQLite databases in SQLite's memory
//!   VFS. The page saves them after each command and loads them back on start (see `lib.rs`);
//! * compact blocks kept in memory between download and scan, never written anywhere;
//! * Sapling parameters fetched by the page when a payment first needs them, checked against
//!   their published BLAKE2b hashes, and kept for the rest of the session.

use std::{
    cell::RefCell, collections::BTreeMap, future::Future, io, path::Path, rc::Rc, time::Duration,
};

use futures_util::future::{Either, select};
use sapling::{
    circuit::{OutputParameters, SpendParameters},
    prover::{OutputProver, SpendProver},
};
use sqlite_wasm_rs::{MemVfsUtil, WasmOsCallback};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use zcash_client_backend::{
    data_api::chain::{BlockSource, error::Error as ChainError},
    proto::{
        compact_formats::CompactBlock, service::compact_tx_streamer_client::CompactTxStreamerClient,
    },
};
use zcash_client_sqlite::chain::BlockMeta;
use zcash_protocol::consensus::BlockHeight;

use crate::{
    data::WalletPaths,
    failure::{Failure, R},
};

pub(crate) use web_time::{Instant, SystemTime, UNIX_EPOCH};

/// The clock the wallet database records times with. The library's `SystemClock` reads
/// `std::time::SystemTime::now`, which does not exist in a browser; this one asks JavaScript.
#[derive(Clone, Copy)]
pub(crate) struct WalletClock;

impl zcash_client_sqlite::util::Clock for WalletClock {
    fn now(&self) -> std::time::SystemTime {
        std::time::UNIX_EPOCH + Duration::from_millis(js_sys::Date::now() as u64)
    }
}

/// The transport under the lightwalletd client: gRPC-web over `fetch`.
pub(crate) type Transport = tonic_web_wasm_client::Client;
/// A lightwalletd client.
pub(crate) type Client = CompactTxStreamerClient<Transport>;

/// The deadline passed before the future finished.
#[derive(Debug)]
pub(crate) struct Elapsed;

/// Runs `future` for at most `limit`.
pub(crate) async fn timeout<F: Future>(limit: Duration, future: F) -> Result<F::Output, Elapsed> {
    let sleep = gloo_timers::future::sleep(limit);
    match select(std::pin::pin!(future), std::pin::pin!(sleep)).await {
        Either::Left((output, _)) => Ok(output),
        Either::Right(_) => Err(Elapsed),
    }
}

thread_local! {
    static EMITTER: RefCell<Option<js_sys::Function>> = const { RefCell::new(None) };
    static FILES: RefCell<BTreeMap<String, Vec<u8>>> = const { RefCell::new(BTreeMap::new()) };
    static PARAM_LOADER: RefCell<Option<js_sys::Function>> = const { RefCell::new(None) };
    static OUTPUT_PARAMS: RefCell<Option<Rc<OutputParameters>>> = const { RefCell::new(None) };
    static SPEND_PARAMS: RefCell<Option<Rc<SpendParameters>>> = const { RefCell::new(None) };
}

/// Where progress lines go while a command runs (set by `lib.rs`).
pub(crate) fn set_emitter(f: Option<js_sys::Function>) {
    EMITTER.with(|e| *e.borrow_mut() = f);
}

/// Hands one line of output to the page.
pub(crate) fn write_line(text: &str) {
    EMITTER.with(|e| {
        if let Some(f) = e.borrow().as_ref() {
            let _ = f.call1(&JsValue::NULL, &JsValue::from_str(text));
        }
    });
}

// ---- Sapling proving -------------------------------------------------------------------------

const SAPLING_SPEND_HASH: &str = "8270785a1a0d0bc77196f000ee6d221c9c9894f55307bd9357c3f0105d31ca63991ab91324160d8f53e2bbd3c2633a6eb8bdf5205d822e7f3f73edac51b2b70c";
const SAPLING_OUTPUT_HASH: &str = "657e3d38dbb5cb5e7dd2970e8b03d69b4787dd907285b5a7f0790dcc8072f60bf593b32cc2d1c030e00ff5ae64bf84c5c3beb84ddc841d48264b4a171744d028";

/// The page's function that fetches parameter files: `(name) => Promise<Uint8Array>`.
pub(crate) fn set_param_loader(f: js_sys::Function) {
    PARAM_LOADER.with(|l| *l.borrow_mut() = Some(f));
}

async fn fetch_params(name: &str, hash: &str) -> R<Vec<u8>> {
    let loader = PARAM_LOADER.with(|l| l.borrow().clone()).ok_or_else(|| {
        Failure::new(
            "params_unavailable",
            "The Sapling parameters cannot be loaded here.",
        )
    })?;
    let unavailable = || {
        Failure::new(
            "params_unavailable",
            format!(
                "Could not download the Sapling parameters ({name}). Check your connection and try again."
            ),
        )
    };
    let promise: js_sys::Promise = loader
        .call1(&JsValue::NULL, &JsValue::from_str(name))
        .map_err(|_| unavailable())?
        .dyn_into()
        .map_err(|_| unavailable())?;
    let bytes = JsFuture::from(promise).await.map_err(|_| unavailable())?;
    let bytes = js_sys::Uint8Array::new(&bytes).to_vec();
    // The same check zcash_proofs applies to parameter files on disk.
    if blake2b_simd::Params::new()
        .hash_length(64)
        .hash(&bytes)
        .to_hex()
        .as_str()
        != hash
    {
        return Err(Failure::new(
            "params_corrupt",
            format!(
                "The downloaded Sapling parameters ({name}) do not match their published hash. Nothing was sent."
            ),
        ));
    }
    Ok(bytes)
}

/// Sapling proving with the output parameters always and the spend parameters only when loaded.
pub(crate) struct Prover {
    spend: Option<Rc<SpendParameters>>,
    output: Rc<OutputParameters>,
}

/// Returns the Sapling prover, fetching the parameters this payment needs: the output parameters
/// (3.6 MB) for every payment, the spend parameters (48 MB) only when it spends Sapling notes.
pub(crate) async fn prover(needs_spend: bool) -> R<Prover> {
    let output = match OUTPUT_PARAMS.with(|p| p.borrow().clone()) {
        Some(p) => p,
        None => {
            crate::out::progress(
                "params",
                serde_json::json!({ "file": "sapling-output.params" }),
            );
            let bytes = fetch_params("sapling-output.params", SAPLING_OUTPUT_HASH).await?;
            let params = Rc::new(OutputParameters::read(&bytes[..], false).map_err(|e| {
                Failure::new(
                    "params_corrupt",
                    format!("The Sapling output parameters could not be read: {e}"),
                )
            })?);
            OUTPUT_PARAMS.with(|p| *p.borrow_mut() = Some(params.clone()));
            params
        }
    };
    let spend = match (needs_spend, SPEND_PARAMS.with(|p| p.borrow().clone())) {
        (_, Some(p)) => Some(p),
        (false, None) => None,
        (true, None) => {
            crate::out::progress(
                "params",
                serde_json::json!({ "file": "sapling-spend.params" }),
            );
            let bytes = fetch_params("sapling-spend.params", SAPLING_SPEND_HASH).await?;
            let params = Rc::new(SpendParameters::read(&bytes[..], false).map_err(|e| {
                Failure::new(
                    "params_corrupt",
                    format!("The Sapling spend parameters could not be read: {e}"),
                )
            })?);
            SPEND_PARAMS.with(|p| *p.borrow_mut() = Some(params.clone()));
            Some(params)
        }
    };
    Ok(Prover { spend, output })
}

impl SpendProver for Prover {
    type Proof = <SpendParameters as SpendProver>::Proof;

    fn prepare_circuit(
        proof_generation_key: sapling::ProofGenerationKey,
        diversifier: sapling::Diversifier,
        rseed: sapling::Rseed,
        value: sapling::value::NoteValue,
        alpha: jubjub::Fr,
        rcv: sapling::value::ValueCommitTrapdoor,
        anchor: bls12_381::Scalar,
        merkle_path: sapling::MerklePath,
    ) -> Option<sapling::circuit::Spend> {
        SpendParameters::prepare_circuit(
            proof_generation_key,
            diversifier,
            rseed,
            value,
            alpha,
            rcv,
            anchor,
            merkle_path,
        )
    }

    fn create_proof<Rng: rand_core::RngCore>(
        &self,
        circuit: sapling::circuit::Spend,
        rng: &mut Rng,
    ) -> Self::Proof {
        self.spend
            .as_ref()
            // `spend::spends_sapling` decides whether these are loaded, from the same proposal
            // that is being built, so a Sapling spend never reaches here without them.
            .expect(
                "Sapling spend parameters are loaded for every proposal that spends Sapling notes",
            )
            .create_proof(circuit, rng)
    }

    fn encode_proof(proof: Self::Proof) -> sapling::bundle::GrothProofBytes {
        SpendParameters::encode_proof(proof)
    }
}

impl OutputProver for Prover {
    type Proof = <OutputParameters as OutputProver>::Proof;

    fn prepare_circuit(
        esk: &sapling::keys::EphemeralSecretKey,
        payment_address: sapling::PaymentAddress,
        rcm: jubjub::Fr,
        value: sapling::value::NoteValue,
        rcv: sapling::value::ValueCommitTrapdoor,
    ) -> sapling::circuit::Output {
        OutputParameters::prepare_circuit(esk, payment_address, rcm, value, rcv)
    }

    fn create_proof<Rng: rand_core::RngCore>(
        &self,
        circuit: sapling::circuit::Output,
        rng: &mut Rng,
    ) -> Self::Proof {
        self.output.create_proof(circuit, rng)
    }

    fn encode_proof(proof: Self::Proof) -> sapling::bundle::GrothProofBytes {
        OutputParameters::encode_proof(proof)
    }
}

/// The self-test's name for its prover check.
pub(crate) const PROVER_CHECK: &str = "prover-parameter-check";

/// Self-test: the parameter hashes are the published ones. The files themselves are fetched the
/// first time a payment needs them, so they are not loaded here.
pub(crate) fn check_prover() -> Result<String, String> {
    let empty = blake2b_simd::Params::new()
        .hash_length(64)
        .hash(b"")
        .to_hex();
    if SAPLING_OUTPUT_HASH.len() != 128 || SAPLING_SPEND_HASH.len() != 128 || empty.len() != 128 {
        return Err("the Sapling parameter hashes are malformed".to_string());
    }
    Ok("Sapling parameters are fetched when a payment first needs them and checked against their published hashes".to_string())
}

/// A folder for the self-test's throw-away wallet.
pub(crate) fn scratch_dir() -> std::path::PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::path::PathBuf::from(format!("selftest-{nanos}"))
}

// ---- the wallet folder -----------------------------------------------------------------------

fn key(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn databases() -> MemVfsUtil<WasmOsCallback> {
    MemVfsUtil::new()
}

/// Every file of every wallet, for the page to save: small files and SQLite databases alike.
pub(crate) fn export_files() -> Vec<(String, Vec<u8>)> {
    let mut out: Vec<(String, Vec<u8>)> = FILES.with(|f| {
        f.borrow()
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    });
    let vfs = databases();
    for name in vfs.list() {
        // Journals exist only while a transaction is open; between commands there are none.
        if name.ends_with("-journal") {
            continue;
        }
        if let Ok(bytes) = vfs.export_db(&name) {
            out.push((name, bytes));
        }
    }
    out
}

/// Loads one saved file back, before the first command runs.
pub(crate) fn import_file(path: &str, bytes: &[u8]) -> Result<(), String> {
    if path.ends_with(".sqlite") {
        databases()
            .import_db(path, bytes)
            .map_err(|e| format!("{e:?}"))
    } else {
        FILES.with(|f| f.borrow_mut().insert(path.to_string(), bytes.to_vec()));
        Ok(())
    }
}

/// Forgets every file.
pub(crate) fn clear_files() {
    FILES.with(|f| f.borrow_mut().clear());
    databases().clear_all();
}

pub(crate) mod files {
    use std::{io, path::Path};

    use super::{FILES, databases, key};

    fn not_found() -> io::Error {
        io::Error::from(io::ErrorKind::NotFound)
    }

    pub(crate) fn is_file(path: &Path) -> bool {
        let k = key(path);
        FILES.with(|f| f.borrow().contains_key(&k)) || databases().exists(&k)
    }

    pub(crate) fn exists(path: &Path) -> bool {
        let k = key(path);
        let dir = format!("{k}/");
        is_file(path)
            || FILES.with(|f| f.borrow().keys().any(|name| name.starts_with(&dir)))
            || databases().list().iter().any(|name| name.starts_with(&dir))
    }

    pub(crate) fn read_to_string(path: &Path) -> io::Result<String> {
        let bytes = FILES
            .with(|f| f.borrow().get(&key(path)).cloned())
            .ok_or_else(not_found)?;
        String::from_utf8(bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }

    /// Folders exist implicitly.
    pub(crate) fn create_dir_all(_path: &Path) -> io::Result<()> {
        Ok(())
    }

    pub(crate) fn remove_dir(_path: &Path) -> io::Result<()> {
        Ok(())
    }

    pub(crate) fn remove_file(path: &Path) -> io::Result<()> {
        let k = key(path);
        if FILES.with(|f| f.borrow_mut().remove(&k)).is_some() {
            return Ok(());
        }
        let vfs = databases();
        if vfs.exists(&k) {
            vfs.delete_db(&k);
            return Ok(());
        }
        Err(not_found())
    }

    pub(crate) fn remove_dir_all(path: &Path) -> io::Result<()> {
        let dir = format!("{}/", key(path));
        FILES.with(|f| f.borrow_mut().retain(|name, _| !name.starts_with(&dir)));
        let vfs = databases();
        for name in vfs.list() {
            if name.starts_with(&dir) {
                vfs.delete_db(&name);
            }
        }
        Ok(())
    }

    pub(crate) fn rename(from: &Path, to: &Path) -> io::Result<()> {
        let (from, to) = (key(from), key(to));
        if let Some(bytes) = FILES.with(|f| f.borrow_mut().remove(&from)) {
            FILES.with(|f| f.borrow_mut().insert(to, bytes));
            return Ok(());
        }
        let vfs = databases();
        if vfs.exists(&from) {
            let bytes = vfs
                .export_db(&from)
                .map_err(|e| io::Error::other(format!("{e:?}")))?;
            vfs.import_db(&to, &bytes)
                .map_err(|e| io::Error::other(format!("{e:?}")))?;
            vfs.delete_db(&from);
            return Ok(());
        }
        Err(not_found())
    }

    pub(crate) fn write_new_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
        let k = key(path);
        FILES.with(|f| {
            let mut f = f.borrow_mut();
            if f.contains_key(&k) {
                return Err(io::Error::from(io::ErrorKind::AlreadyExists));
            }
            f.insert(k, bytes.to_vec());
            Ok(())
        })
    }

    pub(crate) fn replace_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
        FILES.with(|f| f.borrow_mut().insert(key(path), bytes.to_vec()));
        Ok(())
    }
}

// ---- compact blocks ------------------------------------------------------------------------

/// Compact blocks between download and scan, in memory.
#[derive(Default)]
pub(crate) struct BlockCache {
    blocks: RefCell<BTreeMap<u32, CompactBlock>>,
}

impl BlockCache {
    pub(crate) fn init(_paths: &WalletPaths) -> R<()> {
        Ok(())
    }

    pub(crate) fn open(_paths: &WalletPaths) -> R<Self> {
        Ok(Self::default())
    }

    pub(crate) fn source(&self) -> &Self {
        self
    }

    pub(crate) async fn store(&self, block: CompactBlock) -> anyhow::Result<BlockMeta> {
        let meta = block_meta(&block);
        self.blocks
            .borrow_mut()
            .insert(u32::from(meta.height), block);
        Ok(meta)
    }

    pub(crate) fn index(&mut self, _metas: &[BlockMeta]) -> R<()> {
        Ok(())
    }

    pub(crate) async fn discard(&mut self, metas: Vec<BlockMeta>) {
        let mut blocks = self.blocks.borrow_mut();
        for meta in metas {
            blocks.remove(&u32::from(meta.height));
        }
    }

    pub(crate) fn truncate_to_height(&mut self, height: BlockHeight) -> R<()> {
        let _ = self.blocks.borrow_mut().split_off(&(u32::from(height) + 1));
        Ok(())
    }

    pub(crate) fn clear(_paths: &WalletPaths) {}
}

impl BlockSource for BlockCache {
    type Error = io::Error;

    fn with_blocks<F, WalletErrT>(
        &self,
        from_height: Option<BlockHeight>,
        limit: Option<usize>,
        mut with_block: F,
    ) -> Result<(), ChainError<WalletErrT, Self::Error>>
    where
        F: FnMut(CompactBlock) -> Result<(), ChainError<WalletErrT, Self::Error>>,
    {
        let from = from_height.map(u32::from).unwrap_or(0);
        let blocks: Vec<CompactBlock> = self
            .blocks
            .borrow()
            .range(from..)
            .take(limit.unwrap_or(usize::MAX))
            .map(|(_, b)| b.clone())
            .collect();
        for block in blocks {
            run_queued_jobs();
            with_block(block)?;
        }
        run_queued_jobs();
        Ok(())
    }
}

/// Runs the jobs the scanner queued on rayon.
///
/// The scanner decrypts outputs in batches handed to `rayon::spawn_fifo`, then waits for the
/// results. A browser has no threads for rayon, so its pool is this thread alone, and queued jobs
/// run only when this thread yields to rayon; waiting for them without yielding never ends. The
/// scanner reads blocks through this cache twice, queueing work in the first pass and collecting
/// results in the second, so running the queue before each block it is handed (and once at the
/// end) completes every batch before its results are needed.
fn run_queued_jobs() {
    while let Some(rayon::Yield::Executed) = rayon::yield_now() {}
}

/// The metadata the scanner keeps for a block.
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
