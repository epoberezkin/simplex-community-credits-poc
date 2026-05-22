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
// TestUSDC has 6 decimals — UI is fully human-readable. Strip trailing
// ".0" so whole-number amounts display as e.g. "100" rather than "100.0".
function fmtUsdc(raw) {
  const s = ethers.formatUnits(BigInt(raw), 6);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}
const parseUsdc = (s) => ethers.parseUnits(String(s), 6);
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
import { buildInspectorPanel } from '@community-credits/core/educational';

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
  let totalAssignable = 0n;
  let totalPending = 0n;
  for (const n of notes) {
    const row = document.createElement('div');
    row.className = 'note-row';
    const leafIdx = cmToLeafIndex.get(n.commitment);
    const pending =
      !n.spent && (leafIdx === undefined || leafIdx >= cpCount);
    const value = BigInt(n.value);
    let status, faceColor;
    if (n.spent) {
      status = '✓ spent';
      faceColor = '#999';
    } else if (pending) {
      status = '⏳ pending checkpoint';
      faceColor = '#c80';
      totalPending += value;
    } else {
      status = '✓ spendable';
      faceColor = '#393';
      totalAssignable += value;
    }
    row.innerHTML =
      `<span>cm ${n.commitment.slice(0, 10)}… ` +
      `<strong style="color:${faceColor}">${fmtUsdc(value)} tUSDC</strong></span>` +
      `<span class="mut">${status}</span>`;
    host.appendChild(row);
    if (!n.spent && !pending) {
      const opt = document.createElement('option');
      opt.value = n.commitment;
      opt.textContent = `${fmtUsdc(value)} tUSDC (cm ${n.commitment.slice(0, 8)}…)`;
      sel.appendChild(opt);
    }
  }
  const totalRow = document.createElement('p');
  totalRow.className = 'mut';
  totalRow.style.marginTop = '0.5rem';
  totalRow.innerHTML =
    `<strong>Assignable: ${fmtUsdc(totalAssignable)} tUSDC</strong>` +
    (totalPending > 0n ? ` &nbsp;·&nbsp; pending: ${fmtUsdc(totalPending)} tUSDC` : '');
  host.appendChild(totalRow);
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
  let totalRedeemable = 0n;
  let totalPending = 0n;
  for (const n of notes) {
    const row = document.createElement('div');
    row.className = 'note-row';
    const leafIdx = cmToLeafIndex.get(n.commitment);
    const pending =
      !n.spent && (leafIdx === undefined || leafIdx >= cpCount);
    const value = BigInt(n.value);
    let status, color;
    if (n.spent) {
      status = '✓ spent';
      color = '#999';
    } else if (pending) {
      status = '⏳ pending checkpoint';
      color = '#c80';
      totalPending += value;
    } else {
      status = '✓ redeemable';
      color = '#393';
      totalRedeemable += value;
    }
    row.innerHTML =
      `<span>cm ${n.commitment.slice(0, 10)}… ` +
      `<strong style="color:${color}">${fmtUsdc(value)} tUSDC</strong></span>` +
      `<span class="mut">${status}</span>`;
    host.appendChild(row);
    if (!n.spent && !pending) {
      const opt = document.createElement('option');
      opt.value = `${cid}:${n.commitment}`;
      opt.textContent = `${fmtUsdc(value)} tUSDC (cm ${n.commitment.slice(0, 8)}…)`;
      sel.appendChild(opt);
    }
  }
  const totalRow = document.createElement('p');
  totalRow.className = 'mut';
  totalRow.style.marginTop = '0.5rem';
  totalRow.innerHTML =
    `<strong>Redeemable: ${fmtUsdc(totalRedeemable)} tUSDC</strong>` +
    (totalPending > 0n ? ` &nbsp;·&nbsp; pending: ${fmtUsdc(totalPending)} tUSDC` : '');
  host.appendChild(totalRow);
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
  const destValue = parseUsdc($('destValue').value);
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
    const assignInputs = {
      sk, value, expiryEpoch, randomness,
      pathElements, pathIndices,
      destValue, destOwnerPkHash, destRandomness,
      redeemerId: communityId, changeRandomness,
      root, nullifier, expiryEpochPub: expiryEpoch,
      cmDest, cmChange,
    };
    const r = await callWorker('assign', assignInputs);

    const assignBundle = {
      nullifier, expiryEpoch: Number(expiryEpoch),
      cmDest, cmChange, root,
      proof: r.proofFlat.map((x) => BigInt(x)),
    };
    const link = buildAssignLink(cfg.relayBaseUrl, assignBundle);
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

    // Educational inspector — private inputs + decoded handover.
    const result = $('assignResult');
    result.querySelectorAll('details.cc-inspector').forEach((n) => n.remove());
    const panel = buildInspectorPanel({
      circuit: 'assign',
      proveInputs: assignInputs,
      handoverKind: 'assign',
      handoverPayload: assignBundle,
      handoverUrl: link,
    });
    panel.classList.add('cc-inspector');
    result.appendChild(panel);

    // Optimistic local update: mark the source note spent and stash the
    // change note in the user scope. The relay will submit the tx; we
    // assume success rather than wait for a confirmation handshake.
    await store.markSpent('user', note.commitment);
    const changeValue = value - destValue;
    if (changeValue > 0n) {
      await store.add('user', {
        commitment: cmChange.toString(),
        sk: sk.toString(),
        ownerPkHash: note.ownerPkHash,
        randomness: changeRandomness.toString(),
        redeemerHash: '0',
        value: changeValue.toString(),
        expiryEpoch: note.expiryEpoch,
        assigned: 0,
        spent: false,
      });
    }
    await renderUserNotes();
  } catch (e) {
    const human = humanizeProofError(e.message);
    // Surface to the browser console too, so demo-watchers see rejections
    // (they don't reach the chain → won't appear in the events feed).
    console.warn('[chat] proof rejected:', human, '— raw:', e.message);
    status.innerHTML = `<span class="err">${human}</span>`;
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
  const redeemValue = parseUsdc($('redeemValue').value);
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
    const redeemInputs = {
      sk, value, expiryEpoch, randomness,
      redeemerHash, redeemerId: BigInt(cid),
      pathElements, pathIndices,
      changeRandomness, changeValue,
      root, nullifier, expiryEpochPub: expiryEpoch,
      redeemValue, cmChange, operatorId,
    };
    const r = await callWorker('redeem', redeemInputs);

    const redeemBundle = {
      nullifier, expiryEpoch: Number(expiryEpoch),
      redeemValue, cmChange, root, operatorId,
      proof: r.proofFlat.map((x) => BigInt(x)),
    };
    const link = buildRedeemLink(cfg.relayBaseUrl, redeemBundle);
    $('redeemLink').href = link;
    await QRCode.toCanvas($('redeemQR'), link, { width: 280, margin: 1 });
    $('redeemResult').hidden = false;
    status.innerHTML = '<span class="ok">Redeem proof ready — hand to relay.</span>';

    // Educational inspector — private inputs + decoded handover.
    const result = $('redeemResult');
    result.querySelectorAll('details.cc-inspector').forEach((n) => n.remove());
    const panel = buildInspectorPanel({
      circuit: 'redeem',
      proveInputs: redeemInputs,
      handoverKind: 'redeem',
      handoverPayload: redeemBundle,
      handoverUrl: link,
    });
    panel.classList.add('cc-inspector');
    result.appendChild(panel);

    // Optimistic local update: source note spent. Change note (if any —
    // partial redeem) lands in the same community scope.
    await store.markSpent(scope, note.commitment);
    if (changeValue > 0n) {
      await store.add(scope, {
        commitment: cmChange.toString(),
        sk: note.sk,
        ownerPkHash: note.ownerPkHash,
        randomness: changeRandomness.toString(),
        redeemerHash: note.redeemerHash,
        value: changeValue.toString(),
        expiryEpoch: note.expiryEpoch,
        assigned: 1,
        spent: false,
      });
    }
    await renderAdminNotes();
  } catch (e) {
    const human = humanizeProofError(e.message);
    // Surface to the browser console too, so demo-watchers see rejections
    // (they don't reach the chain → won't appear in the events feed).
    console.warn('[chat] proof rejected:', human, '— raw:', e.message);
    status.innerHTML = `<span class="err">${human}</span>`;
  }
}

