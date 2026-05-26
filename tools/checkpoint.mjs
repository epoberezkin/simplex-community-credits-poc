#!/usr/bin/env node
// CLI checkpointer. Drains the on-chain pending stream into checkpointed
// tree state by submitting batched `checkpoint()` extrinsics (B_MAX=8).
//
// As of issue #3 the checkpointer is STATELESS: it reads the current
// frontier and stream tail directly from chain, so any new instance can
// step in without first replaying history. This is the fallback story:
// a stalled primary can be replaced by any participant (an SMP relay, an
// affected user, a community watchdog) without warm state.
//
// Scheduler (--watch):
//   CP_MIN_MS   (default 5 min)  own cooldown (limit max fee expenses, #2)
//   CP_AGE_MS   (default 5 min)  submit if oldest pending leaf is older
//   CP_POLL_MS  (default 30 s)   how often the loop wakes to re-check
// Demo overrides these to 20 s / 20 s / 4 s for snappy UX.
//
// Submit policy on each tick:
//   pending = streamCount - checkpointedCount
//   if pending == 0: skip (no work)
//   else if pending >= B_MAX OR oldest leaf age >= MAX_LEAF_AGE_MS:
//       if own last-submit cooldown elapsed: submit min(pending, B_MAX)
//   else: wait
//
// The 5-min cadence is a polite-primary convention, not a chain invariant
// — the contract has no time gating. A user impatient with the cadence can
// submit any time; we just won't preempt them.
//
// Reads pool address + ethRpcUrl from tools/last-deploy.json. Submits as
// the relay key (registered as operator, prefunded with DOT for gas).

import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  IncrementalMerkleTree,
  buildCheckpointInput,
  CHECKPOINT_BATCH_MAX,
  DEFAULT_DEPTH,
} from '@community-credits/core';
import { proveCheckpoint } from '@community-credits/core/proof';
import { relayWallet } from './keys.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(__dirname, 'last-deploy.json'), 'utf8'));

const watch = process.argv.includes('--watch');
const POLL_INTERVAL_MS = Number(process.env.CP_POLL_MS  || 30_000);
const MIN_INTERVAL_MS  = Number(process.env.CP_MIN_MS   || 5 * 60_000);
const MAX_LEAF_AGE_MS  = Number(process.env.CP_AGE_MS   || 5 * 60_000);

const TX_GAS = process.env.TX_GAS
  ? BigInt(process.env.TX_GAS)
  : manifest.chainId === 31337 ? 15_000_000n : 100_000_000n;

const provider = new ethers.JsonRpcProvider(manifest.ethRpcUrl);
// No NonceManager — see prior comment: the relay key may be used
// concurrently by the relay dapp.
const relay = relayWallet.connect(provider);

