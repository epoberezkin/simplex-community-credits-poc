# Chopsticks + Paseo/Polkadot Asset Hub

Local fork of a real Asset Hub so the protocol e2e can run against the actual
pallet-revive runtime — real weights, fees, storage deposits, and the
`bn128`/ecPairing precompile the Groth16 verifiers need.

## Status

End-to-end **works** against a chopsticks-forked Asset Hub via the eth-rpc
bridge: deploy → reads → `buyAndCreate` / `assign` / `redeem` / `withdraw`,
with per-tx fee measurement. The refactored design folds each commitment into
an on-chain Tornado-style Merkle tree inside the user tx (20 on-chain
Poseidon(2) hashes per leaf), and that heavy single-tx executes fine under
pallet-revive's **REVM** — see `../docs/gas-design.md` for the measured fees
(buyAndCreate ~16k, assign ~25k, redeem ~18k pallet-revive gas units).

> Historical note: an earlier design *avoided* on-chain Poseidon (stream +
> permissionless `checkpoint()`) because the combined verify + transferFrom +
> insert was believed to OOG pallet-revive's per-extrinsic budget under its
> native PVM path. Measurement under REVM disproved that, so the contracts now
> deploy as plain EVM bytecode with no resolc/PVM and no checkpoint step.

## Running it

```bash
# toolchain (one-time): circom (rebuild circuits), eth-rpc (the bridge).
#   - eth-rpc  → ~/.local/bin/eth-rpc   (prebuilt from polkadot-sdk releases)
#   No resolc / PVM compile is needed — the e2e deploys EVM bytecode.

# 1. boot chopsticks + the eth-rpc bridge (ws:8000 + http:8545):
CHAIN=paseo bash chopsticks/run.sh        # or CHAIN=polkadot

# 2. run the e2e against it:
cd test/e2e && TARGET=chopsticks node flow.test.mjs
```

Contracts are deployed by `test/e2e/deploy.mjs` (EVM bytecode from the hardhat
build, plus `PoseidonT3` from circomlibjs bytecode); `TARGET=chopsticks` just
points the harness at the eth-rpc bridge and passes an explicit gas limit.

## What's wired up

- `chopsticks/paseo-asset-hub.yml` / `polkadot-asset-hub.yml`
  - prefunds deterministic-but-PoC-unique EOAs (deployer / buyer / relay) on
    the substrate side via the pallet-revive address mapping
    (`AccountId32 = h160 || 0xEE × 12`)
  - mints tUSDC (asset id 1984) to Alice/Bob + the buyer EOAs
- `chopsticks/run.sh` — boots chopsticks (ws:8000) and eth-rpc (http:8545)
- `paseo-fork.yml` — a trimmed config used for fee runs: a single reachable
  endpoint + a pinned block (see "gotchas").

## Gotchas

- **Use `@acala-network/chopsticks@latest`.** The old 1.3.1 pin silently hangs
  on Node 22 (boots, never opens the WS). Run with
  `--build-block-mode Instant` so a block seals when a tx hits the pool
  (eth-rpc's automine is off); otherwise `tx.wait()` hangs. A fork that has
  been auto-mined for hours can wedge its block-builder — restart fresh.
- **Endpoints.** Prefer `wss://asset-hub-paseo-rpc.n.dwellir.com`
  (`asset-hub-paseo.ibp.network` was unreachable in testing). chopsticks tries
  the yml list in order, so a dead first endpoint makes it hang — pin a
  reachable one with `--endpoint` or reorder the list.
- **Hardhat default keys collide on a forked Asset Hub** — account #0's
  CREATE@nonce-0 address already has code there (`DuplicateContract`). The
  configs prefund PoC-unique keys derived from
  `keccak256("simplex-community-credits-poc-…")` (see `tools/keys.mjs`).
- **eth_estimateGas under-budgets pallet-revive** — pass an explicit
  `{ gasLimit: 100_000_000n }` on every state-changing tx (the harness does).
- **eth-rpc binds IPv6 first** — use `localhost:8545`, not `127.0.0.1:8545`.
- **Stale caches** — delete `chopsticks/*.sqlite*` to refetch chain state, and
  `~/.local/share/eth-rpc/eth-rpc.db*` (can throw `UNIQUE constraint failed`)
  when restarting the bridge from scratch.
- **`pkill -f chopsticks` self-matches your shell** — kill by the PID holding
  the port (`ss -ltnp`) instead.
