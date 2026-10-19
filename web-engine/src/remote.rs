//! Connecting to a lightwalletd server from the browser.
//!
//! A page can only speak gRPC-web, so the server must offer it (with CORS for the page's origin).
//! Most public lightwalletd servers speak plain gRPC only; ChainSafe runs gRPC-web proxies in front
//! of lightwalletd for both networks, and those are the defaults. The same request shape as the
//! native engine's `remote.rs` is accepted: `{ "servers": preset | "https://..." | [...], "mode" }`.
//! There is no Tor or SOCKS in a browser, so the only mode is `direct`, and the page says plainly
//! that the server sees the visitor's IP address.

use std::time::Duration;

use serde_json::{Value, json};
use tracing::warn;
use zcash_client_backend::proto::service::{
    self, compact_tx_streamer_client::CompactTxStreamerClient,
};
use zcash_protocol::consensus::Network;

use crate::{
    data::{WalletPaths, network_name},
    failure::{Failure, R},
    platform::{Client, timeout},
};

const CHAINSAFE_MAINNET: &[&str] = &["https://zcash-mainnet.chainsafe.dev"];
const CHAINSAFE_TESTNET: &[&str] = &["https://zcash-testnet.chainsafe.dev"];

/// How long one attempt to reach a server (`GetLightdInfo`) may take.
const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(25);

#[derive(Clone, Debug)]
pub(crate) struct Server(String);

impl Server {
    fn parse(spec: &str) -> R<Self> {
        let spec = spec.trim().trim_end_matches('/');
        let bad = |why: &str| {
            Failure::new(
                "bad_request",
                format!(
                    "Server {spec:?} is not valid: {why}. Use a gRPC-web address such as https://zcash-mainnet.chainsafe.dev."
                ),
            )
        };
        let rest = spec
            .strip_prefix("https://")
            .ok_or_else(|| bad("it must start with https://"))?;
        let host = rest.split([':', '/']).next().unwrap_or("");
        let host_ok = !host.is_empty()
            && host.len() <= 253
            && host
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
        if !host_ok {
            return Err(bad("the host name has unexpected characters"));
        }
        Ok(Self(spec.to_string()))
    }
}

#[derive(Clone, Debug)]
pub(crate) enum Mode {
    Direct,
}

impl Mode {
    pub(crate) fn name(&self) -> String {
        "direct".into()
    }
}

/// Where and how to reach the chain.
#[derive(Clone, Debug)]
pub(crate) struct Connection {
    servers: Vec<Server>,
    mode: Mode,
}

/// An open connection to a verified server.
pub(crate) struct Link {
    pub(crate) client: Client,
    pub(crate) server: String,
    pub(crate) info: service::LightdInfo,
}

impl Link {
    pub(crate) fn info_json(&self) -> Value {
        json!({
            "server": self.server,
            "vendor": self.info.vendor,
            "version": self.info.version,
            "chain": self.info.chain_name,
            "blockHeight": self.info.block_height,
            "estimatedHeight": self.info.estimated_height,
            "saplingActivationHeight": self.info.sapling_activation_height,
            "upgradeName": self.info.upgrade_name,
            "upgradeHeight": self.info.upgrade_height,
        })
    }
}

