# Community Credits PoC — full demo tutorial

End-to-end walkthrough for the V1.1 PoC: chopsticks-forked Polkadot Asset
Hub → contract deployment → buy → assign → redeem → withdraw across the
three single-purpose dapps.

Designed to be reproducible on a clean Linux laptop. Allow ~30 min for a
first run (10 min downloading chain state for chopsticks, then under 2 min
per voucher flow). Per-flow real fee on Polkadot Asset Hub is ~0.08 DOT
all-in; running against the chopsticks fork costs nothing because the fork
mints free DOT into prefunded keys.

## 0 — Prereqs

Required binaries (versions are what the PoC was developed/tested against;
newer point releases generally fine):

- Node 20.19 (`node --version`)
- pnpm 9.15 (`pnpm --version` — pnpm 10+ requires Node 22+)
- `circom` 2.2.3 (only needed to rebuild circuits; precompiled artifacts
  ship in the repo)
- `solc` 0.8.24 (only needed to recompile contracts; Hardhat downloads it
  on first compile and precompiled artifacts ship in the repo)
- `eth-rpc` 0.14 (pallet-revive ETH-JSON-RPC bridge; the PoC binds it on
  `:8545`)
- `@acala-network/chopsticks` (installed on-demand by `chopsticks/run.sh`
  via `npx`)
- A browser with an EVM wallet extension. MetaMask works; the PoC also
  uses EIP-6963 discovery so other injected wallets are picked up.

Install JS deps:

```bash
cd /work/simplex-community-credits-poc
pnpm install
```

The repo's `circuits/`, `contracts/`, `packages/{core,purchaser,chat,
relay}`, `test/e2e`, and `tools/` are all workspaces; one `pnpm install`
at the root wires them up.

### 0.1 — Install eth-rpc

Make sure `~/.local/bin` is on `PATH`
(`export PATH="$HOME/.local/bin:$PATH"` in `~/.bashrc` if not). The binary
below installs into that directory.

Contracts are compiled to plain EVM bytecode by Hardhat (which downloads
`solc 0.8.24` itself on first compile). The very same hardhat-built
bytecode runs both on a local EVM and on pallet-revive's REVM via the
eth-rpc bridge — there is no separate PVM/resolc build step.

**eth-rpc 0.14** — prebuilt binary from
[polkadot-sdk releases](https://github.com/paritytech/polkadot-sdk/releases):

```bash
curl -L https://github.com/paritytech/polkadot-sdk/releases/download/polkadot-stable2603-2/eth-rpc \
  -o ~/.local/bin/eth-rpc
chmod +x ~/.local/bin/eth-rpc
eth-rpc --version  # expect: pallet-revive-eth-rpc 0.14.0
```

Pin `polkadot-stable2503`; later runtime tags work but ship newer
`eth-rpc` versions. Source build alternative (~15 min):
`cargo install --git https://github.com/paritytech/polkadot-sdk eth-rpc`.

## 1 — Run the demo

One command boots chopsticks + eth-rpc, deploys the contract suite,
starts the three Vite dev servers, and prints the dapp URLs:

```bash
pnpm demo
```

What it does (see `tools/demo.mjs`):

- Boots `chopsticks/run.sh` (CHAIN=polkadot) if `:8545` isn't already
  open. First boot fetches ~50–200 MB of state into
  `chopsticks/polkadot-asset-hub.sqlite*`; subsequent boots are seconds.
- Runs `pnpm --filter tools run deploy`: compiles+deploys PoseidonT3,
  IncrementalMerkleTree (lib), the three Groth16 verifiers, TestUSDC,
  `VoucherPool`; mints tUSDC to the buyer; registers the relay as
  operator; writes deployed addresses into each dapp's `public/config.json`
  and into `tools/last-deploy.json`.
- Starts the three Vite dev servers (purchaser :5173, chat :5174,
  relay :5175) if not already running.

Final output looks like:

```
================================================================
  DEMO READY — open these URLs:
================================================================
  Purchaser  http://localhost:5173/?demoKey=0x…
  Chat       http://localhost:5174/
  Relay      http://localhost:5175/?demoKey=0x…
================================================================
  demoKey is stored in localStorage on first open — reload safe.
  Ctrl+C to stop chopsticks + dev servers.
```

Open each URL in a tab. The `?demoKey=` is parsed, persisted in
`localStorage`, and stripped from the URL bar — so reload keeps you
authenticated, and the private key isn't visible after the first load.

If you don't open a URL with `?demoKey=…` (e.g. you load `/` cold),
each signer dapp shows a "Use built-in test key (demo)" button that
does the same thing without needing the URL arg.

