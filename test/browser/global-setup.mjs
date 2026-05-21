// Global setup: bring up the chain backend (hardhat by default, chopsticks-
// polkadot when CHAIN=polkadot), deploy contracts, persist runtime state.
// Playwright will start the three dapp dev servers AFTER this completes.
//
// State (which procs we started) is persisted to .runtime/state.json so
// teardown can clean up only what we started.

import {
  ensureChopsticks,
  ensureHardhat,
  runDeploy,
  saveState,
  HARDHAT_PORT,
  ETH_RPC_PORT,
} from './support/runtime.mjs';

export default async function globalSetup() {
  const t0 = Date.now();
  const target = process.env.CHAIN ?? 'hardhat';
  let rpcUrl, state;
  if (target === 'hardhat') {
    const hh = await ensureHardhat();
    rpcUrl = `http://localhost:${HARDHAT_PORT}`;
    state = { hardhat: hh };
  } else {
    const cs = await ensureChopsticks({ chain: target });
    rpcUrl = `http://localhost:${ETH_RPC_PORT}`;
    state = { chopsticks: cs };
  }
  runDeploy({ ethRpcUrl: rpcUrl, target });
  saveState({ ...state, target, rpcUrl, startedAt: new Date().toISOString() });
  console.log(`[browser-e2e] setup ok (target=${target}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
