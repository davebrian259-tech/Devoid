//! Transaction history, read straight from the wallet database's documented views.
//!
//! `v_transactions` and `v_tx_outputs` already carry everything a history screen needs: mined
//! height and time, the fee, whether a transaction was a shielding or a pool crossing, how many
//! notes and memos were involved, and the recipient address of every output the wallet created. The
//! engine therefore reads them through a separate **read-only** connection and re-derives nothing
//! (the library has no stable Rust API for this; the views are its documented interface to other
//! software).
//!
//! The same connection also finds the wallet's own transactions that were created but never mined,
//! which is what `rebroadcast` sends again.

use std::time::Duration;

use rusqlite::{Connection, OpenFlags, Row, params};
use serde_json::{Value, json};
use zcash_client_backend::data_api::WalletRead;
use zcash_primitives::transaction::TxId;
use zcash_protocol::memo::Memo;

use crate::{
    data::WalletPaths,
    failure::{Failure, R},
    spend::parse_txid,
    wallet::Wallet,
};

const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 500;

fn open_read_only(paths: &WalletPaths) -> R<Connection> {
    if !paths.exists() {
        return Err(Failure::new(
            "no_wallet",
            "There is no wallet in this folder yet.",
        ));
    }
    let connection = Connection::open_with_flags(
        paths.data_db(),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(Duration::from_secs(10))?;

    let has_views: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master \
         WHERE type = 'view' AND name IN ('v_transactions', 'v_tx_outputs')",
        [],
        |row| row.get(0),
    )?;
    if has_views != 2 {
        return Err(Failure::new(
            "upgrade_required",
            "The wallet database needs to be upgraded before its history can be read.",
        ));
    }
    Ok(connection)
}

/// One row of `v_transactions`.
struct TxRow {
    txid: TxId,
    mined_height: Option<i64>,
    expiry_height: Option<i64>,
    block_time: Option<i64>,
    balance_delta: i64,
    total_spent: i64,
    total_received: i64,
    fee: Option<i64>,
    sent_notes: i64,
    received_notes: i64,
    spent_notes: i64,
    memo_count: i64,
    expired: bool,
    is_shielding: bool,
    pool_crossing: Option<i64>,
    zip318: i64,
}

const TX_COLUMNS: &str = "txid, mined_height, expiry_height, block_time, account_balance_delta, \
     total_spent, total_received, fee_paid, sent_note_count, received_note_count, \
     spent_note_count, memo_count, expired_unmined, is_shielding, pool_crossing_value, zip318_kind";

fn read_tx_row(row: &Row<'_>) -> rusqlite::Result<TxRow> {
    let bytes: Vec<u8> = row.get(0)?;
    let internal: [u8; 32] = bytes.as_slice().try_into().map_err(|_| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Blob,
            "a transaction id must be 32 bytes".into(),
        )
    })?;
    let int = |index: usize| -> rusqlite::Result<i64> {
        Ok(row.get::<_, Option<i64>>(index)?.unwrap_or(0))
    };
    Ok(TxRow {
        txid: TxId::from_bytes(internal),
        mined_height: row.get(1)?,
        expiry_height: row.get(2)?,
        block_time: row.get(3)?,
        balance_delta: int(4)?,
        total_spent: int(5)?,
        total_received: int(6)?,
        fee: row.get(7)?,
        sent_notes: int(8)?,
        received_notes: int(9)?,
        spent_notes: int(10)?,
        memo_count: int(11)?,
        expired: int(12)? != 0,
        is_shielding: int(13)? != 0,
        pool_crossing: row.get(14)?,
        zip318: int(15)?,
    })
}

/// `"shielded"`, `"internal"`, `"sent"` or `"received"`.
fn kind_of(row: &TxRow) -> &'static str {
    if row.is_shielding {
        "shielded"
    } else if row.pool_crossing.is_some() {
        "internal"
    } else if row.spent_notes > 0 {
        // Spending only to oneself costs exactly the fee.
        let fee_only = row.sent_notes == 0 && row.fee.is_some_and(|fee| row.balance_delta == -fee);
        if fee_only { "internal" } else { "sent" }
    } else {
        "received"
    }
}

fn status_of(row: &TxRow) -> &'static str {
    if row.mined_height.is_some() {
        "confirmed"
    } else if row.expired {
        "expired"
    } else {
        "pending"
    }
}

fn zip318_label(code: i64) -> Value {
    match code {
        2 => json!("preparation"),
        3 => json!("transfer"),
        _ => Value::Null,
    }
}

fn pool_label(code: i64) -> &'static str {
    match code {
        0 => "transparent",
        1 => "sprout",
        2 => "sapling",
        3 => "orchard",
        4 => "ironwood",
        _ => "unknown",
    }
}

