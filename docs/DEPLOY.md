# Deploying Devoid

## What runs where

| Piece | Where it runs | Status |
|---|---|---|
| Product page (`site/`, at `/`) | Cloudflare, as static files | Ready to deploy |
| Web wallet (`ui/`, at `/app/`) | Cloudflare, as static files; the wallet engine (Rust, compiled to WebAssembly) runs in the visitor's browser. Testnet, plus an offline demo | Ready to deploy |
| Wallet (`ui/` + `server/` + Rust engine) | The user's own computer | Works today |
| Web wallet on mainnet | The same, once web payments are verified on testnet | Next |
| Chrome extension | Chrome Web Store, same in-browser engine | Needs engineering, see below |

## The rule that decides everything: never host keys

Today the wallet is a local Node server that starts a native Rust program for each command, and
keeps the encrypted recovery phrase and the wallet database on disk. Cloudflare cannot run that:
Workers and Pages run JavaScript and WebAssembly only, with no processes and no disk.

Putting the engine on any server you control would mean that server holds every user's keys. That
makes Devoid custodial: a single place to steal from, a regulated business, and the opposite of
what the product promises. So it is off the table. The web app and the extension both keep the
engine on the user's device, inside the browser.

## 1. Deploy the product page and the web wallet to Cloudflare

`scripts/build-site.mjs` assembles `dist/`: the product page from `site/` at `/`, and the wallet UI
from `ui/` at `/app/`, marked as the web version. In the web version the request core
(`server/core.mjs`) runs inside the page with one of two engines:

- **the real engine** (`ui/engine/`): the Rust wallet code of `engine/`, compiled to WebAssembly by
  `web-engine/` and run in a Web Worker. It reaches lightwalletd through ChainSafe's gRPC-web proxy
  and keeps the wallet in the browser's IndexedDB, the recovery phrase encrypted with the
  passphrase. Mainnet or testnet; mainnet asks the person to confirm it holds real ZEC.
- **the simulated engine** (`mock-engine/core.mjs`) for the offline demo.

The web version never asks for a recovery phrase and has no Devoid server. Anyone can open it from
the front page, on a phone too.

The compiled engine is committed (`ui/engine/devoid_web_engine_bg.wasm`, built by
`node scripts/build-web-engine.mjs`), because the Cloudflare build has no Rust. The build downloads
the Sapling proving parameters from `download.z.cash` (checked against their published BLAKE2b
hashes, cached in `.cache/`) and serves them from `/app/engine/params/`, the 48 MB spend file in two
parts to stay under the 25 MiB per-file limit.

