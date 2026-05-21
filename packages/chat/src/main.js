// Dapp B — Chat. NO signer, NO tx submission, NO wallet code.
// Holds owner keys locally, proves assign + redeem in a web worker, hands
// bundles to the relay dapp via deep link + QR.
//
// (Linting reminder: grep for 'eip6963' or 'BrowserProvider' in this dir
//  should return zero matches.)

// MUST be first — see ./buffer-polyfill.js. Inline polyfill won't work
// because ES module imports are hoisted.
import './buffer-polyfill.js';

import { ethers } from 'ethers';
import QRCode from 'qrcode';
import QrScanner from 'qr-scanner';
import {
  generateKeypair,
  deriveCommitment,
  deriveNullifier,
  randomFieldElement,
  IncrementalMerkleTree,
  redeemerHashFromId,
  parseDeepLink,
  buildAssignLink,
  buildRedeemLink,
  buildCommunityImportLink,
} from '@community-credits/core';
import { openStore } from '@community-credits/core/store';

const cfg = await fetch('./config.json').then((r) => r.json());

const POOL_ABI = [
  // canonical (position, cm) mapping for every appended leaf
  'event StreamAppended(uint32 indexed position, uint256 cm)',
  // stream + checkpoint views
  'function streamCount() view returns (uint32)',
  'function streamAt(uint32 position) view returns (uint256)',
  'function checkpointedRoot() view returns (uint256)',
  'function checkpointedCount() view returns (uint32)',
];

const store = await openStore();
const provider = new ethers.JsonRpcProvider(cfg.ethRpcUrl);
const pool =
  cfg.poolAddress && cfg.poolAddress !== '0x0000000000000000000000000000000000000000'
    ? new ethers.Contract(cfg.poolAddress, POOL_ABI, provider)
    : null;

// Off-chain mirror of the *checkpointed* Merkle tree. Membership proofs
// for assign/redeem must verify against `checkpointedRoot`, so the mirror
// must include exactly the leaves the contract has rolled into the tree
// (positions [0..checkpointedCount)). Leaves in the stream beyond that
// are pending — their notes are "not yet spendable" until a checkpointer
// rolls them in.
const mirror = new IncrementalMerkleTree();
let mirroredCount = 0;            // # of leaves currently in `mirror`
const cmToLeafIndex = new Map();  // commitment(decimal string) → uint32
let rebuildInFlight = null;       // serialize concurrent callers

async function rebuildMirror() {
  if (!pool) return;
  // Two render paths can call rebuildMirror concurrently; if both observe
  // the same `mirroredCount` they'll both insert the new leaves and the
  // mirror ends up with duplicates. Serialize on a shared promise so a
  // second caller waits for the first to finish (and sees its updated
  // mirroredCount).
  if (rebuildInFlight) return rebuildInFlight;
  rebuildInFlight = (async () => {
    // Refresh cm→leafIndex map from StreamAppended events.
    const evs = await pool.queryFilter('StreamAppended', 0, 'latest');
    for (const ev of evs) {
      cmToLeafIndex.set(ev.args.cm.toString(), Number(ev.args.position));
    }
    const checkpointed = Number(await pool.checkpointedCount());
    for (let i = mirroredCount; i < checkpointed; i++) {
      const cm = await pool.streamAt(i);
      await mirror.insert(BigInt(cm));
    }
    mirroredCount = checkpointed;
  })();
  try {
    await rebuildInFlight;
  } finally {
    rebuildInFlight = null;
  }
}

function leafIndexOf(note) {
  const idx = cmToLeafIndex.get(note.commitment);
  if (idx === undefined) {
    throw new Error('commitment not yet observed on-chain — refresh after the buy/assign tx confirms');
  }
  return idx;
}

async function isCheckpointed(leafIndex) {
  if (!pool) return false;
  return leafIndex < Number(await pool.checkpointedCount());
}

// ---- UI plumbing ----

const $ = (id) => document.getElementById(id);
let mode = 'user';

function setMode(next) {
  mode = next;
  $('modeUser').classList.toggle('active', next === 'user');
  $('modeAdmin').classList.toggle('active', next === 'admin');
  $('viewMyNotes').hidden = next !== 'user';
  $('viewAssign').hidden = next !== 'user';
  $('viewAdmin').hidden = next !== 'admin';
  if (next === 'user') renderUserNotes();
  else renderAdminNotes();
}

