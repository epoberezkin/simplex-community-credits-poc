pragma circom 2.1.6;

include "./commitment.circom";

// Create circuit: buyer proves a well-formed unassigned commitment
// matching the public (value, expiryEpoch) the contract sees.
//
// Public:  cm, value, expiryEpoch
// Private: ownerPkHash, randomness
template Create() {
    signal input ownerPkHash;
    signal input randomness;

    signal input cm;
    signal input value;
    signal input expiryEpoch;

    component nc = NoteCommitment();
    nc.value <== value;
    nc.expiryEpoch <== expiryEpoch;
    nc.ownerPkHash <== ownerPkHash;
    nc.randomness <== randomness;
    nc.assigned <== 0;
    nc.redeemerHash <== 0;

    cm === nc.out;
}

component main {public [cm, value, expiryEpoch]} = Create();
