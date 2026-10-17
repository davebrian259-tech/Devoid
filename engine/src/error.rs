//! Library error types, as wired up in zcash-devtool (MIT OR Apache-2.0).
//!
//! The aliases pin down the generic parameters of `data_api::error::Error` for the greedy input
//! selector, the ZIP 317 fee rule and the SQLite wallet, so call sites can write
//! `.map_err(error::Error::from)?`.

use std::convert::Infallible;
use std::fmt;

use zcash_client_backend::data_api::{
    BirthdayError, error::Error as WalletError, wallet::input_selection::GreedyInputSelectorError,
};
use zcash_client_sqlite::{
    FsBlockDbError, ReceivedNoteId, error::SqliteClientError, wallet::commitment_tree,
};
use zcash_keys::keys::DerivationError;
use zcash_primitives::transaction::fees::zip317;
use zip321::Zip321Error;

pub(crate) type WalletErrorT = WalletError<
    SqliteClientError,
    commitment_tree::Error,
    GreedyInputSelectorError,
    zip317::FeeError,
    zip317::FeeError,
    ReceivedNoteId,
>;

pub(crate) type ShieldErrorT = WalletError<
    SqliteClientError,
    commitment_tree::Error,
    GreedyInputSelectorError,
    zip317::FeeError,
    zip317::FeeError,
    Infallible,
>;

#[derive(Debug)]
pub enum Error {
    Cache(FsBlockDbError),
    Derivation(DerivationError),
    InvalidAmount,
    InvalidTreeState,
    SendFailed { code: i32, reason: String },
    Shield(ShieldErrorT),
    Wallet(WalletErrorT),
    Zip321(Zip321Error),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Cache(e) => write!(f, "{e:?}"),
            Error::Derivation(e) => write!(f, "{e:?}"),
            Error::InvalidAmount => write!(f, "Invalid amount"),
            Error::InvalidTreeState => write!(f, "Invalid TreeState received from server"),
            Error::SendFailed { code, reason } => write!(f, "Send failed: ({code}) {reason}"),
            Error::Shield(e) => e.fmt(f),
            Error::Wallet(e) => e.fmt(f),
            Error::Zip321(e) => write!(f, "{e:?}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<BirthdayError> for Error {
    fn from(_: BirthdayError) -> Self {
        Error::InvalidTreeState
    }
}

impl From<DerivationError> for Error {
    fn from(e: DerivationError) -> Self {
        Error::Derivation(e)
    }
}

impl From<FsBlockDbError> for Error {
    fn from(e: FsBlockDbError) -> Self {
        Error::Cache(e)
    }
}

impl From<WalletErrorT> for Error {
    fn from(e: WalletErrorT) -> Self {
        Error::Wallet(e)
    }
}

impl From<Zip321Error> for Error {
    fn from(e: Zip321Error) -> Self {
        Error::Zip321(e)
    }
}
