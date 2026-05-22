# simplex-community-credits-poc

Implementation of the Community Credits PoC V1.1 described in
[`community-credits-poc-plan.md`](./community-credits-poc-plan.md).

## Layout

```
circuits/        Circom sources, trusted-setup scripts, generated zkeys + verifiers
contracts/       Hardhat project: VoucherPool + Poseidon Merkle + verifiers
packages/
  core/          Shared ES module (poseidon, codec, handoff, proof, ethers)
  purchaser/     Dapp A: EVM-signed buyAndCreate
  chat/          Dapp B: NO signer, proves assign + redeem, deep-link to relay
  relay/         Dapp C: EVM-signed assign/redeem/withdraw on behalf of chat users
test/e2e/        Node E2E harness (TARGET=hardhat | chopsticks)
test/browser/    Playwright browser e2e — full happy path + adversary suite
chopsticks/      YAML configs to fork Polkadot / Paseo Asset Hub locally
tools/           demo orchestrator, deployer, checkpointer, event subscriber
docs/            tutorial + gas-design notes
```

## Quick Start

### Prerequisites

- **Node 20.19+** (`node --version`) — newer also fine.
- **pnpm 9.x** — `npm i -g pnpm@9.15.9` (pnpm 10+ requires Node 22+).
- **circom 2.2.x** — needed by `pnpm --filter circuits run build`. Not on
  npm; grab the prebuilt binary:
  ```bash
  mkdir -p ~/.local/bin
  curl -L https://github.com/iden3/circom/releases/download/v2.2.3/circom-linux-amd64 \
    -o ~/.local/bin/circom && chmod +x ~/.local/bin/circom
  # ensure ~/.local/bin is on PATH (echo "$PATH" | tr : '\n' | grep -q ~/.local/bin || …)
  circom --version    # expect: circom compiler 2.2.x
  ```
  On macOS use `circom-macos-amd64` (or build from source via
  `cargo install --git https://github.com/iden3/circom`).

Hardhat downloads `solc` automatically on first `contracts` build — no
separate install needed for the quick-start path. (`resolc` + `eth-rpc`
are only needed for the chopsticks/pallet-revive flow — see
[`docs/tutorial.md`](./docs/tutorial.md) §0.1.)

### Run

```bash
pnpm install
pnpm --filter circuits  run build       # compile circuits + trusted setup + verifier export (~5 min first time)
pnpm --filter contracts run build       # hardhat compile
pnpm --filter e2e       run test        # full flow on hardhat-local (~10 s)
```

Expected logs explain all necessary steps for a full voucher flow: 
```
starting hardhat node…
  pool   : 0x5FC8d32690cc91D4c39d9d3abcBD16989F875707
  tUSDC  : 0x5FbDB2315678afecb367f032d93F642f64180aa3
• Dapp A — buyer proves create + buyAndCreate … ok (794 ms)
• checkpoint after buy … ok (1490 ms)
• Dapp B — chat imports note … ok (3 ms)
• Dapp B (chat) — prove assign, no signer … ok (799 ms)
• Dapp C (relay) — submit assign tx … ok (190 ms)
• checkpoint after assign … ok (2788 ms)
• double-spend assign reverts … ok (58 ms)
• Dapp B (community) — prove redeem … ok (844 ms)
• Dapp C (relay) — submit redeem tx … ok (207 ms)
• checkpoint after redeem … ok (1540 ms)
• Dapp C — operator withdraw … ok (170 ms)
• solvency invariant holds … ok (85 ms)
• codec round-trip is byte-exact … ok (2 ms)

── Gas summary by action ──
  checkpoint                1158348 gas
  operator withdraw           78502 gas
  voucher assignment         332637 gas
  voucher issuance           407200 gas
  voucher redemption         362124 gas

13/13 steps passed
```

(Numbers shift slightly between runs; the categories and order are stable.)

## Local Interactive Demo

One command boots a hardhat backend, deploys the contracts, starts the
three dapp dev servers, and prints the URLs:

