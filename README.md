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
tools/           demo orchestrator, deployer, event subscriber
docs/            tutorial + gas-design notes
```

> **Design:** every `buyAndCreate` / `assign` / `redeem` folds its
> commitment(s) into an on-chain Tornado-style Merkle tree in the same tx
> (on-chain Poseidon inserts), so notes are spendable as soon as the tx
> lands. The contracts run as plain EVM bytecode — locally on Hardhat and on
> pallet-revive's REVM on a chopsticks-forked Asset Hub (no resolc/PVM, no
> checkpoint step). The original stream + permissionless-checkpoint design
> was dropped after measurement showed the on-chain inserts run fine under
> REVM.

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
separate install needed for the quick-start path. (`eth-rpc` is only needed
for the chopsticks/pallet-revive flow — see
[`docs/tutorial.md`](./docs/tutorial.md) §0.1. There is no `resolc`/PVM step
anymore: the same EVM bytecode runs locally and under pallet-revive REVM.)

### Run

```bash
pnpm install
pnpm --filter circuits  run build       # compile circuits + trusted setup + verifier export (~5 min first time)
pnpm --filter contracts run build       # hardhat compile
pnpm --filter e2e       run test        # full flow on hardhat-local (~30 s)
```

Expected logs walk through a full voucher flow. Each buy/assign/redeem
inserts its commitment(s) into the on-chain tree in the same tx, so the
`nextIndex` assertions confirm immediate spendability — there are no
checkpoint steps:
```
starting hardhat node…
  pool   : 0x5FC8d32690cc91D4c39d9d3abcBD16989F875707
  tUSDC  : 0x5FbDB2315678afecb367f032d93F642f64180aa3
• Dapp A — userA buys 100 tUSDC … ok
• Dapp A — userB buys 100 tUSDC … ok
• both buys are inserted + spendable immediately … ok
• userA → commA assign 20 … ok
• userB → commA assign 20 … ok
• commA assigns inserted (nextIndex=6) … ok
• userA → commB assign 30 (from change) … ok
• userB → commB assign 30 (from change) … ok
• commB assigns inserted (nextIndex=10) … ok
• commA → relayA redeem 5 … ok
• commA → relayB redeem 8 … ok
• commB → relayA redeem 5 … ok
• commB → relayB redeem 8 … ok
• redeem change notes inserted (nextIndex=14) … ok
• credit balances are 10 (relayA) and 16 (relayB) … ok
• relayA withdraws 10 … ok
• relayB withdraws 16 … ok
• solvency invariant holds … ok
• double-spend (reused nullifier) reverts pool/nullifier … ok
• unknown root reverts pool/root … ok
• post-adversary solvency still holds … ok
• codec round-trip is byte-exact … ok

── Gas summary by action (avg per tx) ──
  operator withdraw           69953 gas/tx (relay)  [2 txs]
  stablecoin approval         46095 gas/tx (user )  [2 txs, once per account]
  voucher assignment        1670370 gas/tx (relay)  [4 txs]
  voucher issuance          1066769 gas/tx (user )  [2 txs]
  voucher redemption        1068379 gas/tx (relay)  [4 txs]

22/22 steps passed
```

These are raw **hardhat EVM** gas units — large because the on-chain
Poseidon Merkle insert (20 hashes per leaf) now happens inside each tx. On
pallet-revive's REVM the metered cost is far lower (see "Chopsticks e2e
tests" below). Numbers shift slightly between runs; categories are stable.

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
3. **Chat tab (User mode)** — wait ~5 s for the new voucher to flip from `⏳ pending confirmation` to `✓ spendable` (the dapp polls for the on-chain insert event).
4. **Chat tab (User mode)** — pick the voucher, pick **Community A**, set **Dest value = 60**, click **Prove + open in relay**.
5. **Relay tab** — paste the relay URL from chat into the queue input, then **Submit** to land the assign tx on chain.
6. **Chat tab (User mode)** — observe: the original 100 voucher is `✓ spent`; a 40-value change voucher appears and is spendable once the assign tx confirms.
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
# in one terminal — boot chopsticks + the eth-rpc bridge:
# (delete a stale receipt db first: rm -f ~/.local/share/eth-rpc/eth-rpc.db*)
CHAIN=polkadot bash chopsticks/run.sh

# in another, once chopsticks is up:
pnpm --filter e2e run test:chopsticks                       # full flow + fee report

# now, be patient, it will take a while.....
```

