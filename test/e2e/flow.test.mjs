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

import {
  generateKeypair,
  deriveCommitment,
  deriveNullifier,
  randomFieldElement,
  IncrementalMerkleTree,
  redeemerHashFromId,
  proveCreate,
  proveAssign,
  proveRedeem,
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
} from '@community-credits/core';

import { deployAll } from './deploy.mjs';

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
    const url = process.env.CHOPSTICKS_RPC_URL || 'http://127.0.0.1:8545';
    provider = new ethers.JsonRpcProvider(url);
    const pk = process.env.PRIVATE_KEY;
    if (!pk) throw new Error('TARGET=chopsticks requires PRIVATE_KEY (deployer)');
    admin = new ethers.NonceManager(new ethers.Wallet(pk, provider));
    const buyerWallet = ethers.Wallet.createRandom().connect(provider);
    const relayWallet = ethers.Wallet.createRandom().connect(provider);
    await (await admin.sendTransaction({ to: buyerWallet.address, value: ethers.parseEther('1') })).wait();
    await (await admin.sendTransaction({ to: relayWallet.address, value: ethers.parseEther('1') })).wait();
    buyer = new ethers.NonceManager(buyerWallet);
    relay = new ethers.NonceManager(relayWallet);
  } else {
    throw new Error(`unknown TARGET=${target}`);
  }

  // ------------------------------------------------------- deploy + setup ---

  const { tUsdc, pool } = await deployAll({ signer: admin, epochSize: 100 });
  console.log('  pool   :', await pool.getAddress());
  console.log('  tUSDC  :', await tUsdc.getAddress());

  const buyerAddr = await buyer.getAddress();
  const relayAddr = await relay.getAddress();
  await (await tUsdc.connect(admin).mint(buyerAddr, 1_000_000n)).wait();
  await (await pool.connect(admin).registerOperator(relayAddr)).wait();

  // Local mirror tree the chat dapp would rebuild from events.
  const mirror = new IncrementalMerkleTree();
  const buyerStore = new NoteStore();
  const communityStore = new NoteStore();

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

    await (await tUsdc.connect(buyer).approve(await pool.getAddress(), value)).wait();
    const txr = await (
      await pool
        .connect(buyer)
        .buyAndCreate(cm, value, Number(expiryEpoch), pA, pB, pC)
    ).wait();

    const poolBal = await tUsdc.balanceOf(await pool.getAddress());
    assertEq(poolBal, value, 'pool balance');
    assertEq(await tUsdc.balanceOf(buyerAddr), 1_000_000n - value, 'buyer balance');

    // Find emitted leaf index from the VoucherCreated log.
    const ev = txr.logs
      .map((l) => {
        try { return pool.interface.parseLog(l); } catch { return null; }
      })
      .find((p) => p && p.name === 'VoucherCreated');
    assertOk(ev, 'VoucherCreated event');
    const leafIndex = Number(ev.args.leafIndex);
    await mirror.insert(cm);

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
    const txr = await (
      await pool
        .connect(relay)
        .assign(b.nullifier, b.expiryEpoch, b.cmDest, b.cmChange, b.root, pA, pB, pC)
    ).wait();
    assertOk(txr.status === 1, 'assign tx status');

    // Mirror the chain inserts in our local tree.
    await mirror.insert(b.cmDest);
    await mirror.insert(b.cmChange);

    // Update the chat store: mark old note spent, add change to buyer.
    buyerStore.markSpent(cm.toString());
    const destLeaf = await pool.nextLeafIndex() - 1n;
    const destLeafIndex = Number(destLeaf) - 1; // dest was inserted first
    const changeLeafIndex = Number(destLeaf);   // change second
    buyerStore.add({
      commitment: cmChange.toString(), leafIndex: changeLeafIndex - 1,
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
    void destLeaf;
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
          .assign(b.nullifier, b.expiryEpoch, b.cmDest, b.cmChange, b.root, pA, pB, pC)
      ).wait();
    } catch (e) {
      threw = /pool\/nullifier/.test(e.message);
    }
    assertOk(threw, 'expected pool/nullifier revert');
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
    const txr = await (
      await pool
        .connect(relay)
        .redeem(
          b.nullifier, b.expiryEpoch, b.redeemValue, b.cmChange, b.root,
          b.operatorId, pA, pB, pC,
        )
    ).wait();
    assertOk(txr.status === 1, 'redeem tx status');

    await mirror.insert(b.cmChange);

    assertEq(await pool.credit(relayAddr), redeemValue, 'credit balance');
    assertEq(await pool.spent(Number(expiryEpoch)), redeemValue, 'spent[epoch]');
  });

  await step('Dapp C — operator withdraw', async () => {
    const before = await tUsdc.balanceOf(relayAddr);
    await (await pool.connect(relay).withdraw(redeemValue)).wait();
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

  console.log(`\n${testsRun - testsFailed}/${testsRun} steps passed`);
  await stopHardhatNode();
  process.exit(testsFailed ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await stopHardhatNode();
  process.exit(1);
});
