#!/usr/bin/env node
// Export Solidity verifier contracts from finalised zkeys.
// Drops them into contracts/contracts/verifiers/.

import * as snarkjs from 'snarkjs';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const KEYS = resolve(ROOT, 'keys');
const OUT = resolve(ROOT, '..', 'contracts', 'contracts', 'verifiers');

mkdirSync(OUT, { recursive: true });

const CIRCUITS = [
  { name: 'create', contract: 'CreateVerifier' },
  { name: 'assign', contract: 'AssignVerifier' },
  { name: 'redeem', contract: 'RedeemVerifier' },
];

// Bundled snarkjs Groth16 verifier template (it lives inside the package).
const tplPath = resolve(
  ROOT,
  'node_modules',
  'snarkjs',
  'templates',
  'verifier_groth16.sol.ejs',
);
const tpl = readFileSync(tplPath, 'utf8');

for (const { name, contract } of CIRCUITS) {
  const zkey = resolve(KEYS, `${name}_final.zkey`);
  console.log(`> ${name} → ${contract}.sol`);
  let src = await snarkjs.zKey.exportSolidityVerifier(zkey, { groth16: tpl });
  // Rename the generated `contract Groth16Verifier` to our circuit-specific name.
  src = src.replace(/contract\s+Groth16Verifier/g, `contract ${contract}`);
  writeFileSync(resolve(OUT, `${contract}.sol`), src);
}

console.log('all verifiers written.');
process.exit(0);
