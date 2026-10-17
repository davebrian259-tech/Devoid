// Network constants. Activation heights come from librustzcash's `consensus.rs`
// (zcash_protocol 0.10.5), the same source the engine builds against.

/** @typedef {'main' | 'test'} NetworkName */

export const NETWORKS = Object.freeze({
  main: Object.freeze({
    id: 'main',
    label: 'Mainnet',
    activation: Object.freeze({
      sapling: 419_200, blossom: 653_600, nu5: 1_687_104, nu6: 2_726_400,
      nu6_1: 3_146_400, nu6_2: 3_364_600, nu6_3: 3_428_143,
    }),
  }),
  test: Object.freeze({
    id: 'test',
    label: 'Testnet',
    activation: Object.freeze({
      sapling: 280_000, blossom: 584_000, nu5: 1_842_420, nu6: 2_976_000,
      nu6_1: 3_536_500, nu6_2: 4_052_000, nu6_3: 4_134_000,
    }),
  }),
});

/**
 * Whether the Ironwood pool (NU6.3) is active at `tipHeight`. Unified-address payments with an
 * Orchard receiver land in Ironwood once it is, and in Orchard before.
 * @param {NetworkName} network
 * @param {number | null | undefined} tipHeight
 */
export function ironwoodActive(network, tipHeight) {
  if (!Number.isFinite(tipHeight)) return true; // unknown tip: assume current rules
  return tipHeight >= NETWORKS[network].activation.nu6_3;
}

/** Mainnet and testnet both target a 75-second block time after Blossom. */
export const BLOCK_SECONDS = 75;

/**
 * Rough block height for a date, for restore flows where the user remembers roughly when the
 * wallet was created. Deliberately conservative: it backs off two days so the scan starts early
 * rather than late (starting late silently misses funds, starting early only costs time).
 * @param {NetworkName} network
 * @param {Date} date
 */
export function estimateHeightForDate(network, date) {
  // Anchor: Blossom activation (75 s blocks from here on) and NU5 activation on mainnet.
  const anchors = {
    main: { height: 1_687_104, time: Date.UTC(2022, 4, 31, 15, 0, 0) / 1000 }, // NU5
    test: { height: 1_842_420, time: Date.UTC(2022, 2, 29, 12, 0, 0) / 1000 }, // NU5 (approx)
  };
  const a = anchors[network];
  const seconds = date.getTime() / 1000 - a.time;
  const est = a.height + Math.floor(seconds / BLOCK_SECONDS) - Math.floor((2 * 86_400) / BLOCK_SECONDS);
  return Math.max(NETWORKS[network].activation.sapling, est);
}
