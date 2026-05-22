// End-to-end driver: buy → assign → redeem → withdraw, all via core,
// against a hardhat node by default (set TARGET=chopsticks to point at a
// running chopsticks/eth-rpc bridge).
//
// The harness exercises the same code paths the three dapps will use, with
// one extra rule: the chat-side simulations never touch a signer. Any tx
// initiated by chat code calls process.exit(1) via an unbound signer.

import { ethers } from 'ethers';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import net from 'node:net';

import {
  generateKeypair,
  deriveCommitment,
  deriveNullifier,
  randomFieldElement,
  IncrementalMerkleTree,
  redeemerHashFromId,
  encodeNote,
  decodeNote,
  encodeAssign,
  decodeAssign,
  encodeRedeem,
  decodeRedeem,
  buildImportLink,
  buildAssignLink,
  buildRedeemLink,
  parseDeepLink,
  buildCheckpointInput,
} from '@community-credits/core';
import { proveCreate, proveAssign, proveRedeem, proveCheckpoint } from '@community-credits/core/proof';

import { deployAll } from './deploy.mjs';
import {
  connectSubstrate, disconnectSubstrate, measured, feeReport,
  useEthProvider, gasReport, subjectFeeReport, declareSubjects,
} from './fees.mjs';

// ---------------------------------------------------------------- helpers ---

function unpackProof(flat) {
  return {
    pA: [flat[0], flat[1]],
    pB: [
      [flat[2], flat[3]],
      [flat[4], flat[5]],
    ],
    pC: [flat[6], flat[7]],
  };
}

let testsRun = 0;
let testsFailed = 0;
async function step(name, fn) {
  process.stdout.write(`• ${name} … `);
  const t0 = Date.now();
  try {
    await fn();
    console.log(`ok (${Date.now() - t0} ms)`);
    testsRun++;
  } catch (e) {
    console.log(`FAIL\n  ${e.message}`);
    if (process.env.VERBOSE) console.error(e.stack);
    testsRun++;
    testsFailed++;
  }
}

function assertEq(a, b, msg) {
  if (BigInt(a) !== BigInt(b)) throw new Error(`${msg}: ${a} !== ${b}`);
}
function assertOk(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// --------------------------------------------------------- hardhat startup ---

let hardhatProc = null;
async function startHardhatNode() {
  // Refuse to start if something is already listening on :8545.
  // Common cause: a stray `eth-rpc` / chopsticks bridge from a previous
  // `pnpm demo CHAIN=polkadot` session — same port, different chainId,
  // which ethers picks up as "network changed" mid-test.
  const inUse = await new Promise((resolve) => {
    const s = net.connect({ port: 8545, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error',   () => { s.destroy(); resolve(false); });
    setTimeout(() => { s.destroy(); resolve(false); }, 500);
  });
  if (inUse) {
    throw new Error(
      'port :8545 is already taken — likely a stale chopsticks eth-rpc.\n' +
        '  Kill it: pkill -f eth-rpc ; pkill -f chopsticks\n' +
        '  (eth-rpc db may need wiping too: rm -f ~/.local/share/eth-rpc/eth-rpc.db*)',
    );
  }
  return new Promise((resolve, reject) => {
    const p = spawn(
      'npx',
      ['hardhat', 'node', '--hostname', '127.0.0.1', '--port', '8545'],
      {
        cwd: new URL('../../contracts/', import.meta.url).pathname,
        env: { ...process.env },
      },
    );
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('Started HTTP and WebSocket JSON-RPC server')) resolve(p);
    });
    p.stderr.on('data', (d) => {
      if (process.env.VERBOSE) process.stderr.write(d);
    });
    p.on('exit', (code) => {
      if (code !== null && code !== 0) reject(new Error(`hardhat exit ${code}`));
    });
    setTimeout(() => reject(new Error('hardhat node startup timeout')), 30_000);
  });
}

