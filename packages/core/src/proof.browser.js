// Browser proof wrapper. Fetches the wasm + zkey from /zk/<name>.{wasm,zkey}
// at proof time (lazy; cached by service worker on revisit).
//
// Used by dapps. Node tests use proof.js instead.

import * as snarkjs from 'snarkjs';

function biToStr(v) {
  if (Array.isArray(v)) return v.map(biToStr);
  return v.toString();
}
function biToStrInputs(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) out[k] = biToStr(v);
  return out;
}

export function formatProofForSolidity(proof) {
  return [
    BigInt(proof.pi_a[0]),
    BigInt(proof.pi_a[1]),
    BigInt(proof.pi_b[0][1]),
    BigInt(proof.pi_b[0][0]),
    BigInt(proof.pi_b[1][1]),
    BigInt(proof.pi_b[1][0]),
    BigInt(proof.pi_c[0]),
    BigInt(proof.pi_c[1]),
  ];
}

async function prove(name, input, basePath = '/zk') {
  const wasm = `${basePath}/${name}.wasm`;
  const zkey = `${basePath}/${name}_final.zkey`;
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    biToStrInputs(input),
    wasm,
    zkey,
  );
  return {
    proof,
    proofFlat: formatProofForSolidity(proof),
    publicSignals: publicSignals.map((x) => BigInt(x)),
  };
}

export const proveCreateBrowser = (i, p) => prove('create', i, p);
export const proveAssignBrowser = (i, p) => prove('assign', i, p);
export const proveRedeemBrowser = (i, p) => prove('redeem', i, p);
