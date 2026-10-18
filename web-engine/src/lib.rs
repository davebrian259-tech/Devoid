//! The Devoid wallet engine, compiled for the browser.
//!
//! The page (a Web Worker, see ui/engine/worker.js) calls [`run`] with the same JSON requests the
//! native engine reads on stdin and gets the same final JSON back; progress lines go to the
//! callback it passes. The wallet logic is the native engine's own source, compiled from
//! engine/src; only `platform`, `remote` and the entry points here are specific to the browser.
//!
//! Storage: the engine keeps the wallet folder in memory. Before the first command the page loads
//! the saved files with [`import_file`]; after each command it saves [`export_files`]. Secrets
//! never leave the engine unencrypted: the recovery phrase is stored only inside keys.json,
//! encrypted with the passphrase, exactly as on disk in the native build.

#[path = "../../engine/src/commands.rs"]
mod commands;
// The browser has no Tor and no block files, so a few native-only helpers go unused here.
mod check;
#[allow(dead_code)]
#[path = "../../engine/src/data.rs"]
mod data;
#[allow(dead_code)]
#[path = "../../engine/src/error.rs"]
mod error;
#[path = "../../engine/src/failure.rs"]
mod failure;
#[path = "../../engine/src/history.rs"]
mod history;
#[path = "../../engine/src/keystore.rs"]
mod keystore;
#[path = "../../engine/src/out.rs"]
mod out;
mod platform;
mod remote;
#[path = "../../engine/src/selftest.rs"]
mod selftest;
#[path = "../../engine/src/spend.rs"]
mod spend;
#[path = "../../engine/src/sync.rs"]
mod sync;
#[path = "../../engine/src/wallet.rs"]
mod wallet;

use serde_json::{Value, json};
use wasm_bindgen::prelude::*;

use failure::Failure;

/// Reports where a panic happened, and nothing else: a panic message could quote data that must
/// not be logged. A panic aborts the module; the worker starts a fresh one.
#[wasm_bindgen(start)]
pub fn start() {
    std::panic::set_hook(Box::new(|info| {
        let place = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "an unknown location".to_string());
        web_sys_console_error(&format!("devoid-engine: internal error at {place}"));
    }));
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn web_sys_console_error(message: &str);
    #[wasm_bindgen(js_namespace = console, js_name = log)]
    fn web_sys_console_log(message: &str);
}

/// Sends the engine's log to the browser console at `level` ("info", "debug", ...). Off unless
/// asked for; the log never contains secrets, as in the native engine.
#[wasm_bindgen(js_name = enableLogging)]
pub fn enable_logging(level: String) {
    struct Console;
    impl std::io::Write for Console {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            web_sys_console_log(String::from_utf8_lossy(buf).trim_end());
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::new(level))
        .with_writer(|| Console)
        .with_ansi(false)
        .without_time()
        .try_init();
}

/// Runs one command. `request` is the JSON request; `on_line` receives each progress line.
/// Returns the final line: `{"ok":true,"result":...}` or `{"ok":false,"error":...}`.
#[wasm_bindgen]
pub async fn run(request: String, on_line: js_sys::Function) -> String {
    platform::set_emitter(Some(on_line));
    let result = match serde_json::from_str::<Value>(&request) {
        Ok(req) => commands::run(req).await,
        Err(e) => Err(Failure::new(
            "bad_request",
            format!("The request is not valid JSON: {e}"),
        )),
    };
    platform::set_emitter(None);
    match result {
        Ok(value) => json!({ "ok": true, "result": value }),
        Err(failure) => json!({ "ok": false, "error": failure.to_json() }),
    }
    .to_string()
}

/// Builds and proves one throw-away transaction offline (see `check.rs`) and reports how long it
/// took, as the same JSON final line `run` returns.
#[wasm_bindgen(js_name = checkProving)]
pub async fn check_proving(on_line: js_sys::Function) -> String {
    platform::set_emitter(Some(on_line));
    let result = check::prove_one_transaction().await;
    platform::set_emitter(None);
    match result {
        Ok(value) => json!({ "ok": true, "result": value }),
        Err(failure) => json!({ "ok": false, "error": failure.to_json() }),
    }
    .to_string()
}

/// Sets the function that fetches Sapling parameter files: `(name) => Promise<Uint8Array>`.
#[wasm_bindgen(js_name = setParamLoader)]
pub fn set_param_loader(loader: js_sys::Function) {
    platform::set_param_loader(loader);
}

/// Loads one saved file of the wallet folder.
#[wasm_bindgen(js_name = importFile)]
pub fn import_file(path: String, bytes: Vec<u8>) -> Result<(), JsValue> {
    platform::import_file(&path, &bytes).map_err(|e| JsValue::from_str(&e))
}

/// Every file of the wallet folder, as `[path, bytes]` pairs, for the page to save.
#[wasm_bindgen(js_name = exportFiles)]
pub fn export_files() -> js_sys::Array {
    platform::export_files()
        .into_iter()
        .map(|(path, bytes)| {
            let pair = js_sys::Array::new();
            pair.push(&JsValue::from_str(&path));
            pair.push(&js_sys::Uint8Array::from(&bytes[..]));
            JsValue::from(pair)
        })
        .collect()
}

/// Forgets the whole wallet folder (the page deletes its saved copy too).
#[wasm_bindgen(js_name = clearFiles)]
pub fn clear_files() {
    platform::clear_files();
}
