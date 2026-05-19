pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";

// Note commitment over the 6-field record:
//   cm = Poseidon(value, expiryEpoch, ownerPkHash, randomness, assigned, redeemerHash)
template NoteCommitment() {
    signal input value;
    signal input expiryEpoch;
    signal input ownerPkHash;
    signal input randomness;
    signal input assigned;
    signal input redeemerHash;
    signal output out;

    component h = Poseidon(6);
    h.inputs[0] <== value;
    h.inputs[1] <== expiryEpoch;
    h.inputs[2] <== ownerPkHash;
    h.inputs[3] <== randomness;
    h.inputs[4] <== assigned;
    h.inputs[5] <== redeemerHash;
    out <== h.out;
}

// pkHash = Poseidon(sk)   -- Poseidon-based owner key (whitepaper §4.5.1 simplification)
template OwnerPkHash() {
    signal input sk;
    signal output out;

    component h = Poseidon(1);
    h.inputs[0] <== sk;
    out <== h.out;
}

// nullifier = Poseidon(sk, cm)
template Nullifier() {
    signal input sk;
    signal input cm;
    signal output out;

    component h = Poseidon(2);
    h.inputs[0] <== sk;
    h.inputs[1] <== cm;
    out <== h.out;
}
