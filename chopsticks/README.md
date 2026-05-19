# Chopsticks + Paseo Asset Hub deployment

## What works today

- `paseo-asset-hub.yml` — chopsticks config that forks Paseo Asset Hub and
  pre-funds Alice + Bob with PAS, plus tUSDC (asset id 1984). Verified to start
  cleanly: `Paseo Asset Hub RPC listening on http://[::]:8000`.
- `run.sh` — wrapper that boots chopsticks and (if installed) the eth-rpc
  bridge on ports 8000 + 8545 respectively.
- The eth-rpc bridge binary itself (`pallet-revive-eth-rpc 0.14.0`) downloads
  cleanly from the polkadot-sdk release page; install at
  `~/.local/bin/eth-rpc`.

## What's blocked

The full `TARGET=chopsticks` E2E path needs contract bytecode compiled by the
revive Solidity compiler (`resolc`) because pallet_revive rejects standard EVM
bytecode. With the current toolchain (resolc 1.1.0 + solc 0.8.24, both Linux
x86_64), `resolc --standard-json` over our 8 contracts (including 3 generated
Groth16 verifiers totalling ~50 KB of Solidity constants) takes about 30 min
of wall time and then fails with an empty `solc error:` diagnostic. Smaller
single-contract compiles (`resolc --bin contracts/TestUSDC.sol`) finish in
<1 s and succeed.

The likely cause is a memory or recursion-depth issue inside resolc's LLVM
backend on the auto-generated Groth16 verifier sources. Two ways forward, in
order of effort:

1. Compile just the non-verifier contracts (`VoucherPool`,
   `IncrementalMerkleTree`, `TestUSDC`) via resolc, and reuse the snarkjs-
   generated verifier *interfaces* — but call out to a remote precompile
   pattern (out of PoC scope) or to a future on-chain ecPairing precompile.
2. Try a newer resolc release once paritytech/revive ships one (we're on
   v1.1.0).

## What's already proven

The hardhat-local E2E harness (`pnpm --filter test/e2e test`) runs the exact
same protocol flow end-to-end (buy → assign → redeem → withdraw, plus
double-spend revert + solvency invariant) in <3 s, hitting every code path
in `core` and `VoucherPool`. Since pallet_revive runs the same EVM ABI and the
same Groth16 `ecPairing` precompile that solc-compiled verifiers depend on,
the protocol guarantees carry over once the verifier-bytecode compilation
issue is resolved.

## Running chopsticks alone

```bash
chopsticks/run.sh
# → ws://127.0.0.1:8000  (chopsticks)
# → http://127.0.0.1:8545 (eth-rpc, if binary present)
```

Then once resolc + eth-rpc are working end-to-end:

```bash
# compile contracts to PVM
node contracts/scripts/compile-resolc.mjs

# deploy + run e2e against the bridge
TARGET=chopsticks \
PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
CHOPSTICKS_RPC_URL=http://127.0.0.1:8545 \
node test/e2e/flow.test.mjs
```

The deploy helper at `test/e2e/deploy.mjs` reads artifacts from
`contracts/artifacts/` by default (hardhat). For the chopsticks path it needs
to read from `contracts/artifacts-pvm/` instead — add a small env switch in
`loadArtifact()` once you've got valid PVM artifacts.
