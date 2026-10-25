// Devoid: a shielded payout to three people, padded so the chain cannot count them.
// Filmed against the built site served locally (demo-video/serve.py), in the light theme, with the
// web demo engine: a simulated chain and play money, which the app itself labels on every screen.
// Nothing is sent to a real network.
const BASE = 'http://localhost:8790';
const PASS = 'payout demo passphrase';

export default {
  title: 'Devoid - one transaction, multiple payments',
  template: 'walkthrough',
  colorScheme: 'light',
  slideTheme: 'light', // white title cards and a fade from and to white
  brand: '#e3a008',
  caption: {theme: 'pill', size: 'md', position: 'bottom'},

  intro: {
    title: 'Devoid',
    subtitle: 'One transaction. Multiple payments.',
    layout: 'split',
    script: "Paying a team in Zcash usually means a transaction per person. Devoid pays the whole list in one shielded transaction. Let me show you a payout, start to finish.",
  },
  outro: {
    title: 'Devoid',
    subtitle: 'One transaction. Multiple payments.',
    url: 'github.com/davebrian259-tech/Devoid',
    script: 'One transaction, multiple payments, and fewer clues on chain. Devoid is open source, on GitHub.',
  },

  // A demo wallet, made off camera: the backup screens are not the story, and the words a demo shows
  // restore nothing. Three of the wallet's own addresses stand in for three contributors.
  setup: async (page, ctx) => {
    await page.goto(`${BASE}/app/`);
    await page.click('.seg button:has-text("Demo")');
    await page.fill('#p1', PASS); await page.fill('#p2', PASS);
    await page.click('text=Create wallet');
    await page.waitForSelector('.phrase span');
    const words = await page.$$eval('.phrase span', (els) => els.map((e) => e.textContent.trim()));
    await page.check('#wrote'); await page.click('text=Continue');
    for (const inp of await page.$$('input[data-word]')) await inp.fill(words[Number(await inp.getAttribute('data-word')) - 1]);
    await page.click('text=Open my wallet'); await page.waitForSelector('.poolbar');
    await page.click('a[data-view=receive]'); await page.waitForSelector('svg.qr');
    const addrs = [await page.innerText('#addr')];
    for (let i = 0; i < 2; i++) {
      await page.click('button:has-text("New address")');
      await page.waitForFunction((prev) => document.getElementById('addr').innerText !== prev, addrs.at(-1));
      addrs.push(await page.innerText('#addr'));
    }
    ctx.list = ['address,amount,memo', `${addrs[0]},1.25,October design work`, `${addrs[1]},0.80,Docs and translations`, `${addrs[2]},2.10,Protocol review`].join('\n');
  },

  scenes: [
    {
      id: 's1-hero',
      prepare: async (page) => { await page.goto(`${BASE}/`); },
      settleMs: 1200, target: '.hero h1', action: 'none', zoom: 1.08,
      script: "It's a non-custodial wallet that runs entirely in your browser. No account, and no server holding your keys.",
    },
    {
      id: 's2-leak',
      prepare: async (page) => { await page.goto(`${BASE}/`); await page.evaluate(() => document.querySelector('#headcount .split').scrollIntoView({block: 'center'})); },
      settleMs: 1000, target: '#headcount .split', action: 'none', zoom: 1.3,
      script: "Here's the catch. Shielding hides amounts and recipients, but the number of outputs is public, and the fee follows from it. So a payout still hints at how many people you paid.",
    },
    {
      id: 's3-wallet',
      prepare: async (page) => { await page.goto(`${BASE}/app/`); await page.waitForSelector('.poolbar'); },
      settleMs: 1200, target: '.band.sim', action: 'none', zoom: 1.05,
      script: "This is a demo wallet on a simulated chain. Play money, real app.",
    },
    {
      id: 's4-paste',
      media: 'clip',
      prepare: async (page) => { await page.click('a[data-view=send]'); await page.waitForSelector('[aria-label="How to add recipients"]'); },
      settleMs: 600,
      record: async (page, rec, ctx) => {
        await rec.click('[aria-label="How to add recipients"] button:has-text("Paste a list")');
        await page.waitForSelector('#batch');
        await rec.moveTo('#batch');
        await page.fill('#batch', ctx.list); // a paste, so it lands at once
        await rec.pause(700);
        await rec.click('text=Check recipients');
        await page.waitForSelector('.ledger');
        await rec.pause(1400);
      },
      script: 'Let\'s pay three contributors. I\'ll paste the list into "Send" and hit "Check recipients". Every address is validated first.',
    },
    {
      id: 's5-pad',
      media: 'clip',
      settleMs: 300,
      record: async (page, rec) => {
        await rec.moveTo('#pad');
        await rec.pause(500);
        await rec.click('#pad');
        await page.waitForFunction(() => document.querySelector('#view').innerText.includes('padded to 5 outputs'));
        await rec.pause(1800);
      },
      script: 'Now the part I like most. Tick "Hide how many people you are paying", and Devoid pads the transaction to five payment slots, with the extra fee shown up front.',
    },
    {
      id: 's6-review',
      media: 'clip',
      settleMs: 300,
      record: async (page, rec) => {
        await rec.click('#review');
        await page.waitForSelector('.sheet');
        await rec.pause(900);
        await rec.moveTo('.sheet .facts');
        await rec.pause(1600);
        await page.evaluate(() => [...document.querySelectorAll('.sheet h2')].find((h) => h.textContent.includes('What others can see'))?.scrollIntoView({behavior: 'smooth', block: 'center'}));
        await rec.pause(2200);
      },
      script: 'The review spells it out: three recipients, five outputs on chain, the exact fee, and what an observer can still see.',
    },
    {
      id: 's7-send',
      media: 'clip',
      settleMs: 300,
      record: async (page, rec) => {
        await rec.type('#pw', PASS);
        await rec.pause(300);
        await rec.click('#confirm');
        await rec.skipWhile(async () => { await page.waitForSelector('#sent-total', {timeout: 60_000}); });
        await rec.pause(1500);
      },
      script: "I'll confirm with the passphrase. Here the send is simulated; on a real wallet, this same screen builds, proves and broadcasts it.",
    },
    {
      id: 's8-activity',
      prepare: async (page) => { await page.click('a[data-view=activity]'); await page.waitForSelector('#view :text("Sent to 3 recipients")'); },
      settleMs: 800, target: '#view :text("Sent to 3 recipients")', action: 'none', zoom: 1.25,
      script: 'In "Activity" it reads "Sent to 3 recipients". The padding is yours, so it never counts as a payment.',
    },
    {
      id: 's9-proof',
      prepare: async (page) => { await page.goto(`${BASE}/`); await page.evaluate(() => [...document.querySelectorAll('#status li')].find((li) => li.textContent.includes('Confirmed on mainnet')).scrollIntoView({block: 'center'})); },
      settleMs: 1000, target: '#status li:has-text("Confirmed on mainnet")', action: 'none', zoom: 1.3,
      script: "And it's real. One Rust engine on librustzcash runs natively and as WebAssembly. Both have sent shielded payments mined on mainnet, and padding is verified on testnet.",
    },
  ],
};