The chat dapp persists view mode (User / Community admin) and the
last community id across reloads in `localStorage` too, so a refresh
keeps you in the same place.

**Test keys are not secrets** — derived from public strings in
`tools/keys.mjs`. Never use them on a real chain.

Watch chain events at
[Polkadot.js Apps](https://polkadot.js.org/apps/?rpc=ws%3A%2F%2Flocalhost%3A8000#/explorer)
(use `ws://localhost`, not `ws://127.0.0.1` — Chrome's secure-context
exemption is hostname-string-based).

For a real-extension wallet (MetaMask), see §7.

## 2 — Buy a voucher (purchaser dapp)

1. In the purchaser tab (from §1), the red "demo mode" banner should
   already be visible and the buy form unblocked. Skip wallet prompts.
2. Fill out the buy form:
   - Value: `100` (= 100 micro-tUSDC; the buyer was minted 1 000 000)
   - Expiry epoch: `9999` (epoch counter; far-future for the demo)
3. Click "Buy". The dapp:
   - generates a fresh note secret key `sk` and randomness,
   - proves the `create` circuit in a worker (~0.5–1 s),
   - approves tUSDC to `VoucherPool`,
   - calls `buyAndCreate(cm, value, expiry, π)` on the pool, which verifies
     the proof and folds `cm` into the on-chain Merkle tree in the same tx
     (on-chain Poseidon insert) — no separate checkpoint step.
4. When the tx confirms, the dapp shows a link (and a QR) of the form
   `http://localhost:5174/?import=<base64-encoded-note>`. This is the
   handoff to the chat dapp — the note material is in the URL fragment
   only, never sent anywhere.

## 3 — Import the note in the chat dapp

Open the import link from §2 — it lands in the chat dapp at
`http://localhost:5174/?import=…`. The dapp:

- decodes the note from the URL,
- recomputes the commitment from the note's secret material and verifies
  it matches the on-chain `VoucherCreated` event,
- writes the note to IndexedDB and re-renders the "My vouchers" list,
- displays `100 tUSDC` once the note is spendable, or `⏳ pending
  confirmation` if the buy tx's insert event hasn't been observed yet. The
  note becomes spendable as soon as its tx confirms and the chat dapp's
  4 s poll picks up the on-chain insert event (a few seconds), at which
  point the row flips to `✓ spendable` — no checkpoint required.

The chat dapp is signer-free by construction (`grep -rE
"BrowserProvider|eth_requestAccounts" packages/chat/src/` returns nothing).
It only reads chain state via a JSON-RPC provider.

## 4 — Assign to an operator (chat dapp + relay dapp)

In the chat dapp's "Assign" panel:

- Community id: a small integer that identifies the operator's community
  (`1` is fine for the demo)
- Operator pkHash: paste the Poseidon hash of the operator's
  community-scoped sk. For the PoC, the chat dapp generates that sk on
  demand the first time the operator scans a `?community-import=…` URL.
  For the very first assign you can paste any 0..p field element; the
  dest note then lives in IndexedDB until somebody with the matching sk
  imports it.
- Dest value: how much of the note to send (e.g. `60`). The rest becomes
  a change note owned by you.

Click "Assign". The dapp:

1. rebuilds the off-chain Merkle mirror from the chain's
   `VoucherCreated`/`Assigned`/`Redeemed` events, inserting every
   commitment in `leafIndex` order so the mirror root matches the chain's,
2. looks up this note's leaf index from those events,
3. errors with `commitment not yet observed on-chain` if the buy tx's
   insert event hasn't been seen yet — wait a few seconds for the poll to
   catch up, then retry,
4. otherwise proves `assign` in a worker (~1 s),
5. emits a deep link of the form
   `http://localhost:5175/?relay=assign:<...>` and (separately) a
   `?community-import=…` link representing the dest note.

Hand the relay link to the relay tab. **Don't click it** — clicking
navigates away from `?demoKey=`, dropping demo mode. Instead, copy the
relay link's URL and paste it into the relay tab's "Paste relay deep
link" input, then click "Add to queue". The relay dapp:

- parses the deep link,
- queues the tx in its "Pending submissions" UI,
- you click "Submit" → tx is sent (no popup; the demo wallet auto-signs).

(In MetaMask mode (§7) clicking the link works because demo state isn't
in the URL.)

The dest note's `community-import` link is copy/pasted into a second
chat-dapp tab to simulate the operator receiving it. That tab tracks
admin-side notes under a separate scope (`community-<id>`).

The assign tx folds both new commitments (dest + change) into the
on-chain tree itself, so once it confirms the operator's tab will show
the dest note as spendable after the next poll — no checkpoint needed.

## 5 — Redeem (chat-admin → relay)

In the second chat-dapp tab (admin mode), the dest note now shows as
spendable. Click the corresponding row and pick "Redeem":

- Operator id: same numeric id as the community id from §4
- Redeem value: must equal the note's full value (no change allowed on
  redeem; remaining value goes back to the operator as `credit`)

