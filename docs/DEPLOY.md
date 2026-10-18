# Deploying Devoid

## What runs where

| Piece | Where it runs | Status |
|---|---|---|
| Product page (`site/`) | Cloudflare, as static files | Ready to deploy |
| Wallet (`ui/` + `server/` + Rust engine) | The user's own computer | Works today |
| Web app | Cloudflare (static files) + the engine compiled to WebAssembly, running in the user's browser | Needs engineering, see below |
| Chrome extension | Chrome Web Store, same in-browser engine | Needs engineering, see below |

## The rule that decides everything: never host keys

Today the wallet is a local Node server that starts a native Rust program for each command, and
keeps the encrypted recovery phrase and the wallet database on disk. Cloudflare cannot run that:
Workers and Pages run JavaScript and WebAssembly only, with no processes and no disk.

Putting the engine on any server you control would mean that server holds every user's keys. That
makes Devoid custodial: a single place to steal from, a regulated business, and the opposite of
what the product promises. So it is off the table. The web app and the extension both keep the
engine on the user's device, inside the browser.

## 1. Deploy the product page to Cloudflare

`site/` is plain static files with no scripts. `wrangler.jsonc` serves it with Cloudflare Workers
static assets (Cloudflare's current recommendation for static sites). No Worker code runs.

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
   - **Build command:** leave empty (the site needs no build).
   - **Deploy command:** `npx wrangler deploy`.
   - **Non-production branch deploy command:** `npx wrangler versions upload` (gives each branch a
     preview link without touching production).
   - **Root directory:** `/`. **Build variables:** none.
4. Save and deploy. The address appears in the Worker's overview.

Use either this or Option B, not both: two deployers would race each other. With this option, leave
the GitHub secrets unset and the workflow skips itself.

### Option B: deploy from GitHub Actions

1. In the repository: Settings → Secrets and variables → Actions → New repository secret. Add:
   - `CLOUDFLARE_API_TOKEN`: the token from step 2.
   - `CLOUDFLARE_ACCOUNT_ID`: the ID from step 3.
2. Merge to `main`. `.github/workflows/deploy-site.yml` deploys whenever `site/` changes. To deploy
   now, open Actions → deploy-site → Run workflow. Without the secrets the workflow skips cleanly.

### Option C: deploy from your computer

```bash
cd ~/Devoid
npx wrangler@4 login        # opens a browser; or export CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
npx wrangler@4 deploy --dry-run   # checks the config and lists what would upload
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
  Zaraz. The site's content security policy blocks every script, so these would only break or
  log errors, and the analytics would contradict the privacy policy.
- **Security → Bots:** Bot Fight Mode is fine to turn on.

The site's own headers come from `site/_headers`: a strict content security policy (no scripts, no
frames, no forms), HSTS, `nosniff`, `no-referrer`, a locked-down Permissions-Policy, and caching for
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

The site has no runtime variables and must never contain a secret: everything in `site/` is public.

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

## 2. The web app (next)

What it takes to make Devoid a website that is still non-custodial:

1. **Engine in WebAssembly.** Compile the wallet logic to Wasm with an in-browser storage backend
   (IndexedDB), instead of the native binary and SQLite. ChainSafe's WebZjs is prior art: a
   librustzcash-based browser wallet library, used for a MetaMask Snap, that has sent shielded
   transactions entirely in the browser. Evaluate building on it before writing a new port.
2. **A gRPC-web endpoint.** Browsers cannot speak plain gRPC, so the app needs a gRPC-web proxy
   in front of a lightwalletd server. It sees what any lightwalletd sees (your IP, your broadcast
   transactions), so let users pick their own, as the desktop app does.
3. **Keys encrypted at rest in the browser** with the passphrase, as today.
4. **Expected costs.** First sync and proving are slower in a browser than natively; scanning old
   blocks from the 2022 spam period is the worst case. Multithreaded proving needs
   `SharedArrayBuffer`.

Extra Cloudflare rules the web app will need (not the product page):

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Content-Security-Policy: default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://YOUR-GRPC-WEB-PROXY; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

The first two enable `SharedArrayBuffer` for threaded proving. The proxy address is a public,
build-time setting, not a secret.

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