```bash
pnpm demo
```

Final banner:

```
================================================================
  DEMO READY (CHAIN=hardhat) — open these URLs:
================================================================
  Purchaser  http://localhost:5173/?demoKey=0x…
  Chat       http://localhost:5174/
  Relay      http://localhost:5175/?demoKey=0x…
================================================================
```

Open the purchaser Dapp in any browser and follow the instructions in the dapp.

The chain backend defaults to hardhat-local (fast, reliable). Stop with
Ctrl+C; restart `pnpm demo` to reset.

### Demo flow

Open all three URLs in separate browser tabs, then run through the
voucher lifecycle:

1. **Purchaser tab** — enter `value=100`, `expiryEpoch=9999`, click **Buy**.
2. **Purchaser tab** — click the emitted `Open in chat dapp →` link to import the note.
3. **Chat tab (User mode)** — wait ~5 s for the new voucher to flip from `⏳ pending checkpoint` to `✓ spendable`.
4. **Chat tab (User mode)** — pick the voucher, pick **demo community**, set **Dest value = 60**, click **Prove + open in relay**.
5. **Relay tab** — paste the relay URL from chat into the queue input, then **Submit** to land the assign tx on chain.
6. **Chat tab (User mode)** — observe: the original 100 voucher is `✓ spent`; a 40-value change voucher appears (after the next checkpoint).
7. **Chat tab** — click the `Community-import link →` from step 4's assign-result panel.
8. **Chat tab (Community admin mode)** — wait for the dest voucher to become `✓ redeemable`, then pick it, pick **demo relay**, click **Prove + open in relay**.
9. **Relay tab** — paste the redeem URL, **Submit**, then **Withdraw all credit**.

### What a successful run looks like

In the demo terminal you'll see, in order:

- per-contract deploy lines with gas + tx hash and a deployer-cost total
- `[events] VoucherPool.VoucherCreated(...)` after the buy
- `[checkpoint] cp #N ok` lines as the watcher drains the stream
- `[events] balance buyer DOT -…` and `[events] balance buyer tUSDC -100` after the buy
- `[events] VoucherPool.Assigned(...)` after the relay submit
- `[events] VoucherPool.Redeemed(...)` after the redeem submit
- `[events] balance relay tUSDC +N` after redeem (operator credited) and again after withdraw

In the relay dapp the credit balance rises after redeem, drops to 0 after
withdraw, and the relay's tUSDC balance increases by the redeemed amount.

## Chopsticks e2e tests

Run the same protocol e2e against a chopsticks fork of Polkadot Asset Hub
(or Paseo) to measure realistic gas, fees, and storage deposits against
the production pallet-revive runtime. The harness here is **headless and
non-interactive** — it drives the contracts via `@community-credits/core`
directly (same code paths the three dapps use), but never spins up a
browser. For the UI-driven variant see "Playwright UI variant" below.

```bash
# one-time / after every circuits-or-contracts rebuild: compile PVM bytecode
node contracts/scripts/compile-resolc.mjs                   # ~16s; needed for pallet-revive

# in one terminal:
CHAIN=polkadot bash chopsticks/run.sh                       # boots chopsticks + eth-rpc

# in another, once chopsticks is up:
pnpm --filter e2e run test:chopsticks                       # full flow + fee report

# now, be patient, it will take a while.....
```

> **Why the PVM compile step?** Pallet-revive deploys PolkaVM bytecode,
> not EVM. `pnpm --filter contracts run build` produces only EVM artifacts
> (for hardhat); `compile-resolc.mjs` regenerates the matching PVM blobs
> in `contracts/artifacts-pvm/`. If you skip this after a circuits
> ceremony, the deployed verifier is from the previous build and rejects
> every new proof — `buyAndCreate` reverts with `pool/proof`. The e2e
> harness detects the mismatch via an mtime check and errors with a hint.

The harness ends with three blocks of output — per-tx fee detail, a
by-subject roll-up, and a gas-by-action roll-up:

