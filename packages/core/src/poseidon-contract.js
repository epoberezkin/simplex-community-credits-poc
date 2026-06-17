// Deploy bytecode for an on-chain Poseidon(2) hash contract ("PoseidonT3"),
// emitted by circomlibjs so it is bit-identical to the Poseidon(2) used in
// circuits/src/merkle.circom and packages/core/src/poseidon.js.
//
// Deployed as raw bytecode (no Solidity source); called on-chain via the
// IPoseidonT3 interface: `poseidon(uint256[2]) returns (uint256)`. Used by
// IncrementalMerkleTree.sol to fold each commitment into the tree on-chain.
import { poseidonContract } from 'circomlibjs';

export const poseidonT3Bytecode = poseidonContract.createCode(2);
