# Chopsticks + Paseo Asset Hub deployment

## What's ready

- `paseo-asset-hub.yml` — chopsticks config that forks Paseo Asset Hub and
  pre-funds Alice + Bob with PAS, plus tUSDC (asset id 1984). Verified to
  start cleanly: `Paseo Asset Hub RPC listening on http://[::]:8000`.
- `run.sh` — wrapper that boots chopsticks and (if installed) the eth-rpc
  bridge on ports 8000 + 8545.
- `pallet-revive-eth-rpc 0.14.0` — bridge binary, install at
  `~/.local/bin/eth-rpc` from the polkadot-sdk releases page.
- `resolc 1.1.0` — revive Solidity compiler, install at `~/.local/bin/resolc`
  from the paritytech/revive releases page (musl-linux-x86_64 build).
- `contracts/scripts/compile-resolc.mjs` — compiles every Solidity source to
  PVM bytecode via resolc's standard-JSON mode. Outputs into
  `contracts/artifacts-pvm/<ContractName>.json` with the same shape Hardhat
  uses. **Runs in ~16 s for the full project**.

## solc + PoseidonT3 gotcha (resolved)

`poseidon-solidity/PoseidonT3.sol` has a ~50 KB inline-assembly block with
thousands of precomputed BN254 constants. With the solc optimizer ON, solc
enters a pathological case: memory climbs ~1.5 GB/min until it OOM-crashes
(reproduced at 8.5 GB RSS after 5 min). resolc then surfaces this as an
empty `solc error:` diagnostic.

The fix is one line in `compile-resolc.mjs`:

```js
settings: { optimizer: { enabled: false }, ... }
```

PVM bytecode for PoseidonT3 grows from ~70 KB to ~200 KB without the solc
optimizer, but resolc's own LLVM optimizer (`-O z` by default) recovers
most of the loss when the contract is actually deployed.

## End-to-end against the forked chain (still TODO)

The remaining pieces are mechanical now that resolc compiles cleanly:

1. Switch `test/e2e/deploy.mjs` to load PVM artifacts when
   `TARGET=chopsticks`:

   ```js
   const useResolved = process.env.TARGET === 'chopsticks';
   const PVM = resolve(__dirname, '..', '..', 'contracts', 'artifacts-pvm');
   function loadArtifact(name) {
     if (useResolved)
       return JSON.parse(readFileSync(resolve(PVM, `${name}.json`), 'utf8'));
     /* existing hardhat path */
   }
   ```

2. Boot chopsticks + eth-rpc:

   ```bash
   ./chopsticks/run.sh
   # → ws://127.0.0.1:8000  (chopsticks)
   # → http://127.0.0.1:8545 (eth-rpc bridge)
   ```

3. Deploy + run e2e:

   ```bash
   node contracts/scripts/compile-resolc.mjs

   TARGET=chopsticks \
   CHOPSTICKS_RPC_URL=http://127.0.0.1:8545 \
   PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
   node test/e2e/flow.test.mjs
   ```

The chopsticks-side of the harness needs to derive a buyer/relay account from
the deployer key (chopsticks doesn't expose hardhat's 20-prefunded-accounts
shortcut), and the eth-rpc bridge's account-mapping convention needs to be
respected — pallet-revive maps an EVM address to a substrate account via
`AccountId32(keccak256(eth_addr)[12..])`. The deployer + operator must hold
PAS on that derived substrate account, which is what the prefund block in
`paseo-asset-hub.yml` already does for Alice's mapped EVM address; add more
entries there as needed.

## What's already proven

`pnpm --filter test/e2e test` runs the exact same protocol flow end-to-end
in <3 s on a Hardhat local node, hitting every code path in `core` and
`VoucherPool`. Once the PVM artifacts plug into the deploy helper, the same
flow should run against the chopsticks fork (same EVM ABI, same Groth16
`ecPairing` precompile semantics).
