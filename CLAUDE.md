# CLAUDE.md — session learnings for the community-credits PoC

Spec lives in [`community-credits-poc-plan.md`](./community-credits-poc-plan.md).
Read §3 (simplifications vs whitepaper) and §8 (three-dapp split) before
implementing anything new.

## What works today

- `pnpm --filter test/e2e test` — full protocol e2e on Hardhat local in ~3s
  (10/10 steps: buy → import → assign-prove (chat, no signer) → relay-submit
  → double-spend-revert → redeem-prove → relay-submit → withdraw → solvency
  → codec round-trip).
- `pnpm --filter circuits run build` — compile + Groth16 setup + Solidity
  verifier export for all 3 circuits.
- `pnpm --filter contracts run build` — Hardhat compile (EVM bytecode).
- `node contracts/scripts/compile-resolc.mjs` — resolc → PVM bytecode for
  pallet-revive (16 s, 7 artifacts to `contracts/artifacts-pvm/`).
- `pnpm --filter @community-credits/{purchaser,chat,relay} build` — three
  Vite bundles. ZK artifacts live in `packages/{purchaser,chat}/public/zk/`.
- `chopsticks/run.sh` — boots a Paseo Asset Hub fork on ws://127.0.0.1:8000
  (+ eth-rpc bridge on 8545 if installed).

## Toolchain (what's installed and why)

- Node 20.19.4 (`/usr/bin/node`). `import.meta.dirname` doesn't exist —
  use `dirname(fileURLToPath(import.meta.url))`.
- `pnpm@9.15.9` (specifically; pnpm 10+ requires Node 22+).
- `circom 2.2.3` — at `~/.local/bin/circom` (prebuilt binary from
  iden3/circom releases).
- `solc 0.8.24` — symlinked at `~/.local/bin/solc` pointing at the binary
  hardhat already cached at
  `~/.cache/hardhat-nodejs/compilers-v2/linux-amd64/solc-linux-amd64-v0.8.24+commit.e11b9ed9`.
  resolc requires solc in PATH (versions `>=0.8.0,<=0.8.34`).
- `resolc 1.1.0` — at `~/.local/bin/resolc` (musl-linux-x86_64 from
  paritytech/revive releases).
- `eth-rpc 0.14.0` (pallet-revive-eth-rpc) — at `~/.local/bin/eth-rpc`
  (prebuilt from polkadot-sdk releases).

## Big gotcha: resolc + PoseidonT3 + solc optimizer = OOM

`poseidon-solidity/PoseidonT3.sol` contains a ~50 KB inline-assembly block
with thousands of precomputed BN254 round constants. With the solc
optimizer ON, solc enters a pathological case: RSS climbs ~1.5 GB/min until
OOM-crash. Reproduced at 8.5 GB RSS after 5 min. resolc surfaces the crash
as an empty `solc error:` diagnostic, often after wall-time so long it looks
like the laptop slept.

Fix is one line in `contracts/scripts/compile-resolc.mjs`:
```js
settings: { optimizer: { enabled: false }, ... }
```
PVM bytecode for PoseidonT3 grows ~3× without it (70 KB → 206 KB) but
resolc's own LLVM `-O z` pass recovers most of the loss.

`--disable-solc-optimizer` is NOT accepted as a CLI flag in standard-JSON
mode; it has to go in the settings block. The CLI flag exists for the
`--bin file.sol` mode.

## Other resolc / standard-JSON quirks

- `execFileSync` deadlocks when piping large stdin (>~64 KB) — both input
  and output pipes fill up. Always write input to a tmpfile and pass file
  descriptors: `stdio: [inFd, outFd, 'inherit']`. Symptom: resolc shows 0%
  CPU and ~0 RSS, looks hung.
- resolc 1.x rejects `urls:` in standard-JSON sources entirely with
  `missing field 'content' at line 1 column N`, regardless of
  `--allow-paths`. Inline every source as `content:` and drop
  `--allow-paths`; bare imports (e.g. `poseidon-solidity/PoseidonT3.sol`)
  still resolve as long as the import path is a key in the sources map.
  See `compile-resolc.mjs` for the pattern.
- IVerifiers.sol has only interfaces → no bytecode artifact → 8 sources
  produces 7 artifact files. Not a bug.

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
- The PoC uses Poseidon-based owner keys (`pkHash = Poseidon(sk)`) — see
  plan §4.5.1. Real WP says BabyJubjub; we trade EC sig security for ~150
  constraints vs 10K. Total sizes: create 247 / assign 6859 / redeem 6503
  non-linear constraints. ptau 14 (`powersOfTau28_hez_final_14.ptau`,
  19 MB, Hermez ceremony) covers all three with room.
- Solidity verifier signature: `verifyProof(uint[2] pA, uint[2][2] pB,
  uint[2] pC, uint[N] pubSignals)`. N = number of public inputs in circuit
  order (create=3, assign=5, redeem=6). The public-input ORDER matches the
  `component main { public [...] }` declaration order in the .circom file
  — get this wrong and the verifier silently rejects valid proofs.

