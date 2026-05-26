// Checkpoint witness builder. Given an off-chain `IncrementalMerkleTree`
// mirror + a batch of streamed commitments + the on-chain frontier/oldCount,
// produces the public + private inputs for the batched checkpoint circuit.
//
// Public-input shape matches circuits/src/checkpoint.circom (Checkpoint
// template with B_MAX=8, depth=20). Order matters — see contract's
// `checkpoint(...)` pack-and-pad.

import { DEFAULT_DEPTH } from './merkle.js';

export const B_MAX = 8;

// Build the input for `proveCheckpoint`.
//
//   mirror   — IncrementalMerkleTree at PRE-batch state. Its frontier()
//              and root() match `oldFrontier` / `oldRoot` on chain.
//   cms      — bigint[] of commitments in this batch (1 ≤ length ≤ B_MAX).
//   oldCount — current on-chain checkpointedCount.
//
// Mutates `mirror` (inserts each cm). After return, mirror.frontier() and
// mirror.root() match the new on-chain state.
//
// Returns { input, oldRoot, newRoot, oldFrontier, newFrontier, count, cms }
// where `input` is ready for proveCheckpoint() and the rest are convenient
// for the contract caller (newFrontier + newRoot are public inputs; count
// and cms (real entries only) help the contract pack pubSignals).
export async function buildCheckpointInput({ mirror, cms, oldCount }) {
  if (!Array.isArray(cms) || cms.length === 0) {
    throw new Error('buildCheckpointInput: cms must be a non-empty array');
  }
  if (cms.length > B_MAX) {
    throw new Error(`buildCheckpointInput: batch size ${cms.length} exceeds B_MAX=${B_MAX}`);
  }

  const oldFrontier = await mirror.frontier();
  const oldRoot = await mirror.root();
  if (oldFrontier.length !== DEFAULT_DEPTH) {
    throw new Error(`unexpected frontier length ${oldFrontier.length}`);
  }

  // Insert real leaves and capture post-batch frontier + root.
  for (const cm of cms) await mirror.insert(BigInt(cm));
  const newFrontier = await mirror.frontier();
  const newRoot = await mirror.root();

  // Zero-pad cms to B_MAX for the circuit's fixed-size cms[] input.
  const cmsPadded = new Array(B_MAX).fill(0n);
  cms.forEach((cm, i) => { cmsPadded[i] = BigInt(cm); });

  const input = {
    oldRoot,
    newRoot,
    oldFrontier,
    newFrontier,
    oldCount: BigInt(oldCount),
    count: BigInt(cms.length),
    cms: cmsPadded,
  };

  return {
    input,
    oldRoot, newRoot, oldFrontier, newFrontier,
    count: cms.length,
    cms: cms.map((x) => BigInt(x)),
  };
}
