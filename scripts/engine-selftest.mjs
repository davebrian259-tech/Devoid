// Runs the engine's offline self-test (real engine if built, else the simulated one).
import { pickEngine, runEngine } from '../server/index.mjs';
const engine = pickEngine({ forceMock: process.argv.includes('--mock') });
console.log(`engine: ${engine.simulated ? 'simulated' : engine.cmd}`);
const r = await runEngine(engine, { cmd: 'selftest' });
console.log(JSON.stringify(r, null, 2));
process.exit(r.ok ? 0 : 1);
