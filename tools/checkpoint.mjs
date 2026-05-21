#!/usr/bin/env node
// CLI checkpointer. Drains the on-chain pending stream into checkpointed
// tree state by submitting BATCH=1 checkpoint() txs.
//
// Reads the pool address + ethRpcUrl from tools/last-deploy.json (written by
// tools/deploy.mjs). Submits as the relay key (which is registered as an
// operator and prefunded with DOT for gas).
//
// Usage:
//   node tools/checkpoint.mjs           # drain all pending leaves
//   node tools/checkpoint.mjs --watch   # drain + poll every 4 s
//
// Per-leaf cost: ~0.007 DOT empirically on Polkadot Asset Hub. Production
// would batch B≥8 to amortize.

import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  IncrementalMerkleTree,
  buildCheckpointInput,
} from '@community-credits/core';
import { proveCheckpoint } from '@community-credits/core/proof';
import { relayWallet } from './keys.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(__dirname, 'last-deploy.json'), 'utf8'));

const watch = process.argv.includes('--watch');
const WATCH_INTERVAL_MS = 4_000;
const TX_GAS = process.env.TX_GAS ? BigInt(process.env.TX_GAS) : 100_000_000n;

const provider = new ethers.JsonRpcProvider(manifest.ethRpcUrl);
const relay = new ethers.NonceManager(relayWallet.connect(provider));

const POOL_ABI = [
  'function streamCount() view returns (uint32)',
  'function streamAt(uint32) view returns (uint256)',
  'function checkpointedRoot() view returns (uint256)',
  'function checkpointedCount() view returns (uint32)',
  'function checkpoint(uint256 newRoot, uint32 newCount, uint256[2] pA, uint256[2][2] pB, uint256[2] pC)',
  'event StreamAppended(uint32 indexed position, uint256 cm)',
  'event Checkpointed(uint256 indexed oldRoot, uint256 indexed newRoot, uint32 oldCount, uint32 newCount)',
];
const pool = new ethers.Contract(manifest.poolAddress, POOL_ABI, relay);

function unpackProof(flat) {
  return {
    pA: [flat[0], flat[1]],
    pB: [[flat[2], flat[3]], [flat[4], flat[5]]],
    pC: [flat[6], flat[7]],
  };
}

// Rebuild the off-chain mirror from on-chain `commitments[0..checkpointedCount)`.
// O(N) one-time; production would persist the tree across runs.
async function rebuildMirror() {
  const mirror = new IncrementalMerkleTree();
  const n = Number(await pool.checkpointedCount());
  if (n > 0) console.log(`> rebuilding mirror over ${n} checkpointed leaves…`);
  for (let i = 0; i < n; i++) {
    const cm = await pool.streamAt(i);
    await mirror.insert(BigInt(cm));
  }
  // Sanity-check against on-chain root.
  const localRoot = await mirror.root();
  const onChain = BigInt(await pool.checkpointedRoot());
  if (localRoot !== onChain) {
    throw new Error(
      `mirror root mismatch (local ${localRoot.toString(16).slice(0, 12)}… ` +
        `vs on-chain ${onChain.toString(16).slice(0, 12)}…). Reorg or bug.`,
    );
  }
  return mirror;
}

async function drainOnce(mirror) {
  const stream = Number(await pool.streamCount());
  let cp = Number(await pool.checkpointedCount());
  const pending = stream - cp;
  if (pending === 0) return 0;
  console.log(`> draining ${pending} pending leaf(s) (stream=${stream} cp=${cp})…`);
  for (let i = 0; i < pending; i++) {
    const cm = BigInt(await pool.streamAt(cp));
    const { input } = await buildCheckpointInput({ mirror, cm, oldCount: cp });
    const { proofFlat } = await proveCheckpoint(input);
    const { pA, pB, pC } = unpackProof(proofFlat);
    const txr = await (
      await pool.checkpoint(input.newRoot, input.newCount, pA, pB, pC, {
        gasLimit: TX_GAS,
      })
    ).wait();
    console.log(`  cp #${cp + 1} ok  (gas ${txr.gasUsed}  hash ${txr.hash.slice(0, 14)}…)`);
    cp++;
  }
  return pending;
}

const mirror = await rebuildMirror();
do {
  const n = await drainOnce(mirror);
  if (!watch) break;
  if (n === 0) await sleep(WATCH_INTERVAL_MS);
} while (true);
console.log('done.');
process.exit(0);
