pragma circom 2.1.6;

include "./commitment.circom";
include "./merkle.circom";
include "circomlib/circuits/comparators.circom";

// Redeem circuit: consume an assigned note, credit operator, mint change note
// (same owner + same redeemer + same epoch).
template Redeem(depth) {
    // --- private ---
    signal input sk;
    signal input value;
    signal input expiryEpoch;
    signal input randomness;
    signal input redeemerHash;
    signal input redeemerId;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal input changeRandomness;
    signal input changeValue;

    // --- public ---
    signal input root;
    signal input nullifier;
    signal input expiryEpochPub;
    signal input redeemValue;
    signal input cmChange;
    signal input operatorId;

    // 1. ownerPkHash = Poseidon(sk)
    component ownerH = OwnerPkHash();
    ownerH.sk <== sk;
    signal ownerPkHash <== ownerH.out;

    // 2. Input note (assigned, given redeemerHash)
    component inCm = NoteCommitment();
    inCm.value <== value;
    inCm.expiryEpoch <== expiryEpoch;
    inCm.ownerPkHash <== ownerPkHash;
    inCm.randomness <== randomness;
    inCm.assigned <== 1;
    inCm.redeemerHash <== redeemerHash;

    // 3. Merkle membership
    component mp = MerkleProof(depth);
    mp.leaf <== inCm.out;
    for (var i = 0; i < depth; i++) {
        mp.pathElements[i] <== pathElements[i];
        mp.pathIndices[i] <== pathIndices[i];
    }
    mp.root === root;

    // 4. Nullifier
    component nf = Nullifier();
    nf.sk <== sk;
    nf.cm <== inCm.out;
    nullifier === nf.out;

    // 6. Redeemer check
    component redeemerH = Poseidon(1);
    redeemerH.inputs[0] <== redeemerId;
    redeemerHash === redeemerH.out;

    // 7. Value conservation
    value === redeemValue + changeValue;

    component redeemPos = GreaterThan(64);
    redeemPos.in[0] <== redeemValue;
    redeemPos.in[1] <== 0;
    redeemPos.out === 1;

    component valueRange = Num2Bits(64);
    valueRange.in <== value;

    component redeemRange = Num2Bits(64);
    redeemRange.in <== redeemValue;

    // 8. Change commitment (same owner, same redeemer, same epoch)
    component chCm = NoteCommitment();
    chCm.value <== changeValue;
    chCm.expiryEpoch <== expiryEpoch;
    chCm.ownerPkHash <== ownerPkHash;
    chCm.randomness <== changeRandomness;
    chCm.assigned <== 1;
    chCm.redeemerHash <== redeemerHash;
    cmChange === chCm.out;

    // 9. Public epoch matches
    expiryEpoch === expiryEpochPub;

    // operatorId is a public input only — bound to the proof so the contract
    // can credit it (no in-circuit constraint needed; reusing it as a Groth16
    // public input prevents tampering by the relay).
    signal opIdSquared <== operatorId * operatorId; // anchor unused public input
}

component main {public [root, nullifier, expiryEpochPub, redeemValue, cmChange, operatorId]} = Redeem(20);
