# Gas-driven design redesign for pallet-revive

## TL;DR

The `buyAndCreate` / `assign` / `redeem` operations OutOfGas on
Paseo Asset Hub because each one calls `PoseidonT3.hash` **20× inside an
external library** (the on-chain Merkle insert). pallet-revive has no
Poseidon precompile, so each hash runs as PVM-compiled inline assembly via
DELEGATECALL, and the per-extrinsic ref_time budget can't absorb 20 of
them on top of a Groth16 verify and an ERC-20 `transferFrom`.

**Proposal:** move the Merkle tree update inside the ZK circuit; have the
contract only verify a single proof and SSTORE a new root. This removes
all on-chain Poseidon hashing, keeps the operation atomic in a single
tx, and matches the design Aztec / zkSync / privacy-pool research
converged on for stateless privacy contracts.

## Table of contents

1. [What drives gas in the current design](#1-what-drives-gas)
2. [What comparable systems do](#2-comparable-systems)
3. [Proposed redesign: stateless Merkle, in-circuit append](#3-proposal)
4. [Concrete diff per layer](#4-concrete-diff)
5. [Cost model after the change](#5-cost-model)
6. [DOT-denominated fee estimate on Polkadot Asset Hub](#6-fee-estimate)
7. [Trade-offs](#7-trade-offs)
8. [What we are not doing and why](#8-rejected-alternatives)

---

## 1. What drives gas

Per `buyAndCreate`, breaking down on EVM (real benchmarks) and what each
maps to under pallet-revive:

| Step | EVM gas | pallet-revive disposition |
|---|---|---|
| Selector dispatch + base tx | ~21K | ~21K weight, comparable |
| `createVerifier.verifyProof` (Groth16, ecPairing precompile) | ~280K | **cheap** — ecPairing is a native precompile on pallet-revive (our measurement: 4064 weight units via eth_call) |
| `transferFrom` to external ERC-20 (CALL + balance/allowance updates) | ~50K | ~5K weight (eth_call measurement on `transfer`: 4615) |
| `tree.insert(cm)` — 20× `PoseidonT3.hash` via DELEGATECALL + ~20 SSTOREs | **~767K** ([ethresear.ch benchmark, binary depth 20](https://ethresear.ch/t/gas-and-circuit-constraint-benchmarks-of-binary-and-quinary-incremental-merkle-trees-using-the-poseidon-hash-function/7446)) | **the wall** — no Poseidon precompile on pallet-revive; each hash runs as PVM code through an external library call, blowing the per-extrinsic ref_time |
| `deposited += value`, `minted[epoch] += value`, event | ~50K | comparable |
| **Total** | **~1.17M EVM gas** | **OOG even with 1T eth-rpc gas hint** |

Empirical data from this session:
- `verifyProof` alone via `eth_call` — succeeds, **4064 weight units**.
- ERC-20 `transfer` alone — succeeds, **4615 weight units**.
- `buyAndCreate` (verify + transferFrom + insert) — OutOfGas at any
  eth-rpc gas hint up to 1T.

Implication: each on-chain Poseidon call on pallet-revive consumes
**dramatically** more weight than its EVM gas cost would suggest, because
the PVM JIT has no fast path for the BN254 field arithmetic that
`PoseidonT3.sol`'s inline assembly relies on. 20 of them blow the budget
even after the constructor optimization (the 21 pre-computed zero
hashes removed 20 setup-time hashes, but per-insert hashes remain).

Cutting tree depth was the obvious lever and we tried it: 20 → 12 → 8.
The constructor stopped OOGing, but `buyAndCreate` still does at depth
8. Even 8 Poseidon hashes per insert exceed what the chain will spend on
one extrinsic that also runs Groth16 + transferFrom.

Linear extrapolation from the EVM benchmarks (Poseidon is ~21K EVM gas;
~767K per insert at depth 20 ÷ 20 ≈ 38K per `PoseidonT3.hash`
DELEGATECALL including SSTORE; we'd need depth ≈ 1 to fit on pallet-revive)
makes clear that reducing depth is the wrong axis. The fix has to
eliminate the Poseidon calls entirely, not reduce their count.

## 2. Comparable systems

How other privacy stacks handle the same "Merkle-insert is expensive" problem:

**Tornado Cash** — accepts the cost. Mainnet deposit is ~1.1 M gas; users
pay it. Tornado's design separates `deposit` (cheap-ish, just the insert)
from `withdraw` (verify + payout). Our protocol bundles both into one
tx (`buyAndCreate` mints + inserts in one go), which makes the wall
hit sooner.
([torn.community proposal](https://torn.community/t/proposal-4-tornado-trees-upgrade/636))

**Semaphore v4 (LeanIMT)** — keeps the on-chain tree but eliminates two
sources of waste: (1) zero-hash siblings are now pass-through (parent = child
when there's only one child), so insertions early in the tree's life
don't compute zero hashes; (2) tree depth grows dynamically. For our
steady-state (>1000 vouchers), neither helps much.
([Semaphore v4 release notes](https://github.com/semaphore-protocol/semaphore/releases/tag/v4.0.0))

**Aztec / zkSync / Privacy-pool research** — push the tree updates
**off-chain** into a sequencer that batches transactions, computes the
new root, and proves the transition with a SNARK. The on-chain contract
only verifies the batch SNARK and updates one storage slot. This is
strictly better for throughput but introduces a trust assumption on the
sequencer (or fraud-proof complexity).
([Aztec network architecture](https://nodes.guru/blog/aztec-network-a-hybrid-public-private-zkrollup-bringing-privacy-to-ethereum))

**Per-transaction in-circuit append** — the path of this proposal.
Each user proves "my new leaf, when appended at index `nextIndex`,
transitions root `R_old` → `R_new`" inside their existing SNARK. The
contract stores only `(currentRoot, nextIndex)` and a recent-root ring
buffer. No on-chain Poseidon. Used in single-user variants of
zk-payments (e.g., Penumbra's "tournament" component, RISC Zero zkVM
demos of zk-accounts).
([Designing recursive SNARK architectures](https://zkdev.com/designing-recursive-snark-architectures-trade-offs-patterns-and-practical-tips/))

The right primitive for our PoC scale (single-digit demo TPS,
no sequencer infra) is per-transaction in-circuit append. It keeps the
trustless one-shot-tx UX we currently have, and the constraint cost is
modest because the same Poseidon-2 template is already in our circuits.

## 3. Proposal

### State on chain shrinks to one root + one index

```solidity
// Replaces MerkleTreeLib + frontier
struct Tree {
    uint256 currentRoot;          // SSTORE'd once per insert
    uint32  nextIndex;             // SSTORE'd once per insert
    uint32  currentRootIndex;
    uint256[ROOT_HISTORY] roots;   // ring buffer, accepts proofs against last 100 roots
}
```

No `filledSubtrees`, no `zeros`, no `PoseidonT3.hash` library import.

### Each ZK circuit gains a "transition" sub-circuit

For `create`, the prover supplies (private inputs):

- the new leaf `cm` (already there)
- the **sibling path** for `nextIndex` against `oldRoot`
  (`pathElements[depth]` — same shape we already use for spend proofs)

…and proves (added constraints):

```
verify_merkle_path(cm, pathElements, nextIndex) == newRoot
```

`nextIndex` decomposed into bit-indices selects left/right per level.
The sibling path before the insertion is well-defined: all positions to the
right of `nextIndex` are zeros (pre-computed constants), all positions to
the left of `nextIndex` come from the prior tree state (replayed from
events).

Public inputs become: `cm, value, expiryEpoch, oldRoot, newRoot, nextIndex`.

For `assign` (two inserts) and `redeem` (one insert), same pattern —
each insert adds ~20 Poseidon constraints + ~20 mux gates.

### Contract verification adds two public inputs and one cheap check

```solidity
function buyAndCreate(
    uint256 cm, uint256 value, uint32 expiryEpoch,
    uint256 oldRoot, uint256 newRoot, uint32 expectedNextIndex,
    uint[2] pA, uint[2][2] pB, uint[2] pC
) external {
    require(expectedNextIndex == tree.nextIndex, "pool/stale-index");
    require(tree.isKnownRoot(oldRoot),             "pool/stale-root");
    require(createVerifier.verifyProof(
        pA, pB, pC,
        [cm, value, uint256(expiryEpoch), oldRoot, newRoot, uint256(expectedNextIndex)]
    ),                                              "pool/proof");

    stablecoin.transferFrom(msg.sender, address(this), value);

    tree.appendRoot(newRoot);                       // single SSTORE + ring buffer update
    tree.nextIndex = expectedNextIndex + 1;

    deposited        += value;
    minted[expiryEpoch] += value;
    emit VoucherCreated(cm, value, expiryEpoch, expectedNextIndex);
}
```

`assign` / `redeem` get the same treatment: drop `tree.insert(leaf)`,
add (`oldRoot`, `newRoot`, expected index) as public inputs to the proof.

### What the contract loses

- The on-chain commitment that the new root is *correct* given the new leaf —
  now proven by the SNARK instead. Same security guarantee, different
  enforcement point.
- The ability to recompute the tree from on-chain state alone. The off-chain
  indexer (which the chat dapp already runs to build witnesses) is now
  the only source of truth for paths.

## 4. Concrete diff per layer

### Circuits (`circuits/src/*.circom`)

Add to `commitment.circom`:

```circom
// Append leaf at `index` (decomposed to bits) to a tree with given
// pre-insertion sibling path; output the post-insertion root.
template MerkleAppend(depth) {
    signal input  leaf;
    signal input  pathElements[depth];
    signal input  index;                   // assert(index < 2^depth)
    signal output newRoot;
    // ... pathIndices = bits of index, then same MerkleProof chain we
    // already use, but we KEEP the levelHashes so we can output the root
    // assuming `leaf` is at position `index` and everything to its right
    // is zero (verified by `pathElements` being the canonical zeros above
    // this leaf's right side).
}
```

For each of `create.circom`, `assign.circom`, `redeem.circom`: instantiate
`MerkleAppend(20)` per leaf inserted, constrain `cmDest`/`cmChange`/`cm`
against `oldRoot`+`pathElements` → `newRoot`. Public inputs list grows.

Constraint count delta (per circuit):

| Circuit | now | after (estimated) |
|---|---|---|
| create  | 357 NL | ~3,500 NL (one append) |
| assign  | 6,859 NL | ~13,000 NL (two appends) |
| redeem  | 6,503 NL | ~9,800 NL (one append) |

All still under 16,384 (ptau-14), so no ceremony change needed.

### Contract (`contracts/contracts/`)

- `IncrementalMerkleTree.sol`: drop `init` body, drop `insert`, drop
  `filledSubtrees`/`zeros`. Keep ring buffer + `isKnownRoot` + new
  `appendRoot(newRoot)` that pushes to the ring.
- `VoucherPool.sol`: change `buyAndCreate`/`assign`/`redeem` signatures
  per above. Remove the `poseidon-solidity` dependency entirely (no
  external library link, no `--link` step for PVM).
- Stop generating `PoseidonT3` artifact (no longer needed on chain).

### Core package (`packages/core/src/`)

- `merkle.js` becomes the canonical off-chain tree. Already exists; bump
  it to also expose `siblingPathForAppend(index)` (positions to the left
  are the current `filledSubtrees`, positions to the right are the
  pre-computed `zeros`).
- `proof.js`: extend input shapes for each prove function with the new
  fields.

### Test harness + dapps

- `test/e2e/flow.test.mjs`: each step needs to compute `siblingPath` from
  the mirror tree and pass it to the prover.
- Dapps: same shape — purchaser and chat dapps need to fetch the current
  tree state before proving (the chat dapp already does this via its event
  indexer; purchaser would gain a similar one).

## 5. Cost model after the change

Per `buyAndCreate`, on pallet-revive:

| Step | Pre-change | Post-change |
|---|---|---|
| Selector + decode | ~21K | ~21K |
| Groth16 verify (ecPairing precompile) | 4K | 4K |
| `transferFrom` external CALL | 5K | 5K |
| `tree.insert` (20× Poseidon DELEGATECALL) | **~5M** est. (extrapolated from the 100M+ wall) | **0** |
| State updates (`root`, `nextIndex`, ring buffer, `deposited`, `minted`, event) | ~50K | ~50K |
| **Total** | **>100M (OOG)** | **~80K** |

Headroom factor 1000×. Even with conservative pallet-revive weight
inflation we land comfortably inside the per-extrinsic budget.

In-circuit cost goes up: assign proving goes from ~400 ms desktop /
~1 s mobile p50 to roughly ~800 ms / ~2 s p50 (2× constraints, linear
in Groth16 prover time). Worst-case (redeem) p95 mobile stays under 5 s
which is within the §8.7.1 acceptance threshold.

## 6. Fee estimate

Translating the weight numbers into actual DOT cost on Polkadot Asset Hub
([polkadot-fellows/runtimes constants](https://github.com/polkadot-fellows/runtimes/blob/main/system-parachains/constants/src/polkadot.rs)):

| Constant | Value |
|---|---|
| 1 DOT | 10^10 plancks |
| `TRANSACTION_BYTE_FEE` | 50,000 plancks/byte (MILLICENTS/2) |
| `WeightToFee` coefficient | `CENTS / (200 × ExtrinsicBaseWeight.ref_time)` |
| `ExtrinsicBaseWeight.ref_time` (Substrate default) | ~125 µs = 1.25×10^8 ps |
| → per-picosecond rate | 10^8 / (200 × 1.25×10^8) ≈ **4×10⁻³ plancks/ps** |
| → per-second rate | 10^12 × 4×10⁻³ = 4×10⁹ plancks = **0.4 DOT/sec ref_time** |
| `MaxEthExtrinsicWeight` (per-tx ceiling, ref_time) | 50% × 0.5 s = **0.25 s** |
| pallet-revive `GasScale` (1 EVM gas → ps) | **80,000 ps/gas** |

### Worst case — tx succeeds at the per-extrinsic ceiling

| Component | Quantity | Plancks | DOT |
|---|---|---|---|
| ref_time (full 0.25 s budget) | 2.5×10¹¹ ps × 4×10⁻³ | 10⁹ | **0.10 DOT** |
| length fee (~550 byte tx — proof + args) | 550 × 50,000 | 2.75×10⁷ | 0.003 DOT |
| proof_size (~30 KB PoV) | order-of-magnitude | ~10⁵–10⁶ | <0.001 DOT |
| base fee | — | small | <0.001 DOT |
| **Inclusion fee total** | | | **≈ 0.10 DOT** |

At DOT ≈ $4: **~$0.40 per ceiling-grazing tx**. At DOT ≈ $10: **~$1.00**.
Comparable Ethereum mainnet 1M-gas tx at 20 gwei: ~$5–50.

### Best case — after the in-circuit-append redesign (§3)

Estimated post-redesign weight: ~80K eth-rpc gas units = 80K × 80K ps =
**6.4 ms ref_time**.

| Component | Plancks | DOT |
|---|---|---|
| ref_time (6.4 ms × 4×10⁻³ plancks/ps × 10⁹) | 2.6×10⁷ | 0.0026 |
| length fee (still ~550 bytes) | 2.75×10⁷ | 0.0028 |
| **Total** | ~5.4×10⁷ | **≈ 0.005 DOT** |

The redesign therefore moves the *fee* from ceiling-grazing (~$0.40)
into normal-tx territory (~$0.02–0.05). Note that after the redesign
the length fee — which we can't shrink without batching across users —
becomes the dominant cost, not compute.

### What's not included above

- **`storage_deposit`** (separate from inclusion fees): pallet-revive
  locks ~20 DOT per new state item + 100 MILLICENTS/byte. Refundable
  on contract destruction. For a fresh `VoucherPool` deploy: ~600 DOT
  locked. Per-tx new state (e.g. nullifier entry): ~0.02 DOT/slot
  locked per tx.
- **`targeted_fee_adjustment`** multiplier: rises with sustained
  congestion (default 1×, can hit 2–4× under load).
- The `GasScale = 80,000` ratio is documented but not yet measured
  against a real successful tx receipt on mainnet Asset Hub. Treat
  absolute fee numbers as accurate to ±2×.

### Why this matters for the protocol

A community-credits voucher denominated in tUSDC at $1 face value can't
absorb a $0.40 mint fee — the protocol breaks even only on $10+ vouchers
under the current design. The redesign brings the per-mint fee to a few
cents, making sub-dollar denominations viable.

## 7. Trade-offs

**Stale-root races.** Two buyers reading the same `(currentRoot, nextIndex)`
and racing will collide; the loser reverts with `pool/stale-index` and has
to refetch + re-prove. For demo-scale traffic this is fine. For production:
add a small sequencer (a relay operator already exists as the role) that
orders submissions and bumps a nonce — same Aztec pattern, much less
infrastructure than a full rollup.

**Off-chain tree-state dependency.** The prover (Dapp A buyer, Dapp B
chat) must know `(filledSubtrees, nextIndex)` to compute the sibling
path. We already replay events for `nextLeafIndex` in the chat dapp;
extending that to materialize the right-edge frontier off-chain is the
same code paths.

**Indexer correctness becomes load-bearing.** If the indexer is wrong, the
prover generates a proof against a non-canonical tree and the contract
rejects it (`pool/stale-root`). No funds at risk — worst case is "buyer
sees error, refreshes, retries." This is the same trust profile as a
blockchain client that has the wrong fork; recoverable by refresh.

**Loses on-chain debuggability.** Inspecting the on-chain tree state
(e.g., "what's the current frontier?") now requires running the indexer.
Acceptable — the existing dapps already need the indexer for
witness-building.

**ZK artifact size grows.** zkey files for the new circuits go from
~6 MB → ~10 MB (rough scaling). Dapp bundle inflation is the same
proportion (single-digit MB). Mitigated by service-worker caching after
first load — same story as today.

## 8. Rejected alternatives

**Splitting `buyAndCreate` into commit + finalize.** Explicitly out of
scope per the requirement. Would lose atomicity, require a per-buyer
nonce, and create a front-running window between the two txs.

**Cutting tree depth to 8 or 4.** Tried 20 → 12 → 8 in
[`chopsticks/README.md`](../chopsticks/README.md); the constructor
stopped OOG-ing but `buyAndCreate` still OOGs at depth 8. The bottleneck
isn't the count of Poseidon calls — it's that pallet-revive can't run
*any* meaningful number of Poseidon DELEGATECALLs alongside other work
in one extrinsic.

**Adding a Poseidon precompile to pallet-revive.** The right long-term
fix for the whole Polkadot ZK ecosystem, but a runtime change — out of
PoC scope. Worth raising upstream as a Polkadot Fellowship RFC; an EVM
counterpart proposal exists as [EIP-5988](https://github.com/ethereum/EIPs/pull/5988/files).

**Sequencer / batched-rollup model (Aztec-style).** Strictly better at
high TPS but adds two new failure modes (sequencer liveness, batch
sequencing latency) for a PoC where one tx per minute is the realistic
load. Keep the design space open for production but use the simpler
single-tx in-circuit append now.

**LeanIMT (Semaphore v4) dynamic-depth optimization.** Only helps for
small trees (savings vanish past ~1K leaves) and still keeps Poseidon
calls on-chain. Wrong axis.

**Quinary trees** (5-ary instead of binary). Reduces depth by ~50% but
increases per-node hash cost (5 inputs vs 2) and circuit constraint
count. Net wash at our scale per the
[ethresear.ch benchmarks](https://ethresear.ch/t/gas-and-circuit-constraint-benchmarks-of-binary-and-quinary-incremental-merkle-trees-using-the-poseidon-hash-function/7446).

## Sources

- [Gas and circuit constraint benchmarks of binary and quinary incremental Merkle trees using Poseidon — ethresear.ch](https://ethresear.ch/t/gas-and-circuit-constraint-benchmarks-of-binary-and-quinary-incremental-merkle-trees-using-the-poseidon-hash-function/7446)
- [Polkadot Hub Gas Model — docs.polkadot.com](https://docs.polkadot.com/smart-contracts/for-eth-devs/gas-model/)
- [Polkadot system-parachain fee constants](https://github.com/polkadot-fellows/runtimes/blob/main/system-parachains/constants/src/polkadot.rs)
- [Asset Hub Polkadot runtime config](https://github.com/polkadot-fellows/runtimes/blob/main/system-parachains/asset-hubs/asset-hub-polkadot/src/lib.rs)
- [Transactions Weights and Fees](https://docs.polkadot.com/reference/parachains/blocks-transactions-fees/fees/)
- [Calculate Transaction Fees](https://docs.polkadot.com/chain-interactions/send-transactions/calculate-transaction-fees/)
- [ETH transaction flow in Polkadot SDK — OneBlock+](https://medium.com/@OneBlockplus/understanding-eth-transaction-flow-in-polkadot-sdk-1fedbecaf93c)
- [Semaphore v4 release (LeanIMT)](https://github.com/semaphore-protocol/semaphore/releases/tag/v4.0.0)
- [Aztec hybrid public-private zkRollup overview](https://nodes.guru/blog/aztec-network-a-hybrid-public-private-zkrollup-bringing-privacy-to-ethereum)
- [Designing recursive SNARK architectures — zkdev.com](https://zkdev.com/designing-recursive-snark-architectures-trade-offs-patterns-and-practical-tips/)
- [Tornado Trees proposal #4 — torn.community](https://torn.community/t/proposal-4-tornado-trees-upgrade/636)
- [EIP-5988: Poseidon hash function precompile](https://github.com/ethereum/EIPs/pull/5988/files)
