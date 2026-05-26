#!/usr/bin/env node
// Print the canonical zero-subtree Poseidon hashes for depths 0..20.
// Used to seed the on-chain frontier and to hardcode constants in the
// checkpoint circuit. ZERO_LEAF = 0 matches the off-chain mirror's
// IncrementalMerkleTree.
import { poseidonHash } from '../packages/core/src/poseidon.js';
const DEPTH = 20;
let z = 0n;
const zs = [z];
for (let i = 1; i <= DEPTH; i++) {
  z = await poseidonHash([z, z]);
  zs.push(z);
}
console.log('Decimal (for circom):');
zs.forEach((v, i) => console.log(`  zeros[${i}] = ${v};`));
console.log('\nHex (for Solidity / docs):');
zs.forEach((v, i) =>
  console.log(`  zero[${String(i).padStart(2)}] = 0x${v.toString(16).padStart(64, '0')}`)
);
process.exit(0);
