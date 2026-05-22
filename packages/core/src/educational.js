// Educational inspector — renders a <details> panel showing:
//   1) the private inputs (witness) to a circuit prove() call
//   2) the decoded handover payload (what the QR/deep-link actually carries)
// Both as small tables, so a reader can see what's secret vs published.
//
// Browser-only (uses `document`). Reach via the `/educational` subpath so
// `@community-credits/core/index.js` stays DOM-free.

import { decodeNote, decodeAssign, decodeRedeem } from './note-codec.js';
import { parseDeepLink } from './handoff.js';

// ---- value formatters ----

function hexPad(v, bytes) {
  return BigInt(v).toString(16).padStart(bytes * 2, '0');
}
function fmtBinary(v, bytes = 32) {
  const hex = hexPad(v, bytes);
  return `${bytes} bytes (0x${hex.slice(0, 6)}…${hex.slice(-4)})`;
}
function fmtAddress(v) {
  return '0x' + hexPad(v, 20);
}
function fmtTusdc(v) {
  const s = (Number(v) / 1e6).toString();
  return `${s} tUSDC`;
}
function fmtUint(v) {
  return BigInt(v).toString();
}

function fmtPrivate(kind, v) {
  switch (kind) {
    case 'binary':       return fmtBinary(v, 32);
    case 'tusdc':        return fmtTusdc(v);
    case 'uint':         return fmtUint(v);
    case 'array-binary': return Array.isArray(v) ? `${v.length} × 32 bytes` : '?';
    case 'array-bits':   return Array.isArray(v) ? v.map((b) => (Number(b) ? '1' : '0')).join('') : '?';
    default:             return String(v);
  }
}
function fmtHandover(kind, v) {
  switch (kind) {
    case 'binary':       return fmtBinary(v, 32);
    case 'tusdc':        return fmtTusdc(v);
    case 'uint':         return fmtUint(v);
    case 'address':      return fmtAddress(v);
    case 'array-binary': return Array.isArray(v) ? `${v.length} × 32 bytes` : '?';
    default:             return String(v);
  }
}

// ---- per-circuit + per-handover metadata ----

// Per circuit, two metadata sets matching the .circom `component main
// {public [...]}` declaration. Anything not listed in either table is
// silently dropped — the renderer treats the union as authoritative.
const PRIVATE_INPUTS_META = {
  create: [
    ['ownerPkHash', 'binary', 'Poseidon(sk) — public key part embedded in the commitment'],
    ['randomness',  'binary', 'Blinding factor so identical (value, expiry, owner) make distinct cms'],
  ],
  assign: [
    ['sk',                'binary',       'Secret key — proves you own the source note'],
    ['value',             'tusdc',        'Source note face value'],
    ['expiryEpoch',       'uint',         'Source note expiry epoch'],
    ['randomness',        'binary',       'Blinding factor of the source note'],
    ['pathElements',      'array-binary', 'Merkle siblings on the path from source leaf to root'],
    ['pathIndices',       'array-bits',   'Left/right bit at each level (0 = source on the left)'],
    ['destValue',         'tusdc',        'How much goes to the dest community'],
    ['destOwnerPkHash',   'binary',       'Public key part of the dest (community) note'],
    ['destRandomness',    'binary',       'Blinding factor of the dest note'],
    ['redeemerId',        'uint',         'Community id (Poseidon(id) becomes the public redeemerHash in cm)'],
    ['changeRandomness',  'binary',       'Blinding factor of the change note (returns to you)'],
  ],
  redeem: [
    ['sk',                'binary',       'Secret key — proves the community owns the dest note'],
    ['value',             'tusdc',        'Dest note face value'],
    ['expiryEpoch',       'uint',         'Dest note expiry epoch'],
    ['randomness',        'binary',       'Blinding factor of the dest note'],
    ['redeemerHash',      'binary',       'Poseidon(redeemerId) — must match the cm\'s redeemerHash'],
    ['redeemerId',        'uint',         'Community id preimage of redeemerHash'],
    ['pathElements',      'array-binary', 'Merkle siblings on the path from dest leaf to root'],
    ['pathIndices',       'array-bits',   'Left/right bit at each level'],
    ['changeRandomness',  'binary',       'Blinding factor of the change note (stays in community)'],
    ['changeValue',       'tusdc',        'Note value minus redeemed amount'],
  ],
};

