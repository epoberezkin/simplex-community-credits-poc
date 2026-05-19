#!/usr/bin/env node
// Per-circuit Groth16 phase-2 setup using a precomputed Hermez powersOfTau file.
// Single-contributor ceremony (PoC; production needs MPC).

import * as snarkjs from 'snarkjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const BUILD = resolve(ROOT, 'build');
const KEYS = resolve(ROOT, 'keys');
const PTAU = resolve(ROOT, '..', 'ptau', 'powersOfTau28_hez_final_14.ptau');

const CIRCUITS = ['create', 'assign', 'redeem'];

if (!existsSync(PTAU)) {
  throw new Error(`Missing ${PTAU}. Re-run ptau download.`);
}

mkdirSync(KEYS, { recursive: true });

for (const c of CIRCUITS) {
  console.log(`\n=== ${c} ===`);
  const r1cs = resolve(BUILD, c, `${c}.r1cs`);
  const zkey0 = resolve(KEYS, `${c}_0000.zkey`);
  const zkeyFinal = resolve(KEYS, `${c}_final.zkey`);
  const vkey = resolve(KEYS, `${c}_vkey.json`);

  console.log('  groth16 setup…');
  await snarkjs.zKey.newZKey(r1cs, PTAU, zkey0);

  console.log('  contributing entropy…');
  await snarkjs.zKey.contribute(
    zkey0,
    zkeyFinal,
    'community-credits-poc-contributor-1',
    randomBytes(32).toString('hex'),
  );

  console.log('  exporting verification key…');
  const vk = await snarkjs.zKey.exportVerificationKey(zkeyFinal);
  writeFileSync(vkey, JSON.stringify(vk, null, 2));
  console.log(`  ✓ wrote ${c}_final.zkey + ${c}_vkey.json`);
}

console.log('\nall keys ready.');
process.exit(0);