> **No PVM/resolc step.** The same hardhat-built EVM bytecode is deployed to
> the fork and run by pallet-revive's REVM. `TARGET=chopsticks` only changes
> the RPC endpoint (the eth-rpc bridge) and passes an explicit gas limit
> (eth-rpc under-budgets `eth_estimateGas` for the Groth16 verify + on-chain
> Poseidon insert). See [`CLAUDE.md`](./CLAUDE.md) "Chopsticks" for fork
> gotchas (chopsticks `@latest`, `--build-block-mode Instant`).

The harness ends with three blocks of output — per-tx fee detail, a
by-subject roll-up, and a gas-by-action roll-up:

```
── Fee summary (chopsticks fork of Polkadot/Paseo Asset Hub, per flow, 2 flows) ──
  Inclusion fee/flow:   1.102e-1 DOT
  Storage deposit/flow:        0 DOT
  All-in/flow:          1.102e-1 DOT  ($0.1432 @ DOT=$1.3)
  Blockspace/flow:      gas=110190  block-fraction=2.35%  full-flows/block=42
  (Per-block normal gas budget = 4687500 = MAX_BLOCK_WEIGHT × NORMAL_DISPATCH_RATIO / GasScale.)

── Fee summary by subject (avg per tx) ──
  relayA          gas=     20463/tx  fee=   2.046e-2 DOT  deposit=          0 DOT  all-in=   2.046e-2 DOT  ($0.0266)  [7 txs]
  relayB          gas=     12388/tx  fee=   1.239e-2 DOT  deposit=          0 DOT  all-in=   1.239e-2 DOT  ($0.0161)  [3 txs]
  userA           gas=     12655/tx  fee=   1.266e-2 DOT  deposit=          0 DOT  all-in=   1.266e-2 DOT  ($0.0165)  [2 txs]
  userB           gas=      7330/tx  fee=   7.331e-3 DOT  deposit=          0 DOT  all-in=   7.331e-3 DOT  ($0.0095)  [2 txs]

── Gas summary by action (avg per tx) ──
  operator withdraw            3255 gas/tx (relay)  [2 txs]
  stablecoin approval          3907 gas/tx (user )  [2 txs, once per account]
  voucher assignment          25154 gas/tx (relay)  [4 txs]
  voucher issuance            16079 gas/tx (user )  [2 txs]
  voucher redemption          18319 gas/tx (relay)  [4 txs]

19/19 steps passed
```

These are pallet-revive (REVM) gas units — note there is **no checkpoint
row**: the Merkle insert cost is now folded into each buy/assign/redeem.
All-in per voucher lifecycle is ~0.11 DOT/PAS, and storage deposit is 0
(pallet-revive folds it into the inclusion fee). Per-tx cost is independent
of tree depth (Tornado frontier = constant 20 Poseidon hashes per insert),
so these hold at a full tree. Exact numbers depend on the upstream fork +
runtime snapshot; the ranges are stable.

Useful env vars:

- `CHAIN=paseo` — fork Paseo Asset Hub instead (smaller chain, often
  faster to fetch the snapshot).
- `CHOPSTICKS_WS_URL=ws://…` — point at an already-running chopsticks
  instance.

See [`docs/gas-design.md`](./docs/gas-design.md) for the analytical
breakdown of these numbers and the on-chain Tornado-frontier insert design.

### Playwright UI variant

Same end-to-end flow, but driven through the three dapps in a headless
Chromium browser (purchaser → chat user → chat admin → relay). Use this
when you want to exercise the actual UI code paths (deep-link parsing,
IDB, signer wiring, render diffing) on top of the same chain backend:

```bash
# one-time: download the chromium build Playwright uses
pnpm --filter @community-credits/browser-test run install-browsers
# (on an OS Playwright doesn't recognise — e.g. Ubuntu 26.04 — the install
#  aborts at an OS-support check; bypass with
#  PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 for both install + test.)

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
- [`docs/gas-design.md`](./docs/gas-design.md) — on-chain Tornado-frontier design + per-step gas analysis.
- [`CLAUDE.md`](./CLAUDE.md) — session-learned gotchas (toolchain quirks, chopsticks bugs, etc.).
- [`community-credits-poc-plan.md`](./community-credits-poc-plan.md) — spec.
