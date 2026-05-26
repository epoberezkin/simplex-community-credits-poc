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
- Fetch **ptau-17**
  ```bash
  mkdir -p ptau
  curl -L https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_17.ptau \
      -o ptau/powersOfTau28_hez_final_17.ptau
  ``` 
  

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
• Dapp A — userA buys 100 tUSDC … ok (683 ms)
• Dapp A — userB buys 100 tUSDC … ok (368 ms)
• checkpoint after buys (drain 2) … ok (2093 ms)
• userA → commA assign 20 … ok (514 ms)
• userB → commA assign 20 … ok (525 ms)
• checkpoint after commA assigns (drain 4) … ok (2076 ms)
• userA → commB assign 30 (from change) … ok (569 ms)
• userB → commB assign 30 (from change) … ok (542 ms)
• checkpoint after commB assigns (drain 4) … ok (2174 ms)
• commA → relayA redeem 5 … ok (534 ms)
• commA → relayB redeem 8 … ok (545 ms)
• commB → relayA redeem 5 … ok (616 ms)
• commB → relayB redeem 8 … ok (496 ms)
• checkpoint after redeems (drain 4) … ok (2141 ms)
• credit balances are 10 (relayA) and 16 (relayB) … ok (33 ms)
• relayA withdraws 10 … ok (177 ms)
• relayB withdraws 16 … ok (200 ms)
• solvency invariant holds … ok (90 ms)
• extra userA buy seeds 1 pending leaf … ok (400 ms)
• checkpoint(count=0) reverts ckp/no-progress … ok (38 ms)
• checkpoint(count=9 > B_MAX) reverts ckp/batch-size … ok (28 ms)
• checkpoint(fabricated newFrontier) reverts ckp/proof … ok (2069 ms)
• permissionless: random key submits valid checkpoint … ok (2248 ms)
• post-adversary solvency still holds … ok (87 ms)
• codec round-trip is byte-exact … ok (3 ms)

── Gas summary by action (avg per tx) ──
  checkpoint                 804958 gas/tx (relay)  [5 txs, <=3 per flow]
  operator withdraw           69930 gas/tx (relay)  [2 txs]
  stablecoin approval         46095 gas/tx (user )  [3 txs, once per account]
  voucher assignment         332704 gas/tx (relay)  [4 txs]
  voucher issuance           315497 gas/tx (user )  [3 txs]
  voucher redemption         340730 gas/tx (relay)  [4 txs]

25/25 steps passed
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

### Subjects

The demo ships with **two of each role** — pick whichever side you want
to play, or run the full 2×2×2 flow described below. Each dapp's wallet
section renders a quick-pick button per subject (sourced from
`cfg.demoBuyers` / `cfg.demoOperators` / `cfg.demoCommunities` written by
`tools/deploy.mjs`):

- **End users** — User A, User B. Each buys vouchers in the purchaser
  and (in a fresh chat tab) assigns them to a community.
- **Communities** — Community A (cid=1), Community B (cid=2). Each gets
  its own chat-admin tab to redeem incoming dest notes.
- **Relays** — Relay A, Relay B. The chat-admin picks one per redeem;
  the relay dapp lets you switch identity in-place before submitting.

The default URLs printed by `pnpm demo` load User A / Relay A; click the
A-vs-B button in either dapp to switch.

### Demo flow (single subject — the quick happy path)

Open all three URLs in separate browser tabs, then run through the
voucher lifecycle for one user and one community:

1. **Purchaser tab** — enter `value=100`, `expiryEpoch=9999`, click **Buy**.
2. **Purchaser tab** — click the emitted `Open in chat dapp →` link to import the note.
3. **Chat tab (User mode)** — wait ~5 s for the new voucher to flip from `⏳ pending checkpoint` to `✓ spendable`.
4. **Chat tab (User mode)** — pick the voucher, pick **Community A**, set **Dest value = 60**, click **Prove + open in relay**.
5. **Relay tab** — paste the relay URL from chat into the queue input, then **Submit** to land the assign tx on chain.
6. **Chat tab (User mode)** — observe: the original 100 voucher is `✓ spent`; a 40-value change voucher appears (after the next checkpoint).
7. **Chat tab** — click the `Community-import link →` from step 4's assign-result panel.
8. **Chat tab (Community admin mode)** — wait for the dest voucher to become `✓ redeemable`, then pick it, pick **Relay A**, click **Prove + open in relay**.
9. **Relay tab** — paste the redeem URL, **Submit**, then **Withdraw all credit**.