## Poseidon library deployment

`poseidon-solidity` exports a `library PoseidonT3` (not contract) with
`function hash(uint[2]) public pure` → external-library link required.
- Their official keyless deterministic-deployment proxy fails on a fresh
  hardhat node with `nonce already used`. Don't use it for local tests.
- `test/e2e/deploy.mjs::deployPoseidonT3()` deploys it as a fresh contract
  and links VoucherPool's bytecode at deploy time via the
  `linkReferences` field. Address doesn't need to be canonical for the PoC.

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
`ethers.JsonRpcProvider` (read-only); in production this becomes
polkadot-api + smoldot.

## Chopsticks

- The dwellir endpoint in older configs (`asset-hub-paseo-rpc.dwellir.com`)
  is dead. Use one of `wss://asset-hub-paseo.ibp.network`,
  `wss://asset-hub-paseo.dotters.network`,
  `wss://asset-hub-paseo-rpc.n.dwellir.com`,
  `wss://sys.turboflakes.io/asset-hub-paseo`. The yml lists them so
  chopsticks tries in order.
- Balance values must be strings if > 2^53 - 1
  (`free: '1000000000000000000'` not `free: 1000000000000000000`).
  Same for any u128 storage value.
- Chopsticks startup signal: log line
  `Paseo Asset Hub RPC listening on http://[::]:8000`. Grep
  case-insensitively (`grep -qi listening`).
- SQLite cache at `chopsticks/*.sqlite*` is gitignored. Delete to force a
  fresh fetch of chain state.
- Asset id 1984 is the USDT convention on Asset Hub. To prefund a test
  account with tUSDC, add to `Assets.Account` and bump
  `Assets.Asset[1984].{accounts, supply}` in the import-storage block.
- Pallet-revive maps an EVM address to a substrate AccountId32 via
  `keccak256(eth_addr)[12..]`. Operators / buyers must hold PAS on that
  derived substrate account for the eth-rpc bridge to let them pay gas.

## Test harness (Bash tool) quirks

- `cd` does not persist between separate Bash tool calls — the shell
  snapshot fresh-starts each invocation. Use absolute paths or
  `cd path && cmd` in the same call.
- Long `sleep`s + `run_in_background`: the tool prefers
  `until <check>; do sleep N; done` loops with `run_in_background: true`.
- The Agent tool needs `git HEAD` to exist (it uses worktrees). Spawning
  an Agent in a fresh repo with no commits fails with
  `Failed to resolve base branch "HEAD"`.

## Files most likely to change

- `community-credits-poc-plan.md` — the spec. Treat as source of truth.
  Keep simplifications-vs-whitepaper (§3) in sync if you alter the
  protocol.
- `contracts/contracts/VoucherPool.sol` — protocol surface. Any change here
  cascades to `core/contract-evm.js` (if added), `test/e2e/flow.test.mjs`,
  and the three dapps.
- `circuits/src/*.circom` — circuit changes invalidate the trusted setup;
  re-run `pnpm --filter circuits run build` (compile + ceremony +
  verifier export) and re-copy the `.wasm` + `_final.zkey` artifacts into
  the dapps' `public/zk/` dirs.

## chopsticks-specific gotchas (learned the hard way)

- **Hardhat default keys collide on a forked Paseo.** Account #0's CREATE
  address at nonce 0 already has code on real Paseo (someone else used the
  same key). Deploying anything from that account errors with
  `pallet-revive::Error::DuplicateContract`. Derive deployer keys from
  PoC-unique seeds instead — see `chopsticks/paseo-asset-hub.yml` for the
  three `keccak256("simplex-community-credits-poc-…")` keys we use.

- **`pkill -f chopsticks` does not kill chopsticks.** The process name is
  `node /usr/local/.../chopsticks/.../cli.js`; the substring `chopsticks`
  is in argv but pkill's pattern-match misses it under some configurations.
  Symptom: new chopsticks instance binds to port 8001/8002 instead of 8000
  (collision falls through to the next port), and your import-storage
  changes silently never take effect because the old instance still serves
  the eth-rpc bridge. Always kill by PID.

- **resolc emits ELF, not PVM, when a contract has unresolved library
  refs.** VoucherPool ships as raw ELF (magic `0x7f454c46`) because
  PoseidonT3 isn't linked yet. `resolc --link --libraries 'path:Name=0x…'`
  relocates the ELF against the deployed library address and rewrites it
  in place as a PolkaVM blob (magic `0x50564d00`). Implemented in
  `test/e2e/deploy.mjs::linkLibrariesPvm`. EVM/hardhat uses the standard
  solc placeholder scheme (`linkLibrariesEvm`).

- **Pre-compute Merkle zero-subtree hashes; don't call `PoseidonT3.hash`
  in the constructor.** `tree.init()` doing 20 external Poseidon calls
  blows pallet-revive's per-extrinsic ref_time budget (constructor OOG).
  Constants are hardcoded in `IncrementalMerkleTree.sol::_zero()`.

