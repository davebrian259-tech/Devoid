//! Connecting to a lightwalletd server.
//!
//! Adapted from zcash-devtool's remote.rs (MIT OR Apache-2.0): the same server presets, the same
//! three transports (direct TLS, the built-in Tor client, an external SOCKS5 proxy), but driven by
//! JSON instead of command-line flags, with failover across a list of servers and a check that the
//! server is on the chain the wallet expects.

use std::{fmt, net::SocketAddr, time::Duration};

use anyhow::anyhow;
use serde_json::{Value, json};
use tonic::transport::{Channel, ClientTlsConfig, Endpoint, Uri};
use tracing::{info, warn};
use zcash_client_backend::{
    proto::service::{self, compact_tx_streamer_client::CompactTxStreamerClient},
    tor,
};
use zcash_protocol::consensus::Network;

use crate::{
    data::{WalletPaths, network_name},
    failure::{Failure, R},
    socks::SocksConnector,
};

const ZEC_ROCKS_MAINNET: &[(&str, u16)] = &[
    ("zec.rocks", 443),
    ("na.zec.rocks", 443),
    ("eu.zec.rocks", 443),
    ("ap.zec.rocks", 443),
    ("sa.zec.rocks", 443),
];
const ZEC_ROCKS_TESTNET: &[(&str, u16)] = &[("testnet.zec.rocks", 443)];

const YWALLET_MAINNET: &[(&str, u16)] = &[
    ("lwd1.zcash-infra.com", 9067),
    ("lwd2.zcash-infra.com", 9067),
    ("lwd3.zcash-infra.com", 9067),
    ("lwd4.zcash-infra.com", 9067),
    ("lwd5.zcash-infra.com", 9067),
    ("lwd6.zcash-infra.com", 9067),
    ("lwd7.zcash-infra.com", 9067),
    ("lwd8.zcash-infra.com", 9067),
];

/// How long one attempt to reach a server (connect plus handshake plus `GetLightdInfo`) may take.
const DIRECT_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(25);
/// Bootstrapping Tor for the first time can take a while.
const TOR_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone, Debug)]
pub(crate) struct Server {
    host: String,
    port: u16,
}

impl fmt::Display for Server {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.host, self.port)
    }
}

impl Server {
    fn new(host: &str, port: u16) -> Self {
        Self {
            host: host.to_string(),
            port,
        }
    }

    fn parse(spec: &str) -> R<Self> {
        let bad = |why: &str| {
            Failure::new(
                "bad_request",
                format!(
                    "Server {spec:?} is not valid: {why}. Use host:port, for example zec.rocks:443."
                ),
            )
        };
        let (host, port) = spec
            .trim()
            .rsplit_once(':')
            .ok_or_else(|| bad("missing :port"))?;
        let port: u16 = port.parse().map_err(|_| bad("the port is not a number"))?;
        if port == 0 {
            return Err(bad("the port is zero"));
        }
        let host_ok = !host.is_empty()
            && host.len() <= 253
            && !host.starts_with(['.', '-'])
            && !host.ends_with(['.', '-'])
            && host
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
        if !host_ok {
            return Err(bad("the host name has unexpected characters"));
        }
        Ok(Self::new(host, port))
    }

    /// Localhost never has a certificate and `.onion` addresses are protected by Tor itself;
    /// everything else needs TLS.
    fn use_tls(&self) -> bool {
        !matches!(self.host.as_str(), "localhost" | "127.0.0.1" | "::1")
            && !self.host.ends_with(".onion")
    }

    fn endpoint(&self) -> String {
        format!(
            "{}://{}:{}",
            if self.use_tls() { "https" } else { "http" },
            self.host,
            self.port
        )
    }

    async fn connect_direct(&self) -> anyhow::Result<CompactTxStreamerClient<Channel>> {
        info!("Connecting to {}", self);

        let endpoint = Channel::from_shared(self.endpoint())?
            .connect_timeout(Duration::from_secs(10))
            .http2_keep_alive_interval(Duration::from_secs(20))
            .keep_alive_timeout(Duration::from_secs(20))
            .keep_alive_while_idle(false);

        let endpoint = if self.use_tls() {
            let tls = ClientTlsConfig::new()
                .domain_name(self.host.clone())
                .assume_http2(true)
                .with_webpki_roots();
            endpoint.tls_config(tls)?
        } else {
            endpoint
        };

        Ok(CompactTxStreamerClient::new(endpoint.connect().await?))
    }