impl Connection {
    pub(crate) fn from_json(value: Option<&Value>, network: Network) -> R<Self> {
        let preset = |name: &str| -> R<Vec<Server>> {
            let list = match (name, network) {
                ("chainsafe", Network::MainNetwork) => CHAINSAFE_MAINNET,
                ("chainsafe", Network::TestNetwork) => CHAINSAFE_TESTNET,
                ("zecrocks" | "ywallet", _) => {
                    return Err(Failure::new(
                        "bad_request",
                        format!(
                            "The {name:?} servers speak plain gRPC, which a browser cannot use. Use a gRPC-web server such as the \"chainsafe\" preset."
                        ),
                    ));
                }
                _ => &[][..],
            };
            Ok(list.iter().map(|s| Server(s.to_string())).collect())
        };

        let servers = match value.and_then(|v| v.get("servers")) {
            None | Some(Value::Null) => preset("chainsafe")?,
            Some(Value::String(s)) if !s.contains("://") => preset(s)?,
            Some(Value::String(s)) => s.split(',').map(Server::parse).collect::<R<Vec<_>>>()?,
            Some(Value::Array(items)) => items
                .iter()
                .map(|item| match item.as_str() {
                    Some(s) => Server::parse(s),
                    None => Err(Failure::new(
                        "bad_request",
                        "Server entries must be https:// addresses.",
                    )),
                })
                .collect::<R<Vec<_>>>()?,
            Some(_) => {
                return Err(Failure::new(
                    "bad_request",
                    "connection.servers must be a preset name, an https:// address or a list of them.",
                ));
            }
        };
        if servers.is_empty() {
            return Err(Failure::new("bad_request", "No servers were given."));
        }
        if servers.len() > 16 {
            return Err(Failure::new(
                "bad_request",
                "Too many servers (at most 16).",
            ));
        }

        let mode = match value.and_then(|v| v.get("mode")).and_then(Value::as_str) {
            None | Some("direct") => Mode::Direct,
            Some(_) => {
                return Err(Failure::new(
                    "bad_request",
                    "Tor and SOCKS5 are not available in a browser. Use the desktop app to hide your IP address from the server.",
                ));
            }
        };
        Ok(Self { servers, mode })
    }

    pub(crate) fn mode(&self) -> &Mode {
        &self.mode
    }

    /// Connects to the first server that answers and is on the expected chain.
    pub(crate) async fn open(&self, network: Network, _paths: &WalletPaths) -> R<Link> {
        let mut attempts = Vec::new();
        for server in &self.servers {
            match timeout(ATTEMPT_TIMEOUT, try_server(server, network)).await {
                Ok(Ok(link)) => return Ok(link),
                Ok(Err(e)) => {
                    warn!("Server {} failed: {:#}", server.0, e);
                    attempts.push(json!({ "server": server.0, "error": format!("{e:#}") }));
                }
                Err(_) => attempts.push(json!({ "server": server.0, "error": "timed out" })),
            }
        }
        Err(Failure::new(
            "connect_failed",
            "Could not reach a Zcash server. Check your internet connection or the server settings.",
        )
        .with_details(json!({ "mode": self.mode.name(), "attempts": attempts })))
    }
}

async fn try_server(server: &Server, network: Network) -> anyhow::Result<Link> {
    let mut client =
        CompactTxStreamerClient::new(tonic_web_wasm_client::Client::new(server.0.clone()));
    let info = client
        .get_lightd_info(service::Empty {})
        .await
        .map_err(anyhow::Error::from)?
        .into_inner();
    let expected = network_name(network);
    if info.chain_name != expected {
        anyhow::bail!(
            "the server is on the {:?} chain but this wallet is on {:?}",
            info.chain_name,
            expected
        );
    }
    Ok(Link {
        client,
        server: server.0.clone(),
        info,
    })
}

/// Self-test: the connection settings this build accepts parse, and bad ones are refused.
pub(crate) fn check_settings() -> Result<String, String> {
    let describe = |f: Failure| format!("{}: {}", f.code, f.message);
    let main = Network::MainNetwork;
    let direct = Connection::from_json(None, main).map_err(describe)?;
    if direct.mode().name() != "direct" || direct.servers.is_empty() {
        return Err("the default connection is not the direct gRPC-web preset".to_string());
    }
    Connection::from_json(None, Network::TestNetwork).map_err(describe)?;
    Connection::from_json(
        Some(&json!({ "servers": ["https://example.org:443"] })),
        main,
    )
    .map_err(describe)?;
    for refused in [
        json!({ "mode": "tor" }),
        json!({ "mode": "socks5://127.0.0.1:9050" }),
        json!({ "servers": "zecrocks" }),
        json!({ "servers": "http://plain.example" }),
    ] {
        if Connection::from_json(Some(&refused), main).is_ok() {
            return Err(format!(
                "{refused} was accepted but cannot work in a browser"
            ));
        }
    }
    Ok("gRPC-web servers parse; Tor, SOCKS5 and plain-gRPC servers are refused".to_string())
}
