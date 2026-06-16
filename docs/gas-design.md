# Gas-driven design for pallet-revive

## Status update

The protocol folds each commitment into an on-chain Tornado-style
incremental Merkle tree **immediately**, inside the same user tx that
emits it (`buyAndCreate` / `assign` / `redeem`). Each insert performs 20
on-chain `Poseidon(2)` hashes via a `PoseidonT3` contract, and rolls the
new root into a 100-slot on-chain ring buffer.

This **replaces** an earlier stream + checkpoint ("mini-rollup") design,
in which user txs only `SSTORE`d their commitment into an on-chain stream
and a separate permissionless `checkpoint()` extrinsic later folded
streamed leaves into the Merkle root inside a SNARK. That indirection
existed to avoid on-chain Poseidon hashing, which was *believed* to OOG
pallet-revive's per-extrinsic weight budget. Direct measurement under
pallet-revive's REVM (EVM-interpreter) path disproved the premise — the
heavy single tx (Groth16 verify + `transferFrom` + 20-Poseidon insert)
runs fine — so the stream, the checkpoint extrinsic, the checkpoint
circuit/verifier, the checkpointer daemon, and the Tornado-frontier-in-
SNARK were all dropped in favour of immediate on-chain insertion.

Consequences of the immediate-insert design:

- **No spend latency.** A note is spendable the moment its tx lands; there
  is no checkpoint cycle to wait for.
- **Radically simpler state.** No stream mapping, no streamCount, no
  checkpointedRoot/Count, no batching, no checkpointer liveness
  dependency. The contract holds only the Tornado frontier
  (`uint256[20] filledSubtrees`), `nextIndex`, and the 100-root ring
  buffer.
- **Higher per-tx gas, by design.** Each user tx now pays for its own 20
  Poseidon hashes rather than deferring them to a batched actor. This is
  the trade: more gas per tx for simpler state and immediate
  spendability. Measured cost is well inside pallet-revive's budget (see
  §§5–6).
- **Three circuits only:** `create`, `assign`, `redeem` — unchanged. There
  is no checkpoint circuit.

The build emits **EVM bytecode only** (solc / hardhat). The *same* EVM
bytecode runs locally on a hardhat node and on pallet-revive's REVM path
on a chopsticks-forked Asset Hub. There is no resolc/PVM path,
no `artifacts-pvm`, and no library linking. `TARGET=chopsticks` now only
points the harness at the eth-rpc bridge with an explicit `gasLimit`; it
does not select different bytecode.

## TL;DR

The protocol mints and spends fixed-denomination vouchers whose
commitments live in an append-only Poseidon Merkle tree (depth 20). The
open question for pallet-revive was whether the on-chain Merkle insert —
20 `Poseidon(2)` hashes per leaf — fits inside one extrinsic's weight
budget alongside a Groth16 verify and an ERC-20 `transferFrom`.

The earlier design assumed it did not, and moved the tree update off the
user's tx into a streamed-commitment + batched-checkpoint SNARK. **Direct
measurement on a chopsticks fork of Asset Hub running pallet-revive's REVM
disproved that assumption:** the full heavy tx (verify + transferFrom +
20-Poseidon insert) executes comfortably, and the `IncrementalMerkleTree`
constructor's 20 Poseidon calls deploy fine.

**Adopted design:** fold each commitment into the on-chain tree
immediately. `buyAndCreate` / `assign` / `redeem` each call `_insert(cm)`
(20 on-chain `Poseidon(2)` hashes + frontier SSTOREs), advance the root,
and push it into a 100-slot ring buffer. Spends prove Merkle membership
against *any* of the last 100 roots, so a proof built against a
slightly-stale root still lands under concurrency. Notes are spendable as
soon as their creating tx lands — no checkpoint latency. The
implementation passes the full e2e end-to-end on a chopsticks-forked
Asset Hub under pallet-revive REVM.

## Table of contents