$('modeUser').onclick = () => setMode('user');
$('modeAdmin').onclick = () => setMode('admin');

async function handleIncomingDeepLink() {
  const parsed = parseDeepLink(location.href);
  if (!parsed) return;
  if (parsed.kind === 'import') {
    const note = parsed.note;
    if (!note.sk) {
      alert('Imported note has no sk — refusing.');
      return;
    }
    const cm = await deriveCommitment(note);
    await store.add('user', {
      commitment: cm.toString(),
      sk: note.sk.toString(),
      ownerPkHash: note.ownerPkHash.toString(),
      randomness: note.randomness.toString(),
      redeemerHash: note.redeemerHash.toString(),
      value: note.value.toString(),
      expiryEpoch: note.expiryEpoch,
      assigned: note.assigned,
      spent: false,
    });
    history.replaceState({}, '', location.pathname);
    await renderUserNotes();
  } else if (parsed.kind === 'community-import') {
    const note = parsed.note;
    const scope = `community-${parsed.communityId}`;
    const sk = await store.getKey(scope);
    if (!sk) {
      const fresh = randomFieldElement();
      await store.putKey(scope, fresh);
    }
    const cm = await deriveCommitment(note);
    await store.add(scope, {
      commitment: cm.toString(),
      sk: (await store.getKey(scope)).toString(),
      ownerPkHash: note.ownerPkHash.toString(),
      randomness: note.randomness.toString(),
      redeemerHash: note.redeemerHash.toString(),
      value: note.value.toString(),
      expiryEpoch: note.expiryEpoch,
      assigned: note.assigned,
      communityId: parsed.communityId,
      spent: false,
    });
    history.replaceState({}, '', location.pathname);
    setMode('admin');
  }
}

async function renderUserNotes() {
  const notes = await store.list('user');
  const host = $('notesList');
  host.innerHTML = '';
  const sel = $('assignNote');
  sel.innerHTML = '';
  if (notes.length === 0) {
    host.innerHTML = '<p class="mut">No vouchers yet. Open an <code>?import=…</code> link from the purchaser dapp.</p>';
    return;
  }
  // Pull checkpoint state once so the list reflects spendability.
  await rebuildMirror().catch(() => {});
  const cpCount = pool ? Number(await pool.checkpointedCount().catch(() => 0n)) : 0;
  for (const n of notes) {
    const row = document.createElement('div');
    row.className = 'note-row';
    const leafIdx = cmToLeafIndex.get(n.commitment);
    const pending =
      !n.spent && (leafIdx === undefined || leafIdx >= cpCount);
    const status = n.spent
      ? '✓ spent'
      : pending
        ? `${n.value} tUSDC (⏳ pending checkpoint)`
        : `${n.value} tUSDC`;
    row.innerHTML = `<span>cm ${n.commitment.slice(0, 10)}…</span><span>${status}</span>`;
    host.appendChild(row);
    if (!n.spent && !pending) {
      const opt = document.createElement('option');
      opt.value = n.commitment;
      opt.textContent = `${n.value} (cm ${n.commitment.slice(0, 8)}…)`;
      sel.appendChild(opt);
    }
  }
}

