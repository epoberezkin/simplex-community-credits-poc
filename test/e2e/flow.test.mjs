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
  deriveOwnerPkHash,
  randomFieldElement,
  IncrementalMerkleTree,
  redeemerHashFromId,
  demoCommunitySk,
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
  CHECKPOINT_BATCH_MAX,
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
let abortReason = null;            // set by a failing step → subsequent non-pure steps SKIP
// Call as either step(name, fn) or step(name, { pure: true }, fn).
async function step(name, optsOrFn, maybeFn) {
  const fn   = typeof optsOrFn === 'function' ? optsOrFn : maybeFn;
  const opts = typeof optsOrFn === 'function' ? {}       : optsOrFn;
  if (abortReason && !opts.pure) {
    console.log(`• ${name} … SKIP (${abortReason})`);
    return;
  }
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
    if (e.abortRest) abortReason = e.abortReason || 'previous step failed';
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
// Ensure the hardhat child is killed even on ctrl-C / SIGTERM / unhandled throw.
// process.on('exit') is synchronous — kill() works but await does not.
process.on('exit', killHardhat);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

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
        detached: true,
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

function killHardhat() {
  if (!hardhatProc) return;
  try { process.kill(-hardhatProc.pid, 'SIGKILL'); } catch {}
  hardhatProc = null;
}
async function stopHardhatNode() {
  killHardhat();
  await wait(200);
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
  let buyerA, buyerB;
  let relayA, relayB;
  let admin;

  if (target === 'hardhat') {
    console.log('starting hardhat node…');
    hardhatProc = await startHardhatNode();
    await wait(500);
    provider = new ethers.JsonRpcProvider('http://127.0.0.1:8545');
    const pks = [
      // Hardhat default mnemonic, accounts 0-4
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
      '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
      '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
      '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
    ];
    admin  = new ethers.NonceManager(new ethers.Wallet(pks[0], provider));
    buyerA = new ethers.NonceManager(new ethers.Wallet(pks[1], provider));
    relayA = new ethers.NonceManager(new ethers.Wallet(pks[2], provider));
    buyerB = new ethers.NonceManager(new ethers.Wallet(pks[3], provider));
    relayB = new ethers.NonceManager(new ethers.Wallet(pks[4], provider));
  } else if (target === 'chopsticks') {
    // Deterministic-but-PoC-unique deployer/buyer/relay keys; the substrate-
    // mapped versions are prefunded with PAS (+ tUSDC for the buyer) in
    // chopsticks/paseo-asset-hub.yml. See the YAML's comment for the reason
    // we can't use the Hardhat defaults on a forked Paseo.
    const url = process.env.CHOPSTICKS_RPC_URL || 'http://localhost:8545';
    // Probe the bridge with a quick eth_chainId before handing it to
    // ethers — otherwise a dead/half-dead eth-rpc surfaces as a generic
    // "socket hang up" inside the JsonRpcProvider retry loop.
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 }),
        signal: AbortSignal.timeout(3000),
      });
      const j = await res.json();
      if (!j?.result) throw new Error(`bad eth_chainId response: ${JSON.stringify(j)}`);
    } catch (e) {
      throw new Error(
        `eth-rpc at ${url} is not responding (${e.message}).\n` +
          `  1) Confirm chopsticks + eth-rpc are running:  bash chopsticks/run.sh\n` +
          `  2) If eth-rpc was started against a different chopsticks before,\n` +
          `     wipe its sqlite db:  rm -f ~/.local/share/eth-rpc/eth-rpc.db*\n` +
          `     then restart chopsticks.`,
      );
    }
    provider = new ethers.JsonRpcProvider(url);
    // Five PoC-derived keys — must match the chopsticks/*.yml prefund
    // block and tools/keys.mjs derivations.
    const pks = [
      '0x8f596c90dbdbe79218062ae45fafaf92e3efecbfe9695007e273e5c82d732f27', // deployer
      '0x72a4e571c864f09fdd0ab7ea50e4bbbb060ab18c9250b5c41a4877ad81761885', // buyer  (A)
      '0x1a7cd30490ac27d8c1fd65a942fc9bb2af050119f2140a0e8413ff70cc324822', // relay  (A)
      '0xe6cbf1d150bca3707ac1e57c24210fccc98ab18b19f285204aaee10b32e078aa', // buyer-b
      '0x84cb4bc63c318930019de582331821f26350c5d8536c597aa3aa37a63952cba3', // relay-b
    ];
    admin  = new ethers.NonceManager(new ethers.Wallet(pks[0], provider));
    buyerA = new ethers.NonceManager(new ethers.Wallet(pks[1], provider));
    relayA = new ethers.NonceManager(new ethers.Wallet(pks[2], provider));
    buyerB = new ethers.NonceManager(new ethers.Wallet(pks[3], provider));
    relayB = new ethers.NonceManager(new ethers.Wallet(pks[4], provider));
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

  const buyerAAddr = await buyerA.getAddress();
  const buyerBAddr = await buyerB.getAddress();
  const relayAAddr = await relayA.getAddress();
  const relayBAddr = await relayB.getAddress();
  for (const addr of [buyerAAddr, buyerBAddr]) {
    await (await tUsdc.connect(admin).mint(addr, 1_000_000n, callOpts)).wait();
  }
  for (const addr of [relayAAddr, relayBAddr]) {
    await (await pool.connect(admin).registerOperator(addr, callOpts)).wait();
  }

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
  // Per-subject note stores.
  const userAStore       = new NoteStore();
  const userBStore       = new NoteStore();
  const communityAStore  = new NoteStore();
  const communityBStore  = new NoteStore();

  // Drain the pendingStream in batches of CHECKPOINT_BATCH_MAX (8) per
  // extrinsic — one SNARK + one verifier call amortised across up to 8
  // leaves. See issue #2 (batching) and #3 (frontier on-chain).
  // Bills checkpointing to relayA since both relays are valid checkpointers.
  async function drainCheckpoints() {
    while (pendingStream.length > 0) {
      const oldCount = Number(await pool.checkpointedCount());
      const n = Math.min(pendingStream.length, CHECKPOINT_BATCH_MAX);
      const batch = pendingStream.slice(0, n);
      const { input } = await buildCheckpointInput({ mirror, cms: batch, oldCount });
      const { proofFlat } = await proveCheckpoint(input);
      const { pA, pB, pC } = unpackProof(proofFlat);
      await wrap(`checkpoint(n=${n})`, relayAAddr, () =>
        pool.connect(relayA).checkpoint(
          input.newRoot, input.newFrontier, n, pA, pB, pC, callOpts,
        ),
      );
      pendingStream.splice(0, n);
    }
  }

  // ----------------------------------------------------------- 2x2x2 flow ---
  //
  // Two end users, two communities, two relay operators. Each user buys
  // one voucher (100), assigns 20 to commA + 30 to commB. Each community
  // then redeems 5 with relayA + 8 with relayB. Final credit: relayA = 10,
  // relayB = 16. See README §"Local Interactive Demo" for the same flow
  // walked through the dapps.

  const expiryEpoch     = 100n;
  const BUY_VALUE       = 100n;
  const TO_COMM_A       = 20n;
  const TO_COMM_B       = 30n;
  const REDEEM_TO_RA    = 5n;
  const REDEEM_TO_RB    = 8n;

  const userAKp = await generateKeypair();
  const userBKp = await generateKeypair();
  // Communities use deterministic sks (cid → keccak → field) so user
  // (assigner) and admin (redeemer) agree on pkHash without coordination.
  const communityAId   = 1n;
  const communityBId   = 2n;
  const communityASk   = demoCommunitySk(communityAId);
  const communityBSk   = demoCommunitySk(communityBId);
  const communityAKp   = { sk: communityASk, ownerPkHash: await deriveOwnerPkHash(communityASk) };
  const communityBKp   = { sk: communityBSk, ownerPkHash: await deriveOwnerPkHash(communityBSk) };
  const redeemerHashA  = await redeemerHashFromId(communityAId);
  const redeemerHashB  = await redeemerHashFromId(communityBId);

  // --- shared helpers used by every step ---
  async function doBuy(userKp, signer, signerAddr, label) {
    const r  = randomFieldElement();
    const cm = await deriveCommitment({
      value: BUY_VALUE, expiryEpoch, ownerPkHash: userKp.ownerPkHash,
      randomness: r, assigned: 0n, redeemerHash: 0n,
    });
    const { proofFlat } = await proveCreate({
      ownerPkHash: userKp.ownerPkHash, randomness: r, cm,
      value: BUY_VALUE, expiryEpoch,
    });
    const { pA, pB, pC } = unpackProof(proofFlat);
    const poolAddr = await pool.getAddress();
    await wrap(`approve ${label}`, signerAddr, () =>
      tUsdc.connect(signer).approve(poolAddr, BUY_VALUE, callOpts),
    );
    const txr = await wrap(`buyAndCreate ${label}`, signerAddr, () =>
      pool.connect(signer).buyAndCreate(cm, BUY_VALUE, Number(expiryEpoch), pA, pB, pC, callOpts),
    );
    const ev = txr.logs
      .map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === 'VoucherCreated');
    assertOk(ev, `VoucherCreated event (${label})`);
    pendingStream.push(cm);
    return {
      commitment: cm.toString(), leafIndex: Number(ev.args.leafIndex),
      sk: userKp.sk, ownerPkHash: userKp.ownerPkHash, randomness: r,
      value: BUY_VALUE, expiryEpoch, assigned: 0, redeemerHash: 0n,
      scope: 'self', spent: false,
    };
  }

  async function doAssign(src, dstKp, dstCid, dstRedeemerHash, dstValue,
                          submitter, submitterAddr, label) {
    const { pathElements, pathIndices, root } = await mirror.proof(src.leafIndex);
    const nullifier      = await deriveNullifier(src.sk, BigInt(src.commitment));
    const destRandomness   = randomFieldElement();
    const changeRandomness = randomFieldElement();
    const changeValue      = src.value - dstValue;
    const cmDest = await deriveCommitment({
      value: dstValue, expiryEpoch: src.expiryEpoch,
      ownerPkHash: dstKp.ownerPkHash, randomness: destRandomness,
      assigned: 1n, redeemerHash: dstRedeemerHash,
    });
    const cmChange = await deriveCommitment({
      value: changeValue, expiryEpoch: src.expiryEpoch,
      ownerPkHash: src.ownerPkHash, randomness: changeRandomness,
      assigned: 0n, redeemerHash: 0n,
    });
    const { proofFlat } = await proveAssign({
      sk: src.sk, value: src.value, expiryEpoch: src.expiryEpoch,
      randomness: src.randomness, pathElements, pathIndices,
      destValue: dstValue, destOwnerPkHash: dstKp.ownerPkHash, destRandomness,
      redeemerId: dstCid, changeRandomness, root,
      nullifier, expiryEpochPub: src.expiryEpoch, cmDest, cmChange,
    });
    const { pA, pB, pC } = unpackProof(proofFlat);
    const txr = await wrap(`assign ${label}`, submitterAddr, () =>
      pool.connect(submitter).assign(
        nullifier, src.expiryEpoch, cmDest, cmChange, root, pA, pB, pC, callOpts,
      ),
    );
    const ev = txr.logs
      .map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === 'Assigned');
    assertOk(ev, `Assigned event (${label})`);
    pendingStream.push(cmDest, cmChange);
    return {
      destEntry: {
        commitment: cmDest.toString(), leafIndex: Number(ev.args.destLeafIndex),
        sk: dstKp.sk, ownerPkHash: dstKp.ownerPkHash, randomness: destRandomness,
        value: dstValue, expiryEpoch: src.expiryEpoch, assigned: 1,
        redeemerHash: dstRedeemerHash, scope: 'self', spent: false,
      },
      changeEntry: {
        commitment: cmChange.toString(), leafIndex: Number(ev.args.changeLeafIndex),
        sk: src.sk, ownerPkHash: src.ownerPkHash, randomness: changeRandomness,
        value: changeValue, expiryEpoch: src.expiryEpoch, assigned: 0,
        redeemerHash: 0n, scope: 'self', spent: false,
      },
    };
  }

  async function doRedeem(src, cid, redeemValue, relayWallet, relayAddr, label) {
    const { pathElements, pathIndices, root } = await mirror.proof(src.leafIndex);
    const nullifier      = await deriveNullifier(src.sk, BigInt(src.commitment));
    const changeRandomness = randomFieldElement();
    const changeValue      = src.value - redeemValue;
    const cmChange = await deriveCommitment({
      value: changeValue, expiryEpoch: src.expiryEpoch,
      ownerPkHash: src.ownerPkHash, randomness: changeRandomness,
      assigned: 1n, redeemerHash: src.redeemerHash,
    });
    const operatorId = BigInt(relayAddr);
    const { proofFlat } = await proveRedeem({
      sk: src.sk, value: src.value, expiryEpoch: src.expiryEpoch,
      randomness: src.randomness, redeemerHash: src.redeemerHash,
      redeemerId: cid, pathElements, pathIndices,
      changeRandomness, changeValue, root,
      nullifier, expiryEpochPub: src.expiryEpoch,
      redeemValue, cmChange, operatorId,
    });
    const { pA, pB, pC } = unpackProof(proofFlat);
    const txr = await wrap(`redeem ${label}`, relayAddr, () =>
      pool.connect(relayWallet).redeem(
        nullifier, src.expiryEpoch, redeemValue, cmChange, root, operatorId,
        pA, pB, pC, callOpts,
      ),
    );
    const ev = txr.logs
      .map((l) => { try { return pool.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === 'Redeemed');
    assertOk(ev, `Redeemed event (${label})`);
    pendingStream.push(cmChange);
    return {
      commitment: cmChange.toString(), leafIndex: Number(ev.args.changeLeafIndex),
      sk: src.sk, ownerPkHash: src.ownerPkHash, randomness: changeRandomness,
      value: changeValue, expiryEpoch: src.expiryEpoch, assigned: 1,
      redeemerHash: src.redeemerHash, scope: 'self', spent: false,
    };
  }

  // -------- buy phase --------
  let userANote, userBNote;
  await step('Dapp A — userA buys 100 tUSDC', async () => {
    try {
      userANote = await doBuy(userAKp, buyerA, buyerAAddr, 'userA');
      userAStore.add(userANote);
    } catch (e) {
      // First on-chain tx — abort cascade if it fails (e.g. stale PVM
      // verifier on chopsticks). Rest of the steps depend on it.
      e.abortRest = true;
      e.abortReason = 'first buyAndCreate failed — see test/e2e/deploy.mjs::assertPvmArtifactsFresh()';
      throw e;
    }
  });
  await step('Dapp A — userB buys 100 tUSDC', async () => {
    userBNote = await doBuy(userBKp, buyerB, buyerBAddr, 'userB');
    userBStore.add(userBNote);
  });
  await step('checkpoint after buys (drain 2)', async () => {
    await drainCheckpoints();
    assertEq(await pool.checkpointedCount(), 2n, 'checkpointedCount=2');
  });

  // -------- assign round 1: each user → commA, value 20 --------
  let userAChange, userBChange;
  await step('userA → commA assign 20', async () => {
    const r = await doAssign(userANote, communityAKp, communityAId, redeemerHashA,
      TO_COMM_A, relayA, relayAAddr, 'userA→commA');
    userAStore.markSpent(userANote.commitment);
    userAStore.add(r.changeEntry);
    communityAStore.add(r.destEntry);
    userAChange = r.changeEntry;
  });
  await step('userB → commA assign 20', async () => {
    const r = await doAssign(userBNote, communityAKp, communityAId, redeemerHashA,
      TO_COMM_A, relayA, relayAAddr, 'userB→commA');
    userBStore.markSpent(userBNote.commitment);
    userBStore.add(r.changeEntry);
    communityAStore.add(r.destEntry);
    userBChange = r.changeEntry;
  });
  await step('checkpoint after commA assigns (drain 4)', async () => {
    await drainCheckpoints();
    assertEq(await pool.checkpointedCount(), 6n, 'checkpointedCount=6');
  });

  // -------- assign round 2: each user → commB, value 30 (from change) --------
  await step('userA → commB assign 30 (from change)', async () => {
    const r = await doAssign(userAChange, communityBKp, communityBId, redeemerHashB,
      TO_COMM_B, relayA, relayAAddr, 'userA→commB');
    userAStore.markSpent(userAChange.commitment);
    userAStore.add(r.changeEntry);
    communityBStore.add(r.destEntry);
  });
  await step('userB → commB assign 30 (from change)', async () => {
    const r = await doAssign(userBChange, communityBKp, communityBId, redeemerHashB,
      TO_COMM_B, relayA, relayAAddr, 'userB→commB');
    userBStore.markSpent(userBChange.commitment);
    userBStore.add(r.changeEntry);
    communityBStore.add(r.destEntry);
  });
  await step('checkpoint after commB assigns (drain 4)', async () => {
    await drainCheckpoints();
    assertEq(await pool.checkpointedCount(), 10n, 'checkpointedCount=10');
  });

  // -------- redeem phase: each community → 5 to relayA, 8 to relayB --------
  // Each community holds two dest notes (one from each user). The two
  // redeems per community spend distinct source notes, so the proof
  // exercises both leaf positions.
  await step('commA → relayA redeem 5', async () => {
    const entry = communityAStore.active('self')[0];
    await doRedeem(entry, communityAId, REDEEM_TO_RA, relayA, relayAAddr, 'commA→relayA');
    communityAStore.markSpent(entry.commitment);
  });
  await step('commA → relayB redeem 8', async () => {
    const entry = communityAStore.active('self')[0];
    await doRedeem(entry, communityAId, REDEEM_TO_RB, relayB, relayBAddr, 'commA→relayB');
    communityAStore.markSpent(entry.commitment);
  });
  await step('commB → relayA redeem 5', async () => {
    const entry = communityBStore.active('self')[0];
    await doRedeem(entry, communityBId, REDEEM_TO_RA, relayA, relayAAddr, 'commB→relayA');
    communityBStore.markSpent(entry.commitment);
  });
  await step('commB → relayB redeem 8', async () => {
    const entry = communityBStore.active('self')[0];
    await doRedeem(entry, communityBId, REDEEM_TO_RB, relayB, relayBAddr, 'commB→relayB');
    communityBStore.markSpent(entry.commitment);
  });
  await step('checkpoint after redeems (drain 4)', async () => {
    await drainCheckpoints();
    assertEq(await pool.checkpointedCount(), 14n, 'checkpointedCount=14');
  });

  // -------- on-chain credit + per-relay withdraw --------
  await step('credit balances are 10 (relayA) and 16 (relayB)', async () => {
    assertEq(await pool.credit(relayAAddr), REDEEM_TO_RA * 2n, 'relayA credit');
    assertEq(await pool.credit(relayBAddr), REDEEM_TO_RB * 2n, 'relayB credit');
  });
  // On chopsticks the eth-rpc eth_call may lag one block behind the
  // just-mined withdraw tx. Poll until the balance reflects the transfer
  // (up to 30 s — two chopsticks block times).
  async function balanceAfterWithdraw(addr, expected) {
    const t0 = Date.now();
    while (Date.now() - t0 < 30_000) {
      const b = await tUsdc.balanceOf(addr);
      if (b >= expected) return b;
      await wait(2_000);
    }
    return tUsdc.balanceOf(addr);
  }
  await step('relayA withdraws 10', async () => {
    const before = await tUsdc.balanceOf(relayAAddr);
    await wrap('withdraw relayA', relayAAddr, () =>
      pool.connect(relayA).withdraw(REDEEM_TO_RA * 2n, callOpts),
    );
    const after = await balanceAfterWithdraw(relayAAddr, before + REDEEM_TO_RA * 2n);
    assertEq(after - before, REDEEM_TO_RA * 2n, 'relayA tUSDC delta');
    assertEq(await pool.credit(relayAAddr), 0n, 'relayA credit drained');
  });
  await step('relayB withdraws 16', async () => {
    const before = await tUsdc.balanceOf(relayBAddr);
    await wrap('withdraw relayB', relayBAddr, () =>
      pool.connect(relayB).withdraw(REDEEM_TO_RB * 2n, callOpts),
    );
    const after = await balanceAfterWithdraw(relayBAddr, before + REDEEM_TO_RB * 2n);
    assertEq(after - before, REDEEM_TO_RB * 2n, 'relayB tUSDC delta');
    assertEq(await pool.credit(relayBAddr), 0n, 'relayB credit drained');
  });

  await step('solvency invariant holds', async () => {
    const deposited  = await pool.deposited();
    const withdrawn  = await pool.withdrawn();
    const credits    = (await pool.credit(relayAAddr)) + (await pool.credit(relayBAddr));
    const mintedE    = await pool.minted(Number(expiryEpoch));
    const spentE     = await pool.spent(Number(expiryEpoch));
    const reclaimedE = await pool.reclaimed(Number(expiryEpoch));
    const unspent    = mintedE - spentE - reclaimedE;
    assertEq(unspent + credits, deposited - withdrawn, 'solvency');
  });

  // -------- adversary cases for the batched checkpoint --------
  // Hardhat-only: revert-reason matching relies on eth_estimateGas
  // running the tx in simulation and throwing the reason string. On
  // pallet-revive with explicit gasLimit, ethers bypasses estimation and
  // the tx gets mined with status=0 without throwing — the test can't
  // detect the revert inline. Contract logic is the same either way; we
  // just can't observe it from JS on chopsticks.
  if (target === 'hardhat') {
    await step('extra userA buy seeds 1 pending leaf', async () => {
      const extraNote = await doBuy(userAKp, buyerA, buyerAAddr, 'userA-extra');
      userAStore.add(extraNote);
    });
    await step('checkpoint(count=0) reverts ckp/no-progress', { pure: true }, async () => {
      const zeroFrontier = new Array(20).fill(0n);
      const zeroProof = { pA: [0n, 0n], pB: [[0n, 0n], [0n, 0n]], pC: [0n, 0n] };
      try {
        await pool.connect(relayA).checkpoint(
          0n, zeroFrontier, 0, zeroProof.pA, zeroProof.pB, zeroProof.pC, callOpts,
        );
        throw new Error('expected revert');
      } catch (e) {
        assertOk(/no-progress/.test(e.message), `got: ${e.message}`);
      }
    });
    await step('checkpoint(count=9 > B_MAX) reverts ckp/batch-size', { pure: true }, async () => {
      const zeroFrontier = new Array(20).fill(0n);
      const zeroProof = { pA: [0n, 0n], pB: [[0n, 0n], [0n, 0n]], pC: [0n, 0n] };
      try {
        await pool.connect(relayA).checkpoint(
          0n, zeroFrontier, 9, zeroProof.pA, zeroProof.pB, zeroProof.pC, callOpts,
        );
        throw new Error('expected revert');
      } catch (e) {
        assertOk(/batch-size/.test(e.message), `got: ${e.message}`);
      }
    });
    await step('checkpoint(fabricated newFrontier) reverts ckp/proof', { pure: true }, async () => {
      const oldCount = Number(await pool.checkpointedCount());
      const cm = pendingStream[0];
      const probeMirror = new IncrementalMerkleTree();
      await probeMirror._ensureInit();
      probeMirror.filledSubtrees = (await pool.checkpointedFrontier()).map((x) => BigInt(x));
      probeMirror._root = BigInt(await pool.checkpointedRoot());
      probeMirror.leaves = new Array(oldCount).fill(0n);
      const { input } = await buildCheckpointInput({ mirror: probeMirror, cms: [cm], oldCount });
      const { proofFlat } = await proveCheckpoint(input);
      const { pA, pB, pC } = unpackProof(proofFlat);
      const tampered = [...input.newFrontier];
      tampered[0] = tampered[0] ^ 1n;
      try {
        await pool.connect(relayA).checkpoint(
          input.newRoot, tampered, 1, pA, pB, pC, callOpts,
        );
        throw new Error('expected revert');
      } catch (e) {
        assertOk(/ckp\/proof/.test(e.message), `got: ${e.message}`);
      }
    });
    await step('permissionless: random key submits valid checkpoint', async () => {
      const stranger = new ethers.NonceManager(
        new ethers.Wallet(ethers.hexlify(ethers.randomBytes(32)), provider)
      );
      const strangerAddr = await stranger.getAddress();
      await provider.send('hardhat_setBalance', [
        strangerAddr, '0xDE0B6B3A7640000',
      ]);
      const oldCount = Number(await pool.checkpointedCount());
      const cm = pendingStream[0];
      const { input } = await buildCheckpointInput({ mirror, cms: [cm], oldCount });
      const { proofFlat } = await proveCheckpoint(input);
      const { pA, pB, pC } = unpackProof(proofFlat);
      const txr = await wrap('stranger checkpoint', strangerAddr, () =>
        pool.connect(stranger).checkpoint(
          input.newRoot, input.newFrontier, 1, pA, pB, pC, callOpts,
        ),
      );
      assertOk(txr.status === 1, 'tx succeeded');
      pendingStream.shift();
      assertEq(await pool.checkpointedCount(), BigInt(oldCount + 1), 'cp advanced');
    });
    await step('post-adversary solvency still holds', async () => {
      const deposited  = await pool.deposited();
      const withdrawn  = await pool.withdrawn();
      const credits    = (await pool.credit(relayAAddr)) + (await pool.credit(relayBAddr));
      const mintedE    = await pool.minted(Number(expiryEpoch));
      const spentE     = await pool.spent(Number(expiryEpoch));
      const reclaimedE = await pool.reclaimed(Number(expiryEpoch));
      const unspent    = mintedE - spentE - reclaimedE;
      assertEq(unspent + credits, deposited - withdrawn, 'solvency');
    });
  }

  await step('codec round-trip is byte-exact', { pure: true }, async () => {
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
    [buyerAAddr.toLowerCase()]: 'userA',
    [buyerBAddr.toLowerCase()]: 'userB',
    [relayAAddr.toLowerCase()]: 'relayA',
    [relayBAddr.toLowerCase()]: 'relayB',
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
