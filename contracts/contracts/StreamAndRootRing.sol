// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Stream + checkpoint state for the voucher pool.
//
// Per user tx (buy / assign / redeem) we SSTORE each emitted commitment into
// an indexed array. This avoids any on-chain Poseidon hashing — a single
// `PoseidonT3.hash` call empirically OOGs the per-extrinsic budget on
// pallet-revive (see chopsticks/README.md). SSTOREs are cheap; per-leaf
// storage cost is ~50K weight.
//
// The Merkle tree for spend membership proofs is materialized off-chain. A
// permissionless `checkpoint(...)` callable on VoucherPool rolls the latest
// streamed commitments into a new Merkle root by verifying a batched SNARK
// whose public inputs include each cm read directly from on-chain storage.
//
// See docs/gas-design.md §3b for the full design and §7 for the trade-offs.
library StreamRingLib {
    uint256 internal constant ROOT_HISTORY = 100;

    struct State {
        // ---- stream side (advances on every buy/assign/redeem) ----
        uint32  streamCount;           // total commitments ever streamed (== next position)
        // Indexed commitment storage. The checkpoint(...) caller reads each
        // cm directly from here and passes it as a public input to the SNARK;
        // the SNARK proves the tree update over exactly those values.
        mapping(uint32 => uint256) commitments;

        // ---- checkpoint side (advances on `checkpoint(...)`) ----
        uint256 checkpointedRoot;      // Merkle root of leaves [0..checkpointedCount-1]
        uint32  checkpointedCount;     // # of leaves included in the latest checkpoint
        uint32  currentRootIndex;      // ring buffer pointer
        uint256[ROOT_HISTORY] roots;

        bool initialized;
    }

    event StreamAppended(uint32 indexed position, uint256 cm);
    event Checkpointed(
        uint256 indexed oldRoot,
        uint256 indexed newRoot,
        uint32 oldCount,
        uint32 newCount
    );

    function init(State storage s) internal {
        require(!s.initialized, "stream/init");
        // Empty tree root at depth 20 is the canonical Poseidon zero-subtree
        // hash at level 20 — pre-computed off-chain so we don't pay 20
        // Poseidons in the constructor.
        s.checkpointedRoot =
            0x2134e76ac5d21aab186c2be1dd8f84ee880a1e46eaf712f9d371b6df22191f3e;
        s.roots[0] = s.checkpointedRoot;
        s.initialized = true;
    }

    // Append a single commitment to the stream. One SSTORE for the
    // commitment, one SSTORE for the count. No on-chain hashing.
    function appendStream(State storage s, uint256 cm) internal returns (uint32 position) {
        require(s.initialized, "stream/uninit");
        position = s.streamCount;
        s.commitments[position] = cm;
        s.streamCount = position + 1;
        emit StreamAppended(position, cm);
    }

    // Read the cm at a given stream position.
    function streamAt(State storage s, uint32 position) internal view returns (uint256) {
        return s.commitments[position];
    }

    // Apply a checkpoint that has been verified by a SNARK upstream. The
    // SNARK guarantees `newRoot` is the result of appending the commitments
    // at positions [oldCount..newCount-1] (read directly from on-chain
    // storage) to the tree at `oldRoot`. This function only updates state.
    function applyCheckpoint(State storage s, uint256 newRoot, uint32 newCount) internal {
        s.checkpointedRoot = newRoot;
        s.checkpointedCount = newCount;
        s.currentRootIndex = uint32((s.currentRootIndex + 1) % ROOT_HISTORY);
        s.roots[s.currentRootIndex] = newRoot;
    }

    function isKnownRoot(State storage s, uint256 root) internal view returns (bool) {
        if (root == 0) return false;
        uint32 i = s.currentRootIndex;
        for (uint256 k = 0; k < ROOT_HISTORY; k++) {
            if (s.roots[i] == root) return true;
            if (i == 0) i = uint32(ROOT_HISTORY - 1); else i--;
        }
        return false;
    }
}
