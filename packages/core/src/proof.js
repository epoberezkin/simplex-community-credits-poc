// snarkjs Groth16 wrappers. Used both by Node tests and (via web-worker
// indirection) by the browser dapps.
//
// Output format matches the solidity verifier's verifyProof(uint[2] pA,
// uint[2][2] pB, uint[2] pC, uint[N] pubSignals) signature. The wire format
// used in deep-link bundles is the flat 8-uint proof array
// [a0, a1, b00, b01, b10, b11, c0, c1] — see formatProofForSolidity().

import * as snarkjs from 'snarkjs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolved from circuits/ relative to this file (packages/core/src/).
function pathOf(name, kind) {
  const root = resolve(__dirname, '..', '..', '..', 'circuits');
  if (kind === 'wasm') return resolve(root, 'build', name, `${name}_js`, `${name}.wasm`);
  if (kind === 'zkey') return resolve(root, 'keys', `${name}_final.zkey`);
  if (kind === 'vkey') return resolve(root, 'keys', `${name}_vkey.json`);
  throw new Error('unknown kind');
}

function loadVkey(name) {
  return JSON.parse(readFileSync(pathOf(name, 'vkey'), 'utf8'));
}

// Bigint values → strings recursively (snarkjs wants strings at every
// nested array level, e.g. multi-dim input arrays).
function biToStr(v) {
  if (Array.isArray(v)) return v.map(biToStr);
  return v.toString();
}

function biToStrInputs(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) out[k] = biToStr(v);
  return out;
}

// proof + publicSignals from full prove. Flat 8-uint proof for Solidity.
export function formatProofForSolidity(proof) {
  return [
    BigInt(proof.pi_a[0]),
    BigInt(proof.pi_a[1]),
    BigInt(proof.pi_b[0][1]), // NOTE: pi_b uses Fp2; the verifier expects [x, y]
    BigInt(proof.pi_b[0][0]),
    BigInt(proof.pi_b[1][1]),
    BigInt(proof.pi_b[1][0]),
    BigInt(proof.pi_c[0]),
    BigInt(proof.pi_c[1]),
  ];
}

async function prove(name, input) {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    biToStrInputs(input),
    pathOf(name, 'wasm'),
    pathOf(name, 'zkey'),
  );
  return {
    proof,
    proofFlat: formatProofForSolidity(proof),
    publicSignals: publicSignals.map((x) => BigInt(x)),
  };
}

export async function verify(name, proof, publicSignals) {
  const vk = loadVkey(name);
  return snarkjs.groth16.verify(
    vk,
    publicSignals.map((x) => x.toString()),
    proof,
  );
}

export const proveCreate = (input) => prove('create', input);
export const proveAssign = (input) => prove('assign', input);
export const proveRedeem = (input) => prove('redeem', input);
