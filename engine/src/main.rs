//! `devoid-engine`: the wallet engine behind Devoid.
//!
//! The engine is deliberately stateless between runs: **one process runs one command**. The caller
//! writes a single JSON request on stdin and reads newline-delimited JSON from stdout: zero or more
//! progress events (`{"event":"progress",...}`), then exactly one final line, either
//! `{"ok":true,"result":...}` or `{"ok":false,"error":{"code","message","details"}}`. Logs go to
//! stderr and never contain secrets. The exit code is 0 on success and 1 on a reported failure.
//!
//! Secrets (the passphrase, a recovery phrase being restored) are part of the request and live only
//! as long as the process; nothing secret is ever written to disk unencrypted or printed.
//!
//! Usage:
//!
//! ```text
//! echo '{"cmd":"version"}' | devoid-engine
//! devoid-engine version        # same, without stdin
//! devoid-engine selftest       # offline self-check of the wiring to the Zcash libraries
//! ```

mod commands;
mod data;
mod error;
mod failure;
mod history;
mod keystore;
mod out;
mod remote;
mod selftest;
mod socks;
mod spend;
mod sync;
mod wallet;

use std::{io::Read, panic::AssertUnwindSafe};

use futures_util::FutureExt;
use serde_json::{Value, json};

use failure::{Failure, R};

/// Requests are small; anything bigger is a mistake or an attack.
const MAX_REQUEST_BYTES: u64 = 4 * 1024 * 1024;

/// Exit code for a command that failed with a reported error.
const EXIT_FAILURE: i32 = 1;
/// Exit code for a bad command line.
const EXIT_USAGE: i32 = 2;
/// Exit code for a crash inside the engine.
const EXIT_CRASH: i32 = 70;

fn init_logging() {
    let filter = tracing_subscriber::EnvFilter::try_from_env("DEVOID_LOG")
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .try_init();
}

/// Reports where a panic happened, and nothing else: a panic message could quote data that must
/// not be logged.
fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let place = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "an unknown location".to_string());
        eprintln!("devoid-engine: internal error at {place}");
    }));
}

fn read_request() -> R<Value> {
    let mut input = Vec::new();
    std::io::stdin()
        .lock()
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut input)?;
    if input.len() as u64 > MAX_REQUEST_BYTES {
        return Err(Failure::new("bad_request", "The request is too large."));
    }
    serde_json::from_slice(&input)
        .map_err(|e| Failure::new("bad_request", format!("The request is not valid JSON: {e}")))
}

/// Prints the final line and returns the process exit code.
fn finish(result: R<Value>) -> i32 {
    match result {
        Ok(value) => {
            out::line(&json!({ "ok": true, "result": value }));
            0
        }
        Err(failure) => {
            out::line(&json!({ "ok": false, "error": failure.to_json() }));
            EXIT_FAILURE
        }
    }
}

async fn execute() -> i32 {
    let mut args = std::env::args().skip(1);
    let request = match args.next().as_deref() {
        None => match read_request() {
            Ok(request) => request,
            Err(failure) => return finish(Err(failure)),
        },
        Some("version" | "--version" | "-V") => json!({ "cmd": "version" }),
        Some("selftest") => json!({ "cmd": "selftest" }),
        Some(other) => {
            let failure = Failure::new(
                "bad_request",
                format!(
                    "Unexpected argument {other:?}. The engine reads one JSON request from stdin."
                ),
            );
            finish(Err(failure));
            return EXIT_USAGE;
        }
    };

    // A panic anywhere in a command becomes a reported failure instead of a silent crash.
    match AssertUnwindSafe(commands::run(request))
        .catch_unwind()
        .await
    {
        Ok(result) => finish(result),
        Err(_) => {
            finish(Err(Failure::new(
                "internal",
                "The wallet engine stopped unexpectedly. Nothing was sent; please try again.",
            )));
            EXIT_CRASH
        }
    }
}

fn main() {
    install_panic_hook();
    init_logging();

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => {
            finish(Err(Failure::new(
                "internal",
                format!("The async runtime could not start: {e}"),
            )));
            std::process::exit(EXIT_CRASH);
        }
    };
    let code = runtime.block_on(execute());
    std::process::exit(code);
}