`wrangler.jsonc` runs that build and serves `dist/` with Cloudflare Workers static assets
(Cloudflare's current recommendation for static sites). No Worker code runs. To build and look at
it locally:

```bash
node scripts/build-site.mjs         # writes dist/
python3 scripts/web-smoke.py        # builds, serves dist/ with site/_headers, drives it in Chromium
python3 scripts/site-smoke.py       # the landing pages at seven widths, light and dark
python3 scripts/web-live.py         # the real web wallet against the live testnet (needs the network)
```

Rebuilding the engine after changing `engine/src` or `web-engine/` needs Rust with the
`wasm32-unknown-unknown` target and `wasm-bindgen-cli` at the version in `web-engine/Cargo.lock`:

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.126
node scripts/build-web-engine.mjs   # writes ui/engine/devoid_web_engine.js and _bg.wasm
```

### One-time setup

1. Create a Cloudflare account and, if you have one, add your domain to it (Websites → Add a site,
   then point your registrar's nameservers at Cloudflare).
Steps 2 and 3 are only for Options B and C; the dashboard route (Option A) needs neither.

2. Create an API token: My Profile → API Tokens → Create Token → use the **Edit Cloudflare
   Workers** template. Under Account Resources pick only your account; under Zone Resources pick
   only the domain you will use (or none, if you will use the free `*.workers.dev` address).
   Copy the token: it is shown once.
3. Find your **Account ID**: Workers & Pages → Overview, right-hand column.

### Option A: connect the repository in the Cloudflare dashboard (simplest)

Cloudflare builds and deploys on every push; no API token or GitHub secret is needed.

1. Merge the pull request that adds `wrangler.jsonc`, so `main` has it.
2. Workers & Pages → Create → **Import a repository** → connect GitHub and pick this repository.
3. Settings:
   - **Project name:** `devoid-site`. Keep it the same as `name` in `wrangler.jsonc`, or change both.
   - **Production branch:** `main`.
   - **Build command:** leave empty. `wrangler deploy` runs `node scripts/build-site.mjs` itself,
     from the `build` entry in `wrangler.jsonc`.
   - **Deploy command:** `npx wrangler deploy`.
   - **Non-production branch deploy command:** `npx wrangler versions upload` (gives each branch a
     preview link without touching production).
   - **Root directory:** `/`. **Build variables:** `NODE_VERSION` = `22` (the build uses Node's
     built-in `fetch` and top-level `await`; pinning the version keeps the build image from choosing).
4. Save and deploy. The address appears in the Worker's overview.

Use either this or Option B, not both: two deployers would race each other. With this option, leave
the GitHub secrets unset and the workflow skips itself.

### Option B: deploy from GitHub Actions

1. In the repository: Settings → Secrets and variables → Actions → New repository secret. Add:
   - `CLOUDFLARE_API_TOKEN`: the token from step 2.
   - `CLOUDFLARE_ACCOUNT_ID`: the ID from step 3.
2. Merge to `main`. `.github/workflows/deploy-site.yml` deploys whenever `site/`, `ui/` or the shared
   modules the web wallet uses change. To deploy
   now, open Actions → deploy-site → Run workflow. Without the secrets the workflow skips cleanly.

### Option C: deploy from your computer

```bash
cd ~/Devoid
npx wrangler@4 login        # opens a browser; or export CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
npx wrangler@4 deploy --dry-run   # runs the build, checks the config, lists what would upload
npx wrangler@4 deploy
```

The first deploy prints the address, `https://devoid-site.<your-subdomain>.workers.dev`.

### Your own domain

Uncomment the `routes` line in `wrangler.jsonc`, set your domain, and deploy again. Cloudflare
creates the DNS record and the certificate. The domain must already be on your Cloudflare account.

### Rules: Cloudflare settings for this site

Set these in the dashboard for the domain:

- **SSL/TLS → Overview:** Full (strict).
- **SSL/TLS → Edge Certificates:** Always Use HTTPS on; Minimum TLS Version 1.2; Automatic HTTPS
  Rewrites on.
- **DNS → Settings:** enable DNSSEC.
- **Turn off anything that injects scripts or rewrites pages:** Rocket Loader (Speed →
  Optimization), Email Address Obfuscation (Scrape Shield), Web Analytics automatic setup, and
  Zaraz. The site's content security policy blocks every script that is not the site's own, so
  these would only break or log errors, and the analytics would contradict the privacy policy.
- **Security → Bots:** Bot Fight Mode is fine to turn on.

The site's own headers come from `site/_headers`: a strict content security policy (only the site's own
scripts, no network requests, no frames, no forms), HSTS, `nosniff`, `no-referrer`, a locked-down Permissions-Policy, and caching for
fonts and images. After a deploy, check they are live:

```bash
curl -sI https://YOUR-DOMAIN/ | grep -iE 'content-security|strict-transport|x-content-type'
```

If nothing prints, add the same headers under Rules → Transform Rules → Modify Response Header.

### Variables

| Name | Where | Secret | Purpose |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | GitHub repository secret, or your shell for Option B | Yes | Lets Wrangler deploy |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub repository secret, or your shell | No, but keep it private | Which account to deploy to |
| `NODE_VERSION` | Cloudflare dashboard → the Worker → Settings → Build → Variables and secrets (Option A only) | No | `22`: the Node version the build runs on |

