# Gas-driven design redesign for pallet-revive

## TL;DR

The original `buyAndCreate` / `assign` / `redeem` operations OutOfGas on
Paseo Asset Hub because each one calls `PoseidonT3.hash` **20× inside an
external library** (the on-chain Merkle insert). pallet-revive has no
Poseidon precompile, so each hash runs as PVM-compiled inline assembly via
DELEGATECALL, and the per-extrinsic ref_time budget can't absorb 20 of
them on top of a Groth16 verify and an ERC-20 `transferFrom`.

Direct measurement (see §1) confirmed something stronger: **a single
`PoseidonT3.hash` call alone OOGs** on pallet-revive. The
poseidon-solidity implementation is fundamentally unusable on-chain there.
So **any design that calls Poseidon on chain — even once per tx — is dead
on arrival.**

We considered moving the Merkle tree update inside the ZK circuit
(buyer proves the `oldRoot → newRoot` transition; contract just SSTOREs
the new root). That fixes the gas wall but **dead-ends on concurrency**:
every prover's proof binds to the specific `(oldRoot, nextIndex)` they
saw, so any concurrent submission serializes the protocol to ~1 tx per
block — see [§3a](#3a-rejected-per-tx-in-circuit-append) for the analysis.

**Adopted design:** stream + checkpoint (mini-rollup), **with no on-chain
hashing at all**. The user tx (`buyAndCreate` / `assign` / `redeem`)
appends each emitted commitment to a `mapping(uint32 => uint256)
commitments` via plain SSTORE — concurrency-safe, no coordination, no
Poseidon. A permissionless `checkpoint(...)` reads commitments back via
SLOAD and rolls them into the off-chain Merkle tree, anchored by a SNARK.
Spends prove membership against the latest checkpointed root, so notes
become spendable one checkpoint after creation. See
[§3b](#3b-stream--checkpoint-the-adopted-design). Implementation passes
13/13 e2e steps end-to-end on a chopsticks-forked Paseo Asset Hub.

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

Per `buyAndCreate` (original design), breaking down on EVM (real benchmarks)
and what each maps to under pallet-revive:

| Step | EVM gas | pallet-revive disposition |
|---|---|---|
| Selector dispatch + base tx | ~21K | ~21K weight, comparable |
| `createVerifier.verifyProof` (Groth16, ecPairing precompile) | ~280K | **cheap** — ecPairing is a native precompile on pallet-revive (measurement: 4064 weight units via eth_call) |
| `transferFrom` to external ERC-20 (CALL + balance/allowance updates) | ~50K | ~5K weight (eth_call measurement on `transfer`: 4615) |
| `tree.insert(cm)` — 20× `PoseidonT3.hash` via DELEGATECALL + ~20 SSTOREs | **~767K** ([ethresear.ch benchmark, binary depth 20](https://ethresear.ch/t/gas-and-circuit-constraint-benchmarks-of-binary-and-quinary-incremental-merkle-trees-using-the-poseidon-hash-function/7446)) | **the wall** — no Poseidon precompile on pallet-revive; each hash runs as PVM code through an external library call, blowing the per-extrinsic ref_time |
| `deposited += value`, `minted[epoch] += value`, event | ~50K | comparable |
| **Total** | **~1.17M EVM gas** | **OOG even with 1T eth-rpc gas hint** |

Empirical data from chopsticks-forked Paseo Asset Hub:

| Call | Result | weight units |
|---|---|---|
| `createVerifier.verifyProof` (eth_call) | succeeds, returns TRUE | 4064 |
| `tUSDC.transfer` (eth_call) | succeeds | 4615 |
| `pool.registerOperator` (eth_call) | succeeds | 4426 |
| **`PoseidonT3.hash([1, 2])` (eth_call, called directly on the deployed library)** | **OutOfGas** | **>10^12** |
| `pool.buyAndCreate` (original 20-hash insert) | OutOfGas | — |
| `pool.buyAndCreate` (with 1-Poseidon hash chain) | OutOfGas | — |

The bottom three lines are the kicker. **Even a single `PoseidonT3.hash`
call on pallet-revive exceeds the per-extrinsic ref_time budget.** The
poseidon-solidity inline assembly (~50 BN254 mulmod ops per round × 65
rounds, all running as PVM-compiled native code with no precompile fast
path) is fundamentally too expensive to call on chain — not just 20×, but
*at all*.

We confirmed this isn't a per-DELEGATECALL overhead issue (calling
PoseidonT3 directly OOGs the same way) and isn't fixable by cutting tree
depth (we tried 20 → 12 → 8; the constructor stopped OOG-ing but
`buyAndCreate` still OOGs because the bottleneck isn't the *count* of
Poseidons but that *any* on-chain Poseidon is too expensive).

The implication for design: **no Poseidon on chain, period**. The fix is
not to reduce hash count but to eliminate the on-chain hash function
entirely.

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
Stream side (every user tx writes here)        Checkpoint side (batched)
─────────────────────────────────────            ──────────────────────────
commitments : mapping(uint32 ⇒ uint256)          checkpointedRoot   : Merkle root
streamCount : # of leaves streamed               checkpointedCount  : # of leaves included
                                                 knownRoots[100]    : recent-roots ring buffer
```

Each user tx does plain `SSTORE`s — **no on-chain hashing of any kind**.

`commitments[i]` stores the i-th streamed leaf verbatim. `streamCount`
is the next free index. The pair gives anyone (including the
checkpointer) a self-contained on-chain anchor: the cm at position N is
exactly what's in `commitments[N]`. No collision-resistance assumption
needed beyond what the SNARK itself uses.

`checkpointedRoot` is the Merkle root of all checkpointed leaves
(positions `0..checkpointedCount-1`). Spends prove membership against
this root, not the absolute latest stream state. After a buy/assign/
redeem, the new commitments are in `commitments[...]` but not yet in the
tree; the next `checkpoint(...)` call rolls them in.

### Per-tx weight on pallet-revive (empirical, measured against chopsticks)

The empirical cap per extrinsic is ~100 M weight units (where 100 M is
the eth-rpc gas-unit equivalent that pallet-revive's bridge maps from /
to substrate weight). Successful txs in the new design land in the
~50–250 K range — three orders of magnitude under the cap.

| Op | What it does on chain | Status on chopsticks |
|---|---|---|
| `buyAndCreate` | ecPairing verify + transferFrom + 1 SSTORE (cm) + 4 small SSTOREs + emit | ✓ passes (e2e) |
| `assign` | ecPairing verify + nullifier SSTORE + 2 SSTOREs (cmDest, cmChange) + 1 SSTORE (streamCount) + emit | ✓ passes |
| `redeem` | ecPairing verify + nullifier SSTORE + 1 SSTORE (cmChange) + 2 SSTOREs (credit, spent) + emit | ✓ passes |
| `checkpoint` | 1 SLOAD (cm) + ecPairing verify + 3 SSTOREs (root, count, ring buffer) + emit | ✓ passes |
| `withdraw` | 2 SSTOREs (credit, withdrawn) + tUSDC.transfer + emit | ✓ passes |

Per-op weight is dominated by the ecPairing verify (~4 K weight) plus
the per-SSTORE cost. Even the heaviest op (assign with 2 commitments
written and the nullifier SSTORE) lands well inside the cap.

### Checkpoint proof

The checkpoint SNARK proves an atomic single-leaf transition (BATCH=1
for the PoC; B≥8 in production):

```
public:  oldRoot, newRoot, oldCount, newCount, cm
private: appendPath[20]      // canonical sibling path

constraints:
  1. newCount == oldCount + 1
  2. MerkleProof(0,  appendPath, bits(oldCount)) == oldRoot   (path canonical)
  3. MerkleProof(cm, appendPath, bits(oldCount)) == newRoot   (transition)
```

The on-chain anchor is `cm` itself: the contract reads
`commitments[oldCount]` via SLOAD and passes it as the public input. The
checkpointer cannot sneak in fake commitments — the SNARK only verifies
what the contract reads.

Constraint count (BATCH=1, depth 20):
- 2 Merkle-proof checks: 2 × 20 Poseidon-2 ≈ 41 × 213 ≈ 8.7 K
- Glue + Num2Bits: ~1 K
- **Total: ~10 K**

Fits ptau-15 (~16 K coverage in Groth16). PoC uses ptau-17 to share one
file across all circuits; setup is fast.

### Batching for production

The PoC uses BATCH=1 so each checkpoint covers one commitment. That
gives no amortization — checkpointer pays one Groth16 verify per
streamed leaf. Production should bump to B≥8:

| BATCH | Constraints | ptau | Amortization |
|---|---|---|---|
| 1 (PoC) | ~10 K | ptau-15 | none — 1 SNARK verify per leaf |
| 4 | ~40 K | ptau-17 | 4× cheaper per leaf |
| 8 | ~80 K | ptau-17 | 8× cheaper per leaf |
| 16 | ~160 K | ptau-18 | 16× cheaper per leaf |

The contract signature changes to `uint256 newRoot, uint32 newCount,
uint256[B] cm, ...` (cm becomes an array) and the contract loops
SLOAD'ing each `commitments[oldCount+i]` to assemble the public-input
batch. Circuit chains intermediate roots `treeRoot[i+1] = newMP[i].root`
the same way the existing PoC code does for the single step.

### Spendability latency

A note is spendable from one checkpoint after its creation. The relay,
which already sequences chat-side ops, runs an eager checkpointer
(trigger on batch-full OR a configurable timer). Bound to a few seconds
in practice on a low-traffic chain; one block confirmation in the
limit.

### Who runs the checkpointer

Anyone can — `checkpoint(...)` is permissionless. The relay operator
naturally does it because they want low spend latency for chat-side
ops. If no one checkpoints, mints still work (they just accumulate in
the stream) but spends queue. Funds are not at risk — the on-chain
commitment log is self-contained truth; any future checkpointer can
roll forward.

## 4. Concrete diff per layer

### Contracts (`contracts/contracts/`)

- `IncrementalMerkleTree.sol` → replaced by `StreamAndRootRing.sol`.
  Drops frontier/zeros/filledSubtrees and the entire `poseidon-solidity`
  dependency. Stores `mapping(uint32 ⇒ uint256) commitments` indexed by
  stream position, `streamCount`, and a 100-slot `roots` ring buffer
  that only advances on `checkpoint(...)`.
- `VoucherPool.sol`:
  - `buyAndCreate` / `assign` / `redeem` no longer call `tree.insert`.
    Each calls `state.appendStream(cm)` which does **one SSTORE** per
    commitment plus one SSTORE for the count. No hashing.
  - Spend proofs (assign / redeem) bind to `oldRoot ∈ knownRoots` —
    i.e. a *checkpointed* root, not the latest stream state.
  - New `checkpoint(...)` (permissionless). Reads `commitments[oldCount]`
    via SLOAD and passes it as the SNARK's `cm` public input — the
    SNARK then proves the tree transition over exactly that cm.
- **No `PoseidonT3` (or any hash function) on chain**. The whole
  poseidon-solidity dependency is removed. The constructor's only
  Merkle root constant is the pre-computed empty-tree root at depth 20,
  hard-coded as a literal.

### Circuits (`circuits/src/*.circom`)

- `create.circom`, `assign.circom`, `redeem.circom`: **unchanged from
  baseline**. Spend proofs still prove membership against `root` exactly
  as today — only now `root` is interpreted as a checkpointed root
  rather than the latest tree state.
- New `checkpoint.circom`:
  - Public inputs: `oldRoot, newRoot, oldCount, newCount, cm`.
  - Private inputs: `appendPath[depth]` (canonical sibling path).
  - Constraints: (i) `newCount == oldCount + 1`; (ii) verify
    `MerkleProof(0, appendPath, bits(oldCount)) == oldRoot` (path
    canonical); (iii) verify
    `MerkleProof(cm, appendPath, bits(oldCount)) == newRoot` (transition).

Constraint count (BATCH=1, depth 20): ~10 K, fits ptau-15 with room.
PoC build uses ptau-17 to share one file across all circuits.

For production B=8: add `cm[B]` + `appendPath[B][depth]`, chain
intermediate roots — ~80 K constraints, needs ptau-17.

### Core package (`packages/core/src/`)

- `merkle.js`: add `appendPath(insertIndex)` — returns the canonical
  sibling path for inserting at `insertIndex` (filledSubtrees on the
  left, pre-computed zeros on the right). Already had `proof(leafIndex)`
  for spends — keep that.
- New `checkpoint.js`: `buildCheckpointInput({mirror, cm, oldCount})`
  returns the input shape for `proveCheckpoint(...)`.
- `proof.js`: add `proveCheckpoint(input)`.

### Test harness + dapps

- `test/e2e/flow.test.mjs`: between each user tx and the next
  membership-requiring tx, call `pool.checkpoint(...)`. The harness
  has a `drainCheckpoints()` helper that loops over `pendingStream`
  (cm not yet checkpointed) and submits one `checkpoint(...)` tx per
  entry.
- Dapps: purchaser unchanged (still just submits buyAndCreate). Chat
  reads `checkpointedCount` and waits if its target note hasn't been
  checkpointed yet. Relay gains a checkpointer mode (eagerly batches +
  submits).

## 5. Cost model after the change

Per user tx on pallet-revive. The empirically-measured per-extrinsic
ceiling is ~100 M weight units (eth-rpc gas-unit-equivalent), and from
direct measurements: `verifyProof` (Groth16, ecPairing precompile) =
4 K, `transfer` = 5 K, single SSTORE ≈ ~5 K. With no on-chain Poseidon
the heaviest op is well clear of the ceiling.

| Step | `buyAndCreate` | `assign` | `redeem` |
|---|---|---|---|
| Selector + decode | ~21 K | ~21 K | ~21 K |
| Groth16 verify (ecPairing precompile) | ~4 K | ~4 K | ~4 K |
| `transferFrom` external CALL | ~5 K | — | — |
| Commitments SSTORE | 1 × ~5 K | 2 × ~5 K | 1 × ~5 K |
| Bookkeeping SSTOREs (streamCount, nullifier, credit, deposited, minted…) | ~25 K | ~25 K | ~30 K |
| Emit event | ~5 K | ~5 K | ~5 K |
| **Total per user tx** | **~65 K** | **~85 K** | **~70 K** |
| Headroom vs 100 M ceiling | ~1500× | ~1200× | ~1400× |

Per `checkpoint(...)` (paid by checkpointer, PoC's BATCH=1):

| Step | Weight |
|---|---|
| SLOAD (`commitments[oldCount]`) | ~3 K |
| Groth16 verify (ecPairing) | ~4 K |
| State updates (root, count, ring buffer) | ~25 K |
| Emit event | ~5 K |
| **Total** | **~40 K** |

Amortized per user tx (BATCH=1): 1 checkpoint per commitment streamed
≈ 1.3 checkpoints per user tx average (buy adds 1 leaf, assign 2,
redeem 1). At B=8 in production: ~5 K weight extra per user tx of
"checkpointer share".

These are empirical-passing numbers — all 13/13 e2e steps land on
chopsticks-forked Paseo Asset Hub in real ~10–20 s wall time per block
(matching real Paseo block production), with no OOG anywhere.

Proving time:
- Per user tx (assign): unchanged from baseline, ~400 ms desktop / ~1 s
  mobile p50. The spend circuits did not change.
- Checkpoint (BATCH=1, ~10 K constraints): ~800 ms desktop. BATCH=8
  in production: ~6 s. Runs in the relay's background loop, off the
  user's critical path.

### What about storage_deposit?

Each `SSTORE` to a new `mapping` slot triggers pallet-revive's
`storage_deposit_factor × bytes` lockup, paid by the tx caller. For a
32-byte commitment slot on Asset Hub this is ~0.003 DOT (per the
`100 MILLICENTS/byte` constant). The locked deposit is **refundable**
when the slot is cleared.

For the PoC we don't clear `commitments[i]` after checkpoint, so the
per-mint storage lockup is permanent. Two production paths:

1. **`SSTORE 0` (clear) the commitment in `checkpoint(...)`** once the
   tree includes it — refunds the deposit to the original caller within
   one checkpoint cycle (seconds). Adds one SSTORE-clear per leaf in the
   checkpoint tx.
2. **Skip the SSTORE entirely** by reading cm from the event log
   off-chain; the checkpointer asserts `keccak256(emit) == ...`. Loses
   on-chain anchor; depends on event indexer trust.

Option 1 is the cleanest fit; the PoC contract is one TODO away from
implementing it. The empirical e2e ran with the permanent-lockup model
(no clearing) and still passed — the deposit didn't break anything on
our short-lived chopsticks run.

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

With no on-chain Poseidon, per-tx weight drops dramatically — the
ecPairing verify dominates at ~4 K, then a handful of SSTOREs.
Per-tx total: 65–85 K eth-rpc gas units (empirically measured to
fit in chopsticks-forked Paseo Asset Hub).

| Component | Plancks | DOT |
|---|---|---|
| Per user tx — 65–85 K eth-rpc gas units | ~6.5–8.5 × 10⁴ | ~0.000007–0.000009 DOT |
| Length fee (~550 byte tx — proof + args) | 2.75×10⁷ | 0.003 DOT |
| **Per user tx total** | | **≈ 0.003 DOT** |
| | | (~$0.012–$0.030 at $4–10/DOT) |

The **length fee dominates**. Once compute is no longer the bottleneck,
the cost-per-tx floor is the bytes-on-chain cost of the Groth16 proof
(~256 bytes) + ABI overhead. Aggregating multiple users into one tx
(rollup-style) would amortize this, but for a per-user design ~0.003
DOT/tx is the floor.

Per `checkpoint` (BATCH=1):

| Component | Plancks | DOT |
|---|---|---|
| ref_time (~40 K gas units) | ~4×10⁴ | <0.00001 DOT |
| Length fee (~800 bytes — proof + public inputs) | 4×10⁷ | 0.004 DOT |
| **Per checkpoint** | | **≈ 0.004 DOT** |

Amortized at BATCH=1: ~0.004 DOT per leaf. At BATCH=8 (production):
~0.0005 DOT per leaf.

**Combined per voucher operation** (user tx + amortized checkpoint
share):

| Configuration | DOT/op | USD ($4/DOT) | USD ($10/DOT) |
|---|---|---|---|
| PoC (BATCH=1) | ~0.007 | $0.03 | $0.07 |
| Production (BATCH=8) | ~0.004 | $0.02 | $0.04 |

About **25–30× cheaper** than the original OOG-or-bust ceiling-grazing
design's 0.10 DOT, and — crucially — the protocol actually completes
under the per-extrinsic weight ceiling rather than reverting on OOG.

### Storage deposit (separate from inclusion fee)

Each new state slot the contract writes also locks
`storage_deposit_factor × bytes` of the tx caller's balance, refundable
when the slot is cleared.

For our `mapping(uint32 ⇒ uint256) commitments`:
- 32 bytes per cm × `100 MILLICENTS/byte` = **~0.0032 DOT locked per
  streamed cm**, paid by the user submitting the tx.
- buyAndCreate: 1 cm written = 0.0032 DOT lockup
- assign: 2 cm written = 0.0064 DOT lockup
- redeem: 1 cm written = 0.0032 DOT lockup

If `checkpoint(...)` clears `commitments[i]` after use (one-line change,
adds SSTORE-to-zero per leaf), this lockup is **refunded within
seconds** — net zero. If left in place (PoC behavior), it's permanent.

For a $1-denominated voucher at DOT = $4, the *temporary* lockup is
~$0.013, recovered on next checkpoint. Acceptable; doesn't break the
economics.

### What's not included above

- **`targeted_fee_adjustment`** multiplier: rises with sustained
  congestion (default 1×, can hit 2–4× under load).
- The `GasScale = 80,000` ratio is documented but not yet measured
  against a real successful tx receipt on mainnet Asset Hub. Treat
  absolute fee numbers as accurate to ±2×.
- The contract-creation `storage_deposit` for `VoucherPool` itself
  (~few hundred DOT locked once, refundable on destruction) is a
  one-time setup cost separate from per-tx fees.

### Why this matters for the protocol

A community-credits voucher denominated in tUSDC at $1 face value can't
absorb a $0.40 mint fee — the original design breaks even only on $10+
vouchers (and that's before it OOGs entirely). The redesign brings the
per-mint *inclusion fee* to under a cent and the *storage lockup* to a
recoverable ~$0.01, making sub-dollar denominations economically
viable.

## 7. Trade-offs

**Spend latency = checkpoint interval.** A note minted at time `t` can
only be assigned/redeemed once `checkpoint(...)` has rolled its
commitment into the tree. With an eager checkpointer (trigger on
batch-full OR configurable timer), bound to a few seconds. Worst case:
no checkpointer is running → no spends are possible (existing notes are
unaffected; just queued). The relay operator naturally has incentive
to checkpoint because they want low spend latency for the chat-side ops
they relay.

**Checkpointer liveness is a soft dependency.** If no one ever
checkpoints, mints still work (they just append to `commitments[...]`)
but spends stall. Funds aren't at risk — the on-chain commitment array
is self-contained truth and any future checkpointer can roll forward.
We don't run on a checkpoint-or-nothing model; the stream is
permissionlessly observable.

**Per-mint storage lockup.** Each streamed cm locks ~0.0032 DOT of the
caller's balance under pallet-revive's `storage_deposit` rule (32 bytes
× `100 MILLICENTS/byte`). PoC leaves it permanent; production should
add SSTORE-to-zero on cm in `checkpoint(...)` to refund within a
checkpoint cycle. See §6 "Storage deposit" for numbers.

**Indexer correctness becomes load-bearing for the checkpointer.** The
checkpointer reads each cm via SLOAD on `commitments[oldCount]` —
trivial. But it also needs to rebuild the off-chain Merkle tree to
compute the canonical sibling path. That mirror tree is built from
`VoucherCreated`/`Assigned`/`Redeemed` events. If the indexer is wrong
about the tree, the checkpoint proof's `oldRoot` won't match
`checkpointedRoot` and the tx reverts. No funds at risk; checkpointer
re-syncs and retries.

**No on-chain tree state for debug.** Inspecting "is leaf N at position
N in the tree" requires running the indexer. The on-chain
`checkpointedRoot` is a single hash; you can't recover the leaf set
from it. Acceptable — the dapps already need the indexer to build
witnesses.

**ZK artifact size grows for the checkpointer.** The new checkpoint
zkey is ~10 MB at BATCH=1 (~10 K constraints), ~25 MB at BATCH=8
(~80 K). Only the checkpointer (relay) needs to host + use it;
end-user dapps are unchanged.

**Reorg sensitivity.** A re-org that drops a `VoucherCreated` tx also
drops the matching `commitments[N]` write and decrements `streamCount`,
so a partially-built checkpoint becomes invalid. Standard solution:
checkpointer waits for finality (~6 blocks on Asset Hub) before
including events in its batch. Adds latency proportional to finality
lag.

## 8. Rejected alternatives

**Splitting `buyAndCreate` into commit + finalize.** Explicitly out of
scope per the requirement. Would lose atomicity, require a per-buyer
nonce, and create a front-running window between the two txs.

**Per-tx in-circuit append.** Detailed analysis in §3a above. Each
user's proof binds to a specific `oldRoot`, so concurrent submissions
serialize to ~1 tx per block. Fine for demos, dead for any real load.
The stream+checkpoint design escapes this by decoupling "commit a leaf"
from "update the tree" so user txs no longer compete for tree state.

**On-chain Poseidon hash chain as the stream anchor.** First attempt at
stream+checkpoint anchored each leaf via `streamHash = Poseidon(prev,
cm)` — one Poseidon call per user tx, much cheaper than the original
20-hash insert. **Empirically OOGs** on pallet-revive: a single
`PoseidonT3.hash` call alone exceeds the per-extrinsic weight budget.
The current design uses plain `SSTORE` of cm into a mapping instead.
Trade-off: per-mint `storage_deposit` lockup of ~0.003 DOT (see §6,
§7), refundable if checkpoint clears the slot.

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
