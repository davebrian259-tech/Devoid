//! The error type every engine command returns.
//!
//! A [`Failure`] carries a stable, machine-readable `code` (the Node server and the UI branch on
//! it), a human-readable `message`, and optional structured `details`. Anything unexpected that
//! bubbles up from a library through `?` becomes code `internal`.

use serde_json::{Value, json};

#[derive(Debug)]
pub(crate) struct Failure {
    pub(crate) code: &'static str,
    pub(crate) message: String,
    pub(crate) details: Option<Value>,
}

impl Failure {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: None,
        }
    }

    pub(crate) fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    pub(crate) fn to_json(&self) -> Value {
        json!({
            "code": self.code,
            "message": self.message,
            "details": self.details,
        })
    }
}

/// Any error convertible to `anyhow::Error` becomes an `internal` failure, which lets command
/// code use `?` on library calls. (`Failure` deliberately does not implement `std::error::Error`,
/// the same arrangement `anyhow::Error` itself uses, so this blanket impl cannot overlap with
/// `impl<T> From<T> for T`.)
impl<E> From<E> for Failure
where
    E: Into<anyhow::Error>,
{
    fn from(e: E) -> Self {
        let err: anyhow::Error = e.into();
        Failure::new("internal", format!("{err:#}"))
    }
}

pub(crate) type R<T> = Result<T, Failure>;
