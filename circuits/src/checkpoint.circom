pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";

// Single-insert frontier transition. Given the current frontier and the
// insert position (as depth bits) + leaf, computes the new frontier (the
// classic Tornado-style `filledSubtrees[]` for the next insert position)
// and the resulting tree root (with empty right subtrees padded by zeros).
//
// At each level d, with pathIndices[d] the d-th bit of the insert position:
//   bit = 0 (left child):  parent = Poseidon(current[d], zeros[d])
//                          newFrontier[d] = current[d]
//   bit = 1 (right child): parent = Poseidon(frontierIn[d], current[d])
//                          newFrontier[d] = frontierIn[d]
//
// `left[d]` (the left input to the level-d Poseidon) equals `newFrontier[d]`
// in both cases — we compute the mux once and reuse it.
template InsertStep(depth) {
    signal input frontierIn[depth];
    signal input pathIndices[depth];   // depth booleans
    signal input leaf;

    signal output frontierOut[depth];
    signal output root;

    // Precomputed Poseidon zero-subtree hashes (zeros[0] = 0,
    // zeros[d+1] = Poseidon(zeros[d], zeros[d])). 20 levels of right-pad.
    // Regenerate with scripts/compute-zeros.mjs if depth changes.
    var zeros[20];
    zeros[0]  = 0;
    zeros[1]  = 14744269619966411208579211824598458697587494354926760081771325075741142829156;
    zeros[2]  = 7423237065226347324353380772367382631490014989348495481811164164159255474657;
    zeros[3]  = 11286972368698509976183087595462810875513684078608517520839298933882497716792;
    zeros[4]  = 3607627140608796879659380071776844901612302623152076817094415224584923813162;
    zeros[5]  = 19712377064642672829441595136074946683621277828620209496774504837737984048981;
    zeros[6]  = 20775607673010627194014556968476266066927294572720319469184847051418138353016;
    zeros[7]  = 3396914609616007258851405644437304192397291162432396347162513310381425243293;
    zeros[8]  = 21551820661461729022865262380882070649935529853313286572328683688269863701601;
    zeros[9]  = 6573136701248752079028194407151022595060682063033565181951145966236778420039;
    zeros[10] = 12413880268183407374852357075976609371175688755676981206018884971008854919922;
    zeros[11] = 14271763308400718165336499097156975241954733520325982997864342600795471836726;
    zeros[12] = 20066985985293572387227381049700832219069292839614107140851619262827735677018;
    zeros[13] = 9394776414966240069580838672673694685292165040808226440647796406499139370960;
    zeros[14] = 11331146992410411304059858900317123658895005918277453009197229807340014528524;
    zeros[15] = 15819538789928229930262697811477882737253464456578333862691129291651619515538;
    zeros[16] = 19217088683336594659449020493828377907203207941212636669271704950158751593251;
    zeros[17] = 21035245323335827719745544373081896983162834604456827698288649288827293579666;
    zeros[18] = 6939770416153240137322503476966641397417391950902474480970945462551409848591;
    zeros[19] = 10941962436777715901943463195175331263348098796018438960955633645115732864202;

    signal current[depth + 1];
    current[0] <== leaf;

    signal left[depth];
    signal right[depth];
    component hash[depth];

    for (var d = 0; d < depth; d++) {
        pathIndices[d] * (pathIndices[d] - 1) === 0;
        // left  = (1 - bit) * current[d] + bit * frontierIn[d]
        left[d]  <== current[d] + pathIndices[d] * (frontierIn[d] - current[d]);
        // right = (1 - bit) * zeros[d]   + bit * current[d]
        right[d] <== zeros[d]   + pathIndices[d] * (current[d]   - zeros[d]);

        hash[d] = Poseidon(2);
        hash[d].inputs[0] <== left[d];
        hash[d].inputs[1] <== right[d];
        current[d + 1] <== hash[d].out;

        // newFrontier[d] = left[d] (same mux: see comment above).
        frontierOut[d] <== left[d];
    }

    root <== current[depth];
}

// Batched, count-aware checkpoint circuit. Public-input order matches the
// Solidity verifier's `pubSignals` array; keep VoucherPool.checkpoint()
// pack-and-pad in sync.
//
//   oldRoot                — root stored on-chain (== root of oldFrontier)
//   newRoot                — root after the batch (= last active step's root)
//   oldFrontier[depth]     — frontier stored on-chain (Tornado-style)
//   newFrontier[depth]     — frontier after the batch
//   oldCount               — # of leaves already checkpointed
//   count                  — # of REAL leaves in this batch (1 ≤ count ≤ B_MAX)
//   cms[B_MAX]             — leaves; slots [0..count) are real (from stream),
//                            rest are zero-padding (contract pads tail to 0)
//
// Total public inputs (B_MAX=8, depth=20): 1+1+20+20+1+1+8 = 52.
//
// For each slot i in [0, B_MAX): compute the InsertStep at position
// (oldCount + i) with leaf cms[i]. The active[i]=(i<count) mask gates the
// per-slot advance of both the running frontier and the running root —
// inactive slots are no-ops (passthrough). The final frontier+root must
// match the supplied newFrontier+newRoot. count <= B_MAX is enforced by
// the contract (rejecting count > B_MAX before SNARK verify).
template Checkpoint(depth, B_MAX) {
    signal input oldRoot;
    signal input newRoot;
    signal input oldFrontier[depth];
    signal input newFrontier[depth];
    signal input oldCount;
    signal input count;
    signal input cms[B_MAX];

    signal frontier[B_MAX + 1][depth];
    signal runningRoot[B_MAX + 1];
    for (var d = 0; d < depth; d++) frontier[0][d] <== oldFrontier[d];
    runningRoot[0] <== oldRoot;

    // Position bits for each slot. oldCount + B_MAX - 1 must fit in `depth`
    // bits — i.e. the tree must have room for the whole batch. Tree
    // overflow check belongs in the contract.
    component posBits[B_MAX];
    for (var i = 0; i < B_MAX; i++) {
        posBits[i] = Num2Bits(depth);
        posBits[i].in <== oldCount + i;
    }

    // active[i] = (i < count). LessThan(32) handles uint32 count.
    component lt[B_MAX];
    signal active[B_MAX];
    for (var i = 0; i < B_MAX; i++) {
        lt[i] = LessThan(32);
        lt[i].in[0] <== i;
        lt[i].in[1] <== count;
        active[i] <== lt[i].out;
    }

    component step[B_MAX];
    for (var i = 0; i < B_MAX; i++) {
        step[i] = InsertStep(depth);
        for (var d = 0; d < depth; d++) {
            step[i].frontierIn[d]  <== frontier[i][d];
            step[i].pathIndices[d] <== posBits[i].out[d];
        }
        step[i].leaf <== cms[i];
        // Conditional advance: ∀x: x[i+1] = active ? stepOut : x[i].
        for (var d = 0; d < depth; d++) {
            frontier[i + 1][d] <==
                frontier[i][d] + active[i] * (step[i].frontierOut[d] - frontier[i][d]);
        }
        runningRoot[i + 1] <==
            runningRoot[i] + active[i] * (step[i].root - runningRoot[i]);
    }

    // Outputs equal supplied newFrontier + newRoot (this is what the SNARK proves).
    for (var d = 0; d < depth; d++) {
        newFrontier[d] === frontier[B_MAX][d];
    }
    newRoot === runningRoot[B_MAX];
}

component main {
    public [oldRoot, newRoot, oldFrontier, newFrontier, oldCount, count, cms]
} = Checkpoint(20, 8);
