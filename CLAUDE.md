# CLAUDE.md — session learnings for the community-credits PoC

Spec lives in [`community-credits-poc-plan.md`](./community-credits-poc-plan.md).
Read §3 (simplifications vs whitepaper) and §8 (three-dapp split) before
implementing anything new.

> **Design note — branch `ab/tornado-frontier`.** The PoC was refactored away
> from the original *stream + permissionless checkpoint* design (which only
> SSTORE'd each commitment to an on-chain "stream" and rolled streamed leaves
> into the Merkle root in a separate batched-SNARK `checkpoint()` extrinsic, to
> *avoid* on-chain Poseidon hashing under pallet-revive's native PVM path) to a
> **Tornado-style on-chain frontier**: every buy/assign/redeem folds its
> commitment(s) into the on-chain incremental Merkle tree immediately (20
> on-chain Poseidon(2) hashes per leaf). There is no stream, no checkpoint, no
> checkpoint circuit/verifier, no checkpointer daemon, and no resolc/PVM — the
> contracts run as plain solc EVM bytecode, locally on Hardhat and on
> pallet-revive's **REVM** (EVM interpreter) on a chopsticks-forked Asset Hub.
> Notes are spendable as soon as their tx lands. Measurement showed the
> heavy single-tx (Groth16 verify + transferFrom + 20-Poseidon insert) and the
> tree constructor's 20 Poseidon calls execute fine under REVM, which is why
> the checkpoint indirection was dropped — which brings the implementation
> back in line with the plan: `community-credits-poc-plan.md` §6.3 always
> specified an on-chain incremental Merkle tree (Tornado frontier); the
> stream+checkpoint was a later implementation deviation, now reverted.
> Everything below reflects the current code.

## What works today

- `pnpm --filter e2e test` — full protocol e2e on a Hardhat local node
  (22/22 steps: 2 buys → 4 assigns → 4 redeems → 2 withdraws → solvency →
  double-spend revert (`pool/nullifier`) → unknown-root revert (`pool/root`)
  → codec round-trip). Each buy/assign/redeem inserts its commitment(s) into
  the on-chain tree in the same tx, so notes are spendable immediately.
- `TARGET=chopsticks CHOPSTICKS_RPC_URL=… CHOPSTICKS_WS_URL=… node test/e2e/flow.test.mjs`
  — the same e2e against a chopsticks-forked Paseo Asset Hub via the eth-rpc
  bridge (REVM). 19/19, with per-tx pallet-revive fee measurement.
- `pnpm --filter circuits run build` — compile + Groth16 setup + Solidity
  verifier export for the 3 circuits (create / assign / redeem).
- `pnpm --filter contracts run build` — Hardhat compile (EVM bytecode). The
  SAME bytecode runs locally and under pallet-revive REVM; there is no
  resolc/PVM build step anymore.
- `pnpm --filter @community-credits/{purchaser,chat,relay} build` — three
  Vite bundles. ZK artifacts live in `packages/{purchaser,chat}/public/zk/`.
- `pnpm --filter @community-credits/browser-test test` (Playwright) — full
  2×2×2 flow across all three dapps + adversary cases (7/7). See the
  Playwright note under "chopsticks-specific gotchas" for the Ubuntu-26.04
  browser-install workaround.
- `chopsticks/run.sh` — boots a Paseo Asset Hub fork on ws://127.0.0.1:8000
  (+ eth-rpc bridge on 8545 if installed).

## Toolchain (what's installed and why)

- Node 20.19.4 (`/usr/bin/node`). `import.meta.dirname` doesn't exist —
  use `dirname(fileURLToPath(import.meta.url))`. (chopsticks @latest works on
  Node 22 too; the pinned 1.3.1 hangs there — see chopsticks gotchas.)
- `pnpm@9.15.9` (pnpm 10+ requires Node 22+).
- `circom 2.2.3` — at `~/.local/bin/circom` (prebuilt binary from
  iden3/circom releases). Only needed to rebuild circuits.
- `solc 0.8.24` — Hardhat downloads + caches it automatically; no manual
  install or PATH symlink needed (resolc, which used to require solc in PATH,
  is gone).
- `eth-rpc` (pallet-revive-eth-rpc) — at `~/.local/bin/eth-rpc` (prebuilt
  from polkadot-sdk releases). Bridges chopsticks' substrate RPC to eth_*
  JSON-RPC so ethers can talk to the fork.

There is **no `resolc`** in the toolchain anymore — the contracts are
deployed as EVM bytecode (run by pallet-revive's REVM), not compiled to PVM.

## On-chain Poseidon(2)

The Merkle tree hashes sibling pairs on-chain with Poseidon(2) ("PoseidonT3").
The implementation is **deployed from circomlibjs bytecode**, not a Solidity
library:

- `packages/core/src/poseidon-contract.js` exports
  `poseidonT3Bytecode = poseidonContract.createCode(2)`. `deploy.mjs` deploys
  it with an empty ABI (`new ethers.ContractFactory([], poseidonT3Bytecode, signer)`);
  `VoucherPool`'s constructor takes its address and `IncrementalMerkleTree`
  calls it via `IPoseidonT3.poseidon(uint256[2])`.
- This bytecode is **bit-identical** to `circuits/src/merkle.circom`'s
  Poseidon(2) and `packages/core/src/poseidon.js` (all circomlib/circomlibjs),
  so off-chain mirror root == on-chain `getLatestRoot()` (the e2e asserts this
  after every insert).
- Selector gotcha: `poseidonContract.generateABI(2)` *labels* the input
  `bytes32[2]`, but the deployed bytecode dispatches on
  `poseidon(uint256[2])`. The `IPoseidonT3` interface and all calls use
  `uint256[2]` — confirmed correct by deploy-and-call. No library linking is
  involved (it's a plain contract, called through an interface).

## ethers v6 footguns

- Default `ethers.Wallet` does not auto-increment nonce across sequential
  calls. Wrap with `new ethers.NonceManager(wallet)`.
- `NonceManager` is not a Wallet — use `await signer.getAddress()`, not
  `signer.address`.
- A failed tx that reverts during `eth_estimateGas` still burns a
  NonceManager local nonce. After an expected revert (e.g. the double-spend
  test in the e2e harness), call `signer.reset()` so the next real tx gets
  a fresh nonce from chain.
- Hardhat node survives `SIGTERM`. Use `SIGKILL` in test teardown and
  null out the proc handle.

## snarkjs + Node

- snarkjs leaves worker threads open that prevent `node --test` from
  exiting. Write tests as plain scripts ending in `process.exit(...)`.
  Node 22+ has `--test-force-exit`; we don't.
- snarkjs's `pi_b` is in Fp2 with `[a, b]` ordering. The Solidity verifier
  expects `[b, a]`. The 8-uint flat proof for `verifyProof` is therefore:
  ```js
  [pi_a[0], pi_a[1],
   pi_b[0][1], pi_b[0][0],
   pi_b[1][1], pi_b[1][0],
   pi_c[0], pi_c[1]]
  ```
- The Solidity verifier template lives at
  `node_modules/snarkjs/templates/verifier_groth16.sol.ejs`. Pass it
  explicitly to `zKey.exportSolidityVerifier(zkey, { groth16: tpl })` —
  it's not auto-discovered. Generated contract is named `Groth16Verifier`;
  rename per-circuit via regex.

## Circuits

- circomlib resolves via `-l circuits/node_modules` + bare-style includes:
  `include "circomlib/circuits/poseidon.circom"`. Do not use
  `../../node_modules/...` paths — fragile across pnpm hoisting.
- There are **3 circuits**: create / assign / redeem (the 4th, `checkpoint`,
  was deleted with the stream+checkpoint design). They are agnostic to how
  the tree is updated on-chain — they only prove Merkle membership against a
  root — so the on-chain-insert refactor did **not** change them or require a
  new trusted setup.
- The PoC uses Poseidon-based owner keys (`pkHash = Poseidon(sk)`) — see
  plan §4.5.1. Real WP says BabyJubjub; we trade EC sig security for ~150
  constraints vs 10K. Sizes: create 247 / assign 6859 / redeem 6503
  non-linear constraints — all fit ptau-14, though `setup.mjs` uses the
  vendored `ptau/powersOfTau28_hez_final_17.ptau` (already present).
- Solidity verifier signature: `verifyProof(uint[2] pA, uint[2][2] pB,
  uint[2] pC, uint[N] pubSignals)`. N = public-input count in circuit order
  (create=3, assign=5, redeem=6). The ORDER matches the
  `component main { public [...] }` declaration in the .circom file — get it
  wrong and the verifier silently rejects valid proofs.

## Vite + workspace package gotchas

- Don't alias `@community-credits/core` to `index.js` in `vite.config.js`
  — subpath imports (`@community-credits/core/proof-browser`) then resolve
  to `index.js/proof-browser` and the build fails. Drop the alias; rely on
  the package.json `exports` map via the workspace symlink.
- The package's `index.js` must stay DOM-free AND Node-free. Anything that
  pulls `node:fs` or `node:path` (i.e. `proof.js` with its zkey-loading
  via `readFileSync`) breaks the browser bundle. Subpath imports:
  - `@community-credits/core/proof` → Node (fs-based)
  - `@community-credits/core/proof-browser` → fetches `/zk/*.{wasm,zkey}`
  - `@community-credits/core/store` → conditional node/browser

## Chat dapp invariant

`packages/chat/src/` must have **no** signer or wallet code. Lint check:
```bash
grep -rE "BrowserProvider|eth_requestAccounts|discoverProviders|connectEvm|wallet_" packages/chat/src/
```
must return zero matches (the only acceptable hit is the comment that
documents the rule). The chat dapp reads chain via
`ethers.JsonRpcProvider` (read-only) and rebuilds its tree mirror from
`VoucherCreated` / `Assigned` / `Redeemed` events (inserting commitments in
`leafIndex` order); in production this becomes polkadot-api + smoldot.

## Chopsticks

- Use `@acala-network/chopsticks@latest`, **not** the old 1.3.1 pin — 1.3.1
  silently hangs on Node 22 (boots, never opens the WS port). @latest works.
- Run with `--build-block-mode Instant` so a block is sealed when a tx hits
  the pool (eth-rpc's automine is off). Otherwise tx.wait() hangs — either
  use Instant mode or run a `dev_newBlock` ticker. A long-running fork that
  has been auto-mined for hours can wedge its block-builder; restart fresh.
- Endpoints: prefer `wss://asset-hub-paseo-rpc.n.dwellir.com` (others in the
  yml; `asset-hub-paseo.ibp.network` was unreachable in testing). chopsticks
  tries the list in order — a dead first endpoint makes it hang, so pin the
  reachable one with `--endpoint` or reorder the yml.
- Balance values must be strings if > 2^53 - 1
  (`free: '1000000000000000000'`). Same for any u128 storage value.
- Startup signal: log line `Paseo Asset Hub RPC listening on …:8000`. Grep
  case-insensitively (`grep -qi listening`).
- SQLite cache at `chopsticks/*.sqlite*` is gitignored. Delete to force a
  fresh fetch of chain state.
- Asset id 1984 is the USDT convention on Asset Hub. To prefund a test
  account with tUSDC, add to `Assets.Account` and bump
  `Assets.Asset[1984].{accounts, supply}` in the import-storage block.
- pallet-revive maps an EVM address to a substrate AccountId32 by suffix
  padding: `h160 || 0xEE × 12`. Operators / buyers must hold PAS on that
  derived account for the eth-rpc bridge to let them pay gas; the
  fee meter reads `system.account` on the same derived address.

## Test harness (Bash tool) quirks

- `cd` does not persist between separate Bash tool calls — the shell
  snapshot fresh-starts each invocation. Use absolute paths or
  `cd path && cmd` in the same call.
- Long `sleep`s + `run_in_background`: the tool prefers
  `until <check>; do sleep N; done` loops with `run_in_background: true`.
- `pkill -f <pattern>` self-matches the calling shell (its argv contains the
  pattern), so `pkill -f chopsticks` can kill your own wrapper. Kill by the
  PID holding the port (`ss -ltnp`) instead.
- The Agent tool needs `git HEAD` to exist (it uses worktrees). Spawning
  an Agent in a fresh repo with no commits fails with
  `Failed to resolve base branch "HEAD"`.

## Files most likely to change

- `community-credits-poc-plan.md` — the spec. Treat as source of truth; §6.3
  already specifies the on-chain incremental Merkle tree this implementation
  uses (the deploy-sequence build note was the only stale bit, now fixed).
- `contracts/contracts/VoucherPool.sol` + `IncrementalMerkleTree.sol` +
  `IPoseidonT3.sol` — protocol surface. Changes cascade to
  `test/e2e/{deploy,flow.test,fees}.mjs`, `tools/deploy.mjs`, and the dapps.
- `circuits/src/*.circom` — circuit changes invalidate the trusted setup;
  re-run `pnpm --filter circuits run build` (compile + ceremony +
  verifier export) and re-copy the `.wasm` + `_final.zkey` artifacts into
  the dapps' `public/zk/` dirs.

## chopsticks-specific gotchas (learned the hard way)

- **Hardhat default keys collide on a forked Paseo.** Account #0's CREATE
  address at nonce 0 already has code on real Paseo (someone else used the
  same key). Deploying from that account errors with
  `pallet-revive::Error::DuplicateContract`. Derive deployer keys from
  PoC-unique seeds — see `tools/keys.mjs` / the `keccak256("simplex-community-credits-poc-…")`
  keys prefunded in `chopsticks/paseo-asset-hub.yml`.

- **eth_estimateGas under-budgets pallet-revive calls.** ethers v6's default
  estimateGas pre-flight returns gas values that pallet-revive's weight
  conversion treats as OutOfGas. Pass `{ gasLimit: 100_000_000n }` explicitly
  on every state-changing tx via `txOpts` / call options.

- **On-chain Poseidon inserts run fine under REVM.** The old design avoided
  on-chain hashing because the combined verify + transferFrom + 20-Poseidon
  insert was believed to blow pallet-revive's per-extrinsic weight under PVM.
  Measurement on a chopsticks-forked Paseo Asset Hub (REVM) showed it
  executes fine: buyAndCreate ~16k, assign ~25k, redeem ~18k pallet-revive
  gas units; the `IncrementalMerkleTree` constructor's 20 Poseidon calls also
  deploy fine (VoucherPool deploy ~3M gas). That is why the stream+checkpoint
  + resolc/PVM machinery was removed. Per-tx cost is independent of tree depth
  (Tornado frontier = constant 20 hashes per insert).

- **eth-rpc binds to IPv6 first.** `[::1]:8545` and `localhost:8545` work;
  `127.0.0.1:8545` may silently time out. The harness uses `localhost`.

- **chopsticks output filename collisions.** `chopsticks/chopsticks.log`
  and `chopsticks/eth-rpc.log` get appended-to forever; delete them
  between runs to make `grep` useful.

- **eth-rpc receipt sqlite gets dirty.** `~/.local/share/eth-rpc/eth-rpc.db*`
  caches block + log records and can throw `UNIQUE constraint failed`
  on a restart. Delete the db files when restarting chopsticks from scratch.

- **Playwright on an unsupported OS (e.g. Ubuntu 26.04).** `playwright install
  chromium` aborts at an OS-support check before downloading. Bypass it with
  `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64` for both the install AND
  the test run (so launch resolves the fallback binary path). The downloaded
  Chrome-for-Testing build is generic-linux and runs headless with the host's
  existing libs — no sudo needed.

## What's NOT done

- Mobile-bench page (`?bench=1` in dapps), real mobile manual pass — out
  of session scope, plan §8.7.1 + §10 spell them out.
- GitHub Pages deploy workflow (plan §11) — README mentions but no
  `.github/workflows/` directory yet.