const POOL_ABI = [
  'function streamCount() view returns (uint32)',
  'function streamAt(uint32) view returns (uint256)',
  'function checkpointedRoot() view returns (uint256)',
  'function checkpointedCount() view returns (uint32)',
  'function checkpointedFrontier() view returns (uint256[20])',
  `function checkpoint(uint256 newRoot, uint256[${DEFAULT_DEPTH}] newFrontier, uint32 count, uint256[2] pA, uint256[2][2] pB, uint256[2] pC)`,
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

// Build an off-chain mirror seeded from on-chain frontier (constant-time;
// no full-history replay). The mirror's filledSubtrees and root are set
// directly from `checkpointedFrontier()` / `checkpointedRoot()` so the
// next insert continues from where the chain is.
async function mirrorFromChain() {
  const m = new IncrementalMerkleTree();
  await m._ensureInit();
  const frontierOnChain = (await pool.checkpointedFrontier()).map((x) => BigInt(x));
  if (frontierOnChain.length !== m.depth) {
    throw new Error(`unexpected frontier length: ${frontierOnChain.length}`);
  }
  m.filledSubtrees = frontierOnChain.slice();
  m._root = BigInt(await pool.checkpointedRoot());
  // We also need leaves.length to match checkpointedCount so insert()
  // positions new leaves at the right index. We pad with zero placeholders
  // — these are never read (only used for proof() lookups, which the
  // checkpointer doesn't do).
  const cp = Number(await pool.checkpointedCount());
  m.leaves = new Array(cp).fill(0n);
  return m;
}

// Returns the block timestamp (ms) of the StreamAppended event for the
// position == checkpointedCount, or null if the position is past the head
// or no such event exists. Used to decide whether the oldest pending leaf
// has aged past MAX_LEAF_AGE_MS.
async function oldestPendingLeafAgeMs(checkpointedCount) {
  const topic = pool.interface.getEvent('StreamAppended').topicHash;
  // ethers indexed uint32 → 32-byte topic (left-padded). Filter by topic[1].
  const posTopic = ethers.zeroPadValue(ethers.toBeHex(BigInt(checkpointedCount)), 32);
  const logs = await provider.getLogs({
    address: manifest.poolAddress,
    topics: [topic, posTopic],
    fromBlock: 0,
    toBlock: 'latest',
  });
  if (logs.length === 0) return null;
  const blk = await provider.getBlock(logs[0].blockNumber);
  return Date.now() - blk.timestamp * 1000;
}

let lastSubmitAtMs = 0;

async function maybeSubmit({ force = false } = {}) {
  const streamCount = Number(await pool.streamCount());
  const cp          = Number(await pool.checkpointedCount());
  const pending     = streamCount - cp;
  if (pending === 0) return 0;

  if (!force) {
    const cooldownLeft = MIN_INTERVAL_MS - (Date.now() - lastSubmitAtMs);
    const sizeReady    = pending >= CHECKPOINT_BATCH_MAX;
    const ageMs        = sizeReady ? null : await oldestPendingLeafAgeMs(cp);
    const ageReady     = !sizeReady && ageMs !== null && ageMs >= MAX_LEAF_AGE_MS;
    if (!sizeReady && !ageReady) {
      // Nothing to do yet — neither full batch nor stale leaf.
      return 0;
    }
    if (cooldownLeft > 0) {
      // Polite cooldown: we'd like to submit but it's too soon since our
      // last one. If anyone else wants to step in earlier, the contract
      // accepts them — we'll just see streamCount → cp catch up.
      console.log(`> would submit (pending=${pending}) but cooldown ${Math.ceil(cooldownLeft / 1000)}s left`);
      return 0;
    }
  }

  const n = Math.min(pending, CHECKPOINT_BATCH_MAX);
  const cms = [];
  for (let i = 0; i < n; i++) cms.push(BigInt(await pool.streamAt(cp + i)));

  const mirror = await mirrorFromChain();
  const { input } = await buildCheckpointInput({ mirror, cms, oldCount: cp });
  const { proofFlat } = await proveCheckpoint(input);
  const { pA, pB, pC } = unpackProof(proofFlat);

  let attempts = 0;
  while (true) {
    try {
      const txr = await (
        await pool.checkpoint(input.newRoot, input.newFrontier, n, pA, pB, pC, {
          gasLimit: TX_GAS,
        })
      ).wait();
      console.log(
        `> checkpoint #${cp + n} ok — n=${n} (cp ${cp} → ${cp + n}, gas ${txr.gasUsed}, ${txr.hash.slice(0, 14)}…)`
      );
      lastSubmitAtMs = Date.now();
      return n;
    } catch (e) {
      if (++attempts > 3) throw e;
      if (e.code === 'NONCE_EXPIRED' || /nonce/i.test(e.shortMessage || '')) {
        await sleep(500);
        continue;
      }
      throw e;
    }
  }
}

if (!watch) {
  // One-shot: keep submitting until everything is drained (subject to
  // B_MAX-per-tx). Ignores the cooldown — used by tests and ad-hoc runs.
  let total = 0;
  while (true) {
    const n = await maybeSubmit({ force: true });
    if (n === 0) break;
    total += n;
  }
  console.log(`done (${total} leaves checkpointed).`);
  process.exit(0);
}

console.log(`watching pool=${manifest.poolAddress} (B_MAX=${CHECKPOINT_BATCH_MAX}, cooldown=${MIN_INTERVAL_MS / 60000} min, max-age=${MAX_LEAF_AGE_MS / 60000} min)`);
while (true) {
  try {
    await maybeSubmit();
  } catch (e) {
    console.error(`error: ${e.shortMessage || e.message}; retry next tick`);
  }
  await sleep(POLL_INTERVAL_MS);
}
