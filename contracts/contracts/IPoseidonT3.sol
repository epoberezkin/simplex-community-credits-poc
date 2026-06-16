// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// On-chain Poseidon(2) hash, deployed from circomlibjs `poseidonContract`
// bytecode so it is bit-identical to:
//   - circuits/src/merkle.circom        (Poseidon(2) tree hash)
//   - packages/core/src/poseidon.js     (circomlibjs poseidonHash)
// The deployed bytecode has no Solidity source; this interface is the call
// surface used by IncrementalMerkleTree.
interface IPoseidonT3 {
    function poseidon(uint256[2] calldata input) external pure returns (uint256);
}
