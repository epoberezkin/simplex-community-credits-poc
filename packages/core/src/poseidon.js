// Poseidon-hash wrapper around circomlibjs. circomlibjs initializes lazily and
// returns BN254 field elements via its own F instance. We funnel everything
// through bigint so callers don't have to learn ffjavascript's Fr API.
//
// IMPORTANT: the t-parameter choice (and round constants) must match the
// circom Poseidon template exactly — circomlibjs uses iden3's standard
// (t=2..17), the same one circomlib.circuits.poseidon uses. Verified via the
// commitment-equality test in `crypto.test.js`.

import { buildPoseidon } from 'circomlibjs';

let _p;
let _F;

export async function poseidon() {
  if (!_p) {
    _p = await buildPoseidon();
    _F = _p.F;
  }
  return _p;
}

export async function field() {
  await poseidon();
  return _F;
}

// hash([a, b, ...]) → bigint
export async function poseidonHash(inputs) {
  const p = await poseidon();
  const arr = inputs.map((x) => BigInt(x));
  const out = p(arr);
  return BigInt(_F.toString(out));
}
