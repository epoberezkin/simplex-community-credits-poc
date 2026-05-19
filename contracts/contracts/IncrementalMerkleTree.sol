// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "poseidon-solidity/PoseidonT3.sol";

// Tornado/Semaphore-style incremental Merkle tree with Poseidon(2) hashes.
// `filledSubtrees` are the frontier; `zeros` are pre-computed empty subtrees.
// A small ring of recent roots lets concurrent proofs verify against a recent
// root even if a tx changes the tree between proving and submission.
library MerkleTreeLib {
    uint256 internal constant DEPTH = 20;
    uint256 internal constant ROOT_HISTORY = 100;
    uint256 internal constant MAX_LEAVES = 1 << DEPTH;

    struct Tree {
        uint256[DEPTH] filledSubtrees;
        uint256[DEPTH + 1] zeros;
        uint256[ROOT_HISTORY] roots;
        uint32 nextIndex;
        uint32 currentRootIndex;
        bool initialized;
    }

    event LeafInserted(uint256 indexed leafIndex, uint256 leaf, uint256 root);

    function init(Tree storage t) internal {
        require(!t.initialized, "tree/init");
        t.zeros[0] = 0;
        for (uint256 d = 0; d < DEPTH; d++) {
            t.zeros[d + 1] = PoseidonT3.hash([t.zeros[d], t.zeros[d]]);
            t.filledSubtrees[d] = t.zeros[d];
        }
        t.roots[0] = t.zeros[DEPTH];
        t.initialized = true;
    }

    function insert(Tree storage t, uint256 leaf)
        internal
        returns (uint32 leafIndex, uint256 newRoot)
    {
        require(t.initialized, "tree/uninit");
        uint32 idx = t.nextIndex;
        require(idx < MAX_LEAVES, "tree/full");

        uint256 cur = leaf;
        uint32 walkIdx = idx;
        for (uint256 d = 0; d < DEPTH; d++) {
            uint256 left;
            uint256 right;
            if (walkIdx & 1 == 0) {
                left = cur;
                right = t.zeros[d];
                t.filledSubtrees[d] = cur;
            } else {
                left = t.filledSubtrees[d];
                right = cur;
            }
            cur = PoseidonT3.hash([left, right]);
            walkIdx >>= 1;
        }

        t.currentRootIndex = uint32((t.currentRootIndex + 1) % ROOT_HISTORY);
        t.roots[t.currentRootIndex] = cur;
        t.nextIndex = idx + 1;

        emit LeafInserted(idx, leaf, cur);
        return (idx, cur);
    }

    function currentRoot(Tree storage t) internal view returns (uint256) {
        return t.roots[t.currentRootIndex];
    }

    function isKnownRoot(Tree storage t, uint256 root) internal view returns (bool) {
        if (root == 0) return false;
        uint32 i = t.currentRootIndex;
        for (uint256 k = 0; k < ROOT_HISTORY; k++) {
            if (t.roots[i] == root) return true;
            if (i == 0) i = uint32(ROOT_HISTORY - 1); else i--;
        }
        return false;
    }
}
