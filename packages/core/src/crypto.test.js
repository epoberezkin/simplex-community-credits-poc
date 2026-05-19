import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateKeypair,
  deriveCommitment,
  deriveNullifier,
  deriveOwnerPkHash,
  FIELD,
} from './crypto.js';
import { poseidonHash } from './poseidon.js';

test('keypair: ownerPkHash == Poseidon(sk)', async () => {
  const { sk, ownerPkHash } = await generateKeypair();
  assert.ok(sk > 0n && sk < FIELD);
  const expected = await poseidonHash([sk]);
  assert.equal(ownerPkHash, expected);
});

test('commitment is deterministic', async () => {
  const args = {
    value: 1000n,
    expiryEpoch: 5n,
    ownerPkHash: 7n,
    randomness: 11n,
    assigned: 0n,
    redeemerHash: 0n,
  };
  const a = await deriveCommitment(args);
  const b = await deriveCommitment(args);
  assert.equal(a, b);
});

test('nullifier binds sk to cm', async () => {
  const cm = 0x1234n;
  const a = await deriveNullifier(1n, cm);
  const b = await deriveNullifier(2n, cm);
  const c = await deriveNullifier(1n, cm + 1n);
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});
