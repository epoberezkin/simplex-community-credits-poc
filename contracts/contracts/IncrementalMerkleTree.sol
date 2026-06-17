// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoseidonT3} from "./IPoseidonT3.sol";

/// @title IncrementalMerkleTree — append-only Poseidon Merkle tree (depth 20).
/// @notice Tornado-style frontier construction: store the `TREE_DEPTH`
///         filled-subtree hashes plus precomputed zero-subtree hashes per
///         level, recompute the new root on each insert. Replaces the old
///         stream + permissionless-checkpoint design: commitments are now
///         folded into the tree on-chain inside each buy/assign/redeem, so a
///         note is spendable as soon as its tx lands (no checkpoint latency).
///
///         A 100-slot ring buffer keeps recent roots accepted, so concurrent
///         assign/redeem proofs built against a slightly-stale root still
///         verify without front-running invalidation.
///
///         Must stay byte-compatible with packages/core/src/merkle.js and
///         circuits/src/merkle.circom (same depth, ZERO_LEAF=0, Poseidon(2)).
abstract contract IncrementalMerkleTree {
    uint8 internal constant TREE_DEPTH = 20;
    uint32 internal constant TREE_CAPACITY = uint32(1) << TREE_DEPTH; // 1_048_576
    uint32 internal constant ROOT_HISTORY_SIZE = 100;

    IPoseidonT3 public immutable poseidonT3;

    uint256[TREE_DEPTH] internal _zeros;
    uint256[TREE_DEPTH] internal _filledSubtrees;
    uint256[ROOT_HISTORY_SIZE] internal _roots;

    /// @notice Index of the most-recent root in the ring buffer.
    uint32 public currentRootIndex;

    /// @notice Position the next inserted leaf will occupy.
    uint32 public nextIndex;

    error TreeFull();

    constructor(IPoseidonT3 _poseidonT3) {
        poseidonT3 = _poseidonT3;

        // Precompute zero-subtree hashes per level. Level 0 leaf is 0.
        // Each subsequent level is Poseidon(prev, prev). zeros[20] is the
        // empty-tree root (matches scripts/compute-zeros.mjs).
        uint256 currentZero = 0;
        for (uint8 i = 0; i < TREE_DEPTH; i++) {
            _zeros[i] = currentZero;
            _filledSubtrees[i] = currentZero;
            currentZero = poseidonT3.poseidon([currentZero, currentZero]);
        }

        // Empty-tree root sits at ring buffer index 0.
        _roots[0] = currentZero;
    }

    /// @notice Append `leaf` and roll the root forward. Returns the leaf index
    ///         it occupied (callers emit it so off-chain mirrors can build
    ///         inclusion witnesses).
    function _insert(uint256 leaf) internal returns (uint32 leafIndex) {
        uint32 _nextIndex = nextIndex;
        if (_nextIndex >= TREE_CAPACITY) revert TreeFull();

        uint32 currentIndex = _nextIndex;
        uint256 currentLevelHash = leaf;

        for (uint8 i = 0; i < TREE_DEPTH; i++) {
            uint256 left;
            uint256 right;
            if (currentIndex % 2 == 0) {
                left = currentLevelHash;
                right = _zeros[i];
                _filledSubtrees[i] = currentLevelHash;
            } else {
                left = _filledSubtrees[i];
                right = currentLevelHash;
            }
            currentLevelHash = poseidonT3.poseidon([left, right]);
            currentIndex /= 2;
        }

        uint32 newRootIndex = (currentRootIndex + 1) % ROOT_HISTORY_SIZE;
        currentRootIndex = newRootIndex;
        _roots[newRootIndex] = currentLevelHash;

        nextIndex = _nextIndex + 1;
        return _nextIndex;
    }

    /// @notice True iff `root` matches any of the last `ROOT_HISTORY_SIZE` roots.
    function isKnownRoot(uint256 root) public view returns (bool) {
        if (root == 0) return false;
        uint32 _currentRootIndex = currentRootIndex;
        uint32 i = _currentRootIndex;
        do {
            if (root == _roots[i]) return true;
            if (i == 0) i = ROOT_HISTORY_SIZE - 1; else i--;
        } while (i != _currentRootIndex);
        return false;
    }

    /// @notice The most-recently computed root.
    function getLatestRoot() public view returns (uint256) {
        return _roots[currentRootIndex];
    }
}