// Circuit assertion failures come back as "Error: Assert Failed. Error
// in template Assign_NNN line: XX". Map common ones to human text.
function humanizeProofError(msg) {
  if (!msg) return 'unknown proof error';
  if (/template (Assign|Redeem)_\d+ line: \d+/.test(msg)) {
    return (
      'Circuit rejected the proof. Most common cause: you tried to ' +
      'spend more than the note holds, or the value is outside the ' +
      '64-bit range. The original assertion was: ' + msg
    );
  }
  return msg;
}

$('proveAssignBtn').onclick = doAssign;
$('proveRedeemBtn').onclick = doRedeem;

// Live over-spend / over-redeem warnings on the value inputs. The user
// is still allowed to click — they get to see the circuit reject the
// proof — but the warning makes the eventual error self-explanatory.
function selectedValue(selectId, scope) {
  return async () => {
    const v = $(selectId).value;
    if (!v) return 0n;
    const all = await store.list(scope);
    const cm = scope === 'user' ? v : v.split(':')[1];
    const n = all.find((x) => x.commitment === cm);
    return n ? BigInt(n.value) : 0n;
  };
}
const getAssignNoteValue = selectedValue('assignNote', 'user');
async function getRedeemNoteValue() {
  const v = $('redeemNote').value;
  if (!v) return 0n;
  const [c, cm] = v.split(':');
  const all = await store.list(`community-${c}`);
  const n = all.find((x) => x.commitment === cm);
  return n ? BigInt(n.value) : 0n;
}
function attachOverspendWarning(valueId, noteSelectId, statusId, getNoteValueFn, label) {
  const fn = async () => {
    const want = parseUsdc($(valueId).value || '0');
    const have = await getNoteValueFn();
    const s = $(statusId);
    if (have > 0n && want > have) {
      s.innerHTML = `<span class="err">⚠ ${label} (${fmtUsdc(want)} tUSDC) exceeds the note's value (${fmtUsdc(have)} tUSDC). The circuit will reject this — try anyway if you want to see the failure.</span>`;
    } else if (s.querySelector?.('.err')?.textContent?.includes('exceeds')) {
      s.innerHTML = '';
    }
  };
  $(valueId).addEventListener('input', fn);
  $(noteSelectId).addEventListener('change', fn);
}
attachOverspendWarning('destValue',   'assignNote', 'assignStatus', getAssignNoteValue, 'Dest value');
attachOverspendWarning('redeemValue', 'redeemNote', 'redeemStatus', getRedeemNoteValue, 'Redeem value');

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
  if (!cfg.deployId) return;
  // Identify a deploy by the deploy-time tag in cfg (set by
  // tools/deploy.mjs) rather than by poolAddress alone — with hardhat's
  // state-reset-per-spawn, the deployer's deterministic key sequence
  // produces identical CREATE addresses each run, so the address can't
  // distinguish "same deploy reload" from "new deploy at same address".
  const prev = await store.getKey('_deployId');
  const cur = BigInt(cfg.deployId);
  if (prev === null) {
    await store.putKey('_deployId', cur);
    return;
  }
  if (prev === cur) return;
  // Subsequent visit with a different deployed pool — wipe stale notes
  // (they're orphans against the new VoucherPool, would be permanently
  // "pending" and circuit-rejected at the merkle membership check).
  // Iterate keys + delete one by one rather than deleteDatabase, since
  // the latter is `onblocked` by our own already-open IDB connection.
  const all = await new Promise((resolve, reject) => {
    const req = indexedDB.open('keyval-store', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('keyval');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('keyval', 'readwrite');
      const s = tx.objectStore('keyval');
      const keys = s.getAllKeys();
      keys.onsuccess = () => { db.close(); resolve(keys.result); };
      keys.onerror = () => { db.close(); reject(keys.error); };
    };
    req.onerror = () => reject(req.error);
  });
  for (const k of all) {
    if (typeof k === 'string' && k !== 'cc:sk:_deployId') {
      await new Promise((resolve, reject) => {
        const req = indexedDB.open('keyval-store', 1);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('keyval', 'readwrite');
          tx.objectStore('keyval').delete(k);
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => { db.close(); reject(tx.error); };
        };
        req.onerror = () => reject(req.error);
      });
    }
  }
  await store.putKey('_deployId', cur);
  console.log(`[chat] wiped IDB (new deploy ${cfg.deployId})`);
}
await wipeIfPoolChanged();

// Populate the assign-community + redeem-operator dropdowns from the
// deploy manifest. Both lists carry {label, cid|address, …} so the user
// can pick any demo community / relay without copy-paste.
const demoCommunities = cfg.demoCommunities ?? [{ cid: '1', label: 'Community A (cid=1)' }];
for (const c of demoCommunities) {
  const o = document.createElement('option');
  o.value = c.cid;
  o.textContent = `${c.label} (cid=${c.cid})`;
  $('assignCommunity').appendChild(o);
}
for (const op of (cfg.demoOperators ?? [])) {
  const o = document.createElement('option');
  o.value = op.address;
  o.textContent = `${op.label || op.name} (${op.address.slice(0, 10)}…)`;
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
