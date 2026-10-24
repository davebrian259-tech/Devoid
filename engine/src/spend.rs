//! Previewing, sending and shielding payments.
//!
//! A batch payment is **one Zcash transaction with one output per recipient**: a ZIP 321
//! multi-payment request that librustzcash turns into a proposal (`propose_transfer`) and then
//! builds, proves and signs (`create_proposed_transactions`). Splitting a very large batch into
//! several transactions is the Node planner's job; the engine only ever builds a single
//! transaction per send, and refuses requests that would not fit the network's relay limits.
//!
//! The flow has two steps so that the person reviews exactly what will happen on-chain:
//!
//! * `propose` (offline, no passphrase): returns a summary of the transaction (payments, fee,
//!   change, privacy findings) and a *fingerprint* of it;
//! * `send` (passphrase + that fingerprint): catches the wallet up with the chain, rebuilds the
//!   proposal, refuses if it differs from the one that was reviewed, then builds, stores and
//!   broadcasts the transaction.
//!
//! Funding is chosen to avoid revealing amounts: the engine tries to pay from a single shielded
//! pool and keeps the proposal that moves the least value across pool boundaries (the amount that
//! crosses between pools is public on-chain). Whatever remains visible is listed in the privacy
//! findings, and anything that reveals amounts has to be acknowledged explicitly before `send`
//! will go ahead.

use std::{collections::HashSet, convert::Infallible, str::FromStr};

use secrecy::ExposeSecret;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tracing::warn;
use transparent::address::TransparentAddress;
use zcash_address::{ConversionError, ZcashAddress};
use zcash_client_backend::{
    data_api::{
        Account, CoinbaseFilter, WalletRead,
        error::Error as WalletError,
        wallet::{
            ConfirmationsPolicy, SpendingKeys, TargetHeight, create_proposed_transactions,
            input_selection::{GreedyInputSelector, GreedyInputSelectorError, SpendPolicy},
            propose_shielding, propose_transfer,
        },
    },
    fees::{
        ChangeError, DustOutputPolicy, SplitPolicy, StandardFeeRule,
        standard::MultiOutputChangeStrategy,
    },
    proposal::{Proposal, ProposalError},
    proto::service,
    wallet::OvkPolicy,
};
use zcash_client_sqlite::{AccountUuid, ReceivedNoteId};
use zcash_keys::{
    address::Address, encoding::AddressCodec, keys::UnifiedAddressRequest, keys::UnifiedSpendingKey,
};
use zcash_primitives::transaction::TxId;
use zcash_protocol::{
    PoolType, ShieldedPool,
    consensus::{Network, NetworkType},
    memo::{Memo, MemoBytes},
    value::Zatoshis,
};
use zip321::{Payment, TransactionRequest};

use crate::{
    data::{Db, network_name, open_block_cache},
    error::{ShieldErrorT, WalletErrorT},
    failure::{Failure, R},
    out,
    platform::{self, Prover},
    remote::{Connection, Link},
    sync::{Budget, SyncOptions, sync_slice},
    wallet::{Wallet, ironwood_active_at},
};

/// The most recipients one transaction may carry. Every recipient is one shielded output (about
/// 3 KB with its proof), and relay policy rejects transactions over 100 KB.
pub(crate) const MAX_RECIPIENTS_PER_TX: usize = 30;

/// How many outputs a padded transaction is rounded up to.
///
/// Shielded transactions hide who is paid and how much, but not *how many*: the number of outputs
/// is public, and since a ZIP 317 fee is 5,000 zatoshis per logical action, the fee alone narrows
/// it down. For a batch that is the headcount of a payroll or a grant round. Padding rounds the
/// output count up to one of these, with the extra outputs paying this wallet zero, so a payment
/// to three people and a payment to nine look the same on chain. It costs one action each.
///
/// The top bucket is the UI's transactions-per-batch size, so a full chunk pays nothing extra.
pub(crate) const PAD_BUCKETS: [usize; 3] = [5, 10, 25];

/// The bucket a batch of `n` recipients is padded up to (`n` itself when it is already past them).
pub(crate) fn pad_bucket(n: usize) -> usize {
    PAD_BUCKETS.into_iter().find(|bucket| *bucket >= n).unwrap_or(n)
}

/// The largest transaction the engine will build, in bytes (the standard relay limit).
pub(crate) const MAX_STANDARD_TX_BYTES: usize = 100_000;

const MAX_MEMO_BYTES: usize = 512;

/// Outputs below this value are "dust" to a relaying node when they go to a transparent address.
const TRANSPARENT_DUST_ZAT: u64 = 54;

/// Transparent balances below this are not worth the fee it takes to shield them.
const SHIELD_THRESHOLD_ZAT: u64 = 20_000;

/// How long `send` may spend catching the wallet up with the chain before building.
const SEND_SYNC_BUDGET_SECS: u64 = 40;

const FINGERPRINT_TAG: &str = "devoid/proposal/1";

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

const POOLS: [ShieldedPool; 3] = [
    ShieldedPool::Sapling,
    ShieldedPool::Orchard,
    ShieldedPool::Ironwood,
];

fn pool_index(pool: ShieldedPool) -> usize {
    match pool {
        ShieldedPool::Sapling => 0,
        ShieldedPool::Orchard => 1,
        ShieldedPool::Ironwood => 2,
    }
}

fn pool_name(pool: ShieldedPool) -> &'static str {
    match pool {
        ShieldedPool::Sapling => "sapling",
        ShieldedPool::Orchard => "orchard",
        ShieldedPool::Ironwood => "ironwood",
    }
}

fn parse_pool(name: &str) -> Option<ShieldedPool> {
    match name {
        "sapling" => Some(ShieldedPool::Sapling),
        "orchard" => Some(ShieldedPool::Orchard),
        "ironwood" => Some(ShieldedPool::Ironwood),
        _ => None,
    }
}

fn pool_type_name(pool: PoolType) -> &'static str {
    match pool {
        PoolType::Transparent => "transparent",
        PoolType::Shielded(p) => pool_name(p),
    }
}

/// `123456789` -> `"1.23456789"`; trailing zeros are dropped (`"1.5"`, `"2.0"`).
pub(crate) fn zec(zatoshis: u64) -> String {
    let whole = zatoshis / 100_000_000;
    let frac = zatoshis % 100_000_000;
    let mut text = format!("{whole}.{frac:08}");
    while text.ends_with('0') && !text.ends_with(".0") {
        text.pop();
    }
    text
}

fn plural(n: usize, one: &str, many: &str) -> String {
    if n == 1 {
        format!("{n} {one}")
    } else {
        format!("{n} {many}")
    }
}

fn bad_request(message: impl Into<String>) -> Failure {
    Failure::new("bad_request", message)
}

fn sync_required() -> Failure {
    Failure::new(
        "sync_required",
        "The wallet has not finished syncing yet. Wait for it to catch up and try again.",
    )
}

