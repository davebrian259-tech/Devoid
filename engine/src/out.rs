//! Everything the engine prints on stdout is newline-delimited JSON, one object per line.
//!
//! Progress events look like `{"event":"progress","stage":"scan",...}`. The last line of every
//! run is the result: `{"ok":true,"result":...}` or `{"ok":false,"error":{...}}`. Logs go to
//! stderr and never contain secrets.

use std::io::Write;

use serde_json::{Value, json};

pub(crate) fn line(value: &Value) {
    let mut out = std::io::stdout().lock();
    // A closed stdout means the parent went away; there is nobody left to tell.
    let _ = serde_json::to_writer(&mut out, value);
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}

/// Reports progress of a long-running command. `fields` must be a JSON object.
pub(crate) fn progress(stage: &str, fields: Value) {
    let mut event = json!({ "event": "progress", "stage": stage });
    if let (Some(target), Value::Object(extra)) = (event.as_object_mut(), fields) {
        for (key, value) in extra {
            target.insert(key, value);
        }
    }
    line(&event);
}
