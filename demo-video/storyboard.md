# Devoid demo — storyboard

**One transaction. Multiple payments.** A 1:43 walkthrough of a shielded payout to three people,
start to finish, followed by the evidence that the engine behind it is real. It sticks to the
plain advantages: one transaction for many people, private by default, checked before you sign,
keys on your device.

| | |
|---|---|
| Output | `output/final-demo.mp4` — 1920×1080, 30 fps, H.264 High + AAC-LC 48 kHz stereo, 102.9 s |
| Loudness | −14.3 LUFS integrated, LRA 2.8 LU, true peak −1.3 dBTP (two-pass EBU R128, measured) |
| Also | `output/narration.wav`, `output/captions.srt`, `output/review.png` (contact sheet), `output/x/` |
| Source | `project/flow.mjs` (the scenes), `project/storyboard.json` (as rendered), `tools/` |

## What is real, and what is not

- **Every frame is the real product**, built from this repository and served locally with its
  production headers (`serve.py`), in the light theme. No mock-ups, no composited UI.
- **The payout runs on the web demo engine**: a simulated chain with play money. The app labels it
  on every screen ("Web demo" band, "Demo" badge), the narration says so ("This is a demo wallet on a
  simulated chain"), and the send scene states that a real wallet builds, proves and broadcasts
  from the same screen. Nothing touches a real network; no payment is made.
- **The proof scene points at real transactions**: the mainnet batch `82731e0e…` (block 3,522,904)
  and the browser payment `f95a7846…` (block 3,522,951), as listed on the site's status section. The block explorers themselves refuse
  requests from the build environment (HTTP 403 and 401), so the video shows the product's own
  record of them rather than an explorer page; the links are in the README and the submission.

## Scenes

| # | Time | On screen | Narration |
|---|---|---|---|
| Intro | 0:00 | White title card: Devoid, *One transaction. Multiple payments.*, beside the homepage | Paying a team in Zcash usually means a transaction per person. Devoid pays the whole list at once, privately. Here's a payout, start to finish. |
| 1 | 0:12 | Homepage hero | It's a Zcash wallet built for one job: paying many people in a single shielded transaction. |
| 2 | 0:19 | *How it works*: bring your list, see what the chain will see, sign once | You bring a list, check it, and sign once. Up to twenty-five people go in each shielded transaction, and longer lists go out in order. |
| 3 | 0:29 | The wallet's overview, with the "Web demo" band | This is a demo wallet on a simulated chain. Play money, but the real app, running entirely in your browser. No account, and your keys never leave your device. |
| 4 | 0:41 | Send → Paste a list → three recipients with memos → Check recipients → the validated ledger | Let's pay three contributors. I'll paste the list into "Send" and hit "Check recipients". Every address is validated, so a typo can't cost you. |
| 5 | 0:52 | The running totals: to recipients, network fee, left after sending | Devoid totals it up as you go: what everyone gets, the network fee, and what you'll have left. |
| 6 | 0:59 | Review: 4.15 TAZ to 3 recipients, the fee, the total | Then one review screen, with everything in one place: three recipients, the total, and the exact fee, before you sign. |
| 7 | 1:07 | Passphrase, Confirm and send, the sent screen | One passphrase, one confirmation, and it's sent. Here it's simulated; on a real wallet, this same screen builds, proves and broadcasts it. |
| 8 | 1:18 | Activity: *Sent to 3 recipients* | In "Activity", it reads "Sent to 3 recipients": three people paid, in a single transaction. |
| 9 | 1:25 | Site status: *Confirmed on mainnet*, with both transaction IDs | And it's not a mock-up. Devoid's Rust engine has sent shielded payments that were mined on the Zcash mainnet, from the desktop app and from the browser. |
| Outro | 1:36 | White end card: Devoid, the tagline, github.com/davebrian259-tech/Devoid | One transaction. Multiple payments. Devoid is open source, on GitHub. |

Arc: hook (a transaction per person) → what Devoid is → how it works → the payout, step by step →
the verified outcome → close. About 240 spoken words at roughly 144 words a minute.

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

- Frames sampled across every scene (`output/review.png`), and the ones that carry specific values
  read at full resolution: the totals, the review's recipients and fee, *Sent to 3 recipients*, and
  the transaction IDs with their block heights.
- Every narrated claim is on screen in its own scene; nothing is stated before it appears.
- No secrets or private data: demo-wallet addresses only, the passphrase field is masked, and no
  browser chrome or URL bar is captured.
- The MP4 decodes end to end without errors; the narration track runs 102.1 s against 102.9 s of
  picture.
