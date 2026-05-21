# Community Credits PoC — full demo tutorial

End-to-end walkthrough for the V1.1 PoC: chopsticks-forked Polkadot Asset
Hub → contract deployment → buy → assign → redeem → withdraw across the
three single-purpose dapps, with the off-chain checkpointer interleaved.

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
- `solc` 0.8.24 + `resolc` 1.1 (only needed to recompile PVM bytecode;
  precompiled artifacts ship in `contracts/artifacts-pvm/`)
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

### 0.1 — Install solc, resolc, eth-rpc

Make sure `~/.local/bin` is on `PATH`
(`export PATH="$HOME/.local/bin:$PATH"` in `~/.bashrc` if not). All three
binaries below install into that directory.

**solc 0.8.24** — Hardhat downloads it on first compile; just symlink the
cached binary so `resolc` can find it on `PATH`:

```bash
pnpm --filter contracts run build       # one-time; populates ~/.cache/hardhat-nodejs/…
mkdir -p ~/.local/bin
ln -sf ~/.cache/hardhat-nodejs/compilers-v2/linux-amd64/solc-linux-amd64-v0.8.24+commit.e11b9ed9 \
       ~/.local/bin/solc
solc --version    # expect: Version: 0.8.24+commit.e11b9ed9…
```

**resolc 1.1** — prebuilt static binary from
[paritytech/revive releases](https://github.com/paritytech/revive/releases):

```bash
curl -L https://github.com/paritytech/revive/releases/download/v0.1.0-dev.16/resolc-x86_64-unknown-linux-musl \
  -o ~/.local/bin/resolc
chmod +x ~/.local/bin/resolc
resolc --version  # expect: …revive compiler version 1.1.0…
```

Pick the `-musl` build; the `-gnu` build can fail to load on older glibc.
If a newer release exists, swap the tag — the PoC was built against 1.1.0.

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

## 1 — Fork Polkadot Asset Hub with chopsticks

boot a forked node + the eth-rpc bridge:

```bash
# purge any old state. only needed when switching chains
rm -f ~/.local/share/eth-rpc/eth-rpc.db*
CHAIN=polkadot bash chopsticks/run.sh
```

What this does:

- Forks Polkadot Asset Hub at the latest finalized block from public RPCs
  (`chopsticks/polkadot-asset-hub.yml` lists the endpoints).
- Applies an `import-storage` block that prefunds three PoC-specific keys
  (deployer / buyer / relay, derived from
  `keccak256("simplex-community-credits-poc-{role}-v1")`) with 1000 DOT
  each, and mints 1 unit of tUSDC (asset id 1984) into the buyer's
  substrate-derived account.
- Starts `eth-rpc` on `:8545`, exposing the fork over the standard
  Ethereum JSON-RPC so wallets / ethers / hardhat can talk to it.

Wait until the terminal prints:

```
[ready] chopsticks ws://127.0.0.1:8000
[ready] eth-rpc    http://127.0.0.1:8545
```

Leave this running in its own terminal. Ctrl+C stops both.

Open a browser to observe events in: [js-apps](https://polkadot.js.org/apps/?rpc=ws%3A%2F%2F127.0.0.1%3A8000#/explorer)

First boot fetches ~50–200 MB of chain state into
`chopsticks/polkadot-asset-hub.sqlite*`; subsequent boots are near-instant.
Delete the sqlite files to force a fresh fetch.

## 2 — Deploy the contract suite

In a second terminal, with chopsticks running:

```bash
pnpm --filter tools run deploy
```

What this does (see `tools/deploy.mjs`):

1. Compiles+deploys PoseidonT3, IncrementalMerkleTree (lib), the four
   Groth16 verifiers (create / assign / redeem / checkpoint), a TestUSDC
   ERC-20, and `VoucherPool`.
2. Mints 1 000 000 micro-tUSDC (1 unit at 6 decimals) to the buyer EOA.
3. Registers the relay EOA as a `VoucherPool` operator (so it's allowed
   to submit `redeem` and accrue credit).
4. Writes the deployed addresses + chainId into each dapp's
   `public/config.json`.
5. Writes `tools/last-deploy.json` (used by `tools/checkpoint.mjs`).

Expected output ends with:

```
> wrote packages/purchaser/public/config.json
> wrote packages/chat/public/config.json
> wrote packages/relay/public/config.json
> wrote tools/last-deploy.json
done.
```

If you re-deploy, every dapp picks up the new addresses on next reload.

## 3 — Start the dapps

Open three more terminals (one per dapp), all from the repo root:

```bash
pnpm --filter @community-credits/purchaser run dev   # http://localhost:5173
pnpm --filter @community-credits/chat      run dev   # http://localhost:5174
pnpm --filter @community-credits/relay     run dev   # http://localhost:5175
```

Each is a Vite dev server. They are completely independent SPAs — they
communicate only via deep links (the user pastes/clicks a URL with a
`?import=…` / `?relay=…` / `?community-import=…` query string).

## 4 — MetaMask setup

The chat dapp has no wallet. Purchaser and relay do. Each needs the
chopsticks-forked Polkadot Asset Hub registered as a custom network and
each needs the corresponding PoC test key imported.

Network (Settings → Networks → Add):

- Network name: `Polkadot Asset Hub (chopsticks fork)`
- RPC URL: `http://localhost:8545`
- Chain ID: from `tools/last-deploy.json` `chainId` field
  (`420420419` on the current revive fork)
- Currency symbol: `DOT`

Import the buyer key into MetaMask (Settings → Accounts → Import Account
→ Private Key) — print it with:

```bash
node -e "import('./tools/keys.mjs').then(m=>console.log(m.BUYER_PRIVATE_KEY))"
```

Switch to it before opening the purchaser dapp. Repeat for the relay key
(`RELAY_PRIVATE_KEY`) before using the relay dapp.

These keys are not secrets — they're derived from public strings in
`tools/keys.mjs`. Never reuse them on a real chain.

## 5 — Buy a voucher (purchaser dapp)

1. Open `http://localhost:5173`. Click "Connect" → pick MetaMask → confirm
   on the BUYER account. MetaMask may prompt to switch network.
2. Fill out the buy form:
   - Value: `100` (= 100 micro-tUSDC; the buyer was minted 1 000 000)
   - Expiry epoch: `9999` (epoch counter; far-future for the demo)
3. Click "Buy". The dapp:
   - generates a fresh note secret key `sk` and randomness,
   - proves the `create` circuit in a worker (~0.5–1 s),
   - approves tUSDC to `VoucherPool`,
   - calls `buyAndCreate(cm, value, expiry, π)` on the pool.
4. When the tx confirms, the dapp shows a link (and a QR) of the form
   `http://localhost:5174/?import=<base64-encoded-note>`. This is the
   handoff to the chat dapp — the note material is in the URL fragment
   only, never sent anywhere.

## 6 — Checkpoint the pending leaf

The chat dapp will not let you spend a note until the on-chain Merkle
tree includes it. The buy puts the commitment into the contract's
`pending stream`; a checkpointer must roll the stream into the
`checkpointedRoot` before any membership proof is valid.

Drain the stream once:

```bash
pnpm --filter tools run checkpoint
```

Expected output ends with `cp #1 ok (gas …)`. Each leaf costs ~0.007 DOT
(BATCH=1; production should use B≥8). For a persistent demo it's nicer to
let the checkpointer poll:

```bash
pnpm --filter tools run checkpoint -- --watch
```

This blocks every 4 s, drains anything new it sees, and re-blocks.

## 7 — Import the note in the chat dapp

Open the import link from step 5 — it lands in the chat dapp at
`http://localhost:5174/?import=…`. The dapp:

- decodes the note from the URL,
- recomputes the commitment from the note's secret material and verifies
  it matches the on-chain `VoucherCreated` event,
- writes the note to IndexedDB and re-renders the "My vouchers" list,
- displays `100 tUSDC` (or `⏳ pending checkpoint` if step 6 hasn't
  finished yet — refresh after the next checkpoint).

The chat dapp is signer-free by construction (`grep -rE
"BrowserProvider|eth_requestAccounts" packages/chat/src/` returns nothing).
It only reads chain state via a JSON-RPC provider.

## 8 — Assign to an operator (chat dapp + relay dapp)

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

1. rebuilds the off-chain Merkle mirror against
   `checkpointedRoot`/`checkpointedCount` from chain,
2. looks up this note's leaf index from the cached `StreamAppended`
   events,
3. errors with `note not yet checkpointed` if the leaf is still beyond
   `checkpointedCount` — go run the checkpointer again,
4. otherwise proves `assign` in a worker (~1 s),
5. emits a deep link of the form
   `http://localhost:5175/?relay=assign:<...>` and (separately) a
   `?community-import=…` link representing the dest note.

Open the relay link in the relay dapp window (manually paste it into the
address bar, or click — they're plain `<a>` tags). The relay dapp:

- parses the deep link,
- queues the tx in its "Pending submissions" UI,
- you click "Submit" → MetaMask asks for confirmation on the RELAY
  account → tx is sent.

The dest note's `community-import` link is copy/pasted into a second
chat-dapp tab to simulate the operator receiving it. That tab tracks
admin-side notes under a separate scope (`community-<id>`).

Run the checkpointer again so the assign's two new commitments (dest +
change) move into the tree.

## 9 — Redeem (chat-admin → relay)

In the second chat-dapp tab (admin mode), the dest note now shows as
spendable. Click the corresponding row and pick "Redeem":

- Operator id: same numeric id as the community id from step 8
- Redeem value: must equal the note's full value (no change allowed on
  redeem; remaining value goes back to the operator as `credit`)

The dapp proves `redeem` (~1 s) and emits
`http://localhost:5175/?relay=redeem:<...>`.

Open the link in the relay dapp, click "Submit". On confirmation the
redeem amount accrues to the operator's on-chain `credit(relay)` balance
and the dapp's credit-balance widget updates.

A final checkpoint pass merges the redeem's change commitment into the
tree (so it could be spent later if change > 0).

## 10 — Withdraw operator credit (relay dapp)

Back in the relay dapp, the "Withdraw" panel shows the current
`credit(relay)` value. Click "Withdraw" → MetaMask → tx → the entire
credit is paid out from the pool's tUSDC reserves to the relay EOA.

Cross-check: query `tUSDC.balanceOf(relay)` from any RPC and you should
see the redeem value land in the relay account (less the gas spent).

## 11 — Tear down

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

**`note not yet checkpointed` in the chat dapp.** Expected — run
`pnpm --filter tools run checkpoint`. The error message includes the
note's leaf index and the current `checkpointedCount` so you can confirm
the gap.

**`mirror root mismatch` from the checkpointer.** The on-chain tree has
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

- Architecture: see `docs/gas-design.md` for the stream+checkpoint
  rationale and the on-chain weight measurements that drove it.
- Protocol: `community-credits-poc-plan.md` (esp. §3 simplifications vs
  whitepaper and §8 three-dapp split).
- Session quirks: `CLAUDE.md` for foot-guns hit while building this.