/// `(text, kind)` where `kind` is `"text"`, `"binary"` or `"invalid"`; `None` when there is no memo.
fn decode_memo(bytes: Option<&[u8]>) -> (Option<String>, Option<&'static str>) {
    let Some(bytes) = bytes else {
        return (None, None);
    };
    match Memo::from_bytes(bytes) {
        Ok(Memo::Empty) => (None, None),
        Ok(Memo::Text(text)) => (Some(String::from(text)), Some("text")),
        Ok(Memo::Future(_)) | Ok(Memo::Arbitrary(_)) => (None, Some("binary")),
        Err(_) => (None, Some("invalid")),
    }
}

fn outputs_of(connection: &Connection, txid: &TxId) -> R<Vec<Value>> {
    let mut statement = connection.prepare(
        "SELECT output_pool, output_index, to_address, value, is_change, \
                to_account_uuid IS NOT NULL, memo \
         FROM v_tx_outputs WHERE txid = ?1 \
         ORDER BY output_pool, output_index",
    )?;
    let rows = statement.query_map(params![txid.as_ref().as_slice()], |row| {
        let pool: i64 = row.get(0)?;
        let index: i64 = row.get(1)?;
        let address: Option<String> = row.get(2)?;
        let value: Option<i64> = row.get(3)?;
        let is_change: Option<i64> = row.get(4)?;
        let to_self: Option<i64> = row.get(5)?;
        let memo: Option<Vec<u8>> = row.get(6)?;
        Ok((pool, index, address, value, is_change, to_self, memo))
    })?;

    let mut outputs = Vec::new();
    for row in rows {
        let (pool, index, address, value, is_change, to_self, memo) = row?;
        let (text, memo_kind) = decode_memo(memo.as_deref());
        outputs.push(json!({
            "pool": pool_label(pool),
            "index": index,
            "address": address,
            "valueZat": value.unwrap_or(0),
            "isChange": is_change.unwrap_or(0) != 0,
            "toSelf": to_self.unwrap_or(0) != 0,
            "memo": text,
            "memoKind": memo_kind,
        }));
    }
    Ok(outputs)
}

fn opt_usize(req: &Value, key: &str, default: usize) -> R<usize> {
    match req.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(value) => value
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .ok_or_else(|| Failure::new("bad_request", format!("{key} must be a whole number."))),
    }
}

/// Lists transactions, newest first (unmined ones on top).
///
/// Request fields (all optional): `limit` (default 50, at most 500), `offset`, `txid` (just that
/// transaction, with its outputs) and `outputs` (include each transaction's outputs).
pub(crate) fn history(wallet: &Wallet, req: &Value) -> R<Value> {
    let limit = opt_usize(req, "limit", DEFAULT_LIMIT)?.clamp(1, MAX_LIMIT);
    let offset = opt_usize(req, "offset", 0)?;
    let only = match req.get("txid") {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(parse_txid(text)?),
        Some(_) => {
            return Err(Failure::new("bad_request", "txid must be text."));
        }
    };
    let with_outputs =
        only.is_some() || req.get("outputs").and_then(Value::as_bool).unwrap_or(false);

    let chain_height = wallet.db.chain_height()?.map(|h| i64::from(u32::from(h)));
    let connection = open_read_only(&wallet.paths)?;

    let sql = format!(
        "SELECT {TX_COLUMNS} FROM v_transactions \
         WHERE (?1 IS NULL OR txid = ?1) \
         ORDER BY (mined_height IS NULL) DESC, COALESCE(mined_height, expiry_height) DESC, \
                  tx_index DESC, txid DESC \
         LIMIT ?2 OFFSET ?3"
    );
    let mut statement = connection.prepare(&sql)?;
    let only_bytes: Option<Vec<u8>> = only.map(|t| t.as_ref().to_vec());
    // One extra row tells whether there is a next page.
    let fetch = i64::try_from(limit + 1).unwrap_or(i64::MAX);
    let skip = i64::try_from(offset).unwrap_or(i64::MAX);
    let mapped = statement.query_map(params![only_bytes, fetch, skip], read_tx_row)?;
    let mut rows = Vec::new();
    for row in mapped {
        rows.push(row?);
    }
    let has_more = rows.len() > limit;
    rows.truncate(limit);

    let mut transactions = Vec::with_capacity(rows.len());
    for row in &rows {
        let confirmations = match (chain_height, row.mined_height) {
            (Some(tip), Some(mined)) if tip >= mined => Some(tip - mined + 1),
            (_, Some(_)) => Some(1),
            _ => None,
        };
        let mut entry = json!({
            "txid": row.txid.to_string(),
            "kind": kind_of(row),
            "status": status_of(row),
            "minedHeight": row.mined_height,
            "blockTime": row.block_time,
            "expiryHeight": row.expiry_height.filter(|h| *h > 0),
            "confirmations": confirmations,
            "balanceDeltaZat": row.balance_delta,
            "feeZat": row.fee,
            "spentZat": row.total_spent,
            "receivedZat": row.total_received,
            "sentOutputs": row.sent_notes,
            "receivedOutputs": row.received_notes,
            "memoCount": row.memo_count,
            "poolCrossingZat": row.pool_crossing,
            "zip318": zip318_label(row.zip318),
        });
        if with_outputs {
            entry["outputs"] = Value::Array(outputs_of(&connection, &row.txid)?);
        }
        transactions.push(entry);
    }

    if let Some(txid) = only
        && transactions.is_empty()
    {
        return Err(Failure::new(
            "not_found",
            format!("The wallet has no transaction {txid}."),
        ));
    }

    Ok(json!({
        "chainHeight": chain_height,
        "transactions": transactions,
        "hasMore": has_more,
    }))
}