fn network_label(net: NetworkType) -> &'static str {
    match net {
        NetworkType::Main => "mainnet",
        NetworkType::Test => "testnet",
        NetworkType::Regtest => "regtest",
    }
}

pub(crate) fn parse_txid(text: &str) -> R<TxId> {
    let bytes = hex::decode(text.trim())
        .ok()
        .and_then(|b| <[u8; 32]>::try_from(b).ok())
        .ok_or_else(|| bad_request(format!("{text:?} is not a transaction id.")))?;
    // Transaction ids are displayed byte-reversed.
    let mut internal = bytes;
    internal.reverse();
    Ok(TxId::from_bytes(internal))
}

// ---------------------------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub(crate) struct Recipient {
    address: ZcashAddress,
    amount: Zatoshis,
    memo: Option<MemoBytes>,
}

fn bad_recipient(index: usize, why: impl AsRef<str>) -> Failure {
    Failure::new(
        "bad_recipient",
        format!("Recipient {}: {}", index + 1, why.as_ref()),
    )
    .with_details(json!({ "index": index }))
}

fn parse_amount_zat(value: Option<&Value>) -> Result<Zatoshis, String> {
    let n: u64 = match value {
        Some(Value::Number(n)) => n
            .as_u64()
            .ok_or_else(|| "the amount must be a whole number of zatoshis".to_string())?,
        Some(Value::String(s)) => {
            if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
                return Err("the amount must be a whole number of zatoshis".to_string());
            }
            s.parse::<u64>()
                .map_err(|_| "the amount is too large".to_string())?
        }
        _ => return Err("the amount is missing".to_string()),
    };
    if n == 0 {
        return Err("the amount must be more than zero".to_string());
    }
    Zatoshis::from_u64(n).map_err(|_| "the amount is more than all the ZEC that exists".to_string())
}

pub(crate) fn parse_recipient(params: &Network, index: usize, value: &Value) -> R<Recipient> {
    let object = value
        .as_object()
        .ok_or_else(|| bad_recipient(index, "must be an object with an address and an amount"))?;

    let text = object
        .get("address")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| bad_recipient(index, "the address is missing"))?;

    let amount =
        parse_amount_zat(object.get("amountZat")).map_err(|why| bad_recipient(index, why))?;

    let address: ZcashAddress = text
        .parse()
        .map_err(|_| bad_recipient(index, "that is not a valid Zcash address"))?;

    let decoded =
        Address::try_from_zcash_address(params, address.clone()).map_err(|e| match e {
            ConversionError::IncorrectNetwork { expected, actual } => bad_recipient(
                index,
                format!(
                    "that is a {} address, but this wallet is on {}",
                    network_label(actual),
                    network_label(expected)
                ),
            ),
            ConversionError::Unsupported(_) => bad_recipient(
                index,
                "Devoid cannot pay this kind of address (old Sprout addresses are not supported)",
            ),
            ConversionError::User(why) => {
                bad_recipient(index, format!("that address cannot be used: {why}"))
            }
        })?;

    match &decoded {
        Address::Tex(_) => {
            return Err(bad_recipient(
                index,
                "that is a ZIP 320 (TEX) address, which Devoid cannot pay yet",
            ));
        }
        Address::Unified(ua) => {
            if !(ua.has_orchard() || ua.has_sapling() || ua.has_transparent()) {
                return Err(bad_recipient(
                    index,
                    "that unified address has no receiver Devoid can pay",
                ));
            }
        }
        Address::Sapling(_) | Address::Transparent(_) => {}
    }

    if address.is_transparent_only() && amount.into_u64() < TRANSPARENT_DUST_ZAT {
        return Err(bad_recipient(
            index,
            format!(
                "a payment to a transparent address must be at least {TRANSPARENT_DUST_ZAT} zatoshis"
            ),
        ));
    }

    let memo = match object.get("memo") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.is_empty() => None,
        Some(Value::String(s)) => {
            if s.len() > MAX_MEMO_BYTES {
                return Err(bad_recipient(
                    index,
                    format!(
                        "the memo is {} bytes long; the limit is {MAX_MEMO_BYTES} bytes",
                        s.len()
                    ),
                ));
            }
            if s.contains('\0') {
                return Err(bad_recipient(index, "a memo cannot contain NUL characters"));
            }
            if !address.can_receive_memo() {
                return Err(bad_recipient(
                    index,
                    "a memo cannot be sent to a transparent address",
                ));
            }
            let parsed = Memo::from_str(s).map_err(|e| bad_recipient(index, e.to_string()))?;
            Some(MemoBytes::from(parsed))
        }
        Some(_) => return Err(bad_recipient(index, "the memo must be text")),
    };

    Ok(Recipient {
        address,
        amount,
        memo,
    })
}

/// How the funding pools of a transfer are chosen.
#[derive(Clone, Debug)]
enum Funding {
    /// Try each shielded pool on its own, then all together, and keep the proposal that moves the
    /// least value between pools.
    Auto,
    /// Spend only from these pools.
    Pools(Vec<ShieldedPool>),
}

pub(crate) struct TransferRequest {
    pub(crate) recipients: Vec<Recipient>,
    funding: Funding,
    /// Pad the outputs up to a bucket, so the chain does not show how many people were paid.
    pad: bool,
}

pub(crate) fn parse_transfer_request(params: &Network, req: &Value) -> R<TransferRequest> {
    let list = req
        .get("recipients")
        .and_then(Value::as_array)
        .ok_or_else(|| bad_request("recipients must be a list."))?;
    if list.is_empty() {
        return Err(bad_request("Add at least one recipient."));
    }
    if list.len() > MAX_RECIPIENTS_PER_TX {
        return Err(Failure::new(
            "too_many_recipients",
            format!(
                "One transaction can pay at most {MAX_RECIPIENTS_PER_TX} recipients; split the batch into several transactions."
            ),
        ));
    }

    let mut recipients = Vec::with_capacity(list.len());
    let mut total: u64 = 0;
    for (index, item) in list.iter().enumerate() {
        let recipient = parse_recipient(params, index, item)?;
        total = total
            .checked_add(recipient.amount.into_u64())
            .ok_or_else(|| bad_request("The total amount is too large."))?;
        recipients.push(recipient);
    }
    if Zatoshis::from_u64(total).is_err() {
        return Err(bad_request(
            "The total amount is more than all the ZEC that exists.",
        ));
    }

    let funding = match req.get("fundingPools") {
        None | Some(Value::Null) => Funding::Auto,
        Some(Value::Array(items)) if items.is_empty() => Funding::Auto,
        Some(Value::Array(items)) => {
            let mut pools = Vec::new();
            for item in items {
                let pool = item.as_str().and_then(parse_pool).ok_or_else(|| {
                    bad_request(
                        "fundingPools may only contain \"sapling\", \"orchard\" or \"ironwood\".",
                    )
                })?;
                if !pools.contains(&pool) {
                    pools.push(pool);
                }
            }
            Funding::Pools(pools)
        }
        Some(_) => return Err(bad_request("fundingPools must be a list.")),
    };

    let pad = match req.get("padOutputs") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(on)) => *on,
        Some(_) => return Err(bad_request("padOutputs must be true or false.")),
    };

    Ok(TransferRequest {
        recipients,
        funding,
        pad,
    })
}