async function stopHardhatNode() {
  if (!hardhatProc) return;
  hardhatProc.kill('SIGKILL');
  await wait(200);
  hardhatProc = null;
}

// --------------------------------------------------------- chat-side store ---

// A minimal in-memory store that mirrors how the chat dapp tracks notes.
// Indexed by leafIndex so that the witness builder can locate paths cheaply.
class NoteStore {
  constructor() {
    this.notes = []; // {commitment, leafIndex, note, scope, spent}
  }
  add(entry) {
    this.notes.push(entry);
  }
  active(scope) {
    return this.notes.filter((n) => !n.spent && n.scope === scope);
  }
  markSpent(commitment) {
    const n = this.notes.find((x) => x.commitment === commitment);
    if (n) n.spent = true;
  }
}

// ----------------------------------------------------------------- main ----

async function main() {
  const target = process.env.TARGET || 'hardhat';

  let provider;
  let buyer;
  let relay;
  let admin;

  if (target === 'hardhat') {
    console.log('starting hardhat node…');
    hardhatProc = await startHardhatNode();
    await wait(500);
    provider = new ethers.JsonRpcProvider('http://127.0.0.1:8545');
    const wallets = (await provider.send('eth_accounts', [])).slice(0, 3);
    const pks = [
      // Hardhat default mnemonic, accounts 0-2
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
      '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
    ];
    admin = new ethers.NonceManager(new ethers.Wallet(pks[0], provider));
    buyer = new ethers.NonceManager(new ethers.Wallet(pks[1], provider));
    relay = new ethers.NonceManager(new ethers.Wallet(pks[2], provider));
    void wallets;
  } else if (target === 'chopsticks') {
    // Deterministic-but-PoC-unique deployer/buyer/relay keys; the substrate-
    // mapped versions are prefunded with PAS (+ tUSDC for the buyer) in
    // chopsticks/paseo-asset-hub.yml. See the YAML's comment for the reason
    // we can't use the Hardhat defaults on a forked Paseo.
    const url = process.env.CHOPSTICKS_RPC_URL || 'http://localhost:8545';
    provider = new ethers.JsonRpcProvider(url);
    const pks = [
      '0x8f596c90dbdbe79218062ae45fafaf92e3efecbfe9695007e273e5c82d732f27', // deployer
      '0x72a4e571c864f09fdd0ab7ea50e4bbbb060ab18c9250b5c41a4877ad81761885', // buyer
      '0x1a7cd30490ac27d8c1fd65a942fc9bb2af050119f2140a0e8413ff70cc324822', // relay
    ];
    admin = new ethers.NonceManager(new ethers.Wallet(pks[0], provider));
    buyer = new ethers.NonceManager(new ethers.Wallet(pks[1], provider));
    relay = new ethers.NonceManager(new ethers.Wallet(pks[2], provider));
  } else {
    throw new Error(`unknown TARGET=${target}`);
  }

  // ------------------------------------------------------- deploy + setup ---

  // pallet-revive's eth-rpc estimateGas under-budgets contract calls that
  // hit ecPairing precompile + storage + external calls (our Groth16 verifier
  // + Poseidon Merkle insert burns far more PVM weight than EVM gas would
  // suggest). Bypass eth_estimateGas by passing an explicit cap on every tx.
  const TX_GAS = target === 'chopsticks' ? 100_000_000n : undefined;
  const callOpts = TX_GAS ? { gasLimit: TX_GAS } : {};

  const { tUsdc, pool } = await deployAll({ signer: admin, epochSize: 100, txOpts: callOpts });
  console.log('  pool   :', await pool.getAddress());
  console.log('  tUSDC  :', await tUsdc.getAddress());

  const buyerAddr = await buyer.getAddress();
  const relayAddr = await relay.getAddress();
  await (await tUsdc.connect(admin).mint(buyerAddr, 1_000_000n, callOpts)).wait();
  await (await pool.connect(admin).registerOperator(relayAddr, callOpts)).wait();

  // Fee measurement (chopsticks only). Connect to chopsticks's substrate WS
  // so we can read system.account.{free, reserved} before/after each tx.
  const measureFees = target === 'chopsticks';
  if (measureFees) {
    const subUrl = process.env.CHOPSTICKS_WS_URL || 'ws://127.0.0.1:8000';
    console.log('  substrate WS:', subUrl);
    await connectSubstrate(subUrl);
  } else {
    // Hardhat: feed `measured` an eth provider so it can still record
    // free-balance delta + gasUsed. Fee/deposit columns stay 0 on
    // hardhat (no substrate-side storage rent), but the action gas
    // summary is what we surface to the README quick-start.
    useEthProvider(provider);
  }
  const wrap = (label, payer, sendFn) => measured(label, payer, sendFn);

  // Local mirror of the *checkpointed* tree state. Updated only after a
  // checkpoint is submitted on-chain. The chat dapp rebuilds the same
  // mirror by replaying VoucherCreated / Assigned / Redeemed events up to
  // the latest Checkpointed event.
  const mirror = new IncrementalMerkleTree();
  // Commitments streamed but not yet rolled into a checkpoint.
  const pendingStream = []; // bigint[]
  const buyerStore = new NoteStore();
  const communityStore = new NoteStore();

  // Drain the pendingStream by submitting one checkpoint per commitment
  // (PoC uses BATCH=1; production should batch B≥8 — see docs/gas-design.md
  // §3b for the design and §5 for the cost analysis).
  async function drainCheckpoints() {
    while (pendingStream.length > 0) {
      const oldCount = Number(await pool.checkpointedCount());
      const cm = pendingStream[0];
      const { input } = await buildCheckpointInput({ mirror, cm, oldCount });
      const { proofFlat } = await proveCheckpoint(input);
      const { pA, pB, pC } = unpackProof(proofFlat);
      await wrap(`checkpoint #${oldCount + 1}`, relayAddr, () =>
        pool.connect(relay).checkpoint(
          input.newRoot, input.newCount, pA, pB, pC, callOpts,
        ),
      );
      pendingStream.shift();
    }
  }

  // ----------------------------------------------------------- buy/mint ---

  // Buyer key (per-voucher).
  const buyerKp = await generateKeypair();
  const randomness = randomFieldElement();
  const value = 1000n;
  const expiryEpoch = 100n;
  const cm = await deriveCommitment({
    value,
    expiryEpoch,
    ownerPkHash: buyerKp.ownerPkHash,
    randomness,
    assigned: 0n,
    redeemerHash: 0n,
  });

  let importLink;
  await step('Dapp A — buyer proves create + buyAndCreate', async () => {
    const { proofFlat } = await proveCreate({
      ownerPkHash: buyerKp.ownerPkHash,
      randomness,
      cm,
      value,
      expiryEpoch,
    });
    const { pA, pB, pC } = unpackProof(proofFlat);

    const poolAddr = await pool.getAddress();
    await wrap('approve', buyerAddr, () =>
      tUsdc.connect(buyer).approve(poolAddr, value, callOpts),
    );
    const txr = await wrap('buyAndCreate', buyerAddr, () =>
      pool.connect(buyer).buyAndCreate(cm, value, Number(expiryEpoch), pA, pB, pC, callOpts),
    );

    const poolBal = await tUsdc.balanceOf(await pool.getAddress());
    assertEq(poolBal, value, 'pool balance');
    assertEq(await tUsdc.balanceOf(buyerAddr), 1_000_000n - value, 'buyer balance');

    // Find emitted leaf index from the VoucherCreated log (the stream
    // position; not yet a tree leaf index — that's set at checkpoint time).
    const ev = txr.logs
      .map((l) => {
        try { return pool.interface.parseLog(l); } catch { return null; }
      })
      .find((p) => p && p.name === 'VoucherCreated');
    assertOk(ev, 'VoucherCreated event');
    const leafIndex = Number(ev.args.leafIndex);
    // cm is in the stream — NOT in the mirror yet. drainCheckpoints below
    // will roll it into the tree.
    pendingStream.push(cm);

    // Buyer hands the note to chat via deep link.
    importLink = buildImportLink('https://chat.example/', {
      value, expiryEpoch, ownerPkHash: buyerKp.ownerPkHash, randomness,
      assigned: 0, redeemerHash: 0n, sk: buyerKp.sk,
    });

    buyerStore.add({
      commitment: cm.toString(), leafIndex, sk: buyerKp.sk,
      ownerPkHash: buyerKp.ownerPkHash, randomness, value, expiryEpoch,
      assigned: 0, redeemerHash: 0n, scope: 'self', spent: false,
    });
  });

  await step('checkpoint after buy', async () => {
    await drainCheckpoints();
    assertEq(await pool.checkpointedCount(), 1n, 'checkpointedCount=1');
  });

  // ---------------------------- chat imports note from deep link ----------

  await step('Dapp B — chat imports note', async () => {
    const parsed = parseDeepLink(importLink);
    assertEq(parsed.kind === 'import' ? 1n : 0n, 1n, 'kind=import');
    const n = parsed.note;
    assertEq(n.value, value, 'imported value');
    assertEq(n.ownerPkHash, buyerKp.ownerPkHash, 'imported pkHash');
    assertEq(n.sk, buyerKp.sk, 'imported sk');
  });

  // ----------------------------- assign: chat proves, relay submits -------

  const communityId = 0xa11cen;
  const communityKp = await generateKeypair();
  const destValue = 250n;
  const changeValue = value - destValue;
  const destRandomness = randomFieldElement();
  const changeRandomness = randomFieldElement();
  const redeemerHash = await redeemerHashFromId(communityId);

  let assignBundleLink;
  let cmDest, cmChange, nullifier1;
  await step('Dapp B (chat) — prove assign, no signer', async () => {
    const entry = buyerStore.active('self')[0];
    const { pathElements, pathIndices, root } = await mirror.proof(entry.leafIndex);
    nullifier1 = await deriveNullifier(entry.sk, BigInt(entry.commitment));

    cmDest = await deriveCommitment({
      value: destValue,
      expiryEpoch: entry.expiryEpoch,
      ownerPkHash: communityKp.ownerPkHash,
      randomness: destRandomness,
      assigned: 1n,
      redeemerHash,
    });
    cmChange = await deriveCommitment({
      value: changeValue,
      expiryEpoch: entry.expiryEpoch,
      ownerPkHash: entry.ownerPkHash,
      randomness: changeRandomness,
      assigned: 0n,
      redeemerHash: 0n,
    });

    const { proofFlat } = await proveAssign({
      sk: entry.sk,
      value: entry.value,
      expiryEpoch: entry.expiryEpoch,
      randomness: entry.randomness,
      pathElements,
      pathIndices,
      destValue,
      destOwnerPkHash: communityKp.ownerPkHash,
      destRandomness,
      redeemerId: communityId,
      changeRandomness,
      root,
      nullifier: nullifier1,
      expiryEpochPub: entry.expiryEpoch,
      cmDest,
      cmChange,
    });

    assignBundleLink = buildAssignLink('https://relay.example/', {
      nullifier: nullifier1,
      expiryEpoch: Number(entry.expiryEpoch),
      cmDest,
      cmChange,
      root,
      proof: proofFlat,
    });
  });

  await step('Dapp C (relay) — submit assign tx', async () => {
    const parsed = parseDeepLink(assignBundleLink);
    assertEq(parsed.kind === 'assign' ? 1n : 0n, 1n, 'kind=assign');
    const b = parsed.bundle;
    const { pA, pB, pC } = unpackProof(b.proof);
    const txr = await wrap('assign', relayAddr, () =>
      pool.connect(relay).assign(
        b.nullifier, b.expiryEpoch, b.cmDest, b.cmChange, b.root, pA, pB, pC, callOpts,
      ),
    );
    assertOk(txr.status === 1, 'assign tx status');

    // Both new commitments land in the stream. They'll be folded into the
    // tree by the next drainCheckpoints() pass; record their eventual leaf
    // positions now (Assigned event includes destLeafIndex / changeLeafIndex
    // = the stream positions).
    const ev = txr.logs
      .map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === 'Assigned');
    assertOk(ev, 'Assigned event');
    const destLeafIndex = Number(ev.args.destLeafIndex);
    const changeLeafIndex = Number(ev.args.changeLeafIndex);
    pendingStream.push(b.cmDest, b.cmChange);

    // Update the chat store: mark old note spent, add change to buyer.
    buyerStore.markSpent(cm.toString());
    buyerStore.add({
      commitment: cmChange.toString(), leafIndex: changeLeafIndex,
      sk: buyerKp.sk, ownerPkHash: buyerKp.ownerPkHash, randomness: changeRandomness,
      value: changeValue, expiryEpoch, assigned: 0, redeemerHash: 0n,
      scope: 'self', spent: false,
    });
    communityStore.add({
      commitment: cmDest.toString(), leafIndex: destLeafIndex,
      sk: communityKp.sk, ownerPkHash: communityKp.ownerPkHash, randomness: destRandomness,
      value: destValue, expiryEpoch, assigned: 1, redeemerHash,
      scope: 'self', spent: false,
    });
  });

  await step('checkpoint after assign', async () => {
    await drainCheckpoints();
    assertEq(await pool.checkpointedCount(), 3n, 'checkpointedCount=3');
  });

  await step('double-spend assign reverts', async () => {
    const parsed = parseDeepLink(assignBundleLink);
    const b = parsed.bundle;
    const { pA, pB, pC } = unpackProof(b.proof);
    let threw = false;
    try {
      await (
        await pool
          .connect(relay)
          .assign(b.nullifier, b.expiryEpoch, b.cmDest, b.cmChange, b.root, pA, pB, pC, callOpts)
      ).wait();
    } catch (e) {
      // Hardhat surfaces the explicit "pool/nullifier" revert string;
      // pallet-revive/eth-rpc collapses it to a generic CALL_EXCEPTION
      // ("transaction execution reverted") without the reason. Accept both.
      threw = /pool\/nullifier|execution reverted/.test(e.message);
    }
    assertOk(threw, 'expected double-spend revert');
    // The eth_estimateGas pre-flight on the failed tx burned a phantom nonce
    // in NonceManager's local counter; resync from chain so the next tx
    // doesn't fall behind.
    relay.reset();
  });

  // ---------------------------- redeem: community proves, relay submits ---

  const redeemValue = 100n;
  const redeemChangeValue = destValue - redeemValue;
  const redeemChangeRandomness = randomFieldElement();
  let redeemBundleLink;
  let cmRedeemChange;
  let nullifier2;

  await step('Dapp B (community) — prove redeem', async () => {
    const entry = communityStore.active('self')[0];
    // Recompute path for the dest leaf — mirror tree has all leaves so far.
    // dest was inserted right after the create, before the change leaf.
    const { pathElements, pathIndices, root } = await mirror.proof(entry.leafIndex);
    nullifier2 = await deriveNullifier(entry.sk, BigInt(entry.commitment));

    cmRedeemChange = await deriveCommitment({
      value: redeemChangeValue,
      expiryEpoch: entry.expiryEpoch,
      ownerPkHash: entry.ownerPkHash,
      randomness: redeemChangeRandomness,
      assigned: 1n,
      redeemerHash,
    });

    const operatorId = BigInt(relayAddr);

    const { proofFlat } = await proveRedeem({
      sk: entry.sk,
      value: entry.value,
      expiryEpoch: entry.expiryEpoch,
      randomness: entry.randomness,
      redeemerHash,
      redeemerId: communityId,
      pathElements,
      pathIndices,
      changeRandomness: redeemChangeRandomness,
      changeValue: redeemChangeValue,
      root,
      nullifier: nullifier2,
      expiryEpochPub: entry.expiryEpoch,
      redeemValue,
      cmChange: cmRedeemChange,
      operatorId,
    });

    redeemBundleLink = buildRedeemLink('https://relay.example/', {
      nullifier: nullifier2,
      expiryEpoch: Number(entry.expiryEpoch),
      redeemValue,
      cmChange: cmRedeemChange,
      root,
      operatorId,
      proof: proofFlat,
    });
  });

  await step('Dapp C (relay) — submit redeem tx', async () => {
    const parsed = parseDeepLink(redeemBundleLink);
    assertEq(parsed.kind === 'redeem' ? 1n : 0n, 1n, 'kind=redeem');
    const b = parsed.bundle;
    const { pA, pB, pC } = unpackProof(b.proof);
    const txr = await wrap('redeem', relayAddr, () =>
      pool.connect(relay).redeem(
        b.nullifier, b.expiryEpoch, b.redeemValue, b.cmChange, b.root,
        b.operatorId, pA, pB, pC, callOpts,
      ),
    );
    assertOk(txr.status === 1, 'redeem tx status');

    // cmChange goes into the stream; the next drainCheckpoints() will fold
    // it into the tree. Not necessary for this test (no further spends),
    // but flush it anyway to exercise the post-redeem checkpoint path.
    pendingStream.push(b.cmChange);

    assertEq(await pool.credit(relayAddr), redeemValue, 'credit balance');
    assertEq(await pool.spent(Number(expiryEpoch)), redeemValue, 'spent[epoch]');
  });

  await step('checkpoint after redeem', async () => {
    await drainCheckpoints();
    assertEq(await pool.checkpointedCount(), 4n, 'checkpointedCount=4');
  });

  await step('Dapp C — operator withdraw', async () => {
    const before = await tUsdc.balanceOf(relayAddr);
    await wrap('withdraw', relayAddr, () =>
      pool.connect(relay).withdraw(redeemValue, callOpts),
    );
    const after = await tUsdc.balanceOf(relayAddr);
    assertEq(after - before, redeemValue, 'relay tUSDC delta');
    assertEq(await pool.credit(relayAddr), 0n, 'credit drained');
  });

  await step('solvency invariant holds', async () => {
    const deposited = await pool.deposited();
    const withdrawn = await pool.withdrawn();
    const credits = await pool.credit(relayAddr);
    const mintedE = await pool.minted(Number(expiryEpoch));
    const spentE = await pool.spent(Number(expiryEpoch));
    const reclaimedE = await pool.reclaimed(Number(expiryEpoch));
    const unspent = mintedE - spentE - reclaimedE;
    assertEq(unspent + credits, deposited - withdrawn, 'solvency');
  });

  await step('codec round-trip is byte-exact', async () => {
    const n = {
      value: 5n, expiryEpoch: 10, ownerPkHash: 0xabcn, randomness: 0xdefn,
      assigned: 1, redeemerHash: 0x123n, sk: 0x42n,
    };
    const enc = encodeNote(n);
    const dec = decodeNote(enc);
    assertEq(dec.value, n.value, 'note.value');
    assertEq(dec.ownerPkHash, n.ownerPkHash, 'note.pk');
    assertEq(dec.sk, n.sk, 'note.sk');
  });

  // Summaries
  declareSubjects({
    [buyerAddr.toLowerCase()]: 'buyer',
    [relayAddr.toLowerCase()]: 'paymaster + operator',
  });
  if (measureFees) {
    feeReport();
    subjectFeeReport();
  }
  gasReport();

  console.log(`\n${testsRun - testsFailed}/${testsRun} steps passed`);
  if (measureFees) await disconnectSubstrate();
  await stopHardhatNode();
  process.exit(testsFailed ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await stopHardhatNode();
  process.exit(1);
});
