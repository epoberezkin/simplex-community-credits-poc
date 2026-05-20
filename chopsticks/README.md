# Chopsticks + Paseo Asset Hub deployment

## State as of this session

End-to-end status against the chopsticks-forked Paseo Asset Hub:

| Step                                                  | Works |
|-------------------------------------------------------|-------|
| chopsticks boots, eth-rpc bridges, chainId reachable  | ✅    |
| pre-funding EOAs via `import-storage`                 | ✅    |
| resolc → PVM artifacts (`compile-resolc.mjs`)         | ✅    |
| `resolc --link` (PoseidonT3 lib address → PVM blob)   | ✅    |
| Deploy PoseidonT3 + TestUSDC + 3 verifiers + Pool     | ✅    |
| Read calls (eth_call, view methods)                   | ✅    |
| `verifyProof` via eth_call (ecPairing precompile)     | ✅    |
| `mint`, `approve`, `registerOperator` state txs       | ✅    |
| **`buyAndCreate` (verify + transferFrom + insert)**   | ❌    |
| Same for `assign`, `redeem` (same heavy combo)        | ❌    |

`buyAndCreate` fails with pallet-revive `OutOfGas` even with a 100M gas hint.
Each of the three sub-operations runs in isolation (Groth16 verify worked
via `eth_call`, `transferFrom` succeeded as a separate tx), but their
combination exceeds the per-extrinsic ref_time / proof_size budget Paseo
Asset Hub allows for a single pallet_revive::call.

This is a runtime-limit issue, not a contract bug. The same VoucherPool
runs end-to-end on a Hardhat local node in <3s (10/10 steps).

## Fixes for someone continuing the work

In order of effort:

1. **Split buyAndCreate / assign / redeem into two txs each.** Tx A does
   the Groth16 verify + state checks, tx B does the `transferFrom` + tree
   insert. Trade-off: loses atomicity (someone could front-run between A
   and B), so add a per-buyer commit-then-finalize gate. Probably a day
   of work to refactor `VoucherPool.sol` + the harness.

2. **Bump pallet-revive's per-call weight limit on the forked chain.**
   The hard cap comes from `RuntimeBlockWeights::max_block / 2` plus
   per-extrinsic class limits in the Asset Hub runtime config. chopsticks
   supports a `wasm-override` field that swaps the runtime wasm wholesale
   — building a permissive custom runtime takes ~half a day. Storage
   overrides via import-storage won't help here since these are constants.

3. **Recompile circuits at smaller tree depth.** Cutting DEPTH from 20 to
   ~12 reduces Merkle insert from 20 Poseidon calls to 12 (≈40% weight
   saving) and is enough to fit. The circuit constraint count and the
   trusted-setup ptau (we already use ptau-14 which covers ~16K) stay
   the same shape. Workflow:
   - edit `circuits/src/{assign,redeem}.circom` (the `Assign(20)` /
     `Redeem(20)` instantiations), and `IncrementalMerkleTree.sol::DEPTH`
   - re-run `circuits/scripts/{compile,setup,verifiers}.mjs`
   - re-run `contracts/scripts/compile-resolc.mjs`
   - copy the new wasm + zkey into `packages/{purchaser,chat}/public/zk/`

## What's wired up today

- `chopsticks/paseo-asset-hub.yml`
  - prefunds three deterministic-but-PoC-unique EOAs (deployer / buyer / relay)
    on the substrate side via the pallet-revive address mapping
    (`AccountId32 = h160 || 0xee × 12`)
  - tries dwellir + ibp + dotters + turboflakes endpoints in order
  - mints 1M tUSDC (asset id 1984) to Alice, Bob, and the buyer EOA
- `chopsticks/run.sh` — boots chopsticks (ws:8000) and eth-rpc (http:8545)
- `contracts/scripts/compile-resolc.mjs` — PVM compile in ~16 s
- `test/e2e/deploy.mjs` — `loadArtifact` is TARGET-aware:
  - `TARGET=hardhat` (default) → reads `contracts/artifacts/`
  - `TARGET=chopsticks` → reads `contracts/artifacts-pvm/` and links
    PoseidonT3 via `resolc --link`
- `test/e2e/flow.test.mjs` — `TARGET=chopsticks` path uses PoC-unique keys
  and passes an explicit `{ gasLimit: 100_000_000n }` on every state tx
  to bypass `eth_estimateGas` (the bridge under-budgets Groth16+Merkle)

## Lessons that bit us

1. **Hardhat default keys are dangerous on a forked chain.** Account #0's
   nonce-0 CREATE address already has code on real Paseo (someone else used
   the same default key). Result: `pallet-revive::Error::DuplicateContract`
   on the very first deploy. Mitigation: derive deployer keys from
   `keccak256("simplex-community-credits-poc-…")` seeds so they're unique
   to this PoC.

2. **`pkill -9 -f chopsticks` doesn't actually kill it.** The process is
   `node /usr/local/.../chopsticks` and pkill's pattern match misses it.
   Kill by PID instead. The symptom is chopsticks listening on a "wrong"
   port (8001, 8002 …) because the original instance still holds 8000 —
   import-storage changes never take effect for new YAML.

3. **Tree.init() in the constructor blows the per-extrinsic weight on
   pallet-revive.** Pre-compute the 21 zero-subtree hashes and embed them
   as constants in `IncrementalMerkleTree.sol::_zero()` — done. This drops
   the constructor from 20 PoseidonT3.hash calls to a single SSTORE per
   level.

4. **VoucherPool's PVM blob isn't directly deployable**: it's raw ELF
   (`0x7f454c46`) when PoseidonT3 isn't yet linked. Use
   `resolc --link --libraries "poseidon-solidity/PoseidonT3.sol:PoseidonT3=0x…"`
   to relocate against the deployed address and produce a PVM blob
   (magic `0x50564d00`). Implemented in `test/e2e/deploy.mjs::linkLibrariesPvm`.

5. **Solc optimizer hangs on PoseidonT3's inline-asm constant block.**
   Disable in standard-JSON settings (`optimizer.enabled: false`). PVM
   bytecode grows ~3× but resolc's own LLVM `-O z` recovers most at
   deploy time.

## Running it

```bash
# Toolchain (one-time):
#   - circom 2.2.3       → ~/.local/bin/circom
#   - solc 0.8.24        → ~/.local/bin/solc  (symlink from hardhat cache)
#   - resolc 1.1.0       → ~/.local/bin/resolc
#   - eth-rpc 0.14.0     → ~/.local/bin/eth-rpc

# 1. Compile contracts
node contracts/scripts/compile-resolc.mjs       # → contracts/artifacts-pvm/

# 2. Boot the forked chain + bridge
./chopsticks/run.sh                              # ws:8000 + http:8545

# 3. Run the e2e
cd test/e2e && TARGET=chopsticks node flow.test.mjs

# Current expected: deploys + reads + simple txs succeed; heavy txs OOG.
# See "Fixes for someone continuing the work" above.
```
