// msgpack + base64url encoders for notes / assign bundles / redeem bundles.
// Wire format defined in plan §8.5.

import { encode as msgEncode, decode as msgDecode } from '@msgpack/msgpack';

function b64uEncode(bytes) {
  const b64 = Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64uDecode(str) {
  const pad = '='.repeat((4 - (str.length % 4)) % 4);
  return new Uint8Array(
    Buffer.from(
      str.replace(/-/g, '+').replace(/_/g, '/') + pad,
      'base64',
    ),
  );
}

// We carry bigints as 32-byte big-endian Uint8Arrays (so the wire payload is
// stable and msgpack doesn't have to lean on its bigint extension).
function bigIntToBytes(x, n = 32) {
  const out = new Uint8Array(n);
  let v = BigInt(x);
  for (let i = n - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function bytesToBigInt(bytes) {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

// ---- Note ----

export function encodeNote(note) {
  const payload = {
    v: BigInt(note.value),
    e: note.expiryEpoch,
    o: bigIntToBytes(note.ownerPkHash),
    r: bigIntToBytes(note.randomness),
    a: note.assigned,
    h: bigIntToBytes(note.redeemerHash ?? 0n),
  };
  if (note.sk !== undefined) payload.sk = bigIntToBytes(note.sk);
  return b64uEncode(msgEncode(payload, { useBigInt64: true }));
}

export function decodeNote(str) {
  const raw = msgDecode(b64uDecode(str), { useBigInt64: true });
  return {
    value: BigInt(raw.v),
    expiryEpoch: Number(raw.e),
    ownerPkHash: bytesToBigInt(raw.o),
    randomness: bytesToBigInt(raw.r),
    assigned: Number(raw.a),
    redeemerHash: bytesToBigInt(raw.h),
    sk: raw.sk ? bytesToBigInt(raw.sk) : undefined,
  };
}

// ---- Assign bundle ----

export function encodeAssign(b) {
  const payload = {
    fn: 'assign',
    nf: bigIntToBytes(b.nullifier),
    e: b.expiryEpoch,
    cd: bigIntToBytes(b.cmDest),
    cc: bigIntToBytes(b.cmChange),
    rt: bigIntToBytes(b.root),
    pi: b.proof.map((x) => bigIntToBytes(x)),
  };
  return b64uEncode(msgEncode(payload));
}

export function decodeAssign(str) {
  const raw = msgDecode(b64uDecode(str));
  return {
    fn: raw.fn,
    nullifier: bytesToBigInt(raw.nf),
    expiryEpoch: Number(raw.e),
    cmDest: bytesToBigInt(raw.cd),
    cmChange: bytesToBigInt(raw.cc),
    root: bytesToBigInt(raw.rt),
    proof: raw.pi.map((x) => bytesToBigInt(x)),
  };
}

// ---- Redeem bundle ----

export function encodeRedeem(b) {
  const payload = {
    fn: 'redeem',
    nf: bigIntToBytes(b.nullifier),
    e: b.expiryEpoch,
    v: BigInt(b.redeemValue),
    cc: bigIntToBytes(b.cmChange),
    rt: bigIntToBytes(b.root),
    op: bigIntToBytes(b.operatorId, 20),
    pi: b.proof.map((x) => bigIntToBytes(x)),
  };
  return b64uEncode(msgEncode(payload, { useBigInt64: true }));
}

export function decodeRedeem(str) {
  const raw = msgDecode(b64uDecode(str), { useBigInt64: true });
  return {
    fn: raw.fn,
    nullifier: bytesToBigInt(raw.nf),
    expiryEpoch: Number(raw.e),
    redeemValue: BigInt(raw.v),
    cmChange: bytesToBigInt(raw.cc),
    root: bytesToBigInt(raw.rt),
    operatorId: bytesToBigInt(raw.op),
    proof: raw.pi.map((x) => bytesToBigInt(x)),
  };
}