Only Option B needs the two Cloudflare values, and only Option A needs `NODE_VERSION`. The site has no runtime variables and must never contain a secret: everything in `site/` and `ui/` is public.

The wallet itself reads these, all optional:

| Name | Purpose |
|---|---|
| `DEVOID_HOME` | Wallet data folder. Default `~/.devoid` (`.demo-data` with `--demo`) |
| `DEVOID_ENGINE` | Path to a `devoid-engine` binary, if not the one in `engine/target/release` |
| `DEVOID_LOG` | Engine log filter, written to stderr, never secrets (for example `info`) |
| `DEVOID_CA_FILE` | Extra TLS roots, for networks that inspect TLS. Added to the built-in roots |
| `DEVOID_CHROMIUM` | A Chromium binary for the UI test and the site screenshots |

Server flags: `--demo` (simulated chain), `--mock` (simulated engine, real data folder),
`--port=N` (default 8787).

## 2. How the web wallet works, and what comes next

- **One engine, two builds.** `web-engine/` compiles the engine's own files (`sync`, `spend`,
  `wallet`, `keystore`, `history`, `commands`, `selftest`) for the browser. Everything platform
  specific sits in `engine/src/platform.rs` (native) and `web-engine/src/platform.rs` (browser):
  the lightwalletd transport, timeouts, the clock, files, the block cache and the Sapling prover.
- **Storage.** The wallet database is SQLite in memory (sqlite-wasm-rs), saved to IndexedDB after
  every command that can change it, and loaded back on start.
- **Server.** A browser can only speak gRPC-web, so the wallet uses ChainSafe's gRPC-web proxies in
  front of lightwalletd. They see what any lightwalletd sees: the visitor's IP address and the
  transactions they broadcast. There is no Tor in a browser; the desktop app has it.
- **Proving** runs on one thread. Building one transaction with Sapling and Orchard proofs takes
  about a minute on a laptop; each further recipient adds a few seconds. Threads would make it
  several times faster but need cross-origin isolation (`Cross-Origin-Embedder-Policy`) and a
  nightly Rust build; that is the next performance step.
- **The policy** for `/app/*` is in `site/_headers`: `'wasm-unsafe-eval'` to compile the engine,
  `worker-src 'self'`, and `connect-src` limited to this site and the two gRPC-web servers.

Next: mainnet on the web once payments from the web wallet are verified on testnet, and threads.

## 3. The Chrome extension (next)

Two ways to build it:

- **In-browser engine (recommended).** The same Wasm engine as the web app, bundled in a
  Manifest V3 extension. One install, nothing else on the computer, and the code is shared with
  the web app.
- **Native messaging.** The extension is the UI and talks to today's `devoid-engine` installed
  separately. Faster to build, but users must run an installer outside the Web Store, which is
  more friction and more to review.

Chrome Web Store checklist:

- [ ] Developer account: a one-time $5 registration fee, and 2-step verification on the Google account.
- [ ] Privacy policy URL: `https://YOUR-DOMAIN/privacy.html` (in `site/`). Update it to describe
      the extension before submitting.
- [ ] Single purpose, stated plainly. Draft: *"A non-custodial Zcash wallet for sending shielded
      payments to many recipients at once."*
- [ ] The fewest permissions possible (likely `storage` only, plus host access to the
      lightwalletd proxy), each with a one-line justification in the dashboard.
- [ ] No remotely hosted code: every script and Wasm file ships inside the package.
- [ ] Data disclosures that match the privacy policy exactly. Wallet data is processed on the
      device; transactions go to the user's chosen lightwalletd server.
- [ ] Listing assets: icon, screenshots and promotional tile. Check the dashboard for current
      sizes. `scripts/site-shots.py` captures real screens you can adapt.

Wallets get extra scrutiny in review. A clear single purpose, minimal permissions and an
accurate privacy policy are what get one approved.
