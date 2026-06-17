# Community Credits PoC V1.1 — Implementation Plan

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [Protocol Simplifications vs Whitepaper](#3-protocol-simplifications-vs-whitepaper)
4. [On-Chain State Design](#4-on-chain-state-design)
5. [Circom Circuits](#5-circom-circuits)
6. [Solidity Smart Contracts](#6-solidity-smart-contracts)
7. [Stablecoin via pallet_assets](#7-stablecoin-via-pallet_assets)
8. [Three Vanilla-JS Dapps](#8-three-vanilla-js-dapps)
9. [Development Phases](#9-development-phases)
10. [Testing Strategy](#10-testing-strategy)
11. [Deployment](#11-deployment)
12. [Open Risks](#12-open-risks)

---

## 1. Executive Summary

A PoC implementing community credit vouchers with privacy-preserving assignment and
redemption on Paseo Asset Hub. Users purchase vouchers (stablecoin-backed), assign them
privately to communities, and communities redeem them with operators — all unlinkable
on-chain.

**Stack**: Circom circuits (Groth16/BN254) + Solidity contracts on pallet-revive +
three vanilla-JS dapps (purchaser / chat / relay-operator) sharing a `core` ES module,
all built with Vite (no framework), with in-browser snarkjs WASM proving.

**Signing model**: Purchaser + Relay-operator dapps connect a browser EVM signer
via EIP-6963 (desktop: MetaMask / Talisman EVM / SubWallet EVM; mobile in-app
dapp browsers: Nova Wallet, SubWallet mobile). Chat dapp **has no signer**,
never submits a tx, generates ZK proofs locally, reads chain read-only via
polkadot-api, hands proof bundles to the relay via deep link or QR. This
mirrors the chat dapp's eventual home inside simplex-chat where users hold no
crypto.

**Mobile-first UX**: all three dapps are responsive single-page apps; every
handoff has two parallel channels — a clickable deep link (single device) and
a scannable QR (cross-device, e.g., desktop Dapp A → mobile chat).

**Key simplifications vs whitepaper**: single ever-growing Merkle tree (not
per-epoch); epochs govern only nullifier bucketing + expiry; no AHE; SMP onion
relay collapses to a single-hop relay-operator dapp submitting both assigns
and redeems on behalf of chat users; paymaster economics collapse to "relay
operator absorbs gas"; permissionless single-tx `buyAndCreate` (buyer pays
stablecoin + submits create proof in one tx). Stablecoin is a pallet_assets
token accessed via the ERC20 assets precompile.

Three ZK circuits: **create** (buyer proves + submits), **assign** (chat user
proves; relay submits), **redeem** (community admin proves; relay submits).

---

## 2. Architecture Overview

```
   ┌──────────────────────┐  deep link    ┌──────────────────────┐  deep link    ┌──────────────────────┐
   │  Dapp A: Purchaser    │ ?import=...  │  Dapp B: Chat         │ ?assign=...  │  Dapp C: Relay        │
   │  (future web dapp)    │ ───────────► │  (future part of      │ or ?redeem=  │  Operator             │
   │  EVM wallet (EIP-6963)│              │   simplex-chat app)   │ ───────────► │  EVM wallet (EIP-6963)│
   │  - buyAndCreate       │              │  user + community-    │              │  - queue              │
   │  - proves: create     │              │   admin modes         │              │  - submits assign tx  │
   │                       │              │  NO signer, NO tx     │              │  - submits redeem tx  │
   │                       │              │  - proves: assign,    │              │  - withdraw           │
   │                       │              │              redeem   │              │                       │
   └──────────┬────────────┘              └──────────┬────────────┘              └──────────┬────────────┘
              │                                      │                                      │
              │ buyAndCreate tx                      │ read-only RPC                        │ assign tx
              │ (buyer signs +                       │ (polkadot-api,                       │ redeem tx
              │  pays gas)                           │  no signing,                         │ withdraw tx
              │                                      │  no fees)                            │ (operator
              │                                      │                                      │  signs + pays gas)
              ▼                                      ▼                                      ▼
   ════════════════════════════════════════════════════════════════════════════════════════════════════
   shared package: packages/core   (Poseidon, owner-key derivation, snarkjs wrappers, note codec,
                                     deep-link, QR, ethers bindings [purchaser, relay],
                                     polkadot-api reads [chat], IndexedDB / memory store)
   ════════════════════════════════════════════════════════════════════════════════════════════════════
              │                                      │                                      │
              │ eth-rpc                              │ substrate RPC                        │ eth-rpc
              │ (pallet-revive proxy)                │ (pallet-revive events)               │ (pallet-revive proxy)
              ▼                                      ▼                                      ▼
   ┌─────────────────────────────────────────────────────────────┐
   │                    Paseo Asset Hub                          │
   │                                                             │
   │  ┌───────────────────────────────────────────────────┐      │
   │  │           VoucherPool.sol                          │      │
   │  │  - buyAndCreate(cm, v, epoch, proof)  [open]       │      │
   │  │  - assign(nf, cmDest, cmChange, proof)             │      │
   │  │  - redeem(nf, cmChange, opId, proof)               │      │
   │  │  - withdraw(amount)                                │      │
   │  │  - Incremental Merkle tree (depth 20)              │      │
   │  │  - Nullifier sets bucketed by epoch                │      │
   │  │  - Operator registry + credits                     │      │
   │  │  - Recent roots ring buffer (100)                  │      │
   │  └──────────────┬────────────────────────────────────┘      │
   │                 │                                            │
   │  ┌──────────────┴────────────────────────────────────┐      │
   │  │  Groth16 Verifiers (3 contracts)                   │      │
   │  │  CreateVerifier / AssignVerifier / RedeemVerifier  │      │
   │  └────────────────────────────────────────────────────┘      │
   │                                                             │
   │  ┌────────────────────────────────────────────────────┐     │
   │  │  pallet_assets (test stablecoin, ID=N)              │     │
   │  │  ↕ ERC20 assets precompile (addr=f(N))              │     │
   │  └────────────────────────────────────────────────────┘     │
   └─────────────────────────────────────────────────────────────┘
```

### Data Flow

End-to-end (each step detailed in §8.2-8.4):

1. **Buy / mint** (Dapp A): buyer (precondition: wallet extension with tUSDC + PAS)
   generates a fresh per-voucher note key `sk` (random field element, not a wallet
   account; `ownerPkHash = Poseidon(sk)`), proves create, signs `approve` +
   `buyAndCreate`. Output: link + QR to chat dapp.
2. **Import** (Dapp B): chat opens link/QR, stores the note, watches chain
   read-only for commitment + witness.
3. **Assign** (Dapp B → Dapp C): chat proves assign in a Web Worker, hands
   bundle to relay via link/QR; relay signs + submits `assign`. Chat polls chain
   for confirmation, then renders a `community-import` link/QR.
4. **Community inbox** (Dapp B): community admin opens the dest note in their
   chat profile.
5. **Redeem** (Dapp B → Dapp C): community admin proves redeem, hands bundle to
   relay; relay signs + submits `redeem`. Credit accrues to the `operatorId`
   bound in the proof (relay cannot reroute).
6. **Withdraw** (Dapp C): operator signs `withdraw`, receives stablecoin.

---

## 3. Protocol Simplifications vs Whitepaper

| Whitepaper | PoC V1 | Rationale |
|---|---|---|
| Per-epoch commitment trees + epochs structure | Single ever-growing Merkle tree (depth 20, ~1M leaves) | Simpler on-chain state, single root to verify against |
| Epochs control tree rotation | Epochs control nullifier bucketing + note expiry only | Same GC properties, simpler proving |
| AHE liability buckets (ElGamal on Baby Jubjub) | Plaintext `minted[epoch]` + `spent[epoch]` counters | No privacy needed for aggregate stats in PoC |
| Multi-hop SMP onion-routed relay | Single-hop relay-operator dapp; chat user generates proof, hands off via deep link, operator submits tx and pays gas (for both assign and redeem) | Trust split (chat user vs. relay/operator) preserved; relay-side privacy (onion routing) deferred |
| Issuer-mediated voucher creation | Permissionless single-tx `buyAndCreate` (buyer pays stablecoin + submits create proof together) | Eliminates the issuer backend; matches a self-serve buying UX |
| Paymaster / ERC-4337 fee sponsorship for chat user | Relay operator absorbs gas for all chat-user-originating txs (assign + redeem). Buyer + operator pay their own gas for their own txs | Same end-user UX (chat user holds no crypto); paymaster economics out of PoC scope |
| Chat user holds an on-chain identity | Chat user holds NO crypto, NO signing wallet — pure proof generation + local store + read-only chain reads via polkadot-api | Mirrors planned simplex-chat integration where users have no on-chain identity |
| Note delivery via SimpleX messaging | Deep-link URLs between dapps; base64url-encoded note as URL arg | No SimpleX integration; one click moves a note between roles |
| Chat client reads chain via onion-routed SimpleX indexers (§2.3 of whitepaper) | Chat dapp talks directly to a Substrate RPC node via polkadot-api | Indexer-privacy out of PoC scope; the WP read-side onion routing is a separate component from the voucher protocol itself |
| Buyer + relay operator pay gas in stablecoin via Asset Hub asset-fee-payment | Both pay gas in PAS (the native token) — buyer must hold PAS in addition to tUSDC | Production can drop the PAS requirement entirely by enabling `pallet_asset_conversion_tx_payment` (Asset Hub's pay-fees-in-assets feature) so the buyer's existing tUSDC covers gas as well; out of PoC scope but mechanically a config change |
| Encrypted note payload commitment (h_ct, h_del) | Omitted from creation proof | Delivery channel verification not needed for PoC |
| Revenue share on withdrawal | Simple operator withdrawal (full amount) | Revenue share is business logic, not crypto |
| Expiration bucket reclaim with verifiable decryption | Simple admin reclaim after epoch+2 | No AHE means no decryption proof needed |

### What IS preserved

- All three ZK circuits (create, assign, redeem) with full privacy properties
- Note-and-nullifier pattern with Poseidon commitments
- Single Merkle tree membership proofs
- Nullifier bucketing by expiry epoch with garbage collection
- Expiry enforcement (notes become unspendable after their epoch)
- Operator registry with permissioned redemption
- Stablecoin backing with solvency invariant

---

## 4. On-Chain State Design

### Note Format

```
note = (value, expiryEpoch, ownerPkHash, randomness, assigned, redeemerHash)
```

- `value`: uint64, denominated in stablecoin smallest unit
- `expiryEpoch`: uint32, epoch number when note expires
- `ownerPkHash`: `Poseidon(sk)` — the note owner's "public key", a SNARK-friendly
  hash of the spending key
- `randomness`: Field element
- `assigned`: 0 or 1
- `redeemerHash`: Poseidon(redeemerId) or 0 if unassigned

### Commitment

```
cm = Poseidon(value, expiryEpoch, ownerPkHash, randomness, assigned, redeemerHash)
```

### Nullifier

```
nf = Poseidon(sk, cm)   // binds the spend to knowledge of sk
```

### Owner Key — Poseidon-based (PoC simplification)

The note owner's identity is `ownerPkHash = Poseidon(sk)` where `sk` is a random
field element. Ownership is proved in-circuit by showing `Poseidon(sk) ==
ownerPkHash` — pure hashing, no elliptic curve in-circuit. This collapses the
~10K-constraint BabyJubjub scalar multiplication that a `pk = sk·G` scheme would
require to a single ~150-constraint Poseidon hash, dropping total assign/redeem
circuit size from ~25K to ~5K constraints and bringing browser-WASM proving on
mobile into the ~1s p50 range (see §8.7).

This deviates from the original whitepaper §4.5.1, which specified a BabyJubjub
keypair. The whitepaper is being updated to reflect this optimization. The
security argument relies on Poseidon collision-resistance + Groth16 soundness,
which is adequate for the closed-loop permissioned voucher protocol.

### Merkle Tree

- Incremental append-only Merkle tree, depth 20 (~1M capacity)
- On-chain: frontier (20 hashes) + current root + leaf count
- Hash function: Poseidon (2-to-1) — must match the circuit
- Recent roots ring buffer: last 100 roots stored, any accepted as valid
  (allows concurrent tx without front-running issues)

### Epochs and Nullifiers

- Epoch size: configurable block count (e.g. ~30 days of blocks)
- `currentEpoch()` = `block.number / EPOCH_SIZE`
- Nullifiers stored in `mapping(uint32 => mapping(bytes32 => bool)) nullifiers`
- Expiry check: `currentEpoch() <= note.expiryEpoch`
- GC: `reclaimEpoch(e, sink)` callable when `currentEpoch() >= e + 2`; transfers
  `minted[e] - spent[e] - reclaimed[e]` stablecoin to `sink`, bumps
  `reclaimed[e]`, and may delete the nullifier set to refund storage

### Stablecoin Accounting

```
deposited: uint256        // total stablecoin pulled in via buyAndCreate
withdrawn: uint256        // total stablecoin paid out via operator withdraw
minted[epoch]: uint256    // total face value minted expiring in epoch
spent[epoch]: uint256     // total face value redeemed from epoch (plaintext, no AHE)
reclaimed[epoch]: uint256 // unspent face value reclaimed after expiry
credit[operator]: uint256 // redeemable balance per operator (address-keyed)
```

Solvency invariant (exact equality, since every voucher is 1:1 stablecoin-backed at
creation): `sum_e(minted[e] - spent[e] - reclaimed[e]) + sum_op(credit[op]) == deposited - withdrawn`.

`reclaimed[epoch]` lets the admin sweep expired-unspent face value back to a sink
(burn / treasury / re-issuance budget) without inflating `spent` accounting.

---

## 5. Circom Circuits

All circuits use BN254 scalar field. Hash function: Poseidon from circomlib.
Merkle tree: MerkleProof from circomlib (depth 20, Poseidon hash).

### 5.1 Create Circuit

**Prover**: Buyer (in Dapp A, at purchase time)
**Purpose**: Prove commitment is well-formed and matches public value/epoch (the
contract enforces 1:1 stablecoin backing via `transferFrom(msg.sender, , value)`
in the same tx).

**Private inputs**:
- `ownerPkHash` — note owner's Poseidon-based pk (= `Poseidon(sk)`)
- `randomness` — commitment randomness

**Public inputs**:
- `cm` — commitment (output of Poseidon)
- `value` — face value
- `expiryEpoch` — expiry epoch

**Constraints**:
1. `assigned == 0`
2. `redeemerHash == 0`
3. `cm == Poseidon(value, expiryEpoch, ownerPkHash, randomness, 0, 0)`

~300 constraints (Poseidon-6 inputs).

### 5.2 Assign Circuit

**Prover**: Chat user / note owner (in Dapp B); the proof is then handed off via
deep link to a relay operator (Dapp C) who submits the on-chain tx.
**Purpose**: Consume unassigned note, produce assigned dest note + unassigned change note.

**Private inputs**:
- `sk` — spending secret key (field element)
- `value` — input note value
- `expiryEpoch` — input note expiry
- `randomness` — input note randomness
- `pathElements[20]` — Merkle path
- `pathIndices[20]` — Merkle path direction bits
- `destValue` — destination note value
- `destOwnerPkHash` — destination note owner's pkHash (= Poseidon(sk_dest))
- `destRandomness` — destination note randomness
- `redeemerId` — redeemer identity (preimage of redeemerHash)
- `changeRandomness` — change note randomness

**Public inputs**:
- `root` — Merkle tree root
- `nullifier` — nullifier of consumed note
- `expiryEpochPub` — expiry epoch (for contract to check)
- `cmDest` — commitment of destination note
- `cmChange` — commitment of change note

**Constraints**:
1. Ownership: `ownerPkHash = Poseidon(sk)` (single Poseidon hash; pure-hash replacement for EC scalar mul)
2. Input note reconstruction: `cmIn = Poseidon(value, expiryEpoch, ownerPkHash, randomness, 0, 0)`
3. Merkle membership: `MerkleProof(cmIn, pathElements, pathIndices) == root`
4. Nullifier: `nullifier == Poseidon(sk, cmIn)`
5. Input unassigned: `assigned == 0` (enforced by construction in step 2)
6. Value conservation: `destValue + changeValue == value` where `changeValue = value - destValue`
7. `destValue > 0`
8. Dest note: `redeemerHash = Poseidon(redeemerId)`
   `cmDest == Poseidon(destValue, expiryEpoch, destOwnerPkHash, destRandomness, 1, redeemerHash)`
9. Change note: `cmChange == Poseidon(changeValue, expiryEpoch, ownerPkHash, changeRandomness, 0, 0)`
10. Epoch matches public: `expiryEpoch == expiryEpochPub`

~5K constraints (Poseidon hashes + Merkle path; no EC operations).

### 5.3 Redeem Circuit

**Prover**: Community admin (in Dapp B); the proof is then handed off via deep link
to a relay operator (Dapp C) who submits the on-chain tx.
**Purpose**: Consume assigned note, credit operator, produce change note (same
community owner).

**Private inputs**:
- `sk` — spending secret key (field element)
- `value` — input note value
- `expiryEpoch` — input note expiry
- `randomness` — input note randomness
- `redeemerHash` — redeemer hash in the note
- `redeemerId` — redeemer identity (preimage)
- `pathElements[20]` — Merkle path
- `pathIndices[20]` — Merkle path direction bits
- `changeRandomness` — change note randomness
- `changeValue` — value remaining after partial redeem

**Public inputs**:
- `root` — Merkle tree root
- `nullifier` — nullifier of consumed note
- `expiryEpochPub` — expiry epoch
- `redeemValue` — value being redeemed (credited to operator)
- `cmChange` — commitment of change note
- `operatorId` — target operator (for domain binding)

**Constraints**:
1. Ownership: `ownerPkHash = Poseidon(sk)`
2. Input note: `cmIn = Poseidon(value, expiryEpoch, ownerPkHash, randomness, 1, redeemerHash)`
3. Merkle membership: `MerkleProof(cmIn, pathElements, pathIndices) == root`
4. Nullifier: `nullifier == Poseidon(sk, cmIn)`
5. Input assigned: `assigned == 1` (enforced by construction in step 2)
6. Redeemer check: `redeemerHash == Poseidon(redeemerId)`
7. Value conservation: `redeemValue + changeValue == value`, `redeemValue > 0`
8. Change note (same owner, same redeemer, same expiry):
   `cmChange == Poseidon(changeValue, expiryEpoch, ownerPkHash, changeRandomness, 1, redeemerHash)`
   (If `changeValue == 0`, `cmChange` is a dummy commitment that won't be appended)
9. Epoch matches public: `expiryEpoch == expiryEpochPub`

~5K constraints.

### 5.4 Trusted Setup

Per-circuit ceremony using snarkjs powers-of-tau + circuit-specific phase 2.
For PoC, a single-contributor ceremony is acceptable. Production would need MPC.

---

## 6. Solidity Smart Contracts

### 6.1 Contract Structure

```
contracts/
  VoucherPool.sol          -- main contract (tree, nullifiers, lifecycle)
  IncrementalMerkleTree.sol -- Poseidon Merkle tree library
  PoseidonT3.sol           -- Poseidon hash (2 inputs) — from circomlibjs
  PoseidonT7.sol           -- Poseidon hash (6 inputs) — for note commitments
  ICreateVerifier.sol      -- interface
  IAssignVerifier.sol      -- interface
  IRedeemVerifier.sol      -- interface
```

Verifier contracts (`CreateVerifier.sol`, `AssignVerifier.sol`, `RedeemVerifier.sol`)
are auto-generated by `snarkjs zkey export solidityverifier`. They use `ecPairing`
(precompile at `0x08`) which is available on pallet-revive.

### 6.2 VoucherPool.sol — Key Functions

```solidity
// --- Voucher creation (permissionless, called by Dapp A) ---
function buyAndCreate(
    uint256 cm,
    uint256 value,
    uint32 expiryEpoch,
    uint256[8] calldata proof
) external
    // require(expiryEpoch > currentEpoch())
    // Verifies create proof binding (cm, value, expiryEpoch) — well-formedness only
    // stablecoin.transferFrom(msg.sender, address(this), value)
    // Appends cm to tree
    // deposited += value; minted[expiryEpoch] += value

// --- Assign (called by relay operator via Dapp C, on behalf of chat user) ---
function assign(
    uint256 nullifier,
    uint256 expiryEpoch,
    uint256 cmDest,
    uint256 cmChange,
    uint256 root,
    uint256[8] calldata proof
) external
    // Permissionless: anyone can submit a valid assign proof. msg.sender is NOT
    // referenced anywhere — the proof binds everything the contract cares about.
    // Verifies assign proof against an accepted root (recent-roots ring buffer)
    // require(!nullifiers[expiryEpoch][nullifier])
    // Records nullifier in nullifiers[expiryEpoch]
    // Appends cmDest and cmChange to tree (cmChange may be a dummy if change==0)

// --- Redeem (called by relay operator via Dapp C) ---
function redeem(
    uint256 nullifier,
    uint256 expiryEpoch,
    uint256 redeemValue,
    uint256 cmChange,
    uint256 root,
    uint256 operatorId,
    uint256[8] calldata proof
) external
    // operator = address(uint160(operatorId)); require(isOperator[operator])
    // Verifies redeem proof against accepted root
    // require(!nullifiers[expiryEpoch][nullifier])
    // Records nullifier; credit[operator] += redeemValue
    // Appends cmChange to tree (if changeValue > 0)
    // spent[expiryEpoch] += redeemValue
    // NB: msg.sender (the relay) is NOT credited; only `operatorId` from the proof's
    //     public inputs is. The relay cannot misroute funds.

// --- Operator withdraw (called by anyone with credit; Dapp C operator) ---
function withdraw(uint256 amount) external
    // require(credit[msg.sender] >= amount)
    // credit[msg.sender] -= amount; withdrawn += amount
    // stablecoin.transfer(msg.sender, amount)

// --- Admin functions ---
function registerOperator(address op) external onlyAdmin
    // isOperator[op] = true   (operatorId = uint256(uint160(op)))
function unregisterOperator(address op) external onlyAdmin
function reclaimEpoch(uint32 epoch, address sink) external onlyAdmin
    // require(currentEpoch() >= epoch + 2)
    // unspent = minted[epoch] - spent[epoch] - reclaimed[epoch]
    // reclaimed[epoch] += unspent; withdrawn += unspent
    // stablecoin.transfer(sink, unspent)
    // (Optional) delete nullifiers[epoch] to refund storage
```

Notes: `buyAndCreate` is fully open; `cm` replay is harmless (the replayer
pays their own stablecoin). `operatorId = uint256(uint160(op))` — the redeem
proof binds the credit recipient cryptographically; the relay cannot reroute.
`withdraw` gates on `credit > 0`, not on a role.

### 6.3 Incremental Merkle Tree

Standard incremental Merkle tree (Semaphore/Tornado Cash pattern):
- Depth 20, zero-values pre-computed per level
- `filledSubtrees[20]` — frontier hashes
- `roots[100]` — ring buffer of recent roots
- `nextIndex` — next leaf position
- `_insert(uint256 leaf)` — append and update root

Hash function: Poseidon. We use the `poseidon-solidity` library (or generate from
circomlibjs). The same constants must be used in circuits and contracts.

### 6.4 Gas Estimates (pallet-revive)

| Operation | Estimated gas |
|---|---|
| Groth16 verify (ecPairing) | ~200K |
| Poseidon hash (2-in) | ~15K |
| Merkle insert (20 levels) | ~300K (20 Poseidon hashes) |
| buyAndCreate total (verify + 1 insert + ERC20 transferFrom) | ~600K |
| assign total (verify + 2 inserts) | ~900K |
| redeem total (verify + 1-2 inserts) | ~700K |
| withdraw (ERC20 transfer) | ~80K |

These are EVM-equivalent estimates. Actual pallet-revive costs may differ but should
be in the same order of magnitude since bn128 precompiles are native.

---

## 7. Stablecoin via pallet_assets

### 7.1 Asset Creation

Create a test stablecoin on Paseo Asset Hub using pallet_assets:

```
asset ID:    TBD (e.g., 1984 — convention for USDT on Asset Hub)
name:        "Test USDC"
symbol:      "tUSDC"
decimals:    6
admin:       issuer account
```

Created via polkadot-api or polkadot.js from the dapp's admin panel,
calling `assets.create()` + `assets.setMetadata()` + `assets.mint()`.

### 7.2 Contract Integration

Paseo Asset Hub exposes pallet_assets tokens to pallet-revive contracts via an
**ERC20 assets precompile**. Each asset ID maps to a deterministic contract address.
The Solidity contract calls standard ERC20 `transferFrom` / `transfer` on this address.

```solidity
IERC20 public stablecoin;  // set to the precompile address for our asset ID

function buyAndCreate(uint256 cm, uint256 value, uint32 expiryEpoch, uint256[8] calldata proof) external {
    require(createVerifier.verifyProof(proof, [cm, value, expiryEpoch]));
    stablecoin.transferFrom(msg.sender, address(this), value);
    _insert(cm);
    deposited += value;
    minted[expiryEpoch] += value;
    emit VoucherCreated(cm, value, expiryEpoch, _leafIndex());
}
```

**Risk**: The ERC20 precompile for pallet_assets may not yet be live on Paseo Asset Hub.
Fallback: deploy a simple ERC20.sol mock. The contract interface remains identical.

### 7.3 Fallback: Solidity ERC20

If the assets precompile isn't available, deploy a minimal ERC20:

```solidity
contract TestUSDC is ERC20 {
    constructor() ERC20("Test USDC", "tUSDC") {
        _mint(msg.sender, 1_000_000 * 1e6);
    }
}
```

---

## 8. Three Vanilla-JS Dapps

Three browser apps, each scoped to one role, plus a shared `core` ES module. No
framework. Built with Vite (vanilla template). The three apps are chained together
by deep links (URL args) so the user-facing flow is one-click per hop and matches
how the future production system will work across web (purchaser, operator) +
mobile (chat dapp inside simplex-chat).

**Signing model summary**:
- Dapp A (Purchaser): EVM wallet via EIP-6963 (MetaMask, Talisman EVM, SubWallet EVM)
- Dapp B (Chat): NO signer, NO tx submission — proof generation + read-only chain
  reads only. Mirrors the chat-user model where the user holds no crypto.
- Dapp C (Relay Operator): EVM wallet via EIP-6963 — signs assign + redeem on
  behalf of chat users, and withdraw for itself.

### 8.1 Repo Layout

```
community-credits-poc/
  circuits/                  # circom sources + build artifacts
  contracts/                 # Hardhat project
  packages/
    core/                    # shared ES module (browser + node)
      src/
        poseidon.js          # circomlibjs Poseidon wrapper
        crypto.js            # sk generation, ownerPkHash = Poseidon(sk),
                             # commitment + nullifier derivation
        note-codec.js        # encode/decode notes + assign + redeem bundles
        handoff.js           # buildImportLink, buildAssignLink, buildRedeemLink, parseDeepLink
        proof.js             # proveCreate, proveAssign, proveRedeem
        contract-evm.js      # ethers VoucherPool bindings (signing + reads via eth-rpc)
        contract-papi.js     # polkadot-api event indexing + read-only state via substrate RPC
        eip6963.js           # multi-wallet discovery (MetaMask / Talisman EVM / SubWallet EVM / Nova mobile / SubWallet mobile)
        qr.js                # QR render + camera scan (browser only)
        store.browser.js     # IndexedDB note store
        store.node.js        # in-memory note store (for the test harness)
        identity.js          # community id ↔ redeemerHash
        index.js             # re-exports; conditional store via package "exports"
    purchaser/               # Dapp A  (EVM signer)
      index.html
      src/main.js
      vite.config.js
    chat/                    # Dapp B  (no signer; user + community admin modes)
      index.html
      src/main.js
      vite.config.js
    relay/                   # Dapp C  (EVM signer; handles assign + redeem + withdraw)
      index.html
      src/main.js
      vite.config.js
  test/
    e2e/
      flow.test.mjs          # node-only end-to-end driver
  pnpm-workspace.yaml        # workspace pinning
```

`core` is imported by all three dapps and by the Node test harness. The DOM-free
parts of `core` (everything except `store.browser.js` and `eip6963.js`) run
unmodified under Node. The chat dapp imports `contract-papi.js` but NOT
`contract-evm.js` or `eip6963.js` — it has no signing capability at all.

### 8.2 Dapp A — Purchaser (future web dapp)

Audience: anyone who wants to buy a voucher with stablecoin.

Preconditions: buyer has a browser extension wallet (MetaMask / Talisman /
SubWallet) with an EVM account holding tUSDC (face value) and PAS (gas). The
dapp does not provision wallets or fund them.

> **Future**: PAS is a PoC-only requirement. In production, Asset Hub's
> `pallet_asset_conversion_tx_payment` lets gas be paid in tUSDC; the same
> applies to the relay operator in Dapp C.

Wallet connect: **EIP-6963** with `window.ethereum` fallback after 100 ms (for
in-app browsers that haven't adopted EIP-6963); sniffs `isMetaMask` /
`isTalisman` / `isSubWallet` / `isNovaWallet` for the display name. Tested
desktop: MetaMask, Talisman EVM, SubWallet EVM. Tested mobile in-app browsers:
Nova Wallet (Android + iOS), SubWallet mobile (Android + iOS).

Views:
1. **Connect** — wallet picker; shows PAS + tUSDC; chain switch to Paseo Asset
   Hub (chainId `420420417`) via `wallet_switchEthereumChain`.
2. **Buy voucher** (= minting) — form (`value`, `expiryEpoch`); dapp generates
   a fresh per-voucher note key `sk` (random field element; `ownerPkHash =
   Poseidon(sk)`) + randomness, derives `cm`, runs `proveCreate`, then signs
   `approve` + `buyAndCreate` from the connected wallet.
3. **Result** — note rendered as link `https://chat/?import=<base64url-note>`
   AND as a QR. Same-device walkthrough = click; cross-device = scan from the
   chat dapp on a phone. Payload carries `sk`.

### 8.3 Dapp B — Chat (will be folded into simplex-chat mobile app)

Audience: end-users holding vouchers AND community admins. Two modes via header
toggle (production mobile app will infer mode from identity / SimpleX address).

**Mobile-first** (390px portrait), runs inside Nova / SubWallet mobile in-app
browsers but **never connects to a signer**. The chat dapp:
- Holds owner keys locally — random `sk` per profile, plus zero or more
  community keys — stored in IndexedDB (PoC: unencrypted).
- Generates assign + redeem ZK proofs via snarkjs in a Web Worker.
- Reads chain read-only via polkadot-api: `pallet_revive::ContractEmitted`
  for events (with ABI-decoded EVM logs) + `ReviveApi::call` for state.
  polkadot-api over read-only ethers is chosen because the production
  simplex-chat target benefits from smoldot light-client integration later.
- Hands every chain-touching action to the relay dapp via link/QR.

Identity model:
- **User key**: one random `sk` per profile, `pkHash = Poseidon(sk)`.
- **Community key(s)**: each community admin holds random `sk_community`.
  Community publishes `(communityId, communityPkHash)` where
  `communityPkHash = Poseidon(sk_community)`. Assigners use
  `redeemerHash = Poseidon(communityId)` and `communityPkHash` as
  `destOwnerPkHash`. A single chat profile may hold many community keys.

Views:
1. **My vouchers** (user mode) — unspent notes from the indexer; header
   **Scan QR** button (camera via `getUserMedia`) + paste-link fallback.
2. **Assign** — select note, paste/scan `communityId`, enter `destValue` and
   destination pubkey. `proveAssign` in worker → `https://relay/?assign=...`
   as button + QR. Chat polls chain; on success renders the
   `?community-import=...` link + QR.
3. **Community inbox** (community-admin) — notes received via
   `?community-import=...` plus event-recovered notes; status
   verified-on-chain / pending / spent.
4. **Redeem** (community-admin) — pick notes + operator (list via polkadot-api)
   + `redeemValue`. `proveRedeem` in worker → `https://relay/?redeem=...` as
   button + QR. Chat polls for outcome.

Handlers (deep link or QR on load / scan):
- `?import=<note>` → user store + jump to assign with note preselected
- `?community-import=<note>&community-id=<id>` → community-admin mode for
  `id`; store in inbox; verify on-chain before marking spendable

### 8.4 Dapp C — Relay Operator

Audience: an operator that (a) relays chat-user txs (assigns + redeems) paying
gas, and (b) collects stablecoin income from redemptions credited to its
address.

Wallet connect: same EIP-6963 path as Dapp A. Typically desktop, but the dapp
is responsive and works inside mobile in-app browsers.

Views:
1. **Connect** — wallet picker. For redeems, the connected address must equal
   `operatorId = uint256(uint160(address))`; the dapp rejects mismatches
   client-side before asking for a signature.
2. **Queue** — incoming `?assign=...` / `?redeem=...` bundles (deep link, QR
   scan via header **Scan QR** button, or paste). Each row: kind, public
   inputs, and a Submit button or rejection reason (mismatched-operator,
   stale-root). Submit triggers `pool.assign` / `pool.redeem` from the
   operator's wallet.
3. **Credit + Withdraw** — shows on-chain `credit[operator]`; calls
   `pool.withdraw(amount)`.
4. **Settings** — auto-submit toggle for assigns (on by default for the demo).

The relay never generates proofs and cannot tamper with public inputs (any
change invalidates Groth16 verification on chain).

### 8.5 Deep-Link Formats

All payloads are msgpack-encoded then base64url. Compact, URL-safe, no padding.

Note (carried in `?import=` and `?community-import=`):
```
NoteV1 = {
  v: uint64,        // value
  e: uint32,        // expiryEpoch
  o: bytes32,       // ownerPkHash (= Poseidon(sk))
  r: bytes32,       // randomness
  a: 0 | 1,         // assigned
  h: bytes32,       // redeemerHash
  sk: bytes32?      // secret (omitted when forwarding to community inbox)
}
```

Assign bundle (carried in `?assign=`):
```
AssignV1 = {
  fn: "assign",
  nf: bytes32,      // nullifier
  e: uint32,        // expiryEpoch
  cd: bytes32,      // cmDest
  cc: bytes32,      // cmChange
  rt: bytes32,      // root
  pi: [bytes32 × 8] // proof
}
```

Redeem bundle (carried in `?redeem=`):
```
RedeemV1 = {
  fn: "redeem",
  nf: bytes32,
  e: uint32,
  v: uint64,        // redeemValue
  cc: bytes32,      // cmChange
  rt: bytes32,      // root
  op: bytes20,      // operator address (operatorId = uint256(uint160(op)))
  pi: [bytes32 × 8] // proof
}
```

Sizes: note ≈ 120 bytes raw → ~160 base64url chars. Assign bundle ≈ 360 bytes →
~480 base64url chars. Redeem bundle ≈ 380 bytes → ~510 base64url chars. All fit
comfortably in a URL.

**QR codes**: each handoff URL is also rendered as a QR. Capacity check:
- Note URL (~200 chars including host): QR version 9, ECC level M → fits cleanly,
  scans at ~3 cm on a phone screen.
- Redeem URL (~560 chars): QR version 15-17, ECC level L → still scans reliably
  at ~5 cm; we use level L (lowest error correction) since the screen-to-camera
  channel is clean.
QR rendering is done in `core/qr.js` (wraps `qrcode` for render, `qr-scanner`
for camera input). Both libraries are ESM, ~30 KB each gzipped.

### 8.6 Shared Core — Public Surface

```js
// packages/core/src/index.js

// crypto + identity (pure, browser + node)
export { generateKeypair, deriveCommitment, deriveNullifier } from './crypto.js'
export { redeemerHashFromId } from './identity.js'

// codec + handoff (pure)
export { encodeNote, decodeNote, encodeAssign, decodeAssign, encodeRedeem, decodeRedeem } from './note-codec.js'
export { buildImportLink, buildCommunityImportLink, buildAssignLink, buildRedeemLink, parseDeepLink } from './handoff.js'

// QR (browser only; falls back to no-op in node)
export { renderQR, scanQRFromCamera, scanQRFromImage } from './qr.js'

// proving (pure, async)
export { proveCreate, proveAssign, proveRedeem } from './proof.js'

// chain access — EVM signing path (purchaser, relay)
export { discoverProviders, connectEvm } from './eip6963.js'
export { sendBuyAndCreate, sendAssign, sendRedeem, sendWithdraw } from './contract-evm.js'

// chain access — read-only (chat, also reused by signers for reads)
export { connectReadOnly, getWitness, getCurrentEpoch, getOperatorList, subscribeContractEvents } from './contract-papi.js'

// local store
export { openStore } from './store.js'  // conditional: browser → IndexedDB, node → memory
```

All ZK and chain calls are async; all crypto deterministic given inputs (randomness
is taken via a passed-in `rng` so tests are reproducible). Each dapp imports only
the entry points it needs:
- Dapp A (purchaser): everything from the EVM signing path + proveCreate + store
- Dapp B (chat): proveAssign + proveRedeem + read-only chain + handoff + store —
  **never** imports `eip6963.js` or `contract-evm.js` (linting rule enforces it)
- Dapp C (relay): EVM signing path + sendAssign + sendRedeem + sendWithdraw +
  read-only chain (for state checks); does NOT import `proof.js`

### 8.7 Client-Side ZK Proving

snarkjs (ESM) in browser via WASM, **executed inside a Web Worker** so the UI
stays responsive (cold start loads wasm + zkey once per session, cached in a
service worker). Circuits are trimmed to ~5K constraints (assign/redeem) and
~300 (create) via §4's Poseidon-based owner key.

Estimated wall-clock per proof (snarkjs WASM):

| Circuit | Desktop | Mobile p50 | Mobile p95 |
|---|---|---|---|
| Create (~300 c) | ~0.2 s | ~0.5–1 s | ~1 s |
| Assign / Redeem (~5K c) | ~0.5 s | ~1 s | 2–3 s |

Artifact sizes per circuit: zkey ~3 MB (assign/redeem) / ~0.5 MB (create);
witness wasm ~0.5 MB. Dapp A ships Create only; Dapp B ships Assign + Redeem;
Dapp C ships none.

**Production swap-in (out of PoC scope)**: when the chat dapp moves inside the
native simplex-chat app, swap snarkjs for **rapidsnark** or **mopro** via FFI
for ~3–5× more (assign/redeem ~200–500 ms p50). Same circuits, same zkeys.

#### 8.7.1 Mobile Bench Page

Served behind `?bench=1`: runs each circuit 10× with fixed inputs, records
p50/p95/p99, writes a markdown table to clipboard / `test/mobile-bench.md`.
Targets: one iPhone 13/14 + one Snapdragon-7-gen Android, both inside Nova
and SubWallet in-app browsers. Acceptance thresholds: Create < 1 s p95;
Assign / Redeem ~1 s p50, < 3 s p95. Mitigations on miss: further constraint
trim, WASM-SIMD/threads, or production-side native prover swap.

`snarkjs.groth16.fullProve(input, wasmFile, zkeyFile)` → formatted for the Solidity
verifier's `verifyProof(uint[2], uint[2][2], uint[2], uint[N])`.

### 8.8 Local Note Store

`store.browser.js` (IndexedDB via `idb-keyval`) and `store.node.js` (Map-backed)
expose the same async API:

```ts
interface StoredNote {
  commitment: string;       // hex
  value: bigint;
  expiryEpoch: number;
  ownerPkHash: string;      // hex (= Poseidon(sk))
  randomness: string;       // hex
  assigned: 0 | 1;
  redeemerHash: string;     // hex
  leafIndex: number;        // updated by event indexer
  status: 'active' | 'spent' | 'expired';
  scope: 'self' | { communityId: string };   // user vs. community-admin
}
```

The shared event indexer (`listenAndIndex`) watches `VoucherCreated` / `Assigned`
/ `Redeemed` events to maintain `leafIndex` and to mark notes spent when their
nullifiers appear.

---

## 9. Development Phases

### Phase 1: Circuits + Trusted Setup (~3-5 days)

1. Set up circom project with circomlib dependency
2. Implement Poseidon commitment template (6-input)
3. Implement Poseidon-based owner-key derivation (`pkHash = Poseidon(sk)`)
4. Implement nullifier derivation template (`nf = Poseidon(sk, cm)`)
5. **Create circuit** — wire up and test
6. **Assign circuit** — wire up with Merkle proof, test
7. **Redeem circuit** — wire up and test
8. Powers-of-tau ceremony (use existing ptau file for BN254)
9. Per-circuit phase-2 setup, export verification keys
10. Generate Solidity verifier contracts via snarkjs
11. Unit tests: generate witness, prove, verify for each circuit

### Phase 2: Smart Contracts (~3-5 days)

1. Set up Hardhat project (reuse corevo_sc patterns)
2. Implement PoseidonT3.sol and PoseidonT7.sol (generate from circomlibjs)
3. Implement IncrementalMerkleTree.sol (Poseidon-based, depth 20)
4. Implement VoucherPool.sol
   - Merkle tree integration
   - Nullifier storage with epoch bucketing
   - buyAndCreate / assign / redeem with proof verification
   - Stablecoin pull via ERC20 `transferFrom` in `buyAndCreate`
   - Operator registry + credits + withdrawal
   - Epoch-based expiry + `reclaimEpoch(sink)`
5. Integration: plug in generated verifier contracts
6. Hardhat unit tests on local node
7. Test against pallet-revive local dev node (if available) or directly on Paseo

### Phase 3: Stablecoin Setup (~1 day)

1. Create pallet_assets token on Paseo via polkadot-api script
2. Validate ERC20 precompile accessibility from Solidity
3. If precompile unavailable: deploy ERC20 fallback, mint test tokens
4. Wire VoucherPool constructor to stablecoin address

### Phase 4: Shared Core + Three Vanilla-JS Dapps (~8-10 days)

**4a — `core` (~3 days)**: pnpm workspace; Poseidon + commitment/nullifier;
note codec (msgpack + base64url); deep-link builder/parser (note + assign +
redeem); snarkjs proof wrappers in a Web Worker; EIP-6963 + `window.ethereum`
fallback (MetaMask/Talisman EVM/SubWallet EVM/Nova/SubWallet mobile); ethers
signing bindings (`contract-evm.js`); polkadot-api read-only access
(`contract-papi.js`: `pallet_revive::ContractEmitted` events + `ReviveApi::call`);
QR module (qrcode + qr-scanner; no-op in node); store adapters (IDB/memory);
codec/crypto unit tests.

**4b — Dapp A (~1.5 days)**: Vite vanilla; mobile-first responsive; wallet
picker + chain switch; buy form → proveCreate (worker + progress) → approve +
buyAndCreate; result as `chat?import=...` link + QR.

**4c — Dapp B Chat (~4 days)**: Vite vanilla; mobile-first; **no wallet code
path** (lint enforces); polkadot-api read-only on load; handlers + QR scan
for `?import` and `?community-import`; my-vouchers list from event indexer;
assign flow (proveAssign → `relay?assign=...` link + QR → poll for confirm →
emit `chat?community-import=...`); community-admin toggle + inbox + on-chain
verification; redeem flow (proveRedeem → `relay?redeem=...` link + QR → poll).

**4d — Dapp C Relay (~2 days)**: Vite vanilla; responsive (desktop-first);
wallet picker; `?assign` + `?redeem` handlers + QR scan; per-bundle validation
(recent root; redeem also checks `operatorId == connected`); submit buttons
(auto-submit toggle for assigns); credit balance + withdraw.

**4e — Mobile bench + polish (~1 day)**: `?bench=1` page producing markdown
p50/p95/p99 per circuit; cross-dapp responsive QA; manual smoke pass in
Nova + SubWallet mobile on both platforms.

### Phase 5: Node E2E Harness + Mobile Bench + Deploy (~3-4 days)

1. Build Node E2E harness (`test/e2e/flow.test.mjs`) — see §10 for the spec.
2. Deploy contracts to Paseo Asset Hub; GH Pages deploy (§11); run harness
   against live.
3. Mobile bench (§8.7.1) on iOS + Android targets, both inside Nova and
   SubWallet in-app browsers.
4. Mobile flow demo: Dapp A → Dapp B in Nova (Android) and SubWallet (iOS);
   QR handoff to a desktop Dapp C; chat user never sees a signature prompt.
5. Fix pallet-revive gas/weight or mobile-WASM issues as they appear.

**Total estimate: ~22-28 working days**

---

## 10. Testing Strategy

### Circuit Tests
- Per-circuit: valid witness → proof verifies
- Per-circuit: tampered public input → proof rejects
- Edge cases: zero change value, max value, expired epoch
- Constraint count verification (no unconstrained signals)

### Contract Tests (Hardhat)
- Unit: Merkle tree insert + root correctness
- Unit: Poseidon hash matches circomlib output
- Integration: full lifecycle (buy → assign → redeem → withdraw)
- Revert cases: double-spend (same nullifier), expired note, invalid proof,
  unregistered operator, insufficient stablecoin allowance, stale Merkle root
- Epoch GC: create note, let it expire, `reclaimEpoch(sink)` returns unspent
  face value to sink; accounting equality holds

### Node E2E Harness (`test/e2e/flow.test.mjs`)

Primary integration test. Pure Node, no browser. Uses the same `packages/core`
code paths the dapps use.

Sequence: deploy contracts + stablecoin; provision a buyer signer (tUSDC + gas),
a relay-operator signer (registered, gas), and a community key `sk_community`
+ `communityId`. For each cross-dapp boundary: simulate the proving side via
core, round-trip the deep-link string through `parseDeepLink` into the next
role's in-memory store, simulate the signing side (only on Dapp A buyer and
Dapp C relay; chat-side simulations have no signer attached and any sendTx
call from chat code fails CI).

Assertions: balances (buyer −value, pool +value, operator +redeemValue, pool
zero post-withdraw); nullifiers in correct epoch bucket; root advances
monotonically; `credit[operator]` correct. Negatives: double-spend reverts,
expired note rejected, unregistered operator rejected, tampered proof
rejected, stale-root assign rejected client-side. Epoch GC: short-expiry note
→ fast-forward → `reclaimEpoch`. Deep links: encoded blob == decoded blob
byte-for-byte at every boundary.

Optional Playwright smoke deferred; Node harness is the source of truth.

### Mobile Manual Test Pass

Run once per release on actual hardware:
- Devices: one iPhone 13/14, one Android mid-range (Snapdragon 7-gen or
  equivalent)
- In-app browsers: Nova Wallet, SubWallet mobile (both apps installed and
  funded with PAS + tUSDC on Paseo Asset Hub)
- Scenarios:
  1. Open Dapp A (purchaser) in Nova → connect → buy voucher → QR appears
  2. Open Dapp B (chat) in SubWallet mobile → scan QR from desktop → voucher
     imported → assign flow → relay deep link → confirmation
  3. Mobile-bench page (§8.7.1) records p50/p95 per circuit per device into
     `test/mobile-bench.md`
- Acceptance: every flow completes without errors; no signature prompt in
  Dapp B; benchmark thresholds met (§8.7.1)

---

## 11. Deployment

### Prerequisites
- Paseo testnet PAS from faucet (https://faucet.polkadot.io/)
- Deployer account with PAS (any EIP-6963 wallet on Paseo, chainId 420420417)
- eth-rpc endpoint: `https://eth-rpc-testnet.polkadot.io/` (used by Purchaser + Relay)
- Substrate RPC endpoint: standard Paseo Asset Hub WS endpoint (used by Chat read-only)
- Pre-fund the demo buyer's EVM address with tUSDC via an admin script before the demo

### Deploy Sequence
1. `npx hardhat compile` (plain solc → EVM bytecode; runs under pallet-revive REVM — no resolc/PVM)
2. Deploy `PoseidonT3` (Poseidon(2) for the Merkle tree, from circomlibjs bytecode; `PoseidonT7` is not deployed — commitments arrive as proof public inputs, never hashed on-chain)
3. Deploy `CreateVerifier`, `AssignVerifier`, `RedeemVerifier`
4. Deploy `VoucherPool` (constructor links verifiers + stablecoin address)
5. Create pallet_assets token + mint test supply (or deploy ERC20 mock)
6. Register one or more test operators

`fundPool` is no longer needed — the contract is funded by `buyAndCreate` calls.

### Dapp Hosting

Three static bundles (`packages/{purchaser,chat,relay}/dist`) deployed to
**GitHub Pages** (HTTPS mandatory: mobile in-app dapp browsers refuse signing
on non-HTTPS origins). Two layouts (pick at deploy):
- Subpaths under one origin (simpler; one TLS cert; dapps share IndexedDB)
- CNAMEs per subdomain (`buy.`, `chat.`, `relay.`; cleaner origin separation)

Cross-dapp URLs configured via a single `config.json` (`chatBaseUrl`,
`relayBaseUrl`) so localhost / staging / prod share one codebase. A GitHub
Actions workflow on push to `main` runs `pnpm -r build` then
`actions/deploy-pages@v4`.

---

## 12. Open Risks

| Risk | Impact | Mitigation |
|---|---|---|
| bn128 precompiles not working on Paseo pallet-revive | Groth16 verification fails entirely | Test ecPairing early (phase 2, day 1). Fallback: pure-Solidity BN254 pairing (very expensive but possible) |
| ERC20 assets precompile for pallet_assets not live | Can't use native stablecoin from contract | Deploy ERC20.sol fallback (same interface) |
| Poseidon Solidity implementation gas cost too high | Merkle insert too expensive | Use optimized Poseidon implementation (poseidon-solidity from iden3). Alternatively reduce tree depth to 16 |
| snarkjs WASM prover too slow on mobile | Bad UX for assign/redeem | Circuits already trimmed to ~5K constraints (§4, §5) — targets ~1 s p50 mobile. §8.7.1 benchmark catches regressions on iOS + Android mid-range early. Mitigations: Web Worker (UI stays responsive), WASM-SIMD/threads, further constraint trims; production native chat app swaps in rapidsnark/mopro for 3–5× more |
| Mobile in-app browser WASM memory ceiling (iOS Safari ~1 GB) | Prover crashes on assign/redeem | With ~5K-constraint circuits the prover footprint is ~150 MB peak — comfortably under the ceiling. Profile heap during bench anyway |
| Circumventing BabyJubjub means losing the EC-based signature security argument | Spec deviation vs WP §4.5.1 | WP is being updated to match this optimization; security still rests on Poseidon collision-resistance + Groth16 soundness, adequate for the closed-loop permissioned voucher protocol |
| Nova / SubWallet mobile in-app browser does not emit EIP-6963 announcement | Wallet picker shows empty list | `window.ethereum` fallback path (with `isNovaWallet` / `isSubWallet` sniff) is wired from day one; bench-tested in each app's in-app browser |
| QR code becomes too dense at large bundles | Phone camera cannot scan reliably | Redeem bundle (~560 chars) is the largest; QR version ≤17 still scans at ~5 cm. If we ever exceed this, switch to compressed binary (msgpack already in use; further gain is limited) or split across two QR frames |
| pallet-revive gas metering differs from EVM | Contracts may hit unexpected limits | Test on Paseo early. Adjust gas limits in Hardhat config. |
| Circom Poseidon implementation differs from on-chain Poseidon impl | Commitments don't round-trip; tree state divergence | Use identical params (t=6 for 5-input hash, t=2 for Merkle; same MDS / round constants) for circuit + contract; assert byte-equality on a known test vector in CI |

---

## Appendix: Key Dependencies

```
# Circuits
circom ^2.1             — circuit compiler
circomlib               — Poseidon, MerkleProof, Comparators (no BabyJubjub
                          since owner key is `Poseidon(sk)`)
snarkjs ^0.7            — trusted setup + prover + verifier generation

# Contracts
hardhat ^2.22           — build + test framework
@nomicfoundation/hardhat-toolbox
poseidon-solidity       — on-chain Poseidon (or generate via circomlibjs)
solidity ^0.8.24        — target version (evmVersion: paris)

# Dapps — three workspaces + shared core
vite ^6                 — bundler (vanilla template, no framework)
ethers ^6               — EVM signing path in Purchaser + Relay (eth-rpc proxy)
polkadot-api ^1         — read-only chain access in Chat (pallet_revive events
                          via ContractEmitted + ReviveApi::call); also asset
                          admin scripts
snarkjs (ESM)           — browser-side proving (Purchaser + Chat)
circomlibjs ^0.1        — Poseidon in JS (browser + node)
@msgpack/msgpack ^3     — compact binary encoding for notes / assign / redeem bundles
idb-keyval ^6           — IndexedDB note store (browser entry of `core`)
qrcode ^1.5             — QR rendering (canvas + svg)
qr-scanner ^1.4         — camera-based QR scanning (uses BarcodeDetector where
                          available, WASM decoder fallback)
pnpm workspaces         — share `core` across three dapps + test harness

# Wallet integration (Purchaser + Relay only; Chat has no wallet)
EIP-6963 multi-wallet discovery — implemented in ~50 LoC inside `core/eip6963.js`;
no third-party dependency. Tested against:
  Desktop:
  - MetaMask
  - Talisman (EVM mode enabled)
  - SubWallet desktop (EVM mode enabled)
  Mobile in-app dapp browsers:
  - Nova Wallet (Android + iOS)
  - SubWallet mobile (Android + iOS)

# Test harness
node ^20                — Node E2E driver in `test/e2e/flow.test.mjs`
hardhat node            — local EVM node for harness (or pallet-revive dev node)
```

Explicitly NOT used: Svelte / React / Vue / any UI framework; no copy-paste UX
flows for note / assign / redeem handoff (replaced by deep links); no backend
service for voucher issuance (replaced by permissionless `buyAndCreate`); no
signing or fee payment in the Chat dapp (replaced by relay-operator-paid
submission); PJS extension (no EVM signer — out of scope after dropping the
Substrate-extrinsic path).
