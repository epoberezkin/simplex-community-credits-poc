pragma circom 2.1.6;

include "./merkle.circom";
include "circomlib/circuits/bitify.circom";

// Checkpoint circuit: prove that a single commitment (passed as a public
// input to anchor against on-chain storage) can be rolled from the stream
// into the Merkle tree atomically.
//
// Public:
//   oldRoot, newRoot                — Merkle root before / after the append
//   oldCount, newCount              — leaf-position endpoints (newCount = oldCount + 1)
//   cm                              — the commitment being appended (cross-checked
//                                     by the contract against streamAt(oldCount))
//
// Private:
//   appendPath[depth]               — canonical sibling path for the insert
//
// Constraints:
//   1. newCount == oldCount + 1
//   2. Verify(0,  appendPath, bits(oldCount)) == oldRoot   (path canonical)
//   3. Verify(cm, appendPath, bits(oldCount)) == newRoot   (transition)
//
// PoC uses BATCH=1 — the contract reads one cm per checkpoint(). Production
// should bump BATCH to ≥8 (add `cm[BATCH]` + `appendPath[BATCH][depth]` +
// chain the per-leaf transitions through `treeRoot[BATCH+1]`).
template Checkpoint(depth) {
    // --- private ---
    signal input appendPath[depth];

    // --- public ---
    signal input oldRoot;
    signal input newRoot;
    signal input oldCount;
    signal input newCount;
    signal input cm;

    newCount === oldCount + 1;

    component idxBits = Num2Bits(depth);
    idxBits.in <== oldCount;

    component oldMP = MerkleProof(depth);
    oldMP.leaf <== 0;
    component newMP = MerkleProof(depth);
    newMP.leaf <== cm;
    for (var d = 0; d < depth; d++) {
        oldMP.pathElements[d] <== appendPath[d];
        oldMP.pathIndices[d]  <== idxBits.out[d];
        newMP.pathElements[d] <== appendPath[d];
        newMP.pathIndices[d]  <== idxBits.out[d];
    }
    oldRoot === oldMP.root;
    newRoot === newMP.root;
}

component main {public [oldRoot, newRoot, oldCount, newCount, cm]} = Checkpoint(20);
