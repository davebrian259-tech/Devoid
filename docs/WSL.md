# Devoid on Windows (WSL)

Everything below runs inside Ubuntu on WSL2. Keep the code in your Linux home (`~/Devoid`), not
under `/mnt/c`: builds on the Windows drive are many times slower.

## 1. One-time setup

In PowerShell as Administrator, then reboot:

```powershell
wsl --install -d Ubuntu
```

In Ubuntu:

```bash
sudo apt update
sudo apt install -y build-essential pkg-config git curl python3-venv

# Node 22 (Ubuntu's own package is too old)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Rust (1.88 or newer)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"

node -v && rustc --version
```

If the Rust build later runs out of memory, give WSL more: create `C:\Users\<you>\.wslconfig` with
`[wsl2]` and `memory=8GB` on the next line, then run `wsl --shutdown` in PowerShell.

## 2. Get the code

```bash
cd ~
git clone https://github.com/davebrian259-tech/Devoid.git
cd Devoid
```

Already cloned? `git pull`. To try a branch before it is merged:
`git fetch origin && git checkout <branch-name>`.

## 3. Try it (simulated chain, nothing to build)

```bash
node server/index.mjs --demo
```

Open the `http://127.0.0.1:8787/#token=…` link it prints in your Windows browser, including the part
after `#`. Nothing touches a real network; the banner says so. `Ctrl+C` stops it.

## 4. Check it works

```bash
npm test                              # 241 tests, no npm install needed

# the browser test, once:
python3 -m venv .venv && . .venv/bin/activate
pip install playwright==1.64.0
python -m playwright install --with-deps chromium

# then any time:
. .venv/bin/activate && python3 scripts/ui-smoke.py   # screenshots land in shots/
```

## 5. Real Zcash

```bash
npm run engine:build       # about 15 minutes the first time, ~2 GB of disk
npm run engine:selftest    # must report 10 passed, 0 failed
node server/index.mjs      # real engine; wallet data in ~/.devoid
```

The server refuses to start if the engine fails its self-test. Do not pass `--locked` to cargo.

## 6. The testnet run (the one step still unproven)

1. Start the server, create a wallet, and set **Network** to **Testnet**. It defaults to Mainnet.
2. Write down the 24 words, then type the three it asks for.
3. Receive → copy the shielded address (`utest1…`) → request TAZ from a testnet faucet.
4. Wait until the balance stops saying "arriving".
5. Receive → **New address** twice. Send a batch to those two addresses, about 0.001 each.
6. Review → passphrase → **Confirm and send**. Copy the transaction ID.
7. Activity should go from Pending to confirmed. Check the ID on a testnet explorer.
8. Then send to 30 recipients (repeat your addresses). That splits into 25 + 5 and tests the
   wait between transactions. Keep the window open.

If it works, update the status list in `site/index.html` and `docs/STATUS.md`. If it fails, keep
the receipt CSV and the error text: that is the bug report.

## 7. The website

Preview it:

```bash
cd ~/Devoid/site && python3 -m http.server 8080
```

Open `http://127.0.0.1:8080`. Opening the file directly does not load the fonts.

Deploy it to Cloudflare from WSL (the first time, `login` opens a browser; if it does not, copy
the link it prints into your Windows browser):

```bash
cd ~/Devoid
npx wrangler@4 login
npx wrangler@4 deploy --dry-run
npx wrangler@4 deploy
```

Or set it up once on GitHub so every merge deploys by itself: see `docs/DEPLOY.md`.

Refresh the site's screenshots after UI changes:

```bash
. .venv/bin/activate && python3 scripts/site-shots.py
```

## Troubleshooting

| Problem | Fix |
|---|---|
| The page says "Open Devoid from its link" | Use the full link the server printed, with `#token=…` |
| `EADDRINUSE` | Another server is running. The new one picks a free port; use the link it prints |
| `UnknownIssuer` when syncing | Your network inspects TLS: `export DEVOID_CA_FILE=/path/to/ca.pem` |
| The engine build is killed | Out of memory: raise it in `.wslconfig` (step 1) |
| `pip install` refuses ("externally managed") | Use the virtual environment from step 4 |
| Starting over | Stop the server and delete `~/.devoid`. **Only after you have written down your phrase** |