/// The wallet's own transactions that have neither been mined nor expired, with their serialized
/// bytes, ready to be sent to the network again.
pub(crate) fn pending_raw(paths: &WalletPaths) -> R<Vec<(TxId, Vec<u8>)>> {
    let connection = open_read_only(paths)?;
    let mut statement = connection.prepare(
        "SELECT txid, raw FROM v_transactions \
         WHERE mined_height IS NULL AND raw IS NOT NULL AND spent_note_count > 0 \
           AND COALESCE(expired_unmined, 0) = 0",
    )?;
    let mapped = statement.query_map([], |row| {
        let txid: Vec<u8> = row.get(0)?;
        let raw: Vec<u8> = row.get(1)?;
        Ok((txid, raw))
    })?;

    let mut pending = Vec::new();
    for row in mapped {
        let (txid, raw) = row?;
        let internal: [u8; 32] = txid.as_slice().try_into().map_err(|_| {
            Failure::new("internal", "The wallet holds a malformed transaction id.")
        })?;
        pending.push((TxId::from_bytes(internal), raw));
    }
    Ok(pending)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row() -> TxRow {
        TxRow {
            txid: TxId::from_bytes([7; 32]),
            mined_height: Some(100),
            expiry_height: Some(140),
            block_time: Some(1_700_000_000),
            balance_delta: 0,
            total_spent: 0,
            total_received: 0,
            fee: Some(10_000),
            sent_notes: 0,
            received_notes: 0,
            spent_notes: 0,
            memo_count: 0,
            expired: false,
            is_shielding: false,
            pool_crossing: None,
            zip318: 0,
        }
    }

    #[test]
    fn classifies_kinds() {
        let received = TxRow {
            balance_delta: 500,
            received_notes: 1,
            ..row()
        };
        assert_eq!(kind_of(&received), "received");

        let sent = TxRow {
            balance_delta: -2_510_000,
            spent_notes: 1,
            sent_notes: 2,
            ..row()
        };
        assert_eq!(kind_of(&sent), "sent");

        // Funds spent without a recorded recipient (a wallet restored from its phrase) still read
        // as a payment.
        let unknown_recipient = TxRow {
            balance_delta: -2_000_000,
            spent_notes: 1,
            ..row()
        };
        assert_eq!(kind_of(&unknown_recipient), "sent");

        let to_self = TxRow {
            balance_delta: -10_000,
            spent_notes: 1,
            ..row()
        };
        assert_eq!(kind_of(&to_self), "internal");

        let shielding = TxRow {
            is_shielding: true,
            spent_notes: 1,
            ..row()
        };
        assert_eq!(kind_of(&shielding), "shielded");

        let crossing = TxRow {
            pool_crossing: Some(42),
            spent_notes: 1,
            ..row()
        };
        assert_eq!(kind_of(&crossing), "internal");
    }

    #[test]
    fn derives_status() {
        assert_eq!(status_of(&row()), "confirmed");
        let pending = TxRow {
            mined_height: None,
            ..row()
        };
        assert_eq!(status_of(&pending), "pending");
        let expired = TxRow {
            mined_height: None,
            expired: true,
            ..row()
        };
        assert_eq!(status_of(&expired), "expired");
    }

    #[test]
    fn decodes_memos() {
        assert_eq!(decode_memo(None), (None, None));
        // A single 0xF6 byte is "no memo".
        assert_eq!(decode_memo(Some(&[0xF6][..])), (None, None));
        assert_eq!(
            decode_memo(Some(&b"thanks!"[..])),
            (Some("thanks!".to_string()), Some("text"))
        );
        assert_eq!(
            decode_memo(Some(&[0xFF, 1, 2, 3][..])),
            (None, Some("binary"))
        );
        assert_eq!(
            decode_memo(Some(&[0xC3, 0x28][..])),
            (None, Some("invalid"))
        );
    }

    #[test]
    fn names_pools_and_codes() {
        assert_eq!(pool_label(0), "transparent");
        assert_eq!(pool_label(2), "sapling");
        assert_eq!(pool_label(3), "orchard");
        assert_eq!(pool_label(4), "ironwood");
        assert_eq!(pool_label(9), "unknown");
        assert_eq!(zip318_label(0), Value::Null);
        assert_eq!(zip318_label(1), Value::Null);
        assert_eq!(zip318_label(2), json!("preparation"));
        assert_eq!(zip318_label(3), json!("transfer"));
    }
}
