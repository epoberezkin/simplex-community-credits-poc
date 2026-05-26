// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Per-circuit verifier interfaces. The generated Solidity verifier exposes
// `verifyProof(uint[2] pA, uint[2][2] pB, uint[2] pC, uint[N] pubSignals)`.
// VoucherPool wraps that signature behind these named interfaces.

interface ICreateVerifier {
    function verifyProof(
        uint[2] calldata _pA,
        uint[2][2] calldata _pB,
        uint[2] calldata _pC,
        uint[3] calldata _pubSignals
    ) external view returns (bool);
}

interface IAssignVerifier {
    function verifyProof(
        uint[2] calldata _pA,
        uint[2][2] calldata _pB,
        uint[2] calldata _pC,
        uint[5] calldata _pubSignals
    ) external view returns (bool);
}

interface IRedeemVerifier {
    function verifyProof(
        uint[2] calldata _pA,
        uint[2][2] calldata _pB,
        uint[2] calldata _pC,
        uint[6] calldata _pubSignals
    ) external view returns (bool);
}

// Public inputs (in circuit order):
//   oldRoot, newRoot, oldFrontier[20], newFrontier[20], oldCount, count, cms[8]
// Total: 1 + 1 + 20 + 20 + 1 + 1 + 8 = 52.
interface ICheckpointVerifier {
    function verifyProof(
        uint[2] calldata _pA,
        uint[2][2] calldata _pB,
        uint[2] calldata _pC,
        uint[52] calldata _pubSignals
    ) external view returns (bool);
}
