# Gas-driven design redesign for pallet-revive

## TL;DR

The `buyAndCreate` / `assign` / `redeem` operations OutOfGas on
Paseo Asset Hub because each one calls `PoseidonT3.hash` **20× inside an
external library** (the on-chain Merkle insert). pallet-revive has no
Poseidon precompile, so each hash runs as PVM-compiled inline assembly via
DELEGATECALL, and the per-extrinsic ref_time budget can't absorb 20 of
them on top of a Groth16 verify and an ERC-20 `transferFrom`.

We considered moving the Merkle tree update inside the ZK circuit
(buyer proves the `oldRoot → newRoot` transition; contract just SSTOREs
the new root). That fixes the gas wall but **dead-ends on concurrency**:
every prover's proof binds to the specific `(oldRoot, nextIndex)` they
saw, so any concurrent submission serializes the protocol to ~1 tx per
block — see [§3a](#3a-rejected-per-tx-in-circuit-append) for the analysis.

**Adopted design:** stream + checkpoint (mini-rollup). The user tx is a
*cheap stream append*: one Poseidon hash to update a chain accumulator,
verify the Groth16 proof, `transferFrom`. Concurrency-safe (each tx just
appends; no coordination). A separate `checkpoint(...)` callable
periodically batches the streamed commitments into a Merkle tree update
proven by one batched SNARK. Spends prove membership against the
checkpointed root, so notes become spendable one checkpoint after
creation. See [§3b](#3b-stream--checkpoint-the-adopted-design).

## Table of contents

1. [What drives gas in the current design](#1-what-drives-gas)
2. [What comparable systems do](#2-comparable-systems)
3a. [Rejected: per-tx in-circuit append (concurrency dead-end)](#3a-rejected-per-tx-in-circuit-append)
3b. [Adopted: stream + checkpoint](#3b-stream--checkpoint-the-adopted-design)
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

## 3a. Rejected: per-tx in-circuit append

First instinct was to move the Merkle update inside the SNARK: each user
proves `oldRoot → newRoot` for their own leaf, contract just SSTOREs the
new root. Gas-cheap because no on-chain Poseidon, atomicity preserved,
matches the Aztec / zkSync pattern.

**It dead-ends on concurrency.** The proof binds the specific `oldRoot`
it was generated against. Two buyers reading the same `(currentRoot,
nextIndex)` and proving in parallel both compute `newRoot_A` and
`newRoot_B` against the same `oldRoot`; whichever lands first sets
`currentRoot = newRoot_A`, and the other's proof is instantly invalid
(`pool/stale-root`). The loser must refetch state + re-prove (~1 s) +
resubmit (one block, ~12 s on Asset Hub). At any meaningful concurrency
the protocol serializes to **1 tx per block** because every proof in
flight assumes the chain hasn't moved.

This isn't fixable by widening the recent-roots ring buffer: even if the
contract accepts the user's `oldRoot`, applying their `newRoot` at the
contract's actual `nextIndex` would mean writing two leaves at the same
position. The tree only has one leaf per index.

Other systems handle this with:
- a **sequencer** that hands each prover an assigned slot before they
  prove (Aztec / zkSync model — needs always-on infra and a round-trip);
- **recursive proof aggregation** (Nova / Halo2 IVC) — needs a
  recursion-friendly proving system, Groth16 doesn't fold naturally;
- **indexed Merkle trees** (Aztec nullifier-tree pattern) — race
  probability is *almost* zero for random leaves, but still nonzero;
- **stream + checkpoint** (adopted below) — decouple "commit a leaf"
  from "update the tree", so user txs are concurrency-safe and the
  bottleneck moves to the batched checkpoint actor.

For our trust model (a relay actor already exists and is allowed to
sequence chat-side ops) any of the above is feasible. Stream + checkpoint
is the simplest to implement and demands no recursion-friendly proving
system.

## 3b. Stream + checkpoint, the adopted design

### Two layers of on-chain state

```
Stream side (every user tx writes here)         Checkpoint side (batched)
─────────────────────────────────────             ────────────────────────────
streamHash   : Poseidon hash chain                 checkpointedRoot     : Merkle root
streamCount  : # of leaves streamed                checkpointedCount    : # of leaves included
                                                   knownRoots[100]      : ring buffer of recent roots
```

`streamHash` is the running hash of all commitments ever produced:
```
streamHash_0 = 0
streamHash_{i+1} = Poseidon(streamHash_i, cm_i)
```
Updated once per leaf added — **one** on-chain Poseidon hash per leaf,
not 20. The cost per user tx is bounded by what we measured fits
comfortably (each Poseidon is ~5 M weight units; one of them + the
Groth16 verify + transferFrom = ~5–10 M total, well under the
~100 M cap).

`checkpointedRoot` is the Merkle root of all checkpointed leaves
(positions `0..checkpointedCount-1`). Spends prove membership against
this root, not the absolute latest stream state. After a buy/assign/
redeem, the new commitment is in the stream but not yet in the tree;
the next `checkpoint(...)` call rolls forward.

### Per-tx cost on pallet-revive (estimated)

| Op | Poseidons on chain | Estimated weight | Notes |
|---|---|---|---|
| `buyAndCreate` | 1 (streamHash for cm) | ~5 M | fits |
| `assign` | 2 (cmDest, cmChange) | ~10 M | fits |
| `redeem` | 1 (cmChange) | ~5 M | fits |
| `checkpoint` (batch B=4) | 0 (SNARK verifies off-chain hashing) | ~1 M | very cheap |

Cap (per-extrinsic weight on Asset Hub) ≈ 100 M units → all comfortably
under.

### Checkpoint proof

The checkpoint SNARK proves an atomic transition:
```
public:  oldRoot, newRoot, oldCount, newCount,
         oldStreamHash, newStreamHash
private: commitments[B], sibling paths for each insert (off-chain witness)

constraints:
  1. Hash chain: starting from oldStreamHash, applying B commitments
     via Poseidon gives newStreamHash.
  2. Tree update: starting from oldRoot, appending B commitments at
     positions oldCount..oldCount+B-1 produces newRoot.
  3. newCount == oldCount + B.
```

The on-chain `streamHash` anchors the batch — the checkpointer can't
sneak in fake commitments because the public input `newStreamHash` must
equal the contract's stored `streamHash` at index `newCount`.

Constraint count: 2 Merkle-proof checks per insert (verify path matches
`old_root_i` for empty slot + verify it produces `new_root_i` for the
leaf) + 1 Poseidon for the hash chain step. At B=4, depth 20:
- Per insert: 2 × 20 Poseidon-2 + 1 Poseidon-2 ≈ 41 × 213 ≈ 8.7 K
- B=4 inserts: ~35 K constraints
- Plus boilerplate, glue: ~38 K total

That exceeds ptau-15 (covers ~16 K) and ptau-16 (~32 K). Needs **ptau-17**
(covers ~65 K). PoC uses ptau-17 (already in the build script after this
change).

### Spendability latency

A note is spendable from one checkpoint after its creation. With the
relay running an eager checkpointer (triggers when batch fills OR a
configurable timer expires), bound this to a few seconds in practice.

### Who runs the checkpointer

Anyone can — `checkpoint(...)` is permissionless. The relay operator
naturally does it because they want low spend latency for chat-side ops
they relay. If no one checkpoints, no spends can happen; existing notes
remain valid, no funds at risk.

## 4. Concrete diff per layer

### Contracts (`contracts/contracts/`)

- `IncrementalMerkleTree.sol` → renamed `StreamAndRootRing.sol`. Drop
  the frontier/zeros/filledSubtrees. Keep the recent-roots ring buffer
  but advance it only on `checkpoint(...)`. Add `streamHash`,
  `streamCount`.
- `VoucherPool.sol`:
  - `buyAndCreate` / `assign` / `redeem` no longer call `tree.insert`.
    Each calls a new internal `_appendStream(cm)` that updates
    `streamHash = Poseidon(streamHash, cm)` and bumps `streamCount`.
  - Spend proofs (assign / redeem) bind to `oldRoot ∈ knownRoots` —
    i.e. a *checkpointed* root, not the latest stream state.
  - New `checkpoint(...)` function (signature in §3b). Permissionless.
- The `PoseidonT3` library import stays (we now use it for the
  streamHash update). It's only **one** hash per leaf — the cost that
  matters.

### Circuits (`circuits/src/*.circom`)

- `create.circom`, `assign.circom`, `redeem.circom`: **mostly unchanged**.
  Spend proofs (assign, redeem) still prove membership against `root`
  exactly as today — only now `root` is interpreted as a checkpointed
  root rather than the latest tree state.
- New `checkpoint.circom`:
  - Public inputs: `oldRoot, newRoot, oldStreamHash, newStreamHash,
    oldCount, newCount`.
  - Private inputs: `cm[B]`, `appendPath[B][depth]` (one canonical
    sibling path per appended leaf).
  - Constraints: (i) hash chain `Poseidon^B(oldStreamHash, cm[i]) ==
    newStreamHash`; (ii) for each `i ∈ [0..B)`, verify
    `MerkleProof(0, appendPath[i], bits(oldCount+i)) == root_i` AND
    `MerkleProof(cm[i], appendPath[i], bits(oldCount+i)) == root_{i+1}`,
    chaining `root_0 = oldRoot`, `root_B = newRoot`.

Constraint counts at B=4, depth 20:
- ~8.7 K per insert × 4 = ~35 K
- Hash chain: 4 × ~213 = ~850
- Glue / Num2Bits: ~1 K
- **Total: ~37 K** → needs `powersOfTau28_hez_final_17.ptau`.

### Core package (`packages/core/src/`)

- `merkle.js`: add `appendPath(leafIndex)` — returns the canonical
  sibling path for inserting at `leafIndex` (filledSubtrees on the left,
  pre-computed zeros on the right). Already had `proof(leafIndex)` for
  spends — keep that.
- New `streamHash.js`: tracks the chain accumulator off-chain,
  mirroring on-chain state.
- New `checkpoint-witness.js`: given the off-chain tree + a target
  batch of streamed commitments, produces the private inputs for the
  checkpoint circuit.
- `proof.js`: add `proveCheckpoint(input)`.

### Test harness + dapps

- `test/e2e/flow.test.mjs`: between each user tx and the next
  membership-requiring tx, call `pool.checkpoint(...)` with a freshly
  computed batch proof.
- Dapps: purchaser unchanged (still just submits buyAndCreate). Chat
  reads `checkpointedCount` and waits if its target note hasn't been
  checkpointed yet. Relay gains a checkpointer mode (eagerly batches +
  submits).

## 5. Cost model after the change

Per user tx on pallet-revive (estimated weight units, where the
empirically-measured per-extrinsic ceiling is ~100 M):

| Step | `buyAndCreate` | `assign` | `redeem` |
|---|---|---|---|
| Selector + decode | ~21 K | ~21 K | ~21 K |
| Groth16 verify (ecPairing precompile) | ~4 K | ~4 K | ~4 K |
| `transferFrom` external CALL | ~5 K | — | — |
| `streamHash` Poseidon updates | 1 × ~5 M | 2 × ~5 M = 10 M | 1 × ~5 M |
| State updates (`streamHash`, `streamCount`, nullifier, credit, …) | ~50 K | ~80 K | ~80 K |
| **Total per user tx** | **~5 M** | **~10 M** | **~5 M** |
| Headroom vs 100 M ceiling | 20× | 10× | 20× |

Per `checkpoint(...)` (paid by checkpointer, batch size B=4):

| Step | Weight |
|---|---|
| Groth16 verify (ecPairing) | ~4 K |
| State updates (root, count, ring buffer) | ~80 K |
| **Total** | **~85 K** |

Amortized per user tx (B=4): ~85 K / 4 ≈ ~21 K of "checkpointer's tx"
extra on top of the user's own ~5–10 M. The checkpointer's *gas* is
negligible; their cost is **proving** the batch (off-chain).

Proving time:
- Per user tx (assign): unchanged from today, ~400 ms desktop / ~1 s
  mobile p50.
- Checkpoint (batch B=4, ~37 K constraints): ~3 s desktop on a one-shot
  basis. Runs in the relay's background loop, not on the user's critical
  path.

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

### Best case — after the stream+checkpoint redesign (§3b)

Per user tx (5–10 M weight units):

| Component | Quantity | Plancks | DOT |
|---|---|---|---|
| ref_time (5 M × 80 K ps/gas × 4×10⁻³ plancks/ps) | 4×10¹¹ ps | 1.6×10⁹ | 0.16 DOT |

Wait — that's wrong because `eth-rpc` gas units ≠ ps directly. The
GasScale=80,000 ps/gas conversion only applies to EVM-style gas in the
eth-rpc layer. The "5 M weight units" we measured are the *eth-rpc gas*
the user is billed, which already includes the conversion.

Re-do honestly: the 5 M weight unit measurement *is* eth-rpc gas. To
convert to plancks the bridge applies its own fee multiplier (not
documented; ~1 planck per gas-unit in current builds, may vary).
Estimate:

| Component | Plancks | DOT |
|---|---|---|
| Per user tx — 5–10 M eth-rpc gas units | ~5–10 × 10⁶ | ~0.0005–0.001 DOT |
| Length fee (~550 byte tx) | 2.75×10⁷ | 0.003 DOT |
| **Per user tx total** | | **≈ 0.003–0.005 DOT** |
| | | (~$0.012–$0.05 at $4–10/DOT) |

Per `checkpoint` (amortized over B=4 user txs):

| Component | Plancks | DOT |
|---|---|---|
| ref_time (~85 K gas units) | ~10⁵ | <0.001 DOT |
| Length fee (~800 bytes — proof + public inputs) | 4×10⁷ | 0.004 DOT |
| **Per checkpoint** | | **≈ 0.005 DOT** |
| Amortized per user tx (B=4) | | **≈ 0.001 DOT** |

**Combined per voucher operation** (user tx + amortized checkpoint
share): **≈ 0.004–0.006 DOT ≈ $0.02–$0.06**. About 20× cheaper than the
current OOG-or-bust ceiling-grazing design — and the protocol actually
works.

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

**Spend latency = checkpoint interval.** A note minted at time `t` can
only be assigned/redeemed once `checkpoint(...)` includes its position
in the tree. With an eager checkpointer (trigger on batch-full OR
configurable timer), bound to a few seconds. Worst case: no
checkpointer is running → no spends are possible (existing notes are
unaffected; just queued). The relay operator naturally has incentive
to checkpoint because they want low spend latency for the chat-side
ops they relay.

**Checkpointer liveness is a soft dependency.** If no one ever
checkpoints, mints still work (they just append to the stream) but
spends stall. Funds aren't at risk — the on-chain
`(streamHash, streamCount)` exactly anchors the truth and any future
checkpointer can roll forward. We don't run on a checkpoint-or-nothing
model; the stream is permissionlessly observable.

**Indexer correctness becomes load-bearing for the checkpointer.** The
checkpointer needs the full sequence of commitments from events (or
from re-deriving them from `(streamHash_old, streamHash_new)` — but
that's hash inversion, not feasible). Practically: the checkpointer
indexer reads `VoucherCreated`/`Assigned`/`Redeemed` events. If the
indexer is wrong, the checkpoint proof fails — no funds at risk,
checkpointer just gets a revert and retries with corrected data.

**No on-chain tree state for debug.** Inspecting "is leaf N at
position N in the tree" now requires running the indexer. Acceptable
— the dapps already need the indexer to build witnesses.

**ZK artifact size grows for the checkpointer.** The new checkpoint
zkey is ~12 MB (~37 K constraints). Only the checkpointer (relay)
needs to host + use it; end-user dapps are unchanged.

**Reorg sensitivity.** A re-org that drops a `VoucherCreated` event
also rolls back the matching `streamHash` update, so a partially-built
checkpoint becomes invalid. Standard solution: checkpointer waits for
finality (~6 blocks on Asset Hub) before including events in its
batch. Adds latency proportional to finality lag.

## 8. Rejected alternatives

**Splitting `buyAndCreate` into commit + finalize.** Explicitly out of
scope per the requirement. Would lose atomicity, require a per-buyer
nonce, and create a front-running window between the two txs.

**Per-tx in-circuit append.** Detailed analysis in §3a above. Each
user's proof binds to a specific `oldRoot`, so concurrent submissions
serialize to ~1 tx per block. Fine for demos, dead for any real load.
The stream+checkpoint design escapes this by decoupling "commit a leaf"
from "update the tree" so user txs no longer compete for tree state.

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
high TPS than stream+checkpoint, but requires the sequencer to be on
the critical path of every user submission (round-trip before proving).
The stream+checkpoint model lets users submit freely and only requires
a checkpointer for spend-latency, which is a softer dependency.

**Indexed Merkle Tree (Aztec nullifier-tree style).** Insertion's
"neighbor" depends on the existing leaf values; concurrent inserts on
random commitments collide very rarely. Pure in-circuit change, no
new infra. Rejected because (a) collision is non-zero — bad for any
sustained load — and (b) the sorted-tree on-chain logic adds complexity
that stream+checkpoint avoids.

**Recursive proof aggregation (Nova / Halo2 / IVC).** Each user proves
their own thing; an aggregator folds N proofs into one. Conceptually
clean and concurrency-safe, but requires a recursion-friendly proving
system. Groth16 doesn't fold naturally. Out of scope for this Circom
codebase.

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
