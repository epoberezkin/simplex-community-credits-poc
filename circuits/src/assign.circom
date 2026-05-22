pragma circom 2.1.6;

include "./commitment.circom";
include "./merkle.circom";
include "circomlib/circuits/comparators.circom";

// Assign circuit: consume an unassigned note, mint an assigned destination note
// + an unassigned change note (same owner).
template Assign(depth) {
    // --- private ---
    signal input sk;
    signal input value;
    signal input expiryEpoch;
    signal input randomness;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal input destValue;
    signal input destOwnerPkHash;
    signal input destRandomness;
    signal input redeemerId;
    signal input changeRandomness;

    // --- public ---
    signal input root;
    signal input nullifier;
    signal input expiryEpochPub;
    signal input cmDest;
    signal input cmChange;

    // 1. ownerPkHash = Poseidon(sk)
    component ownerH = OwnerPkHash();
    ownerH.sk <== sk;
    signal ownerPkHash <== ownerH.out;

    // 2. Input note commitment (unassigned, redeemerHash=0)
    component inCm = NoteCommitment();
    inCm.value <== value;
    inCm.expiryEpoch <== expiryEpoch;
    inCm.ownerPkHash <== ownerPkHash;
    inCm.randomness <== randomness;
    inCm.assigned <== 0;
    inCm.redeemerHash <== 0;

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

    // 6. Value conservation
    signal changeValue <== value - destValue;

    // 7. destValue > 0  (and changeValue >= 0 implicit because value = destValue + changeValue,
    //    enforced via range check)
    component destPos = GreaterThan(64);
    destPos.in[0] <== destValue;
    destPos.in[1] <== 0;
    destPos.out === 1;

    // value fits in 64 bits
    component valueRange = Num2Bits(64);
    valueRange.in <== value;

    component destRange = Num2Bits(64);
    destRange.in <== destValue;

    // changeValue MUST be 64-bit-bounded too; without this, a prover can
    // set destValue > value so changeValue underflows mod p into a huge
    // positive field element and `value === destValue + changeValue` still
    // holds — letting them mint a dest note larger than the source note.
    component changeRange = Num2Bits(64);
    changeRange.in <== changeValue;

    // 8. Dest commitment
    component redeemerH = Poseidon(1);
    redeemerH.inputs[0] <== redeemerId;
    signal redeemerHash <== redeemerH.out;

    component destCm = NoteCommitment();
    destCm.value <== destValue;
    destCm.expiryEpoch <== expiryEpoch;
    destCm.ownerPkHash <== destOwnerPkHash;
    destCm.randomness <== destRandomness;
    destCm.assigned <== 1;
    destCm.redeemerHash <== redeemerHash;
    cmDest === destCm.out;

    // 9. Change commitment (same owner, unassigned)
    component chCm = NoteCommitment();
    chCm.value <== changeValue;
    chCm.expiryEpoch <== expiryEpoch;
    chCm.ownerPkHash <== ownerPkHash;
    chCm.randomness <== changeRandomness;
    chCm.assigned <== 0;
    chCm.redeemerHash <== 0;
    cmChange === chCm.out;

    // 10. Public epoch matches
    expiryEpoch === expiryEpochPub;
}

component main {public [root, nullifier, expiryEpochPub, cmDest, cmChange]} = Assign(20);
