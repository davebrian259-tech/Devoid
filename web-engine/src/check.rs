//! Proves that this browser can build a payment, before anyone needs it to.
//!
//! Builds and proves one complete testnet transaction offline, with the same library builder,
//! fee rule and provers a real send uses: a made-up transparent coin pays one Sapling and one
//! Orchard recipient, so both proving systems run (Sapling's Groth16 with the parameters fetched
//! from this site, Orchard's Halo 2 with no parameters). The transaction spends a coin that does
//! not exist and is thrown away; nothing touches the network. The timings say how long a real
//! batch will take on this device.

use rand::rngs::OsRng;
use serde_json::{Value, json};
use transparent::{
    address::TransparentAddress,
    builder::TransparentSigningSet,
    bundle::{OutPoint, TxOut},
};
use zcash_primitives::transaction::{
    builder::{BuildConfig, Builder, BundlePadding},
    fees::zip317::FeeRule,
};
use zcash_protocol::{
    consensus::{BlockHeight, Network},
    memo::MemoBytes,
    value::Zatoshis,
};

use crate::{
    failure::{Failure, R},
    platform::{self, Instant},
};

/// A testnet height before Ironwood (NU6.3), where Orchard outputs are still created; the
/// proving work is the same for Ironwood, whose actions use the Orchard circuit.
const TARGET_HEIGHT: u32 = 3_600_000;

pub(crate) async fn prove_one_transaction() -> R<Value> {
    let params = Network::TestNetwork;
    let started = Instant::now();
    let prover = platform::prover(false).await?;
    let params_ms = started.elapsed().as_millis() as u64;

    let mut builder = Builder::new(
        params,
        BlockHeight::from_u32(TARGET_HEIGHT),
        BuildConfig::Standard {
            sapling_anchor: Some(sapling::Anchor::empty_tree()),
            orchard_anchor: Some(orchard::Anchor::empty_tree()),
            ironwood_anchor: None,
            orchard_padding: BundlePadding::DEFAULT,
            ironwood_padding: BundlePadding::DEFAULT,
        },
    );

    let internal = |e: String| {
        Failure::new(
            "internal",
            format!("Building the check transaction failed: {e}"),
        )
    };
    let mut signing = TransparentSigningSet::new();
    let sk = secp256k1::SecretKey::from_slice(&[7u8; 32]).map_err(|e| internal(e.to_string()))?;
    let pubkey = signing.add_key(sk);
    let coin = TxOut::new(
        Zatoshis::const_from_u64(45_000),
        TransparentAddress::from_pubkey(&pubkey).script().into(),
    );
    builder
        .add_transparent_p2pkh_input(pubkey, OutPoint::new([1u8; 32], 0), coin)
        .map_err(|e| internal(format!("{e:?}")))?;

    let sapling_to = sapling::zip32::ExtendedSpendingKey::master(&[3u8; 32])
        .default_address()
        .1;
    builder
        .add_sapling_output::<std::convert::Infallible>(
            None,
            sapling_to,
            Zatoshis::const_from_u64(10_000),
            MemoBytes::empty(),
        )
        .map_err(|e| internal(format!("{e:?}")))?;
    let orchard_sk: orchard::keys::SpendingKey =
        Option::from(orchard::keys::SpendingKey::from_bytes([5u8; 32]))
            .ok_or_else(|| internal("bad Orchard key".into()))?;
    let orchard_to = orchard::keys::FullViewingKey::from(&orchard_sk)
        .address_at(0u32, orchard::keys::Scope::External);
    builder
        .add_orchard_output::<std::convert::Infallible>(
            None,
            orchard_to,
            Zatoshis::const_from_u64(10_000),
            MemoBytes::empty(),
        )
        .map_err(|e| internal(format!("{e:?}")))?;

    let build_started = Instant::now();
    let built = builder
        .build(
            &signing,
            &[],
            &[],
            OsRng,
            &prover,
            &prover,
            &FeeRule::standard(),
        )
        .map_err(|e| internal(format!("{e:?}")))?;
    let prove_ms = build_started.elapsed().as_millis() as u64;

    let tx = built.transaction();
    let mut bytes = Vec::new();
    tx.write(&mut bytes).map_err(|e| internal(e.to_string()))?;
    let actions = tx.orchard_bundle().map(|b| b.actions().len()).unwrap_or(0);
    let sapling_outputs = tx
        .sapling_bundle()
        .map(|b| b.shielded_outputs().len())
        .unwrap_or(0);

    Ok(json!({
        "txid": tx.txid().to_string(),
        "bytes": bytes.len(),
        "orchardActions": actions,
        "saplingOutputs": sapling_outputs,
        "paramsMs": params_ms,
        "proveMs": prove_ms,
        // Each further recipient adds about one Orchard action.
        "msPerAction": if actions > 0 { prove_ms / (actions as u64 + sapling_outputs as u64) } else { 0 },
    }))
}