    async fn connect_over_tor(
        &self,
        tor: &tor::Client,
    ) -> anyhow::Result<CompactTxStreamerClient<Channel>> {
        info!("Connecting to {} over Tor", self);
        let endpoint: Uri = self.endpoint().parse()?;
        // `use_tls()` and `endpoint()` already special-case `.onion` hosts, so a Tor connection
        // may legitimately target one.
        Ok(tor.connect_to_lightwalletd(endpoint, true).await?)
    }

    async fn connect_over_socks(
        &self,
        proxy: SocketAddr,
    ) -> anyhow::Result<CompactTxStreamerClient<Channel>> {
        info!("Connecting to {} via SOCKS proxy {}", self, proxy);

        let connector = SocksConnector::new(proxy);
        let uri: Uri = self.endpoint().parse()?;

        let mut endpoint = Endpoint::from(uri.clone())
            .connect_timeout(Duration::from_secs(10))
            .http2_keep_alive_interval(Duration::from_secs(20))
            .keep_alive_timeout(Duration::from_secs(20))
            .keep_alive_while_idle(false);

        // `.onion` services are encrypted by Tor already; everything else gets TLS on top.
        if self.use_tls() {
            endpoint = endpoint.tls_config(
                ClientTlsConfig::new()
                    .domain_name(self.host.clone())
                    .assume_http2(true)
                    .with_webpki_roots(),
            )?;
        }

        let channel = endpoint.connect_with_connector(connector).await?;
        Ok(CompactTxStreamerClient::with_origin(channel, uri))
    }
}

#[derive(Clone, Debug)]
pub(crate) enum Mode {
    /// Plain TCP (TLS to the server, but the server sees the user's IP address).
    Direct,
    /// The built-in Tor client.
    Tor,
    /// An external SOCKS5 proxy, such as a local Tor daemon or a mixnet client.
    Socks(SocketAddr),
}

impl Mode {
    fn parse(s: &str) -> R<Self> {
        match s {
            "direct" => Ok(Mode::Direct),
            "tor" => Ok(Mode::Tor),
            s if s.starts_with("socks5://") => {
                let rest = s.trim_start_matches("socks5://");
                let rest = rest.replace("localhost", "127.0.0.1");
                let addr: SocketAddr = rest.parse().map_err(|_| {
                    Failure::new(
                        "bad_request",
                        format!("The SOCKS5 proxy address {s:?} is not valid. Use socks5://127.0.0.1:9050."),
                    )
                })?;
                Ok(Mode::Socks(addr))
            }
            other => Err(Failure::new(
                "bad_request",
                format!(
                    "Unknown connection mode {other:?}: use \"direct\", \"tor\" or \"socks5://host:port\"."
                ),
            )),
        }
    }

