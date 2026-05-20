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

    // Pre-computed zero-subtree hashes:
    //   ZEROS[0] = 0
    //   ZEROS[i] = Poseidon(ZEROS[i-1], ZEROS[i-1])
    // Hardcoded so the constructor doesn't have to call PoseidonT3.hash 20×.
    // Verified to match core/merkle.js + circom Poseidon constants (see
    // packages/core/src/poseidon.js test vector).
    function _zero(uint256 i) private pure returns (uint256) {
        if (i ==  0) return 0;
        if (i ==  1) return 0x2098f5fb9e239eab3ceac3f27b81e481dc3124d55ffed523a839ee8446b64864;
        if (i ==  2) return 0x1069673dcdb12263df301a6ff584a7ec261a44cb9dc68df067a4774460b1f1e1;
        if (i ==  3) return 0x18f43331537ee2af2e3d758d50f72106467c6eea50371dd528d57eb2b856d238;
        if (i ==  4) return 0x07f9d837cb17b0d36320ffe93ba52345f1b728571a568265caac97559dbc952a;
        if (i ==  5) return 0x2b94cf5e8746b3f5c9631f4c5df32907a699c58c94b2ad4d7b5cec1639183f55;
        if (i ==  6) return 0x2dee93c5a666459646ea7d22cca9e1bcfed71e6951b953611d11dda32ea09d78;
        if (i ==  7) return 0x078295e5a22b84e982cf601eb639597b8b0515a88cb5ac7fa8a4aabe3c87349d;
        if (i ==  8) return 0x2fa5e5f18f6027a6501bec864564472a616b2e274a41211a444cbe3a99f3cc61;
        if (i ==  9) return 0x0e884376d0d8fd21ecb780389e941f66e45e7acce3e228ab3e2156a614fcd747;
        if (i == 10) return 0x1b7201da72494f1e28717ad1a52eb469f95892f957713533de6175e5da190af2;
        if (i == 11) return 0x1f8d8822725e36385200c0b201249819a6e6e1e4650808b5bebc6bface7d7636;
        if (i == 12) return 0x2c5d82f66c914bafb9701589ba8cfcfb6162b0a12acf88a8d0879a0471b5f85a;
        if (i == 13) return 0x14c54148a0940bb820957f5adf3fa1134ef5c4aaa113f4646458f270e0bfbfd0;
        if (i == 14) return 0x190d33b12f986f961e10c0ee44d8b9af11be25588cad89d416118e4bf4ebe80c;
        if (i == 15) return 0x22f98aa9ce704152ac17354914ad73ed1167ae6596af510aa5b3649325e06c92;
        if (i == 16) return 0x2a7c7c9b6ce5880b9f6f228d72bf6a575a526f29c66ecceef8b753d38bba7323;
        if (i == 17) return 0x2e8186e558698ec1c67af9c14d463ffc470043c9c2988b954d75dd643f36b992;
        if (i == 18) return 0x0f57c5571e9a4eab49e2c8cf050dae948aef6ead647392273546249d1c1ff10f;
        if (i == 19) return 0x1830ee67b5fb554ad5f63d4388800e1cfe78e310697d46e43c9ce36134f72cca;
        if (i == 20) return 0x2134e76ac5d21aab186c2be1dd8f84ee880a1e46eaf712f9d371b6df22191f3e;
        revert("tree/zero-oob");
    }

    function init(Tree storage t) internal {
        require(!t.initialized, "tree/init");
        for (uint256 d = 0; d < DEPTH; d++) {
            t.zeros[d] = _zero(d);
            t.filledSubtrees[d] = t.zeros[d];
        }
        t.zeros[DEPTH] = _zero(DEPTH);
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