### Demo flow (2×2×2 — exercising every subject)

For a realistic flow with two of each, repeat the steps above with the
following distribution. Final credit lands as **Relay A = 10, Relay B = 16**.

1. **Buys.** In the purchaser, hit **Use User A**, buy `100`. Switch to
   **Use User B**, buy `100`.
2. **Assigns by User A.** Open the User A import link in a fresh chat
   tab. Assign **20 → Community A**, submit in the relay using **Use Relay A**.
   Wait for the change note to become spendable, then assign
   **30 → Community B**, submit (again Relay A).
3. **Assigns by User B.** Same as step 2 but in a *separate* chat tab
   (different browser profile / private window keeps IDB scoped), starting
   from the User B import link.
4. **Redeems by Community A.** Open both Community A `community-import`
   links from step 2/3 in a chat tab in **Admin mode**. Redeem
   **5 → Relay A** from the first note, then **8 → Relay B** from the
   second. Submit each in the relay dapp using the matching A/B button.
5. **Redeems by Community B.** Same as step 4 but with Community B's
   community-import links.
6. **Withdraws.** In the relay dapp pick **Use Relay A** and withdraw 10;
   then **Use Relay B** and withdraw 16.

Each proof panel in the chat / purchaser dapps has a 🔍 *Inspect* details
section showing the private inputs (red), public inputs (blue) and the
decoded handover payload (sk in dark orange, public-input overlaps in blue,
neither in black) — useful for following exactly what each role sees.

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
# clean up with `rm -f ~/.local/share/eth-rpc/eth-rpc.db*`
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
── Fee summary (chopsticks fork of Polkadot Asset Hub, per flow, 2 flows) ──
  Inclusion fee/flow:   1.373e-1 DOT
  Storage deposit/flow:        0 DOT
  All-in/flow:          1.373e-1 DOT  ($0.1785 @ DOT=$1.3)
  Blockspace/flow:      gas=171670  block-fraction=3.66%  full-flows/block=27
  (Per-block normal gas budget = 4687500 = MAX_BLOCK_WEIGHT × NORMAL_DISPATCH_RATIO / GasScale.)

── Fee summary by subject (avg per tx) ──
  checkpointer    gas=     38352/tx  fee=   3.068e-2 DOT  deposit=          0 DOT  all-in=   3.068e-2 DOT  ($0.0399)  [4 txs]
  relayA          gas=     15613/tx  fee=   1.249e-2 DOT  deposit=          0 DOT  all-in=   1.249e-2 DOT  ($0.0162)  [7 txs]
  relayB          gas=     12354/tx  fee=   9.884e-3 DOT  deposit=          0 DOT  all-in=   9.884e-3 DOT  ($0.0128)  [3 txs]
  userA           gas=     14191/tx  fee=   1.135e-2 DOT  deposit=          0 DOT  all-in=   1.135e-2 DOT  ($0.0148)  [2 txs]
  userB           gas=      7593/tx  fee=   6.075e-3 DOT  deposit=          0 DOT  all-in=   6.075e-3 DOT  ($0.0079)  [2 txs]

── Gas summary by action (avg per tx) ──
  checkpoint                  38352 gas/tx (relay)  [4 txs, <=3 per flow]
  operator withdraw            8515 gas/tx (relay)  [2 txs]
  stablecoin approval          5119 gas/tx (user )  [2 txs, once per account]
  voucher assignment          16408 gas/tx (relay)  [4 txs]
  voucher issuance            16666 gas/tx (user )  [2 txs]
  voucher redemption          15924 gas/tx (relay)  [4 txs]

19/19 steps passed
```

(Exact numbers depend on the upstream block fork and the runtime version
at the time of the snapshot. The ranges are stable; storage deposits
dominate.)

> **Note:** the numbers above were captured against the BATCH=1 PoC.
> Since then, `checkpoint()` was upgraded to a B_MAX=8 batched extrinsic
> with the Merkle frontier stored on-chain (issues #2 + #3). Per-flow
> cost is expected to drop because one checkpoint now covers up to 8
> leaves, while each individual checkpoint extrinsic becomes more
> expensive (~20 extra SSTOREs for the frontier). Re-run the chopsticks
> e2e to refresh.

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
