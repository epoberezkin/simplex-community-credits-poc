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
  deriveOwnerPkHash,
  randomFieldElement,
  IncrementalMerkleTree,
  redeemerHashFromId,
  parseDeepLink,
  buildAssignLink,
  buildRedeemLink,
  buildCommunityImportLink,
  demoCommunitySk,
  demoCommunityPkHash,
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

// Session state lives in the URL so it survives reload and bookmarking.
// Steady-state URLs:   /  (user)   |   /?mode=admin&cid=N  (admin)
// One-shot URLs:       /?import=…  |   /?community-import=…&community-id=N
// The handlers process the one-shots, then replaceState back to a steady URL.
function syncUrl() {
  const u = new URL(location.href);
  u.search = '';
  if (mode === 'admin') {
    u.searchParams.set('mode', 'admin');
    if (cid) u.searchParams.set('cid', String(cid));
  }
  history.replaceState({}, '', u.toString());
}
let mode = new URL(location.href).searchParams.get('mode') === 'admin' ? 'admin' : 'user';
let cid = new URL(location.href).searchParams.get('cid');

function setMode(next) {
  mode = next;
  syncUrl();
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
    // One-shot URL processed; rewind to a steady-state URL so refresh
    // doesn't re-trigger it.
    syncUrl();
    await renderUserNotes();
  } else if (parsed.kind === 'community-import') {
    const note = parsed.note;
    const scope = `community-${parsed.communityId}`;
    let sk = await store.getKey(scope);
    if (!sk) {
      // Demo: derive sk deterministically from the cid so the assigner's
      // dest pkHash matches what we'll prove. (Real flow: the community
      // would publish its pkHash and we'd persist the sk on first onboard.)
      sk = demoCommunitySk(parsed.communityId);
      await store.putKey(scope, sk);
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
    // Move us into admin view for this community and rewrite the URL
    // accordingly so reload preserves the admin scope.
    mode = 'admin';
    cid = parsed.communityId;
    syncUrl();
  }
}

// Render tokens. Each render bumps the counter; if the value changes
// during awaits, an older run aborts so two concurrent calls can't both
// clear the host and then both append (= duplicate rows).
let _userRenderToken = 0;
let _adminRenderToken = 0;
// Last-rendered note signature per scope; we only redraw the DOM if it
// changed. Otherwise a 4s polling loop would visibly blink the list.
const _lastRenderSig = new Map();
function noteSig(notes, cid, cpCount) {
  return JSON.stringify([
    cid,
    cpCount,
    notes.map((n) => [n.commitment, n.value?.toString(), n.spent, cmToLeafIndex.get(n.commitment) ?? null]),
  ]);
}