fn parse_acknowledgements(req: &Value) -> HashSet<String> {
    req.get("acknowledge")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn transaction_request(recipients: &[Recipient]) -> R<TransactionRequest> {
    let mut payments = Vec::with_capacity(recipients.len());
    for (index, recipient) in recipients.iter().enumerate() {
        let payment = Payment::new(
            recipient.address.clone(),
            Some(recipient.amount),
            recipient.memo.clone(),
            None,
            None,
            vec![],
        )
        .map_err(|e| bad_recipient(index, e.to_string()))?;
        payments.push(payment);
    }
    TransactionRequest::new(payments)
        .map_err(|e| bad_request(format!("The payment request is not valid: {e}")))
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/// `(available, required)` when an error means "not enough money".
fn insufficiency<DE, TE, SE, FE, CE, N>(
    error: &WalletError<DE, TE, SE, FE, CE, N>,
) -> Option<(u64, u64)> {
    match error {
        WalletError::InsufficientFunds {
            available,
            required,
        } => Some((u64::from(*available), u64::from(*required))),
        WalletError::Change(ChangeError::InsufficientFunds {
            available,
            required,
        }) => Some((u64::from(*available), u64::from(*required))),
        _ => None,
    }
}

fn insufficient_funds_failure(available: u64, required: u64) -> Failure {
    Failure::new(
        "insufficient_funds",
        format!(
            "Not enough spendable funds: this needs {} ZEC including the network fee, and {} ZEC is spendable right now.",
            zec(required),
            zec(available)
        ),
    )
    .with_details(json!({
        "availableZat": available,
        "requiredZat": required,
        "shortfallZat": required.saturating_sub(available),
    }))
}

/// Turns a library error into a failure a person can act on.
fn classify<DE, TE, SE, FE, CE, N>(error: WalletError<DE, TE, SE, FE, CE, N>) -> Failure
where
    DE: std::fmt::Display,
    TE: std::fmt::Display,
    SE: std::fmt::Display,
    FE: std::fmt::Display,
    CE: std::fmt::Display,
    N: std::fmt::Display,
{
    if let Some((available, required)) = insufficiency(&error) {
        return insufficient_funds_failure(available, required);
    }
    match error {
        WalletError::ScanRequired => sync_required(),
        WalletError::Proposal(ProposalError::TransactionTooLarge {
            estimated_size,
            limit,
            ..
        }) => Failure::new(
            "batch_too_large",
            "This payment would need more inputs than fit in one transaction. Send fewer recipients at once, or send yourself a payment to consolidate small notes first.",
        )
        .with_details(json!({ "estimatedBytes": estimated_size, "limitBytes": limit })),
        WalletError::Proposal(ProposalError::InputsLocked(_)) => Failure::new(
            "account_busy",
            "Another payment is still being prepared from this wallet. Try again in a moment.",
        ),
        WalletError::Change(ChangeError::DustInputs { .. }) => Failure::new(
            "dust_funds",
            "Your spendable funds are in notes too small to be worth spending (each costs more in fees than it holds).",
        ),
        WalletError::NoSupportedReceivers(_) => Failure::new(
            "unsupported_address",
            "A recipient's address has no receiver this wallet can pay.",
        ),
        WalletError::Address(_) => Failure::new(
            "bad_recipient",
            "A recipient's address could not be read for this network.",
        ),
        WalletError::Payment(payment_error) => Failure::new(
            "bad_recipient",
            format!("A payment is not valid: {payment_error}"),
        ),
        other => Failure::new("send_failed", other.to_string()),
    }
}

// ---------------------------------------------------------------------------------------------
// Analysis: what a proposal does, and what it reveals
// ---------------------------------------------------------------------------------------------

struct Analysis {
    /// The full summary sent to the UI, including the fingerprint.
    summary: Value,
    fingerprint: String,
    /// Value that moves between shielded pools (public on-chain).
    crossing_zat: u64,
    /// Codes of findings that reveal amounts and must be acknowledged before sending.
    requires_ack: Vec<&'static str>,
}

/// Writes `value` as JSON with every object's keys in sorted order and no whitespace, so the same
/// data always produces the same bytes whatever order the keys were inserted in (and whether or
/// not some other crate in the build turned on `serde_json`'s `preserve_order`).
fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Object(map) => {
            out.push('{');
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            for (position, key) in keys.into_iter().enumerate() {
                if position > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push(':');
                write_canonical(&map[key.as_str()], out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (position, item) in items.iter().enumerate() {
                if position > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        scalar => out.push_str(&scalar.to_string()),
    }
}

/// The fingerprint of a proposal: SHA-256 over a version tag and the canonical JSON of everything
/// the person reviews.
pub(crate) fn fingerprint_of(canonical: &Value) -> String {
    let mut text = String::new();
    write_canonical(canonical, &mut text);
    let mut hasher = Sha256::new();
    hasher.update(FINGERPRINT_TAG.as_bytes());
    hasher.update(b"\n");
    hasher.update(text.as_bytes());
    hex::encode(hasher.finalize())
}

fn finding(code: &str, severity: &str, message: String, payment_indexes: Vec<usize>) -> Value {
    json!({
        "code": code,
        "severity": severity,
        "message": message,
        "paymentIndexes": payment_indexes,
    })
}

/// Describes a single-step proposal.
///
/// `kind` is `"transfer"` (a payment to other people) or `"shield"` (moving the wallet's own
/// transparent funds into a shielded pool).
fn analyze<N>(
    params: &Network,
    proposal: &Proposal<StandardFeeRule, N>,
    kind: &'static str,
    funding: &[ShieldedPool],
    target_height: u32,
    ironwood_active: bool,
    // How many of the payments are real recipients; anything after them is padding this wallet
    // pays itself. It is signed like any other output, so the fingerprint covers it, but it is not
    // someone being paid and is not listed as one.
    real_count: usize,
) -> R<Analysis> {
    if proposal.steps().len() != 1 {
        return Err(Failure::new(
            "internal",
            "The proposal unexpectedly has more than one step.",
        ));
    }
    let step = proposal.steps().first();

    // What the transaction spends.
    let mut in_value = [0u64; 3];
    let mut in_count = [0usize; 3];
    if let Some(shielded) = step.shielded_inputs() {
        for note in shielded.notes().iter() {
            let i = pool_index(note.note().pool());
            in_value[i] += u64::from(note.note().value());
            in_count[i] += 1;
        }
    }
    let transparent_in_count = step.transparent_inputs().len();
    let transparent_in_value: u64 = step
        .transparent_inputs()
        .iter()
        .map(|o| u64::from(o.value()))
        .sum();

    // What it creates.
    let mut out_value = [0u64; 3];
    let mut payments = Vec::new();
    let mut canonical_payments = Vec::new();
    let mut to_recipients: u64 = 0;
    let mut transparent_paid: u64 = 0;
    let mut transparent_indexes: Vec<usize> = Vec::new();
    let mut padding_outputs = 0usize;
    for (index, payment) in step.transaction_request().payments() {
        let amount = payment.amount().map(u64::from).unwrap_or(0);
        let pool = step.payment_pools().get(index).copied();
        to_recipients += amount;
        match pool {
            Some(PoolType::Shielded(p)) => out_value[pool_index(p)] += amount,
            Some(PoolType::Transparent) => {
                transparent_paid += amount;
                transparent_indexes.push(*index);
            }
            None => {}
        }
        let address = payment.recipient_address().encode();
        let memo_bytes = payment.memo().map(|m| m.as_slice().to_vec());
        let memo_text = payment.memo().and_then(|m| match Memo::try_from(m) {
            Ok(Memo::Text(text)) => Some(String::from(text)),
            _ => None,
        });
        let pool_label = pool.map(pool_type_name).unwrap_or("unknown");
        if *index >= real_count {
            padding_outputs += 1;
            canonical_payments.push(json!([index, address, amount, Value::Null, pool_label]));
            continue;
        }
        payments.push(json!({
            "index": index,
            "address": address,
            "amountZat": amount,
            "pool": pool_label,
            "memo": memo_text,
            "memoBytes": memo_bytes.as_ref().map(|b| b.len()),
        }));
        canonical_payments.push(json!([
            index,
            address,
            amount,
            memo_bytes.map(hex::encode),
            pool_label
        ]));
    }

    let mut change = Vec::new();
    let mut canonical_change = Vec::new();
    let mut change_total: u64 = 0;
    for item in step.balance().proposed_change() {
        let value = u64::from(item.value());
        change_total += value;
        if let PoolType::Shielded(p) = item.output_pool() {
            out_value[pool_index(p)] += value;
        }
        let label = pool_type_name(item.output_pool());
        change.push(json!({ "pool": label, "valueZat": value }));
        canonical_change.push(json!([label, value]));
    }
    let fee = u64::from(step.balance().fee_required());

    // Value entering a shielded pool from outside that pool is visible on-chain: pool boundaries
    // are public, only what happens inside a pool is hidden.
    let crossing_zat: u64 = if kind == "transfer" {
        (0..3)
            .map(|i| out_value[i].saturating_sub(in_value[i]))
            .sum()
    } else {
        0
    };
    let spends_legacy_orchard = ironwood_active && in_count[pool_index(ShieldedPool::Orchard)] > 0;

    let mut findings = Vec::new();
    let mut requires_ack: Vec<&'static str> = Vec::new();

    if kind == "shield" {
        findings.push(finding(
            "transparent_inputs_public",
            "warn",
            format!(
                "The {} you are shielding ({} ZEC from {}) is already visible on the blockchain. Shielding several transparent addresses in one transaction also shows that they belong together.",
                "funds",
                zec(transparent_in_value),
                plural(transparent_in_count, "coin", "coins"),
            ),
            vec![],
        ));
    }
    if transparent_paid > 0 {
        requires_ack.push("transparent_recipient");
        findings.push(finding(
            "transparent_recipient",
            "high",
            format!(
                "{} go to transparent addresses. The addresses and amounts ({} ZEC in total) will be public on the blockchain.",
                plural(transparent_indexes.len(), "payment", "payments"),
                zec(transparent_paid)
            ),
            transparent_indexes.clone(),
        ));
    }
    if crossing_zat > 0 {
        requires_ack.push("pool_crossing");
        let spent_from: Vec<&str> = POOLS
            .iter()
            .filter(|p| in_count[pool_index(**p)] > 0)
            .map(|p| pool_name(*p))
            .collect();
        findings.push(finding(
            "pool_crossing",
            "warn",
            format!(
                "{} ZEC moves between shielded pools (spending from {}). Pool boundaries are visible on the blockchain, so that amount is public; the recipients and your remaining balance stay private.",
                zec(crossing_zat),
                spent_from.join(" + ")
            ),
            vec![],
        ));
    }
    if spends_legacy_orchard {
        findings.push(finding(
            "legacy_orchard_funds",
            "info",
            "This is funded from the legacy Orchard pool. Since the Ironwood upgrade, value leaving Orchard is visible when it lands in Ironwood. Devoid does not run the fixed-denomination ZIP 318 migration yet.".to_string(),
            vec![],
        ));
    }
    findings.push(finding(
        "shape_visible",
        "info",
        if padding_outputs > 0 {
            format!(
                "Padded to {} outputs: {} of them pay this wallet nothing, so the chain does not show how many people were paid. The number of inputs and outputs is still public, and so is the fee that follows from it. Nobody can see who the recipients are, how much each gets, or which outputs are yours.",
                payments.len() + padding_outputs,
                padding_outputs
            )
        } else {
            "Anyone can see how many inputs and outputs a transaction has (the fee reflects it), so this one shows how many people were paid. Nobody can see who the recipients are, how much each gets, or which outputs are yours.".to_string()
        },
        vec![],
    ));

    let level = if kind == "shield" || transparent_paid > 0 {
        "public"
    } else if crossing_zat > 0 {
        "partial"
    } else {
        "private"
    };

    let estimated_size = proposal.estimated_serialized_size();
    let funding_names: Vec<&str> = funding.iter().map(|p| pool_name(*p)).collect();

    let canonical = json!({
        "v": FINGERPRINT_TAG,
        "network": network_name(*params),
        "kind": kind,
        "payments": canonical_payments,
        "feeZat": fee,
        "change": canonical_change,
        "inputs": [in_count, in_value, transparent_in_count, transparent_in_value],
        "funding": funding_names,
        "padding": padding_outputs,
        "ack": requires_ack,
    });
    let fingerprint = fingerprint_of(&canonical);

    let summary = json!({
        "kind": kind,
        "network": network_name(*params),
        "targetHeight": target_height,
        "ironwoodActive": ironwood_active,
        "fundingPools": funding_names,
        "recipientCount": payments.len(),
        "paddingOutputs": padding_outputs,
        "toRecipientsZat": to_recipients,
        "feeZat": fee,
        "changeZat": change_total,
        "totalDebitZat": to_recipients + fee,
        "estimatedSizeBytes": estimated_size,
        "inputs": {
            "sapling": { "count": in_count[0], "valueZat": in_value[0] },
            "orchard": { "count": in_count[1], "valueZat": in_value[1] },
            "ironwood": { "count": in_count[2], "valueZat": in_value[2] },
            "transparent": { "count": transparent_in_count, "valueZat": transparent_in_value },
        },
        "payments": payments,
        "change": change,
        "privacy": {
            "level": level,
            "crossingZat": crossing_zat,
            "transparentZat": transparent_paid,
            "findings": findings,
            "requiresAck": requires_ack,
        },
        "fingerprint": fingerprint,
    });

    Ok(Analysis {
        summary,
        fingerprint,
        crossing_zat,
        requires_ack,
    })
}

// ---------------------------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------------------------

struct Chosen {
    proposal: Proposal<StandardFeeRule, ReceivedNoteId>,
    analysis: Analysis,
}

/// One attempt at funding the request from a given set of pools. The declared return type pins the
/// generic error parameters of `propose_transfer`.
fn propose_from_pools(
    db: &mut Db,
    params: &Network,
    account_id: AccountUuid,
    request: &TransactionRequest,
    pools: &[ShieldedPool],
    fallback_change_pool: ShieldedPool,
) -> Result<Proposal<StandardFeeRule, ReceivedNoteId>, WalletErrorT> {
    let change_strategy = MultiOutputChangeStrategy::new(
        StandardFeeRule::Zip317,
        None,
        fallback_change_pool,
        DustOutputPolicy::default(),
        // One change note: a batch send is not the place to split notes (every extra output costs
        // a fee and enlarges the transaction).
        SplitPolicy::single_output(),
    );
    let input_selector = GreedyInputSelector::new();
    let spend_policy = SpendPolicy::shielded_pools(pools.iter().copied());

    propose_transfer(
        db,
        params,
        account_id,
        &input_selector,
        &change_strategy,
        request.clone(),
        ConfirmationsPolicy::default(),
        &spend_policy,
        // No input locking: the engine is single-process per wallet, and `send` rebuilds anyway.
        None,
        // The version implied by the target height (version 6 after NU6.3).
        None,
    )
}

fn funding_candidates(funding: &Funding, ironwood_active: bool) -> Vec<Vec<ShieldedPool>> {
    match funding {
        Funding::Pools(list) => vec![list.clone()],
        Funding::Auto => {
            let singles: Vec<ShieldedPool> = if ironwood_active {
                vec![
                    ShieldedPool::Ironwood,
                    ShieldedPool::Sapling,
                    ShieldedPool::Orchard,
                ]
            } else {
                vec![ShieldedPool::Orchard, ShieldedPool::Sapling]
            };
            let mut candidates: Vec<Vec<ShieldedPool>> = singles.iter().map(|p| vec![*p]).collect();
            // Everything together, as a last resort when no single pool can pay.
            candidates.push(singles);
            candidates
        }
    }
}

fn chain_state(wallet: &Wallet) -> R<(u32, bool)> {
    let chain_height = wallet.db.chain_height()?.ok_or_else(sync_required)?;
    let target = chain_height + 1;
    Ok((
        u32::from(target),
        ironwood_active_at(&wallet.params, target),
    ))
}

/// This wallet's own shielded address, which the padding outputs pay.
fn own_shielded_address(wallet: &Wallet) -> R<ZcashAddress> {
    let account = wallet.account()?;
    let (ua, _) = account
        .uivk()
        .default_address(UnifiedAddressRequest::SHIELDED)
        .map_err(|e| {
            Failure::new(
                "internal",
                format!("Could not derive this wallet's own address: {e:?}"),
            )
        })?;
    ZcashAddress::try_from_encoded(&ua.encode(&wallet.params)).map_err(|e| {
        Failure::new(
            "internal",
            format!("Could not read this wallet's own address: {e}"),
        )
    })
}

/// The wallet must know it has scanned everything up to the tip it knows about.
fn ensure_scanned(wallet: &Wallet) -> R<()> {
    if !wallet.db.suggest_scan_ranges()?.is_empty() {
        return Err(sync_required());
    }
    Ok(())
}

fn build_transfer(wallet: &mut Wallet, parsed: &TransferRequest) -> R<Chosen> {
    let account_id = wallet.account_id()?;
    let (target_height, ironwood_active) = chain_state(wallet)?;
    let fallback = if ironwood_active {
        ShieldedPool::Ironwood
    } else {
        ShieldedPool::Orchard
    };
    // Padding pays this wallet zero, as many times as it takes to reach the bucket. The outputs are
    // indistinguishable from the real ones on chain; the only cost is their ZIP 317 actions.
    let real_count = parsed.recipients.len();
    let mut recipients = parsed.recipients.clone();
    if parsed.pad {
        let target = pad_bucket(real_count);
        if target > real_count {
            let own = own_shielded_address(wallet)?;
            for _ in real_count..target {
                recipients.push(Recipient {
                    address: own.clone(),
                    amount: Zatoshis::ZERO,
                    memo: None,
                });
            }
        }
    }
    let request = transaction_request(&recipients)?;

    let mut best: Option<(
        Vec<ShieldedPool>,
        Proposal<StandardFeeRule, ReceivedNoteId>,
        Analysis,
    )> = None;
    let mut insufficient: Option<(u64, u64)> = None;
    let mut hard_error: Option<Failure> = None;

    for pools in funding_candidates(&parsed.funding, ironwood_active) {
        match propose_from_pools(
            &mut wallet.db,
            &wallet.params,
            account_id,
            &request,
            &pools,
            fallback,
        ) {
            Ok(proposal) => {
                let analysis = analyze(
                    &wallet.params,
                    &proposal,
                    "transfer",
                    &pools,
                    target_height,
                    ironwood_active,
                    real_count,
                )?;
                let better = best
                    .as_ref()
                    .is_none_or(|(_, _, current)| analysis.crossing_zat < current.crossing_zat);
                if better {
                    best = Some((pools, proposal, analysis));
                }
            }
            Err(e) => {
                if let Some(pair) = insufficiency(&e) {
                    insufficient = Some(pair);
                } else {
                    hard_error = Some(classify(e));
                }
            }
        }
    }

    match best {
        Some((_, proposal, analysis)) => {
            let size = proposal.estimated_serialized_size();
            if size > MAX_STANDARD_TX_BYTES {
                return Err(Failure::new(
                    "batch_too_large",
                    "This payment would need a transaction larger than the network relays. Send fewer recipients at once, or consolidate small notes first.",
                )
                .with_details(json!({
                    "estimatedBytes": size,
                    "limitBytes": MAX_STANDARD_TX_BYTES,
                })));
            }
            Ok(Chosen { proposal, analysis })
        }
        None => {
            if let Some(failure) = hard_error {
                return Err(failure);
            }
            match insufficient {
                Some((available, required)) => Err(insufficient_funds_failure(available, required)),
                None => Err(Failure::new(
                    "send_failed",
                    "No way to fund this payment was found.",
                )),
            }
        }
    }
}

/// Previews a batch payment: no network, no passphrase.
pub(crate) fn propose(wallet: &mut Wallet, req: &Value) -> R<Value> {
    let parsed = parse_transfer_request(&wallet.params, req)?;
    ensure_scanned(wallet)?;
    let chosen = build_transfer(wallet, &parsed)?;
    Ok(chosen.analysis.summary)
}

// ---------------------------------------------------------------------------------------------
use crate::platform::WalletClock;
use rand::rngs::SysRng;
use rand_core::UnwrapErr;

// Building and broadcasting
// ---------------------------------------------------------------------------------------------

/// True when building `proposal` spends Sapling notes, which needs the Sapling spend parameters.
fn spends_sapling<N>(proposal: &Proposal<StandardFeeRule, N>) -> bool {
    proposal.steps().iter().any(|step| {
        step.shielded_inputs().is_some_and(|inputs| {
            inputs
                .notes()
                .iter()
                .any(|n| matches!(n.note(), zcash_client_backend::wallet::Note::Sapling(_)))
        })
    })
}

fn create_transfer_transactions(
    db: &mut Db,
    params: &Network,
    prover: &Prover,
    usk: UnifiedSpendingKey,
    proposal: &Proposal<StandardFeeRule, ReceivedNoteId>,
) -> Result<Vec<TxId>, WalletErrorT> {
    let result: Result<_, WalletErrorT> = create_proposed_transactions(
        db,
        params,
        &WalletClock,
        &mut UnwrapErr(SysRng),
        prover,
        prover,
        &SpendingKeys::from_unified_spending_key(usk),
        OvkPolicy::Sender,
        proposal,
        // The builder-derived expiry (no override).
        None,
    );
    result.map(|ids| ids.iter().copied().collect())
}

fn create_shielding_transactions(
    db: &mut Db,
    params: &Network,
    prover: &Prover,
    usk: UnifiedSpendingKey,
    proposal: &Proposal<StandardFeeRule, Infallible>,
) -> Result<Vec<TxId>, ShieldErrorT> {
    let result: Result<_, ShieldErrorT> = create_proposed_transactions(
        db,
        params,
        &WalletClock,
        &mut UnwrapErr(SysRng),
        prover,
        prover,
        &SpendingKeys::from_unified_spending_key(usk),
        OvkPolicy::Sender,
        proposal,
        None,
    );
    result.map(|ids| ids.iter().copied().collect())
}

/// The spending key, derived only once the passphrase has been checked.
fn spending_key(wallet: &Wallet, passphrase: &str) -> R<UnifiedSpendingKey> {
    let account = wallet.account()?;
    let account_index = account
        .source()
        .key_derivation()
        .ok_or_else(|| Failure::new("view_only", "This wallet cannot spend."))?
        .account_index();
    let seed = wallet.keys.seed(passphrase)?;
    UnifiedSpendingKey::from_seed(&wallet.params, seed.expose_secret(), account_index).map_err(
        |e| {
            Failure::new(
                "internal",
                format!("The spending key could not be derived: {e}"),
            )
        },
    )
}

fn raw_transaction(db: &Db, txid: TxId) -> R<service::RawTransaction> {
    let transaction = db.get_transaction(txid)?.ok_or_else(|| {
        Failure::new(
            "internal",
            format!("The wallet has no record of transaction {txid}."),
        )
    })?;
    let mut raw = service::RawTransaction::default();
    transaction.write(&mut raw.data).map_err(|e| {
        Failure::new(
            "internal",
            format!("Could not serialize the transaction: {e}"),
        )
    })?;
    Ok(raw)
}

enum Broadcast {
    Accepted,
    /// The node already has this transaction (a harmless repeat).
    AlreadyKnown,
}

async fn broadcast_raw(link: &mut Link, raw: service::RawTransaction, txid: TxId) -> R<Broadcast> {
    match link.client.send_transaction(raw).await {
        Ok(response) => {
            let response = response.into_inner();
            if response.error_code == 0 {
                return Ok(Broadcast::Accepted);
            }
            let reason = response.error_message;
            if reason.to_lowercase().contains("already") {
                return Ok(Broadcast::AlreadyKnown);
            }
            Err(Failure::new(
                "broadcast_rejected",
                format!(
                    "The network did not accept the transaction ({reason}). Your funds have not moved; the wallet frees them when the transaction expires, in about an hour."
                ),
            )
            .with_details(json!({
                "txid": txid.to_string(),
                "code": response.error_code,
                "reason": reason,
            })))
        }
        Err(status) => Err(Failure::new(
            "broadcast_failed",
            "The transaction was created and saved in your wallet, but it could not be sent to the network. It will be sent again automatically.",
        )
        .with_details(json!({
            "txid": txid.to_string(),
            "reason": status.message(),
        }))),
    }
}

/// Sends every new transaction to the network; on failure the error says which ones are saved in
/// the wallet but not yet sent.
async fn broadcast_new(wallet: &Wallet, link: &mut Link, txids: &[TxId]) -> R<()> {
    let mut unsent: Vec<String> = txids.iter().map(|t| t.to_string()).collect();
    for txid in txids {
        let raw = raw_transaction(&wallet.db, *txid)?;
        match broadcast_raw(link, raw, *txid).await {
            Ok(_) => unsent.retain(|t| *t != txid.to_string()),
            Err(failure) => {
                let mut details = match failure.details.clone() {
                    Some(Value::Object(map)) => map,
                    _ => Map::new(),
                };
                details.insert("txids".to_string(), json!(unsent));
                return Err(Failure {
                    details: Some(Value::Object(details)),
                    ..failure
                });
            }
        }
    }
    Ok(())
}

/// Connects, then catches the wallet up so the proposal is built on current data.
async fn connect_and_catch_up(wallet: &mut Wallet, connection: &Connection) -> R<Link> {
    out::progress("connect", json!({}));
    let mut link = connection.open(wallet.params, &wallet.paths).await?;

    let mut cache = open_block_cache(&wallet.paths)?;
    let budget = Budget::from_secs(SEND_SYNC_BUDGET_SECS);
    let report = sync_slice(
        &mut link.client,
        wallet.params,
        &mut wallet.db,
        &mut cache,
        &budget,
        &SyncOptions { enhance: false },
    )
    .await?;
    if !report.synced {
        return Err(Failure::new(
            "sync_incomplete",
            "The wallet is still catching up with the blockchain. Wait for the sync to finish and send again.",
        ));
    }
    Ok(link)
}

fn check_reviewed(
    analysis: &Analysis,
    expected_fingerprint: &str,
    acknowledged: &HashSet<String>,
) -> R<()> {
    if analysis.fingerprint != expected_fingerprint {
        return Err(Failure::new(
            "proposal_changed",
            "The wallet changed since you reviewed this payment (new funds arrived, or the fee changed). Review it again.",
        )
        .with_details(json!({ "summary": analysis.summary })));
    }
    let missing: Vec<&str> = analysis
        .requires_ack
        .iter()
        .copied()
        .filter(|code| !acknowledged.contains(*code))
        .collect();
    if !missing.is_empty() {
        return Err(Failure::new(
            "acknowledgement_required",
            "This payment reveals amounts on the blockchain; confirm that you accept that before sending.",
        )
        .with_details(json!({ "required": missing })));
    }
    Ok(())
}

fn expected_fingerprint(req: &Value) -> R<String> {
    req.get("fingerprint")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| bad_request("Missing the fingerprint of the reviewed payment."))
}

/// Builds, stores and broadcasts the batch payment that was reviewed.
pub(crate) async fn send(
    wallet: &mut Wallet,
    req: &Value,
    passphrase: &str,
    connection: &Connection,
) -> R<Value> {
    let parsed = parse_transfer_request(&wallet.params, req)?;
    let expected = expected_fingerprint(req)?;
    let acknowledged = parse_acknowledgements(req);

    // Authorize first: a wrong passphrase must fail before the network is touched.
    let usk = spending_key(wallet, passphrase)?;

    let mut link = connect_and_catch_up(wallet, connection).await?;

    let chosen = build_transfer(wallet, &parsed)?;
    check_reviewed(&chosen.analysis, &expected, &acknowledged)?;

    out::progress("build", json!({ "recipients": parsed.recipients.len() }));
    let prover = platform::prover(spends_sapling(&chosen.proposal)).await?;
    let txids = create_transfer_transactions(
        &mut wallet.db,
        &wallet.params,
        &prover,
        usk,
        &chosen.proposal,
    )
    .map_err(classify)?;

    out::progress("broadcast", json!({}));
    broadcast_new(wallet, &mut link, &txids).await?;

    Ok(json!({
        "txid": txids.first().map(|t| t.to_string()),
        "txids": txids.iter().map(|t| t.to_string()).collect::<Vec<_>>(),
        "server": link.server,
        "summary": chosen.analysis.summary,
    }))
}

/// Sends transactions the wallet created again: either the listed ones, or every one of the
/// wallet's own transactions that is still unmined and has not expired.
pub(crate) async fn rebroadcast(wallet: &Wallet, req: &Value, connection: &Connection) -> R<Value> {
    let mut jobs: Vec<(TxId, service::RawTransaction)> = Vec::new();
    match req.get("txids").and_then(Value::as_array) {
        Some(list) => {
            for item in list {
                let text = item
                    .as_str()
                    .ok_or_else(|| bad_request("txids must be a list of transaction ids."))?;
                let txid = parse_txid(text)?;
                jobs.push((txid, raw_transaction(&wallet.db, txid)?));
            }
        }
        None => {
            for (txid, bytes) in crate::history::pending_raw(&wallet.paths)? {
                jobs.push((
                    txid,
                    service::RawTransaction {
                        data: bytes,
                        height: 0,
                    },
                ));
            }
        }
    }
    if jobs.is_empty() {
        return Ok(json!({ "results": [] }));
    }

    let mut link = connection.open(wallet.params, &wallet.paths).await?;
    let mut results = Vec::new();
    for (txid, raw) in jobs {
        let status = match broadcast_raw(&mut link, raw, txid).await {
            Ok(Broadcast::Accepted) => json!({ "status": "accepted" }),
            Ok(Broadcast::AlreadyKnown) => json!({ "status": "known" }),
            Err(failure) => {
                warn!("Rebroadcast of {} failed: {}", txid, failure.message);
                json!({ "status": "failed", "code": failure.code, "message": failure.message })
            }
        };
        results.push(json!({ "txid": txid.to_string(), "result": status }));
    }
    Ok(json!({ "results": results, "server": link.server }))
}

// ---------------------------------------------------------------------------------------------
// Shielding: moving the wallet's own transparent funds into a shielded pool
// ---------------------------------------------------------------------------------------------

struct ShieldChosen {
    proposal: Proposal<StandardFeeRule, Infallible>,
    analysis: Analysis,
    addresses: Vec<String>,
}

fn build_shielding(wallet: &mut Wallet, req: &Value) -> R<ShieldChosen> {
    let account_id = wallet.account_id()?;
    let chain_height = wallet.db.chain_height()?.ok_or_else(sync_required)?;
    let target_height = chain_height + 1;
    let ironwood_active = ironwood_active_at(&wallet.params, target_height);
    let shield_pool = if ironwood_active {
        ShieldedPool::Ironwood
    } else {
        ShieldedPool::Orchard
    };
    let policy = ConfirmationsPolicy::default();

    // Which transparent addresses to shield from: the ones named, or all that hold funds.
    let wanted: Option<HashSet<String>> = match req.get("addresses") {
        None | Some(Value::Null) => None,
        Some(Value::Array(items)) if items.is_empty() => None,
        Some(Value::Array(items)) => {
            let mut set = HashSet::new();
            for item in items {
                let text = item.as_str().ok_or_else(|| {
                    bad_request("addresses must be a list of transparent addresses.")
                })?;
                TransparentAddress::decode(&wallet.params, text).map_err(|_| {
                    bad_request(format!(
                        "{text:?} is not a transparent address for this network."
                    ))
                })?;
                set.insert(text.to_string());
            }
            Some(set)
        }
        Some(_) => return Err(bad_request("addresses must be a list.")),
    };

    let balances = wallet.db.get_transparent_balances(
        account_id,
        TargetHeight::from(target_height),
        policy,
    )?;
    let mut from_addrs: Vec<(String, TransparentAddress)> = balances
        .into_iter()
        .filter(|(_, (_, balance))| balance.spendable_value() > Zatoshis::ZERO)
        .map(|(address, _)| (address.encode(&wallet.params), address))
        .filter(|(text, _)| wanted.as_ref().is_none_or(|set| set.contains(text)))
        .collect();
    from_addrs.sort_by(|a, b| a.0.cmp(&b.0));
    if from_addrs.is_empty() {
        return Err(Failure::new(
            "nothing_to_shield",
            "There are no transparent funds ready to shield.",
        ));
    }
    let addresses: Vec<String> = from_addrs.iter().map(|(text, _)| text.clone()).collect();
    let from_addrs: Vec<TransparentAddress> = from_addrs.into_iter().map(|(_, a)| a).collect();

    let change_strategy = MultiOutputChangeStrategy::new(
        StandardFeeRule::Zip317,
        None,
        shield_pool,
        DustOutputPolicy::default(),
        SplitPolicy::single_output(),
    );
    let input_selector = GreedyInputSelector::new();
    let result: Result<Proposal<StandardFeeRule, Infallible>, ShieldErrorT> = propose_shielding(
        &mut wallet.db,
        &wallet.params,
        &input_selector,
        &change_strategy,
        Zatoshis::const_from_u64(SHIELD_THRESHOLD_ZAT),
        &from_addrs,
        account_id,
        policy,
        CoinbaseFilter::AllTransparentOutputs,
        None,
    );
    let proposal = match result {
        Ok(p) => p,
        Err(e) => {
            if let Some((available, _)) = insufficiency(&e) {
                return Err(Failure::new(
                    "nothing_to_shield",
                    format!(
                        "The transparent balance ({} ZEC) is below the minimum worth shielding ({} ZEC).",
                        zec(available),
                        zec(SHIELD_THRESHOLD_ZAT)
                    ),
                ));
            }
            return Err(classify(e));
        }
    };

    let analysis = analyze(
        &wallet.params,
        &proposal,
        "shield",
        &[shield_pool],
        u32::from(target_height),
        ironwood_active,
        usize::MAX, // shielding pays nobody else, so none of its outputs are padding
    )?;
    Ok(ShieldChosen {
        proposal,
        analysis,
        addresses,
    })
}

/// Previews shielding the wallet's transparent funds: no network, no passphrase.
pub(crate) fn propose_shield(wallet: &mut Wallet, req: &Value) -> R<Value> {
    ensure_scanned(wallet)?;
    let chosen = build_shielding(wallet, req)?;
    let mut summary = chosen.analysis.summary;
    summary["addresses"] = json!(chosen.addresses);
    Ok(summary)
}

/// Builds, stores and broadcasts the shielding transaction that was reviewed.
pub(crate) async fn shield(
    wallet: &mut Wallet,
    req: &Value,
    passphrase: &str,
    connection: &Connection,
) -> R<Value> {
    let expected = expected_fingerprint(req)?;
    let acknowledged = parse_acknowledgements(req);
    let usk = spending_key(wallet, passphrase)?;

    let mut link = connect_and_catch_up(wallet, connection).await?;

    let chosen = build_shielding(wallet, req)?;
    check_reviewed(&chosen.analysis, &expected, &acknowledged)?;

    out::progress("build", json!({}));
    let prover = platform::prover(spends_sapling(&chosen.proposal)).await?;
    let txids = create_shielding_transactions(
        &mut wallet.db,
        &wallet.params,
        &prover,
        usk,
        &chosen.proposal,
    )
    .map_err(classify)?;

    out::progress("broadcast", json!({}));
    broadcast_new(wallet, &mut link, &txids).await?;

    let mut summary = chosen.analysis.summary;
    summary["addresses"] = json!(chosen.addresses);
    Ok(json!({
        "txid": txids.first().map(|t| t.to_string()),
        "txids": txids.iter().map(|t| t.to_string()).collect::<Vec<_>>(),
        "server": link.server,
        "summary": summary,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_zec() {
        assert_eq!(zec(0), "0.0");
        assert_eq!(zec(1), "0.00000001");
        assert_eq!(zec(150_000_000), "1.5");
        assert_eq!(zec(100_000_000), "1.0");
        assert_eq!(zec(123_456_789), "1.23456789");
        assert_eq!(zec(2_100_000_000_000_000), "21000000.0");
    }

    #[test]
    fn parses_amounts() {
        assert_eq!(parse_amount_zat(Some(&json!(1))).unwrap().into_u64(), 1);
        assert_eq!(
            parse_amount_zat(Some(&json!("250000"))).unwrap().into_u64(),
            250_000
        );
        assert!(parse_amount_zat(Some(&json!(0))).is_err());
        assert!(parse_amount_zat(Some(&json!(-5))).is_err());
        assert!(parse_amount_zat(Some(&json!(1.5))).is_err());
        assert!(parse_amount_zat(Some(&json!("1.5"))).is_err());
        assert!(parse_amount_zat(Some(&json!("1e3"))).is_err());
        assert!(parse_amount_zat(Some(&json!(""))).is_err());
        assert!(parse_amount_zat(None).is_err());
        assert!(parse_amount_zat(Some(&json!(2_100_000_000_000_001u64))).is_err());
        assert!(parse_amount_zat(Some(&json!("99999999999999999999999"))).is_err());
    }

    #[test]
    fn fingerprints_are_canonical() {
        let a = json!({ "c": { "f": [], "d": "e" }, "b": [1, "x", null, true], "a": 1 });
        let b = json!({ "a": 1, "b": [1, "x", null, true], "c": { "d": "e", "f": [] } });
        assert_eq!(fingerprint_of(&a), fingerprint_of(&b));
        // SHA-256 of "devoid/proposal/1\n" followed by the canonical text
        // {"a":1,"b":[1,"x",null,true],"c":{"d":"e","f":[]}}
        assert_eq!(
            fingerprint_of(&a),
            "d38d9ea000d296668b0db412f608b83f0e49ba02d3b34ba284f54a046b83657b"
        );
        assert_ne!(fingerprint_of(&a), fingerprint_of(&json!({ "a": 2 })));
    }

    #[test]
    fn orders_funding_candidates() {
        let auto = funding_candidates(&Funding::Auto, true);
        assert_eq!(auto.first(), Some(&vec![ShieldedPool::Ironwood]));
        assert_eq!(auto.len(), 4);
        assert_eq!(auto.last().map(Vec::len), Some(3));

        let before = funding_candidates(&Funding::Auto, false);
        assert_eq!(before.first(), Some(&vec![ShieldedPool::Orchard]));
        assert_eq!(before.len(), 3);

        let pinned = funding_candidates(&Funding::Pools(vec![ShieldedPool::Sapling]), true);
        assert_eq!(pinned, vec![vec![ShieldedPool::Sapling]]);
    }

    #[test]
    fn pool_names_round_trip() {
        for pool in POOLS {
            assert_eq!(parse_pool(pool_name(pool)), Some(pool));
        }
        assert_eq!(parse_pool("transparent"), None);
        assert_eq!(pool_type_name(PoolType::Transparent), "transparent");
        assert_eq!(pool_type_name(PoolType::IRONWOOD), "ironwood");
    }

    #[test]
    fn classifies_library_errors() {
        let short: WalletErrorT = WalletError::InsufficientFunds {
            available: Zatoshis::const_from_u64(5),
            required: Zatoshis::const_from_u64(9),
        };
        assert_eq!(insufficiency(&short), Some((5, 9)));
        let failure = classify(short);
        assert_eq!(failure.code, "insufficient_funds");
        let details = failure.details.expect("insufficient funds carries details");
        assert_eq!(details["shortfallZat"], 4);

        let scan: WalletErrorT = WalletError::ScanRequired;
        assert_eq!(classify(scan).code, "sync_required");
    }

    #[test]
    fn parses_transaction_ids() {
        // Displayed ids are byte-reversed relative to the internal order.
        let text = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
        let txid = parse_txid(text).expect("a valid id");
        assert_eq!(txid.to_string(), text);
        let internal: &[u8; 32] = txid.as_ref();
        assert_eq!(internal[0], 0x1f);
        assert_eq!(internal[31], 0x00);
        assert!(parse_txid("not hex").is_err());
        assert!(parse_txid("abcd").is_err());
    }
}
