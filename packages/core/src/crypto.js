// Per-note keypair + commitment + nullifier derivation.
//
// Owner key model (whitepaper §4.5.1 PoC simplification):
//   sk          = random field element
//   ownerPkHash = Poseidon(sk)
// No elliptic curve in-circuit.

import { poseidonHash } from './poseidon.js';

// BN254 scalar field prime; sk and randomness must be < FIELD.
export const FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Sample a uniformly random field element using rejection sampling.
export function randomFieldElement(rngBytes = defaultRng) {
  while (true) {
    const buf = rngBytes(32);
    let x = 0n;
    for (let i = 0; i < 32; i++) x = (x << 8n) | BigInt(buf[i]);
    if (x < FIELD) return x;
  }
}

// Default RNG: webcrypto (available in Node ≥19 and all modern browsers).
function defaultRng(n) {
  const u = new Uint8Array(n);
  globalThis.crypto.getRandomValues(u);
  return u;
}

export async function deriveOwnerPkHash(sk) {
  return poseidonHash([sk]);
}

export async function generateKeypair(rngBytes = defaultRng) {
  const sk = randomFieldElement(rngBytes);
  const ownerPkHash = await deriveOwnerPkHash(sk);
  return { sk, ownerPkHash };
}

// cm = Poseidon(value, expiryEpoch, ownerPkHash, randomness, assigned, redeemerHash)
export async function deriveCommitment({
  value,
  expiryEpoch,
  ownerPkHash,
  randomness,
  assigned,
  redeemerHash,
}) {
  return poseidonHash([
    value,
    expiryEpoch,
    ownerPkHash,
    randomness,
    assigned,
    redeemerHash,
  ]);
}

// nf = Poseidon(sk, cm)
export async function deriveNullifier(sk, cm) {
  return poseidonHash([sk, cm]);
}