- **eth_estimateGas under-budgets pallet-revive calls.** ethers v6's
  default estimateGas pre-flight returns gas values that pallet-revive's
  weight conversion treats as OutOfGas. Pass `{ gasLimit: 100_000_000n }`
  explicitly on every state-changing tx via `txOpts` / call options.

- **Per-extrinsic weight cap on heavy multi-op txs — FIXED by stream +
  checkpoint.** Historical issue: combined verify + transferFrom +
  20-Poseidon insert in one extrinsic blew pallet-revive's per-extrinsic
  ref_time. Resolution: the protocol now appends commitments to a stream
  (`state.appendStream(cm)` is just an SSTORE) and the 20-Poseidon
  Merkle insert is moved into a separate, permissionless `checkpoint()`
  tx that proves the insert with a SNARK. `buyAndCreate` / `assign` /
  `redeem` are now ecPairing verify + transferFrom + a couple of SSTOREs
  — well under the cap. Measured: each fits in ~4 k pallet-revive gas
  units (see docs/gas-design.md §"Per-op weight"). Tested green on
  chopsticks-forked Polkadot Asset Hub.

- **Batched checkpoint + on-chain Merkle frontier (issues #2 + #3).**
  `checkpoint()` now accepts up to `CHECKPOINT_BATCH_MAX=8` leaves per
  extrinsic via one Groth16 verify, amortising fees ~6×. The contract
  stores the Tornado-style frontier (`uint256[20]`) and the SNARK proves
  the (oldFrontier → newFrontier) transition; checkpointer is therefore
  stateless and a fresh instance can take over without history replay.
  Public-input layout (52 entries) is documented at the top of
  `checkpoint()` in `VoucherPool.sol` and at the bottom of
  `circuits/src/checkpoint.circom` — keep both in sync if either side
  changes. **No on-chain time gating**: the 5-min cadence (#2 second
  requirement) lives in `tools/checkpoint.mjs`'s scheduler only, so any
  participant (an SMP relay, an affected user) can step in at will.

- **Stale PVM artifacts silently break the chopsticks e2e.**
  `test/e2e/deploy.mjs` loads from `contracts/artifacts-pvm/` when
  `TARGET=chopsticks` (pallet-revive needs PolkaVM bytecode, not EVM).
  Those blobs are produced by `node contracts/scripts/compile-resolc.mjs`
  — a step that is NOT wired into `pnpm --filter contracts run build`.
  Consequence: after a fresh `pnpm --filter circuits run build` the
  trusted setup changes → new verifier .sol constants → new hardhat
  artifacts, but the PVM artifacts still contain the previous
  ceremony's verifier. The deployed verifier rejects every new proof
  and `buyAndCreate` reverts with `pool/proof`. pallet-revive surfaces
  this as `CALL_EXCEPTION`, status=0, gasUsed ≈ 4 k (the revert is
  before any real work, so the gas counter looks like a no-op).
  `test/e2e/deploy.mjs::assertPvmArtifactsFresh()` now compares the
  verifier .sol mtimes against the PVM .json mtimes and errors with a
  clear hint pointing at `compile-resolc.mjs`.

- **eth-rpc binds to IPv6 first.** `[::1]:8545` and `localhost:8545` work;
  `127.0.0.1:8545` may silently time out. The harness uses `localhost`.

- **chopsticks output filename collisions.** `chopsticks/chopsticks.log`
  and `chopsticks/eth-rpc.log` get appended-to forever; delete them
  between runs to make `grep` useful.

- **eth-rpc receipt sqlite gets dirty.** `~/.local/share/eth-rpc/eth-rpc.db*`
  caches block + log records and can throw `UNIQUE constraint failed`
  on a restart. Delete the db files when restarting chopsticks from
  scratch.

## What's NOT done

- Re-run chopsticks-fork e2e + refresh the README's per-action fee
  numbers after the batched-checkpoint + frontier landing (issues #2 +
  #3). The current numbers in `README.md` predate B_MAX=8 and the
  frontier SSTOREs; per-flow cost is expected to drop (one checkpoint
  amortises ~5 leaves) but each checkpoint becomes more expensive (~20
  extra SSTOREs for the frontier). Run `bash chopsticks/run.sh` +
  `pnpm --filter e2e run test:chopsticks` to refresh.
- Auto-rebuild of PVM artifacts on circuits change. `compile-resolc.mjs`
  remains a manual step (deploy.mjs gates with a clear error). If we
  want a one-command flow, wire it into a `pnpm build:pvm` script or
  into `test:chopsticks` itself (~16 s overhead).
- Mobile-bench page (`?bench=1` in dapps), real mobile manual pass — out
  of session scope, plan §8.7.1 + §10 spell them out.
- GitHub Pages deploy workflow (plan §11) — README mentions but no
  `.github/workflows/` directory yet.