The dapp proves `redeem` (~1 s) and emits
`http://localhost:5175/?relay=redeem:<...>`.

Open the link in the relay dapp, click "Submit". On confirmation the
redeem amount accrues to the operator's on-chain `credit(relay)` balance
and the dapp's credit-balance widget updates. The redeem tx also folds
its change commitment into the on-chain tree in the same tx (so it could
be spent later if change > 0).

## 6 — Withdraw operator credit (relay dapp)

In the relay tab, the "Withdraw" panel shows the current `credit(relay)`
value. Click "Withdraw" → tx → the entire credit is paid out from the
pool's tUSDC reserves to the relay EOA.

Cross-check: query `tUSDC.balanceOf(relay)` from any RPC and you should
see the redeem value land in the relay account (less the gas spent).

## 7 — MetaMask (optional)

If you want to drive the dapps with a real extension wallet (for
realism, or to eventually test against a real chain), skip the
`?demoKey=` arg and use MetaMask instead. The flow is identical — just
connect via the EIP-6963 button each dapp renders.

Network (Settings → Networks → Add):

- Network name: `Polkadot Asset Hub (chopsticks fork)`
- RPC URL: `http://localhost:8545`
- Chain ID: from `tools/last-deploy.json` (`420420419` on the revive fork)
- Currency symbol: `DOT`

Import the buyer + relay keys (Settings → Accounts → Import Account →
Private Key):

```bash
node -e "import('./tools/keys.mjs').then(m=>{
  console.log('Buyer: '+m.BUYER_PRIVATE_KEY);
  console.log('Relay: '+m.RELAY_PRIVATE_KEY);
})"
```

Switch to the buyer account before using the purchaser tab; switch to
the relay account before using the relay tab. In MetaMask mode you can
also click relay deep links directly — navigation doesn't drop any
state since the wallet lives in the extension, not the URL.

## 8 — Tear down

- Ctrl+C the dev servers and `chopsticks/run.sh`.
- Optional: delete `chopsticks/polkadot-asset-hub.sqlite*` to force a
  fresh fork next time.
- Optional: delete `chopsticks/{chopsticks,eth-rpc}.log` — they get
  appended-to forever otherwise.

## Troubleshooting

**MetaMask says "Internal JSON-RPC error" on send.** Almost always
eth-rpc not running, the wrong chain id, or out-of-DOT on the connected
account. `tools/last-deploy.json` has the chain id; `node -e
"import('./tools/keys.mjs').then(m=>console.log(m.BUYER_PRIVATE_KEY))"`
prints the prefunded keys.

**`commitment not yet observed on-chain` in the chat dapp.** Transient —
the buy/assign tx confirmed but the chat dapp's 4 s poll hasn't yet seen
its insert event. Wait a few seconds and retry; the note flips to
`✓ spendable` once the event lands.

**`mirror root mismatch` in the chat dapp.** The on-chain tree has
diverged from the local mirror (a re-fork, a redeploy, or a different
chopsticks state). Re-run `pnpm --filter tools run deploy` to fresh-start
or delete the chopsticks sqlite and start over.

**Buyer has no DOT / no tUSDC.** Chopsticks didn't apply the import-
storage block — make sure `CHAIN=polkadot` is set (the paseo yml has a
different prefund list) and that no other chopsticks instance is on
port 8000.

**Purchaser tx reverts with `tUSDC/balance`.** The buyer EOA wasn't
funded with tUSDC. The deploy step mints into `buyerWallet.address`; if
you imported a different key into MetaMask the balance is zero.

**`pkill -f chopsticks` did not stop chopsticks.** Known: the process
name doesn't match the substring. Kill by PID
(`ps aux | grep chopsticks`).

## Reference

- Architecture: see `docs/gas-design.md` for why each commitment is
  folded into the on-chain Merkle tree immediately (and why the earlier
  stream+checkpoint indirection was dropped), with the on-chain weight
  measurements that drove it.
- Protocol: `community-credits-poc-plan.md` (esp. §3 simplifications vs
  whitepaper and §8 three-dapp split).
- Session quirks: `CLAUDE.md` for foot-guns hit while building this.
