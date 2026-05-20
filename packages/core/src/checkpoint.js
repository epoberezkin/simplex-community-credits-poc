// Checkpoint witness builder. Given an off-chain `IncrementalMerkleTree`
// mirror + ONE streamed commitment, produces the public + private inputs
// for the BATCH=1 checkpoint circuit.
//
// Production should bump BATCH to ≥8; the witness builder would loop and
// chain intermediate roots, but the public-input shape and proving system
// are unchanged.

// Build the input for `proveCheckpoint`.
//
//   mirror   — IncrementalMerkleTree at *pre-append* state (root == oldRoot)
//   cm       — the commitment to append (from on-chain stream)
//   oldCount — current on-chain checkpointedCount
//
// Returns { input, expectedNewRoot } where `input` is ready for
// proveCheckpoint() and `expectedNewRoot` is what the contract gets passed
// as a public input.
export async function buildCheckpointInput({ mirror, cm, oldCount }) {
  const oldRoot = await mirror.root();
  const appendPath = await mirror.appendPath(oldCount);
  await mirror.insert(cm);
  const newRoot = await mirror.root();

  return {
    input: {
      cm: BigInt(cm),
      appendPath,
      oldRoot,
      newRoot,
      oldCount,
      newCount: oldCount + 1,
    },
    expectedNewRoot: newRoot,
  };
}