    pub(crate) fn name(&self) -> String {
        match self {
            Mode::Direct => "direct".into(),
            Mode::Tor => "tor".into(),
            Mode::Socks(addr) => format!("socks5://{addr}"),
        }
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
    pub(crate) client: CompactTxStreamerClient<Channel>,
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
    /// Reads the `connection` object of a request:
    /// `{ "servers": "zecrocks" | "ywallet" | ["host:port", ...] | "host:port,host:port", "mode": ... }`.
    /// Both fields are optional; the default is the zec.rocks servers over a direct connection.
    pub(crate) fn from_json(value: Option<&Value>, network: Network) -> R<Self> {
        let preset = |name: &str| -> R<Vec<Server>> {
            let list: &[(&str, u16)] = match (name, network) {
                ("zecrocks", Network::MainNetwork) => ZEC_ROCKS_MAINNET,
                ("zecrocks", Network::TestNetwork) => ZEC_ROCKS_TESTNET,
                ("ywallet", Network::MainNetwork) => YWALLET_MAINNET,
                ("ywallet", Network::TestNetwork) => &[],
                _ => &[],
            };
            if list.is_empty() {
                return Err(Failure::new(
                    "bad_request",
                    format!(
                        "The {name:?} servers do not serve the {} network.",
                        network_name(network)
                    ),
                ));
            }
            Ok(list.iter().map(|(h, p)| Server::new(h, *p)).collect())
        };

        let servers_value = value.and_then(|v| v.get("servers"));
        let servers = match servers_value {
            None | Some(Value::Null) => preset("zecrocks")?,
            Some(Value::String(s)) if s == "zecrocks" || s == "ywallet" => preset(s)?,
            Some(Value::String(s)) => s.split(',').map(Server::parse).collect::<R<Vec<_>>>()?,
            Some(Value::Array(items)) => items
                .iter()
                .map(|item| match item.as_str() {
                    Some(s) => Server::parse(s),
                    None => Err(Failure::new(
                        "bad_request",
                        "Server entries must be strings like \"zec.rocks:443\".",
                    )),
                })
                .collect::<R<Vec<_>>>()?,
            Some(_) => {
                return Err(Failure::new(
                    "bad_request",
                    "connection.servers must be a preset name, a host:port string or a list of them.",
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

        let mode = match value.and_then(|v| v.get("mode")) {
            None | Some(Value::Null) => Mode::Direct,
            Some(Value::String(s)) => Mode::parse(s)?,
            Some(_) => {
                return Err(Failure::new(
                    "bad_request",
                    "connection.mode must be a string.",
                ));
            }
        };

        Ok(Self { servers, mode })
    }

    pub(crate) fn mode(&self) -> &Mode {
        &self.mode
    }

    /// Connects to the first server that answers and is on the expected chain.
    pub(crate) async fn open(&self, network: Network, paths: &WalletPaths) -> R<Link> {
        let attempt_timeout = match self.mode {
            Mode::Tor => TOR_ATTEMPT_TIMEOUT,
            _ => DIRECT_ATTEMPT_TIMEOUT,
        };

        // The Tor client is created lazily, at most once per process.
        let mut tor_client: Option<tor::Client> = None;
        let mut attempts = Vec::new();

        for server in &self.servers {
            let attempt = tokio::time::timeout(
                attempt_timeout,
                self.try_server(server, network, paths, &mut tor_client),
            )
            .await;
            match attempt {
                Ok(Ok(link)) => return Ok(link),
                Ok(Err(e)) => {
                    warn!("Server {} failed: {:#}", server, e);
                    attempts
                        .push(json!({ "server": server.to_string(), "error": format!("{e:#}") }));
                }
                Err(_) => {
                    warn!("Server {} timed out", server);
                    attempts.push(json!({ "server": server.to_string(), "error": "timed out" }));
                }
            }
        }

        Err(Failure::new(
            "connect_failed",
            "Could not reach a Zcash server. Check your internet connection or the server settings.",
        )
        .with_details(json!({ "mode": self.mode.name(), "attempts": attempts })))
    }

    async fn try_server(
        &self,
        server: &Server,
        network: Network,
        paths: &WalletPaths,
        tor_client: &mut Option<tor::Client>,
    ) -> anyhow::Result<Link> {
        let mut client = match &self.mode {
            Mode::Direct => server.connect_direct().await?,
            Mode::Socks(proxy) => server.connect_over_socks(*proxy).await?,
            Mode::Tor => {
                if server.use_tls() {
                    if tor_client.is_none() {
                        tokio::fs::create_dir_all(paths.tor_dir()).await?;
                        *tor_client = Some(tor::Client::create(&paths.tor_dir(), |_| {}).await?);
                    }
                    let tor = tor_client.as_ref().expect("just created");
                    server.connect_over_tor(tor).await?
                } else {
                    // A server on this computer is not reached over Tor.
                    server.connect_direct().await?
                }
            }
        };

        let info = client
            .get_lightd_info(service::Empty {})
            .await
            .map_err(anyhow::Error::from)?
            .into_inner();

        let expected = network_name(network);
        if info.chain_name != expected {
            return Err(anyhow!(
                "the server is on the {:?} chain but this wallet is on {:?}",
                info.chain_name,
                expected
            ));
        }

        Ok(Link {
            client,
            server: server.to_string(),
            info,
        })
    }
}
