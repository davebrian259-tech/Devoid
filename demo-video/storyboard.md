# Devoid demo — storyboard

**One transaction. Multiple payments.** A 1:50 walkthrough of a shielded payout to three people,
padded so the chain cannot count them, followed by the evidence that the engine behind it is real.

| | |
|---|---|
| Output | `output/final-demo.mp4` — 1920×1080, 30 fps, H.264 High + AAC-LC 48 kHz stereo, 110.0 s |
| Loudness | −14.2 LUFS integrated, LRA 2.6 LU, true peak −1.4 dBTP (two-pass EBU R128, measured) |
| Also | `output/narration.wav`, `output/captions.srt`, `output/review.png` (contact sheet), `output/x/` |
| Source | `project/flow.mjs` (the scenes), `project/storyboard.json` (as rendered), `tools/` |

## What is real, and what is not

- **Every frame is the real product**, built from this repository and served locally with its
  production headers (`serve.py`), in the light theme. No mock-ups, no composited UI.
- **The payout runs on the web demo engine**: a simulated chain with play money. The app labels it
  on every screen ("Web demo" band, "Demo" badge), the narration says so ("This is a demo wallet on a
  simulated chain"), and the send scene states that a real wallet builds, proves and broadcasts
  from the same screen. Nothing touches a real network; no payment is made.
- **The proof scene points at real transactions**: the mainnet batch `82731e0e…` (block 3,522,904),
  the browser payment `f95a7846…` (block 3,522,951) and the padded testnet batch `4fbde366…`
  (block 4,536,660), as listed on the site's status section. The block explorers themselves refuse
  requests from the build environment (HTTP 403 and 401), so the video shows the product's own
  record of them rather than an explorer page; the links are in the README and the submission.

## Scenes

| # | Time | On screen | Narration |
|---|---|---|---|
| Intro | 0:00 | White title card: Devoid, *One transaction. Multiple payments.*, beside the homepage | Paying a team in Zcash usually means a transaction per person. Devoid pays the whole list in one shielded transaction. Let me show you a payout, start to finish. |
| 1 | 0:13 | Homepage hero | It's a non-custodial wallet that runs entirely in your browser. No account, and no server holding your keys. |
| 2 | 0:22 | *What the chain reveals*, zooming on the 4-outputs / 6-outputs comparison | Here's the catch. Shielding hides amounts and recipients, but the number of outputs is public, and the fee follows from it. So a payout still hints at how many people you paid. |
| 3 | 0:34 | The wallet's overview, with the "Web demo" band | This is a demo wallet on a simulated chain. Play money, real app. |
| 4 | 0:40 | Send → Paste a list → three recipients with memos → Check recipients → the validated ledger | Let's pay three contributors. I'll paste the list into "Send" and hit "Check recipients". Every address is validated first. |
| 5 | 0:49 | Ticking *Hide how many people you are paying*; the hint and fee update to 0.0003 | Now the part I like most. Tick "Hide how many people you are paying", and Devoid pads the transaction to five payment slots, with the extra fee shown up front. |
| 6 | 1:01 | Review: 3 recipients, *5 outputs on chain*, fee 0.0003; scrolls to *What others can see* and the padding finding | The review spells it out: three recipients, five outputs on chain, the exact fee, and what an observer can still see. |
| 7 | 1:10 | Passphrase, Confirm and send, the sent screen | I'll confirm with the passphrase. Here the send is simulated; on a real wallet, this same screen builds, proves and broadcasts it. |
| 8 | 1:20 | Activity: *Sent to 3 recipients* | In "Activity" it reads "Sent to 3 recipients". The padding is yours, so it never counts as a payment. |
| 9 | 1:27 | Site status: *Confirmed on mainnet* with both transaction IDs, *Padding verified on testnet* | And it's real. One Rust engine on librustzcash runs natively and as WebAssembly. Both have sent shielded payments mined on mainnet, and padding is verified on testnet. |
| Outro | 1:41 | White end card: Devoid, the tagline, github.com/davebrian259-tech/Devoid | One transaction, multiple payments, and fewer clues on chain. Devoid is open source, on GitHub. |

Arc: hook (the per-person cost) → what Devoid is → the problem (output counts) → the payout →
the reveal (padding, around two-thirds in) → the verified outcome → close. 248 spoken words at
about 144 words a minute.

## How it was made

- **Capture and render: [Ultrademo](https://github.com/new-xp/ultrademo)** at `e7bdcfc` —
  Playwright drives the real app from `project/flow.mjs` at 1920×1080 (device scale 2), then
  Remotion renders the edit: Ken Burns zooms on stills, real recordings for clips with waits
  jump-cut out, burned-in captions with UI terms tinted. One local patch,
  `tools/ultrademo-light-slides.patch`, adds a `slideTheme: 'light'` option so the title cards, the
  base and the fades are white instead of navy.
- **Narration: Kokoro** (offline, voice `am_michael`, speed 0.95), reached through
  `tools/piper`, a Piper-compatible shim, so Ultrademo's offline voice path is used unmodified.
  No ElevenLabs key was configured.
- **Music: `tools/music.py`**, a quiet synthesised pad (nothing licensed), mixed by
  `tools/finish.py` at a low level, side-chain ducked under the voice, then loudness-normalised.
- Skills installed for the work (`npx skills add`): `new-xp/ultrademo` (used), `remotion-dev/skills`
  (Remotion is the renderer Ultrademo drives), `Vincentwei1021/video-shotcraft` (installed, not used: by
  its own description it builds cinematic promos with 2.5D camera moves and beat-synced cuts, a
  different format from an evidence-grade walkthrough).

## Re-make it

```bash
# once: the pipeline, its browser, and the light-slide patch
git clone https://github.com/new-xp/ultrademo ~/ultrademo-workspace && cd ~/ultrademo-workspace
git checkout e7bdcfc && npm ci && node_modules/.bin/playwright install chromium
git apply /path/to/Devoid/demo-video/tools/ultrademo-light-slides.patch
mkdir -p projects/devoid-shielded-payout && cp /path/to/Devoid/demo-video/project/flow.mjs projects/devoid-shielded-payout/

# each take, from the Devoid repository root
python3 demo-video/serve.py &                         # the built site on http://localhost:8790
export PATH="$PWD/demo-video/tools:$PATH" PIPER_MODEL=kokoro-am_michael@0.95 \
       KOKORO_DIR=/path/to/kokoro KOKORO_PY=/path/to/python-with-kokoro_onnx
(cd ~/ultrademo-workspace && npm run capture -- devoid-shielded-payout \
  && npm run tts -- devoid-shielded-payout && npm run render -- devoid-shielded-payout --stems)
PY_AUDIO=/path/to/python-with-numpy python3 demo-video/tools/finish.py ~/ultrademo-workspace devoid-shielded-payout
```

`KOKORO_DIR` holds `kokoro-v1.0.onnx` and `voices-v1.0.bin` from the kokoro-onnx release.

## Checked before delivery

- Frames sampled across every scene (`output/review.png`), and the four that carry specific values
  read at full resolution: the padding hint and fee, *3 recipients · 5 outputs on chain*,
  *Sent to 3 recipients*, and the transaction IDs with their block heights.
- Every narrated claim is on screen in its own scene; nothing is stated before it appears.
- No secrets or private data: demo-wallet addresses only, the passphrase field is masked, and no
  browser chrome or URL bar is captured.
- The MP4 decodes end to end without errors; the narration track runs 109.2 s against 110.0 s of
  picture.