async function renderAdminNotes() {
  const host = $('adminNotes');
  host.innerHTML = '';
  const sel = $('redeemNote');
  sel.innerHTML = '';
  // List all community scopes — could be multiple communities.
  const allKeys = await store.list('community-*'); // current store doesn't support globs;
  // For PoC, iterate known IDs we've seen via the URL handler.
  const seen = new Set();
  for (const k of Object.keys(localStorage)) {
    /* skip */ void k;
  }
  // Fall back: scan IDs from past URL imports stored under prefix.
  // For simplicity, look at all known scopes from the IDB by trying common keys.
  // The store API doesn't expose a list-scopes, so for the PoC require the user
  // to land via the community-import link (which has the communityId) and then
  // we read from that scope.
  const cid = sessionStorage.getItem('lastCommunityId');
  if (!cid) {
    host.innerHTML = '<p class="mut">No community received yet. Open a <code>?community-import=…</code> link.</p>';
    return;
  }
  const notes = await store.list(`community-${cid}`);
  await rebuildMirror().catch(() => {});
  const cpCount = pool ? Number(await pool.checkpointedCount().catch(() => 0n)) : 0;
  for (const n of notes) {
    const row = document.createElement('div');
    row.className = 'note-row';
    const leafIdx = cmToLeafIndex.get(n.commitment);
    const pending =
      !n.spent && (leafIdx === undefined || leafIdx >= cpCount);
    const status = n.spent
      ? '✓ spent'
      : pending
        ? `${n.value} (#${cid}) ⏳ pending`
        : `${n.value} (#${cid})`;
    row.innerHTML = `<span>cm ${n.commitment.slice(0, 10)}…</span><span>${status}</span>`;
    host.appendChild(row);
    if (!n.spent && !pending) {
      const opt = document.createElement('option');
      opt.value = `${cid}:${n.commitment}`;
      opt.textContent = `${n.value}`;
      sel.appendChild(opt);
    }
  }
  void seen;
  void allKeys;
}

// Track last community id when a community-import URL is opened.
async function captureCommunity() {
  const parsed = parseDeepLink(location.href);
  if (parsed?.kind === 'community-import') {
    sessionStorage.setItem('lastCommunityId', parsed.communityId);
  }
}

// ---- prove + relay-handoff flows ----

const worker = new Worker(new URL('./prove.worker.js', import.meta.url), { type: 'module' });
const pending = new Map();
let nextId = 1;

function callWorker(kind, input) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, kind, input });
  });
}

worker.onmessage = (ev) => {
  const { id, ok, ...rest } = ev.data;
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (ok) p.resolve(rest);
  else p.reject(new Error(rest.err));
};

async function doAssign() {
  const cm = $('assignNote').value;
  const all = await store.list('user');
  const note = all.find((n) => n.commitment === cm);
  if (!note) return;
  const communityId = BigInt($('communityId').value);
  const destOwnerPkHash = BigInt($('destOwnerPk').value);
  const destValue = BigInt($('destValue').value);
  const status = $('assignStatus');

  try {
    await rebuildMirror();
    const leafIndex = leafIndexOf(note);
    if (!(await isCheckpointed(leafIndex))) {
      throw new Error(
        `note not yet checkpointed (leafIndex=${leafIndex}, ` +
          `checkpointedCount=${await pool.checkpointedCount()}); ` +
          `wait for the next checkpoint and retry`,
      );
    }
    const { pathElements, pathIndices, root } = await mirror.proof(leafIndex);
    const sk = BigInt(note.sk);
    const value = BigInt(note.value);
    const expiryEpoch = BigInt(note.expiryEpoch);
    const randomness = BigInt(note.randomness);
    const nullifier = await deriveNullifier(sk, BigInt(note.commitment));
    const destRandomness = randomFieldElement();
    const changeRandomness = randomFieldElement();
    const redeemerHash = await redeemerHashFromId(communityId);
    const cmDest = await deriveCommitment({
      value: destValue, expiryEpoch, ownerPkHash: destOwnerPkHash,
      randomness: destRandomness, assigned: 1n, redeemerHash,
    });
    const cmChange = await deriveCommitment({
      value: value - destValue, expiryEpoch, ownerPkHash: BigInt(note.ownerPkHash),
      randomness: changeRandomness, assigned: 0n, redeemerHash: 0n,
    });

    status.textContent = 'Proving in worker (~1 s)…';
    const r = await callWorker('assign', {
      sk, value, expiryEpoch, randomness,
      pathElements, pathIndices,
      destValue, destOwnerPkHash, destRandomness,
      redeemerId: communityId, changeRandomness,
      root, nullifier, expiryEpochPub: expiryEpoch,
      cmDest, cmChange,
    });

    const link = buildAssignLink(cfg.relayBaseUrl, {
      nullifier, expiryEpoch: Number(expiryEpoch),
      cmDest, cmChange, root,
      proof: r.proofFlat.map((x) => BigInt(x)),
    });
    $('assignLink').href = link;
    await QRCode.toCanvas($('assignQR'), link, { width: 280, margin: 1 });
    $('assignResult').hidden = false;
    status.innerHTML = '<span class="ok">Proof ready — hand to relay.</span>';

    // Also emit the community-import link so the operator can pull the dest note.
    const cimport = buildCommunityImportLink(cfg.chatBaseUrl, {
      value: destValue, expiryEpoch, ownerPkHash: destOwnerPkHash,
      randomness: destRandomness, assigned: 1, redeemerHash,
    }, communityId);
    $('communityImportLink').href = cimport;
  } catch (e) {
    status.innerHTML = `<span class="err">${e.message}</span>`;
  }
}