async function renderUserNotes() {
  const tok = ++_userRenderToken;
  const notes = await store.list('user');
  if (tok !== _userRenderToken) return;
  // Pull checkpoint state once so the list reflects spendability.
  await rebuildMirror().catch(() => {});
  if (tok !== _userRenderToken) return;
  const cpCount = pool ? Number(await pool.checkpointedCount().catch(() => 0n)) : 0;
  if (tok !== _userRenderToken) return;
  // Skip the DOM rewrite if nothing changed — otherwise the polling loop
  // visibly re-paints the list every cycle.
  const sig = noteSig(notes, 'user', cpCount);
  if (_lastRenderSig.get('user') === sig) return;
  _lastRenderSig.set('user', sig);
  const host = $('notesList');
  host.innerHTML = '';
  const sel = $('assignNote');
  sel.innerHTML = '';
  if (notes.length === 0) {
    host.innerHTML = '<p class="mut">No vouchers yet. Open an <code>?import=…</code> link from the purchaser dapp.</p>';
    return;
  }
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
  const tok = ++_adminRenderToken;
  // `cid` is module state — set by handleIncomingDeepLink and reflected
  // in the URL (?cid=N) so reload preserves the admin scope.
  if (!cid) {
    const empty = 'no-community';
    if (_lastRenderSig.get('admin') === empty) return;
    _lastRenderSig.set('admin', empty);
    $('adminNotes').innerHTML = '<p class="mut">No community received yet. Open a <code>?community-import=…</code> link.</p>';
    $('adminPkRow').hidden = true;
    $('redeemNote').innerHTML = '';
    return;
  }
  // Demo communities use a deterministic sk derived from the cid so the
  // assigner and the admin agree on the pkHash without coordination.
  // (Real communities would publish their pkHash via onboarding.)
  let scopeSk = await store.getKey(`community-${cid}`);
  if (!scopeSk) {
    scopeSk = demoCommunitySk(cid);
    await store.putKey(`community-${cid}`, scopeSk);
  }
  const pkHash = await deriveOwnerPkHash(scopeSk);
  $('adminPk').textContent = pkHash.toString();
  $('adminPkRow').hidden = false;
  const notes = await store.list(`community-${cid}`);
  if (tok !== _adminRenderToken) return;
  await rebuildMirror().catch(() => {});
  if (tok !== _adminRenderToken) return;
  const cpCount = pool ? Number(await pool.checkpointedCount().catch(() => 0n)) : 0;
  if (tok !== _adminRenderToken) return;
  const sig = noteSig(notes, cid, cpCount);
  if (_lastRenderSig.get('admin') === sig) return;
  _lastRenderSig.set('admin', sig);
  const host = $('adminNotes');
  host.innerHTML = '';
  const sel = $('redeemNote');
  sel.innerHTML = '';
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
  const communityIdStr = $('assignCommunity').value;
  if (!communityIdStr) return;
  const communityId = BigInt(communityIdStr);
  // Demo: derive the dest pkHash from the community id so admin + user
  // agree without copy-paste. (Real flow: paste the admin's published pkHash.)
  const destOwnerPkHash = await demoCommunityPkHash(communityIdStr);
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
  const operatorAddr = $('redeemOperator').value.trim();
  if (!operatorAddr) return;
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

// Wipe note IDB if the deployed VoucherPool address changed since last
// visit — old notes are orphans (no on-chain events for them) and would
// be permanently "pending" otherwise, and circuits would fail at the
// merkle membership check.
async function wipeIfPoolChanged() {
  if (!cfg.poolAddress) return;
  const prev = await store.getKey('_pool');
  const cur = BigInt(cfg.poolAddress);
  if (prev === null) {
    // True first visit (fresh browser context, IDB empty). Just record
    // the pool; don't wipe — would race against test/probe setup that
    // seeds keys right after the page load.
    await store.putKey('_pool', cur);
    return;
  }
  if (prev === cur) return;
  // Subsequent visit with a different deployed pool — wipe stale notes
  // (they're orphans against the new VoucherPool, would be permanently
  // "pending" and circuit-rejected at the merkle membership check).
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('keyval-store');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();   // best-effort
  });
  await store.putKey('_pool', cur);
  console.log(`[chat] wiped IDB (pool changed to ${cfg.poolAddress.slice(0, 10)}…)`);
}
await wipeIfPoolChanged();

// Populate the demo-community + operator dropdowns from cfg. Hardcoded
// single demo community for now; relays come from the deploy manifest.
const DEMO_COMMUNITIES = [{ id: '1', label: 'demo community (cid=1)' }];
for (const c of DEMO_COMMUNITIES) {
  const o = document.createElement('option');
  o.value = c.id;
  o.textContent = c.label;
  $('assignCommunity').appendChild(o);
}
for (const op of (cfg.demoOperators ?? [])) {
  const o = document.createElement('option');
  o.value = op.address;
  o.textContent = `${op.name} (${op.address.slice(0, 10)}…)`;
  $('redeemOperator').appendChild(o);
}

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

// Polling loop: catch on-chain changes (new checkpoints flipping a note
// from "pending" to spendable, new VoucherCreated/Assigned events, etc.)
// without forcing the user to reload.
setInterval(() => {
  if (mode === 'user') renderUserNotes().catch(() => {});
  else renderAdminNotes().catch(() => {});
}, 4_000);
