// Dapp C — Relay Operator. EVM signer via EIP-6963.
//   1) wallet connect + chain switch
//   2) queue of inbound assign/redeem bundles (paste / QR / deep-link)
//   3) submit each via pool.assign / pool.redeem
//   4) credit balance + withdraw

// circomlibjs → blake-hash relies on Node's `Buffer` global; polyfill it
// before any module-init code in core/poseidon runs.
import { Buffer } from 'buffer';
globalThis.Buffer ||= Buffer;

import { ethers } from 'ethers';
import QrScanner from 'qr-scanner';
import {
  parseDeepLink,
  discoverProviders,
  connectEvm,
} from '@community-credits/core';

const cfg = await fetch('./config.json').then((r) => r.json());

const POOL_ABI = [
  'function assign(uint256 nullifier, uint32 expiryEpoch, uint256 cmDest, uint256 cmChange, uint256 root, uint256[2] pA, uint256[2][2] pB, uint256[2] pC)',
  'function redeem(uint256 nullifier, uint32 expiryEpoch, uint256 redeemValue, uint256 cmChange, uint256 root, uint256 operatorId, uint256[2] pA, uint256[2][2] pB, uint256[2] pC)',
  'function withdraw(uint256 amount)',
  'function credit(address) view returns (uint256)',
  'function isKnownRoot(uint256) view returns (bool)',
];

const $ = (id) => document.getElementById(id);

let signer;
let userAddr;
let pool;
const queue = [];

async function renderWallets() {
  const list = await discoverProviders();
  const host = $('wallets');
  host.innerHTML = '';
  for (const w of list) {
    const b = document.createElement('button');
    b.textContent = `Connect ${w.info.name}`;
    b.onclick = () => connect(w.provider, w.info.name);
    host.appendChild(b);
  }
  if (list.length === 0) {
    host.innerHTML = '<p class="err">No wallet detected.</p>';
  }
}

async function connect(eip1193, name) {
  userAddr = await connectEvm(eip1193, { chainIdHex: cfg.chainIdHex });
  const browser = new ethers.BrowserProvider(eip1193);
  signer = await browser.getSigner();
  pool = new ethers.Contract(cfg.poolAddress, POOL_ABI, signer);
  $('walletStatus').textContent = `${name} • ${userAddr}`;
  $('walletStatus').className = 'ok';
  $('queue').hidden = false;
  $('credit').hidden = false;
  await refreshCredit();
  await checkInboundUrl();
}

async function refreshCredit() {
  if (!pool) return;
  try {
    const c = await pool.credit(userAddr);
    $('creditBal').textContent = c.toString();
  } catch (e) {
    $('creditBal').textContent = `(error: ${e.shortMessage || e.message})`;
  }
}

function unpackProof(flat) {
  return {
    pA: [flat[0], flat[1]],
    pB: [[flat[2], flat[3]], [flat[4], flat[5]]],
    pC: [flat[6], flat[7]],
  };
}

function addToQueue(url) {
  const parsed = parseDeepLink(url);
  if (!parsed) {
    alert('Not a recognised deep link');
    return;
  }
  if (parsed.kind !== 'assign' && parsed.kind !== 'redeem') {
    alert(`This dapp only handles assign/redeem (got ${parsed.kind})`);
    return;
  }
  queue.push(parsed);
  renderQueue();
}

function renderQueue() {
  const host = $('queueList');
  host.innerHTML = '';
  if (queue.length === 0) {
    host.innerHTML = '<p class="mut">Queue empty.</p>';
    return;
  }
  queue.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'row';
    const b = item.bundle;
    let label;
    let canSubmit = true;
    let reason = '';
    if (item.kind === 'assign') {
      label = `assign nf=${b.nullifier.toString().slice(0, 10)}… epoch ${b.expiryEpoch}`;
    } else {
      const op = '0x' + b.operatorId.toString(16).padStart(40, '0');
      label = `redeem v=${b.redeemValue} op=${op.slice(0, 10)}…`;
      if (op.toLowerCase() !== userAddr.toLowerCase()) {
        canSubmit = false;
        reason = ` — operatorId ≠ connected wallet`;
      }
    }
    const left = document.createElement('span');
    left.textContent = label + reason;
    if (!canSubmit) left.className = 'err';
    const submit = document.createElement('button');
    submit.textContent = 'Submit';
    submit.disabled = !canSubmit;
    submit.onclick = () => submitBundle(i);
    row.appendChild(left);
    row.appendChild(submit);
    host.appendChild(row);
  });
}

async function submitBundle(idx) {
  const item = queue[idx];
  const b = item.bundle;
  const { pA, pB, pC } = unpackProof(b.proof);
  try {
    let tx;
    if (item.kind === 'assign') {
      tx = await pool.assign(b.nullifier, b.expiryEpoch, b.cmDest, b.cmChange, b.root, pA, pB, pC);
    } else {
      tx = await pool.redeem(b.nullifier, b.expiryEpoch, b.redeemValue, b.cmChange, b.root, b.operatorId, pA, pB, pC);
    }
    await tx.wait();
    queue.splice(idx, 1);
    renderQueue();
    await refreshCredit();
  } catch (e) {
    alert(`Submit failed: ${e.shortMessage || e.message}`);
  }
}

$('pasteBtn').onclick = () => {
  const v = $('pasteUrl').value.trim();
  if (v) addToQueue(v);
  $('pasteUrl').value = '';
};

let qrScanner;
$('scanBtn').onclick = async () => {
  const vid = $('scanVideo');
  vid.hidden = false;
  qrScanner = new QrScanner(vid, (result) => {
    qrScanner.stop();
    vid.hidden = true;
    addToQueue(result.data);
  });
  await qrScanner.start();
};

$('withdrawBtn').onclick = async () => {
  const status = $('withdrawStatus');
  try {
    const c = await pool.credit(userAddr);
    if (c === 0n) {
      status.textContent = 'Nothing to withdraw.';
      return;
    }
    status.textContent = 'Submitting withdraw…';
    await (await pool.withdraw(c)).wait();
    status.innerHTML = `<span class="ok">Withdrew ${c} tUSDC.</span>`;
    await refreshCredit();
  } catch (e) {
    status.innerHTML = `<span class="err">${e.shortMessage || e.message}</span>`;
  }
};

async function checkInboundUrl() {
  const parsed = parseDeepLink(location.href);
  if (parsed) {
    addToQueue(location.href);
    history.replaceState({}, '', location.pathname);
  }
}

renderWallets();
