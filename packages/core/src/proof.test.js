// Smoke tests for the 3 circuits. snarkjs spawns workers that node:test
// can't drain on Node 20, so we run sequentially and process.exit() at the end.

import assert from 'node:assert/strict';

import {
  generateKeypair,
  deriveCommitment,
  deriveNullifier,
  randomFieldElement,
} from './crypto.js';
import { redeemerHashFromId } from './identity.js';
import { IncrementalMerkleTree } from './merkle.js';
import { proveCreate, proveAssign, proveRedeem, verify } from './proof.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('create: prove + verify', async () => {
  const { sk, ownerPkHash } = await generateKeypair();
  const randomness = randomFieldElement();
  const value = 100n;
  const expiryEpoch = 7n;
  const cm = await deriveCommitment({
    value,
    expiryEpoch,
    ownerPkHash,
    randomness,
    assigned: 0n,
    redeemerHash: 0n,
  });

  const { proof, publicSignals } = await proveCreate({
    ownerPkHash,
    randomness,
    cm,
    value,
    expiryEpoch,
  });

  assert.equal(publicSignals[0], cm);
  assert.equal(publicSignals[1], value);
  assert.equal(publicSignals[2], expiryEpoch);
  assert.ok(await verify('create', proof, publicSignals));
});

test('assign: prove + verify', async () => {
  const buyer = await generateKeypair();
  const dest = await generateKeypair();
  const randomness = randomFieldElement();
  const destRandomness = randomFieldElement();
  const changeRandomness = randomFieldElement();
  const value = 100n;
  const destValue = 30n;
  const expiryEpoch = 7n;
  const communityId = 0xdeadbeefn;
  const redeemerHash = await redeemerHashFromId(communityId);

  const cmIn = await deriveCommitment({
    value,
    expiryEpoch,
    ownerPkHash: buyer.ownerPkHash,
    randomness,
    assigned: 0n,
    redeemerHash: 0n,
  });
  const tree = new IncrementalMerkleTree();
  await tree.insert(cmIn);
  const { pathElements, pathIndices, root } = await tree.proof(0);

  const nullifier = await deriveNullifier(buyer.sk, cmIn);
  const cmDest = await deriveCommitment({
    value: destValue,
    expiryEpoch,
    ownerPkHash: dest.ownerPkHash,
    randomness: destRandomness,
    assigned: 1n,
    redeemerHash,
  });
  const cmChange = await deriveCommitment({
    value: value - destValue,
    expiryEpoch,
    ownerPkHash: buyer.ownerPkHash,
    randomness: changeRandomness,
    assigned: 0n,
    redeemerHash: 0n,
  });

  const { proof, publicSignals } = await proveAssign({
    sk: buyer.sk,
    value,
    expiryEpoch,
    randomness,
    pathElements,
    pathIndices,
    destValue,
    destOwnerPkHash: dest.ownerPkHash,
    destRandomness,
    redeemerId: communityId,
    changeRandomness,
    root,
    nullifier,
    expiryEpochPub: expiryEpoch,
    cmDest,
    cmChange,
  });

  assert.equal(publicSignals[0], root);
  assert.equal(publicSignals[1], nullifier);
  assert.equal(publicSignals[2], expiryEpoch);
  assert.equal(publicSignals[3], cmDest);
  assert.equal(publicSignals[4], cmChange);
  assert.ok(await verify('assign', proof, publicSignals));
});

test('redeem: prove + verify', async () => {
  const community = await generateKeypair();
  const randomness = randomFieldElement();
  const changeRandomness = randomFieldElement();
  const value = 50n;
  const redeemValue = 20n;
  const changeValue = value - redeemValue;
  const expiryEpoch = 7n;
  const communityId = 0xfeedfacen;
  const redeemerHash = await redeemerHashFromId(communityId);
  const operatorId = 0xabcd1234n;

  const cmIn = await deriveCommitment({
    value,
    expiryEpoch,
    ownerPkHash: community.ownerPkHash,
    randomness,
    assigned: 1n,
    redeemerHash,
  });
  const tree = new IncrementalMerkleTree();
  await tree.insert(cmIn);
  const { pathElements, pathIndices, root } = await tree.proof(0);
  const nullifier = await deriveNullifier(community.sk, cmIn);

  const cmChange = await deriveCommitment({
    value: changeValue,
    expiryEpoch,
    ownerPkHash: community.ownerPkHash,
    randomness: changeRandomness,
    assigned: 1n,
    redeemerHash,
  });

  const { proof, publicSignals } = await proveRedeem({
    sk: community.sk,
    value,
    expiryEpoch,
    randomness,
    redeemerHash,
    redeemerId: communityId,
    pathElements,
    pathIndices,
    changeRandomness,
    changeValue,
    root,
    nullifier,
    expiryEpochPub: expiryEpoch,
    redeemValue,
    cmChange,
    operatorId,
  });

  assert.equal(publicSignals[5], operatorId);
  assert.ok(await verify('redeem', proof, publicSignals));
});

let failed = 0;
for (const [name, fn] of tests) {
  process.stdout.write(`• ${name} … `);
  const t0 = Date.now();
  try {
    await fn();
    console.log(`ok (${Date.now() - t0} ms)`);
  } catch (e) {
    failed++;
    console.log(`FAIL\n  ${e.message}`);
    if (process.env.VERBOSE) console.error(e);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