// Public inputs are passed to the verifier on chain as `pubSignals` in
// the declaration order of `component main {public [...]}`. Match here.
const PUBLIC_INPUTS_META = {
  create: [
    ['cm',          'binary', 'Commitment — chain appends to the stream and emits VoucherCreated'],
    ['value',       'tusdc',  'tUSDC the chain transfers from buyer to the pool'],
    ['expiryEpoch', 'uint',   'Chain checks > currentEpoch before accepting'],
  ],
  assign: [
    ['root',           'binary', 'Merkle root the proof binds to (chain checks it\'s a checkpointed root)'],
    ['nullifier',      'binary', 'Per-source-note tag — chain reverts if already spent'],
    ['expiryEpochPub', 'uint',   'Source note expiry (constrained equal to private expiryEpoch in-circuit)'],
    ['cmDest',         'binary', 'New dest commitment — chain appends to stream'],
    ['cmChange',       'binary', 'New change commitment — chain appends to stream'],
  ],
  redeem: [
    ['root',           'binary',  'Merkle root the proof binds to'],
    ['nullifier',      'binary',  'Per-dest-note tag — chain reverts if already spent'],
    ['expiryEpochPub', 'uint',    'Dest note expiry (constrained equal to private expiryEpoch)'],
    ['redeemValue',    'tusdc',   'tUSDC credited to the operator on chain'],
    ['cmChange',       'binary',  'New change commitment — chain appends to stream'],
    ['operatorId',     'address', 'Operator EVM address — chain checks isOperator[op]'],
  ],
};

// Handover rows are coloured by which class they belong to relative to
// the associated proof:
//   blue          = also appears in the proof's public inputs (pubSignals)
//   red           = also appears in the proof's private inputs (witness)
//   confidential  = secret hand-off material that isn't itself a circuit
//                   input (e.g. `sk` — Create takes ownerPkHash, not sk,
//                   but losing sk loses the funds)
//   plain         = none of the above (default black)
const HANDOVER_META = {
  note: [
    ['value',        'tusdc',  'Face value — also a Create pubSignal',          'blue'],
    ['expiryEpoch',  'uint',   'Spend deadline — also a Create pubSignal',      'blue'],
    ['ownerPkHash',  'binary', 'Public key — Poseidon(sk); Create witness',     'red'],
    ['randomness',   'binary', 'Blinding factor — Create witness, and witness to every future spend',  'red'],
    ['assigned',     'uint',   '0 = freshly minted; 1 = already assigned to a community', 'plain'],
    ['redeemerHash', 'binary', 'Poseidon(communityId) — 0 if not yet assigned', 'plain'],
    ['sk',           'binary', 'Secret key — anyone with this can spend the note. Not a Create input itself; only ownerPkHash = Poseidon(sk) is. (Omitted for view-only "community-import" links.)', 'confidential'],
  ],
  assign: [
    ['nullifier',    'binary',       'Per-source-note unique tag; chain rejects a second use', 'blue'],
    ['expiryEpoch',  'uint',         'Source note expiry epoch', 'blue'],
    ['cmDest',       'binary',       'New commitment for the community-owned dest note', 'blue'],
    ['cmChange',     'binary',       'New commitment for your change note', 'blue'],
    ['root',         'binary',       'Merkle root the proof binds to (chain checks it\'s a known checkpoint)', 'blue'],
    ['proof',        'array-binary', 'Groth16 proof — 8 × 32-byte field elements (pA, pB, pC)', 'plain'],
  ],
  redeem: [
    ['nullifier',    'binary',       'Per-dest-note unique tag; chain rejects a second use', 'blue'],
    ['expiryEpoch',  'uint',         'Dest note expiry epoch', 'blue'],
    ['redeemValue',  'tusdc',        'tUSDC credited to the operator', 'blue'],
    ['cmChange',     'binary',       'New commitment for the change note (stays in community)', 'blue'],
    ['root',         'binary',       'Merkle root the proof binds to', 'blue'],
    ['operatorId',   'address',      'Operator EVM address that gets credited', 'blue'],
    ['proof',        'array-binary', 'Groth16 proof — 8 × 32-byte field elements', 'plain'],
  ],
};

const COLOR_HEX = {
  red:          '#c33',     // private input (witness) of the associated proof
  blue:         '#1769d3',  // public input (pubSignal) of the associated proof
  confidential: '#b45309',  // confidential handover material that isn't an input itself (e.g. sk)
  plain:        '#222',     // neither (default body)
};

// ---- DOM construction ----