async function doRedeem() {
  const sel = $('redeemNote').value;
  if (!sel) return;
  const [cid, cm] = sel.split(':');
  const scope = `community-${cid}`;
  const all = await store.list(scope);
  const note = all.find((n) => n.commitment === cm);
  if (!note) return;
  const operatorAddr = $('operatorAddr').value.trim();
  const operatorId = BigInt(operatorAddr);
  const redeemValue = BigInt($('redeemValue').value);
  const status = $('redeemStatus');

  try {
    await rebuildMirror();
    const leafIndex = leafIndexOf(note);
    if (!(await isCheckpointed(leafIndex))) {
      throw new Error(
        `note not yet checkpointed (leafIndex=${leafIndex}, ` +
          `checkpointedCount=${await pool.checkpointedCount()}); ` +
          `wait for the next checkpoint and retry`,
      );
    }
    const { pathElements, pathIndices, root } = await mirror.proof(leafIndex);
    const sk = BigInt(note.sk);
    const value = BigInt(note.value);
    const expiryEpoch = BigInt(note.expiryEpoch);
    const randomness = BigInt(note.randomness);
    const redeemerHash = BigInt(note.redeemerHash);
    const changeValue = value - redeemValue;
    const changeRandomness = randomFieldElement();
    const nullifier = await deriveNullifier(sk, BigInt(note.commitment));
    const cmChange = await deriveCommitment({
      value: changeValue, expiryEpoch, ownerPkHash: BigInt(note.ownerPkHash),
      randomness: changeRandomness, assigned: 1n, redeemerHash,
    });

    status.textContent = 'Proving redeem in worker…';
    const r = await callWorker('redeem', {
      sk, value, expiryEpoch, randomness,
      redeemerHash, redeemerId: BigInt(cid),
      pathElements, pathIndices,
      changeRandomness, changeValue,
      root, nullifier, expiryEpochPub: expiryEpoch,
      redeemValue, cmChange, operatorId,
    });

    const link = buildRedeemLink(cfg.relayBaseUrl, {
      nullifier, expiryEpoch: Number(expiryEpoch),
      redeemValue, cmChange, root, operatorId,
      proof: r.proofFlat.map((x) => BigInt(x)),
    });
    $('redeemLink').href = link;
    await QRCode.toCanvas($('redeemQR'), link, { width: 280, margin: 1 });
    $('redeemResult').hidden = false;
    status.innerHTML = '<span class="ok">Redeem proof ready — hand to relay.</span>';
  } catch (e) {
    status.innerHTML = `<span class="err">${e.message}</span>`;
  }
}

$('proveAssignBtn').onclick = doAssign;
$('proveRedeemBtn').onclick = doRedeem;

// ---- QR scanner ----

let qrScanner = null;
$('scanBtn').onclick = async () => {
  const vid = $('scanVideo');
  vid.hidden = false;
  qrScanner = new QrScanner(vid, (result) => {
    qrScanner.stop();
    vid.hidden = true;
    location.href = result.data;
  });
  await qrScanner.start();
};

// ---- bootstrap ----

await captureCommunity();
await handleIncomingDeepLink();
await rebuildMirror().catch((e) => console.warn('event replay skipped:', e.message));
// Respect whatever mode handleIncomingDeepLink picked (community-import
// URLs flip to 'admin'); default is 'user' for a fresh visit.
setMode(mode);

// Auto-generate a user owner key on first load.
if (!(await store.getKey('user'))) {
  const k = await generateKeypair();
  await store.putKey('user', k.sk);
  console.log('generated user pkHash =', k.ownerPkHash.toString());
}