```
── Fee summary (chopsticks fork of Polkadot Asset Hub) ──
  TOTAL inclusion fees: 9.393e-2 DOT (939260000 plancks)
  TOTAL storage locked:        0 DOT (0 plancks)
  TOTAL frozen delta:          0 DOT (0 plancks)
  All-in:               9.393e-2 DOT (939260000 plancks)
  All-in @ DOT=$1.3: $0.1221
  Blockspace:           gas=93926  block-fraction=2.00%  full-flows/block=49
  (Per-block normal gas budget = 4687500 = MAX_BLOCK_WEIGHT × NORMAL_DISPATCH_RATIO / GasScale.)

── Fee summary by subject ──
  buyer           gas=     23227  fee=   2.323e-2 DOT  deposit=          0 DOT  all-in=   2.323e-2 DOT  ($0.0302)
  checkpointer    gas=     32407  fee=   3.241e-2 DOT  deposit=          0 DOT  all-in=   3.241e-2 DOT  ($0.0421)
  paymaster + operator gas=     38292  fee=   3.829e-2 DOT  deposit=          0 DOT  all-in=   3.829e-2 DOT  ($0.0498)

── Gas summary by action ──
  checkpoint                  32407 gas
  operator withdraw            8411 gas
  voucher assignment          13475 gas
  voucher issuance            23227 gas
  voucher redemption          16406 gas

13/13 steps passed
```

(Exact numbers depend on the upstream block fork and the runtime version
at the time of the snapshot. The ranges are stable; storage deposits
dominate.)

Useful env vars:

- `CHAIN=paseo` — fork Paseo Asset Hub instead (smaller chain, often
  faster to fetch the snapshot).
- `CHOPSTICKS_WS_URL=ws://…` — point at an already-running chopsticks
  instance.

See [`docs/gas-design.md`](./docs/gas-design.md) for the analytical
breakdown of these numbers and the stream+checkpoint design that drove
them.

### Playwright UI variant

Same end-to-end flow, but driven through the three dapps in a headless
Chromium browser (purchaser → chat user → chat admin → relay). Use this
when you want to exercise the actual UI code paths (deep-link parsing,
IDB, signer wiring, render diffing) on top of the same chain backend:

```bash
# one-time: download the chromium build Playwright uses
pnpm --filter @community-credits/browser-test run install-browsers

# full UI flow on hardhat-local (auto-spawns hardhat, deploys, runs dapps):
pnpm --filter @community-credits/browser-test test

# same flow against a chopsticks fork (auto-spawns chopsticks too):
CHAIN=polkadot pnpm --filter @community-credits/browser-test test

# headed mode (watch it click):
pnpm --filter @community-credits/browser-test run test:headed
```

The Playwright suite includes both the happy path and an adversary
suite (`test/browser/tests/adversary.spec.mjs`: over-balance buy,
over-spend assign, double-spend, over-redeem, withdraw with no credit).
The chopsticks limitation above applies here too — the heavy-op txs
hit the same per-extrinsic cap.

## Testnet Interactive Demo

TODO — run `pnpm demo` against the live Paseo Asset Hub testnet. Needs:

- a deploy-script variant that funds the buyer / relay via a faucet
  instead of `hardhat_setBalance` / chopsticks `import-storage`,
- public hosting for the three dapps (e.g. GitHub Pages — see plan §11),
- the `?demoKey=` flow swapped for real EIP-6963 (MetaMask) connection
  so secrets stay client-side.

The protocol-level pieces (circuits, contracts, dapps) already work
unchanged against a real chain — what's missing is the demo glue.

## See also

- [`docs/tutorial.md`](./docs/tutorial.md) — step-by-step walkthrough.
- [`docs/gas-design.md`](./docs/gas-design.md) — stream+checkpoint design + per-step gas analysis.
- [`CLAUDE.md`](./CLAUDE.md) — session-learned gotchas (toolchain quirks, chopsticks bugs, etc.).
- [`community-credits-poc-plan.md`](./community-credits-poc-plan.md) — spec.