function el(tag, style, text) {
  const e = document.createElement(tag);
  if (style) e.style.cssText = style;
  if (text != null) e.textContent = text;
  return e;
}

function buildTable(meta, values, fmt, defaultColorName = 'plain') {
  const t = el('table', 'border-collapse:collapse;width:100%;font-size:0.8rem');
  const tr0 = el('tr');
  for (const lbl of ['field', 'value', 'meaning']) {
    tr0.appendChild(el(
      'th',
      'text-align:left;border-bottom:1px solid #ccc;padding:0.2rem 0.4rem;font-weight:500;color:#666',
      lbl,
    ));
  }
  t.appendChild(tr0);
  for (const [key, kind, hint, rowColor] of meta) {
    const v = values?.[key];
    if (v === undefined || v === null) continue;
    const color = COLOR_HEX[rowColor || defaultColorName] || COLOR_HEX.plain;
    const tr = el('tr');
    tr.appendChild(el('td', `padding:0.2rem 0.4rem;vertical-align:top;font-family:monospace;color:${color};white-space:nowrap`, key));
    tr.appendChild(el('td', `padding:0.2rem 0.4rem;vertical-align:top;font-family:monospace;word-break:break-all;color:${color}`, fmt(kind, v)));
    tr.appendChild(el('td', 'padding:0.2rem 0.4rem;vertical-align:top;color:#666', hint));
    t.appendChild(tr);
  }
  return t;
}

// `opts`: { circuit?, proveInputs?, handoverKind?, handoverPayload?, handoverUrl? }
//   - `proveInputs` is the full object you pass to prove() — the renderer
//     splits it into private + public tables via the per-circuit metadata.
export function buildInspectorPanel(opts) {
  const d = el('details', 'margin-top:0.6rem;border:1px solid #ddd;border-radius:6px;padding:0.4rem 0.6rem;background:#fafafa');
  d.appendChild(el('summary', 'cursor:pointer;font-weight:500;font-size:0.9rem', '🔍 Inspect — proof inputs & handover payload'));

  const inputs = opts.proveInputs || {};

  if (opts.circuit && PRIVATE_INPUTS_META[opts.circuit]) {
    d.appendChild(el('h4', 'margin:0.6rem 0 0.2rem;font-size:0.85rem;color:#444',
      'Private inputs (witness — never leave the dapp)'));
    d.appendChild(buildTable(PRIVATE_INPUTS_META[opts.circuit], inputs, fmtPrivate, 'red'));
  }

  if (opts.circuit && PUBLIC_INPUTS_META[opts.circuit]) {
    d.appendChild(el('h4', 'margin:0.6rem 0 0.2rem;font-size:0.85rem;color:#444',
      'Public inputs (committed by the proof; checked on chain as pubSignals)'));
    d.appendChild(buildTable(PUBLIC_INPUTS_META[opts.circuit], inputs, fmtHandover, 'blue'));
  }

  if (opts.handoverKind && HANDOVER_META[opts.handoverKind]) {
    d.appendChild(el('h4', 'margin:0.6rem 0 0.2rem;font-size:0.85rem;color:#444',
      `Handover payload (decoded from the ${opts.handoverKind === 'note' ? 'import' : opts.handoverKind} deep-link)`));
    // Per-row color encoded in the metadata (red = confidential, blue =
    // also a public input of the associated proof, plain = neither).
    d.appendChild(buildTable(HANDOVER_META[opts.handoverKind], opts.handoverPayload || {}, fmtHandover, 'plain'));
  }

  if (opts.handoverUrl) {
    const sz = new Blob([opts.handoverUrl]).size;
    d.appendChild(el('p', 'margin:0.4rem 0 0;color:#666;font-size:0.8rem',
      `Deep-link size: ${sz} bytes (msgpack + base64url + URL framing)`));
  }
  return d;
}

// Convenience for the relay side: given a parsed deep-link, return the
// decoded payload object the table renderer expects.
export function decodeForInspector(parsed) {
  if (!parsed) return null;
  if (parsed.kind === 'import' || parsed.kind === 'community-import') {
    return { kind: 'note', payload: parsed.note };
  }
  if (parsed.kind === 'assign') return { kind: 'assign', payload: parsed.bundle };
  if (parsed.kind === 'redeem') return { kind: 'redeem', payload: parsed.bundle };
  return null;
}

// Re-export the underlying codec helpers so callers don't need a second
// import line just to feed `decodeForInspector`.
export { decodeNote, decodeAssign, decodeRedeem, parseDeepLink };