1. [What drives gas](#1-what-drives-gas)
2. [What comparable systems do](#2-comparable-systems)
3. [The on-chain incremental tree (adopted)](#3-on-chain-incremental-tree)
4. [Concrete diff per layer](#4-concrete-diff)
5. [Cost model](#5-cost-model)
6. [DOT-denominated fee estimate on Polkadot Asset Hub](#6-fee-estimate)
7. [Trade-offs](#7-trade-offs)
8. [Rejected alternatives](#8-rejected-alternatives)

---

## 1. What drives gas

Per `buyAndCreate`, breaking down on EVM and what each maps to under
pallet-revive's REVM path:

| Step | What it does | pallet-revive disposition |
|---|---|---|
| Selector dispatch + base tx | calldata decode, base cost | base inclusion weight |
| `createVerifier.verifyProof` (Groth16, ecPairing precompile) | one pairing check | **cheap** — ecPairing is a native precompile on pallet-revive |
| `transferFrom` to external ERC-20 (CALL + balance/allowance updates) | tUSDC pull | cheap — small SSTOREs + CALL |
| `tree._insert(cm)` — 20× `Poseidon(2)` + frontier/root SSTOREs | the on-chain Merkle insert | **the heaviest component, but well inside budget** under REVM |
| `deposited += value`, `minted[epoch] += value`, event | bookkeeping | comparable to other SSTORE-heavy ops |

The 20-Poseidon insert is the single biggest line item, but it does **not**
OOG under pallet-revive's REVM. The earlier design was built on the belief
that on-chain Poseidon was unusable on pallet-revive; the measurements
below show that belief was wrong.

Empirical data from a chopsticks fork of Asset Hub (REVM), via the e2e
fee meter (`test/e2e/fees.mjs`):

| Call | Result |
|---|---|
| `createVerifier.verifyProof` | succeeds |
| `tUSDC.transfer` / `approve` | succeeds |
| `PoseidonT3` (circomlibjs bytecode) deploy + `poseidon([a,b])` | succeeds |
| `IncrementalMerkleTree` constructor (20 Poseidon zero-hashes) | deploys fine |
| `buyAndCreate` (full: verify + transferFrom + 20-Poseidon insert) | succeeds |
| `assign` (verify + two 20-Poseidon inserts) | succeeds |
| `redeem` (verify + one 20-Poseidon insert) | succeeds |

The `PoseidonT3` contract is deployed from **circomlibjs** bytecode,
bit-identical to the circuits' `Poseidon(2)` (`merkle.circom`,
`ZERO_LEAF=0`). `VoucherPool` calls it through the `IPoseidonT3`
interface; no external-library linking is needed.

The implication for design: **on-chain Poseidon is viable on pallet-revive
REVM.** There is no need to move the hash off-chain, so the simplest
correct design — fold the leaf into the tree in the same tx — is also the
one that ships.

## 2. Comparable systems

How other privacy stacks handle the "Merkle-insert is expensive" problem:

**Tornado Cash** — accepts the cost. Mainnet deposit is ~1.1 M gas; users
pay it. Tornado's design separates `deposit` (the insert) from `withdraw`
(verify + payout). Our adopted design is the same shape: each user tx pays
for its own incremental insert, using the Tornado-style frontier
(`filledSubtrees`) so the per-insert cost is a constant 20 hashes
regardless of tree fill.
([torn.community proposal](https://torn.community/t/proposal-4-tornado-trees-upgrade/636))

**Semaphore v4 (LeanIMT)** — keeps the on-chain tree but eliminates two
sources of waste: (1) zero-hash siblings are now pass-through (parent =
child when there's only one child), so insertions early in the tree's life
don't compute zero hashes; (2) tree depth grows dynamically. For our
steady-state (>1000 vouchers), neither helps much.
([Semaphore v4 release notes](https://github.com/semaphore-protocol/semaphore/releases/tag/v4.0.0))

**Aztec / zkSync / privacy-pool research** — push tree updates **off-chain**
into a sequencer that batches transactions, computes the new root, and
proves the transition with a SNARK. The on-chain contract only verifies
the batch SNARK and updates one storage slot. This is strictly better for
throughput but introduces a trust assumption on the sequencer (or
fraud-proof complexity) and adds spend latency — the very indirection the
adopted design avoids now that on-chain Poseidon is known to fit.
([Aztec network architecture](https://nodes.guru/blog/aztec-network-a-hybrid-public-private-zkrollup-bringing-privacy-to-ethereum))

The right primitive for our PoC scale (single-digit demo TPS, no sequencer
infra, and a per-extrinsic budget that comfortably absorbs the insert) is
the Tornado-style on-chain incremental tree. It keeps the trustless
one-shot-tx UX, gives immediate spendability, and needs no off-chain
checkpointer.

## 3. On-chain incremental tree

### State

```
filledSubtrees : uint256[20]   Tornado frontier (one node per level)
nextIndex      : uint32        position the next inserted leaf occupies
_roots[100]    : uint256       recent-roots ring buffer
currentRootIndex : uint32      index of the most-recent root in the ring
```

There is no stream, no streamCount, no checkpointedRoot/Count. See
`contracts/contracts/IncrementalMerkleTree.sol`.

### Insert

`_insert(leaf)` walks the 20 levels from leaf to root: at each level it
either pairs the new node with its left sibling from `filledSubtrees` (and
leaves `filledSubtrees[level]` updated for the next insert) or hashes it
against the precomputed zero for that level, calling
`poseidonT3.poseidon([left, right])` once per level. After 20 hashes it
has the new root, advances `currentRootIndex` modulo 100, and writes the
root into `_roots[currentRootIndex]`. Returns the leaf's index.

The per-insert cost is a constant 20 `Poseidon(2)` hashes **independent of
tree depth fill** — the Tornado frontier construction means a full tree
costs exactly the same as an empty one. So all the fee numbers below hold
at a full tree.

The empty-tree zero hashes are computed in the constructor
(`zeros[level] = Poseidon(zeros[level-1], zeros[level-1])`, with
`ZERO_LEAF=0`), matching `scripts/compute-zeros.mjs` and
`circuits/src/merkle.circom`. The empty-tree root sits at ring-buffer
index 0.

### Membership and the root ring buffer

Spends (`assign` / `redeem`) prove Merkle membership against a root that
the contract accepts iff it matches any of the last 100 roots
(`isKnownRoot`). Because inserts advance the root on every user tx, a
proof built a few txs ago against a then-current root still verifies as
long as it is within the last 100 roots — this is what makes concurrent
spends practical without a sequencer or a stale-root retry loop.

### Spendability

A note is spendable as soon as the tx that created it lands: its
commitment is in the tree and its root is in the ring buffer immediately.
There is no checkpoint cycle, so no spend latency beyond block inclusion.

## 4. Concrete diff per layer

### Contracts (`contracts/contracts/`)

- `IncrementalMerkleTree.sol`: Tornado-frontier append-only tree (depth
  20). Holds `filledSubtrees[20]`, `nextIndex`, the 100-slot `_roots` ring
  buffer, and `currentRootIndex`. Exposes `_insert`, `isKnownRoot`,
  `getLatestRoot`. Takes an `IPoseidonT3` in its constructor and calls it
  for every hash.
- `IPoseidonT3.sol`: minimal interface (`poseidon(uint256[2]) → uint256`)
  for the externally-deployed Poseidon(2) contract.
- `VoucherPool.sol`:
  - `buyAndCreate` calls `_insert(cm)` (one leaf).
  - `assign` calls `_insert(cmDest)` then `_insert(cmChange)` (two leaves);
    both are spendable immediately.
  - `redeem` calls `_insert(cmChange)` (one leaf).
  - Spend proofs bind to a root accepted by `isKnownRoot` (any of the last
    100 roots).
  - **No `checkpoint()`**, no stream append, no checkpoint public-input
    layout.
- `PoseidonT3` is deployed separately from **circomlibjs** bytecode (raw,
  no ABI) and passed into `VoucherPool`'s constructor via the
  `IncrementalMerkleTree` base. No `poseidon-solidity` dependency, no
  external-library linking.

### Circuits (`circuits/src/*.circom`)

- `create.circom`, `assign.circom`, `redeem.circom`: unchanged. Spend
  proofs prove membership against `root` exactly as before — `root` is a
  ring-buffer root.
- `merkle.circom`, `commitment.circom`: shared templates (`Poseidon(2)`,
  depth 20, `ZERO_LEAF=0`) — kept in sync with the contract's hashing.
- **There is no `checkpoint.circom`** and no checkpoint verifier.

### Core package (`packages/core/src/`)

- Exports `poseidonT3Bytecode` (circomlibjs deploy bytecode) used by the
  deploy script to instantiate the on-chain Poseidon(2).
- `merkle.js`: mirror tree used to build spend witnesses
  (`proof(leafIndex)`). No checkpoint/append-path helper is needed.

### Test harness + dapps

- `test/e2e/deploy.mjs`: deploys `PoseidonT3` from `poseidonT3Bytecode`,
  then the three verifiers, then `VoucherPool` wired to the Poseidon
  address. The **same EVM bytecode** is used for both `TARGET=hardhat` and
  `TARGET=chopsticks`; the only difference is that chopsticks points at the
  eth-rpc bridge and passes an explicit `gasLimit`. No resolc, no
  `artifacts-pvm`, no library linking.
- `test/e2e/flow.test.mjs`: buy → assign → redeem → withdraw with no
  checkpoint step between them — every note is spendable as soon as its tx
  lands.
- `test/e2e/fees.mjs`: reads `system.account.{free,reserved,frozen}` before
  and after each tx and reports the inclusion fee and gas per action.
- Dapps: purchaser submits `buyAndCreate`; chat/relay spend immediately
  after creation. No checkpointer mode.

## 5. Cost model

Per user tx on pallet-revive REVM. The 20-Poseidon insert is the dominant
component but lands well inside the per-extrinsic budget; the heaviest op
(`assign`, two inserts) is still an order of magnitude under the per-block
normal-dispatch budget (~4.69 M gas; see §6). Measured gas (chopsticks
fork, REVM):

| Op | What it does on chain | Gas (avg) |
|---|---|---:|
| `approve` (tUSDC) | ERC-20 allowance SSTORE | ~3,907 |
| `buyAndCreate` | verify + transferFrom + 1 insert (20 Poseidon) + bookkeeping | ~16,079 (cold 21,404 / warm 10,754) |
| `assign` | verify + nullifier + 2 inserts (40 Poseidon) | ~25,154 |
| `redeem` | verify + nullifier + 1 insert (20 Poseidon) + credit | ~18,319 |
| `withdraw` | credit/withdrawn SSTOREs + tUSDC.transfer | ~3,255 |

Per-tx cost is **independent of tree depth/fill** — the Tornado frontier
makes every insert a constant 20 hashes — so these numbers hold at a full
tree.

Proving time (off-chain, unchanged from baseline): per spend (`assign` /
`redeem`) ~400 ms desktop / ~1 s mobile p50. The spend circuits did not
change.

## 6. Fee estimate

### Measured — chopsticks fork of Polkadot/Paseo Asset Hub (REVM)

We ran the full end-to-end flow against a chopsticks fork of Asset Hub
(pallet-revive live since January 2026) through the e2e fee meter
(`test/e2e/fees.mjs`), reading `system.account.{free,reserved,frozen}`
before and after each transaction. Empirically the storage deposit is 0 —
pallet-revive folds state-write cost into the inclusion fee rather than
locking a refundable `reserved` deposit — so the user-facing cost is
exactly the inclusion fee. The effective rate is **fee ≈ gas × 1e-6
PAS/DOT**.

| # | Tx | gas | Fee (DOT/PAS) |
|---|---|---:|---:|
| 1 | `approve` (tUSDC, amortized) | ~3,907 | ~0.004 |
| 2 | `buyAndCreate` | ~16,079 | ~0.016 |
| 3 | `assign` | ~25,154 | ~0.025 |
| 4 | `redeem` | ~18,319 | ~0.018 |
| 5 | `withdraw` | ~3,255 | ~0.003 |
| **Per complete voucher lifecycle** | buy + assign + redeem + withdraw + amortized approve | **~110,190** | **≈ 0.110** |

There are **no checkpoint rows** — the checkpoint extrinsic no longer
exists.

**Throughput.** At ~110,190 gas all-in per voucher lifecycle and a
per-block Normal-dispatch budget of ~4,687,500 gas (0.5 s ref_time × 75% ÷
80,000 ps/gas), the protocol fits **~42 full voucher flows per block** if
it owned the entire normal-dispatch class (it doesn't — the chain also
serves XCM, asset transfers, governance, etc., so realistic share is a
fraction). Well above plausible community-credits demand.

Because each insert is a constant 20 Poseidon hashes (Tornado frontier),
these fees do **not** grow as the tree fills — they hold at a full tree.

### Fee constants (reference)

Polkadot Asset Hub fee model
([polkadot-fellows/runtimes constants](https://github.com/polkadot-fellows/runtimes/blob/main/system-parachains/constants/src/polkadot.rs)):

| Constant | Value |
|---|---|
| 1 DOT | 10^10 plancks |
| `TRANSACTION_BYTE_FEE` | 50,000 plancks/byte (MILLICENTS/2) |
| pallet-revive `GasScale` (1 EVM gas → ps) | 80,000 ps/gas |
| per-block Normal-dispatch gas budget | 0.5 s × 75% ÷ 80,000 ps/gas ≈ 4,687,500 gas |

### Reserved and frozen balances

Across the flow, **`reserved` delta = 0** and **`frozen` delta = 0**.
pallet-revive on Asset Hub does not lock the caller's balance via
`reserved` or `frozen`; the full cost of state writes (including the 20
Poseidon hashes per insert) is rolled into the inclusion fee, debited from
`free`. The user-facing all-in cost is exactly the inclusion fee — no
separate up-front deposit to fund, no refund cycle to track.

The contract-creation deposit (one-time, when `VoucherPool` and
`PoseidonT3` are deployed) is paid by the deployer, not by per-tx callers.

### What's not included above

- **`targeted_fee_adjustment`** multiplier: rises with sustained
  congestion (default 1×, can hit 2–4× under load). The chopsticks fork
  inherits the mainnet adjustment value at the forked block; under load
  per-tx fees scale linearly.
- A live deployment will see per-block gas-price adjustments the static
  fork doesn't reproduce.

## 7. Trade-offs

**Higher per-tx gas, simpler state, immediate spendability.** Folding the
insert into the user tx makes each tx pay for its own 20 Poseidon hashes
rather than deferring them to a batched checkpointer. In exchange the
protocol drops the entire stream + checkpoint machinery (stream mapping,
checkpoint extrinsic, checkpoint circuit/verifier, checkpointer daemon,
frontier-in-SNARK) and notes become spendable the instant their tx lands.
The higher per-tx gas was validated to run under pallet-revive REVM with
ample headroom (§§5–6).

**No checkpointer liveness dependency.** Because there is no checkpoint
step, there is no actor whose absence stalls spends. Every note is
spendable as soon as its creating tx is included.

**Concurrency via the root ring buffer.** Spends prove membership against
any of the last 100 roots, so a proof built against a slightly-stale root
still lands. Past 100 intervening inserts a spend proof must be rebuilt
against a fresher root — a non-issue at PoC scale and tunable via
`ROOT_HISTORY_SIZE`.

**On-chain Poseidon cost.** The 20 hashes per insert are the dominant gas
line item. The Tornado frontier keeps that cost constant regardless of
tree fill, and measurement shows it fits comfortably inside
pallet-revive's per-extrinsic budget — so the cost is bounded and
predictable rather than a scaling risk.

**No on-chain leaf set for debug.** The on-chain root is a single hash;
recovering "is leaf N at position N" requires the off-chain mirror tree
the dapps already build for witnesses. Acceptable.

## 8. Rejected alternatives

**Stream + checkpoint (mini-rollup).** The previously-adopted design:
user txs only `SSTORE` their commitment into an on-chain stream, and a
permissionless `checkpoint()` extrinsic later folds streamed leaves into
the root inside a SNARK (Tornado frontier proven in-circuit, batches up to
B_MAX=8). Its sole motivation was avoiding on-chain Poseidon, believed to
OOG pallet-revive. **Measurement disproved the premise** — the full
20-Poseidon insert runs fine under REVM — so the indirection bought
nothing but complexity and spend latency. Dropped entirely: no stream, no
checkpoint extrinsic, no checkpoint circuit/verifier, no checkpointer
daemon, no frontier-in-SNARK.

**Splitting `buyAndCreate` into commit + finalize.** Out of scope per the
requirement. Would lose atomicity, require a per-buyer nonce, and create a
front-running window between the two txs.

**Per-tx in-circuit append.** Move the Merkle update inside the SNARK
(buyer proves `oldRoot → newRoot`, contract just SSTOREs the new root).
Gas-cheap, but every proof binds to the specific `(oldRoot, nextIndex)`
the prover saw, so concurrent submissions serialize to ~1 tx per block.
The on-chain insert with the root ring buffer avoids this: inserts are
contract-ordered, and stale-root spends still verify against the last 100
roots.

**Sequencer / batched-rollup model (Aztec-style).** Strictly better at
high TPS, but puts the sequencer on the critical path of every submission
(round-trip before proving) and adds spend latency. Unnecessary now that
on-chain insert fits the budget.

**Indexed Merkle Tree (Aztec nullifier-tree style).** Insertion's
"neighbor" depends on existing leaf values; concurrent inserts on random
commitments collide rarely but non-zero. Adds sorted-tree on-chain logic
the append-only tree avoids.

**LeanIMT (Semaphore v4) dynamic-depth optimization.** Only helps small
trees (savings vanish past ~1K leaves). Wrong axis for our steady state.

**Quinary trees** (5-ary instead of binary). Reduces depth ~50% but
increases per-node hash cost (5 inputs vs 2) and circuit constraint count.
Net wash at our scale per the
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
- [Tornado Trees proposal #4 — torn.community](https://torn.community/t/proposal-4-tornado-trees-upgrade/636)
