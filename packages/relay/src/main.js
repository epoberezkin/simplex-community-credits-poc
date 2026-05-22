// Dapp C — Relay Operator. EVM signer via EIP-6963.
//   1) wallet connect + chain switch
//   2) queue of inbound assign/redeem bundles (paste / QR / deep-link)
//   3) submit each via pool.assign / pool.redeem
//   4) credit balance + withdraw

// MUST be first — see ./buffer-polyfill.js. Inline polyfill won't work
// because ES module imports are hoisted.
import './buffer-polyfill.js';

import { ethers } from 'ethers';
import QrScanner from 'qr-scanner';
import {
  parseDeepLink,
  discoverProviders,
  connectEvm,
} from '@community-credits/core';
import { buildInspectorPanel } from '@community-credits/core/educational';

const cfg = await fetch('./config.json').then((r) => r.json());

const POOL_ABI = [
  'function assign(uint256 nullifier, uint32 expiryEpoch, uint256 cmDest, uint256 cmChange, uint256 root, uint256[2] pA, uint256[2][2] pB, uint256[2] pC)',
  'function redeem(uint256 nullifier, uint32 expiryEpoch, uint256 redeemValue, uint256 cmChange, uint256 root, uint256 operatorId, uint256[2] pA, uint256[2][2] pB, uint256[2] pC)',
  'function withdraw(uint256 amount)',
  'function credit(address) view returns (uint256)',
  'function isKnownRoot(uint256) view returns (bool)',
];
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
];

const $ = (id) => document.getElementById(id);

let signer;
let userAddr;
let pool;
let provider;
let usdc;
const queue = [];

// Retry helper for NONCE_EXPIRED — the relay key is shared with the
// background checkpoint watcher, so two processes can pick the same
// pending nonce in the window between read and send.
async function sendWithNonceRetry(fn, attempts = 4) {
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); }
    catch (e) {
      const msg = e.shortMessage || e.message || '';
      if (i < attempts && (e.code === 'NONCE_EXPIRED' || /nonce/i.test(msg))) {
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      throw e;
    }
  }
}

// eth_getBalance returns 18-decimal wei on both hardhat and pallet-
// revive's eth-rpc bridge.
function fmtDot(wei) { return (Number(wei) / 1e18).toFixed(4); }
async function refreshAll() {
  if (!pool || !userAddr || !provider) return;
  try {
    const [dot, u, c] = await Promise.all([
      provider.getBalance(userAddr),
      usdc.balanceOf(userAddr),
      pool.credit(userAddr),
    ]);
    const human = (raw) => {
      const s = ethers.formatUnits(raw, 6);
      return s.endsWith('.0') ? s.slice(0, -2) : s;
    };
    $('balDot').textContent = fmtDot(dot);
    $('balUsdc').textContent = human(u);
    $('creditBal').textContent = human(c);
  } catch { /* RPC blip; try again next tick */ }
}
setInterval(refreshAll, 3_000);

// Demo / Playwright path: ?demoKey=<0x-prefixed-privkey> skips EIP-6963
// and uses a local ethers.Wallet against cfg.ethRpcUrl. URL is the only
// source of truth — reload preserves it (browser keeps the query). URL
// with the key IS the bookmark.

function getDemoKey() {
  const k = new URL(location.href).searchParams.get('demoKey');
  return k && /^0x[0-9a-fA-F]{64}$/.test(k) ? k : null;
}

async function bootDemoMode(key) {
  provider = new ethers.JsonRpcProvider(cfg.ethRpcUrl);
  // No NonceManager — the relay key is also used by the background
  // checkpoint watcher (tools/checkpoint.mjs --watch). An in-memory
  // NonceManager would drift behind every watcher submission and trip
  // NONCE_EXPIRED on the user's next click. Plain Wallet re-queries
  // `eth_getTransactionCount(addr, 'pending')` per send.
  signer = new ethers.Wallet(key, provider);
  userAddr = await signer.getAddress();
  pool = new ethers.Contract(cfg.poolAddress, POOL_ABI, signer);
  usdc = new ethers.Contract(cfg.stablecoinAddress, ERC20_ABI, provider);
  renderDemoSubjects(key);
  $('walletStatus').textContent = `demo • ${userAddr}`;
  $('walletStatus').className = 'ok';
  $('queue').hidden = false;
  $('credit').hidden = false;
  await refreshAll();
  await checkInboundUrl();
}

// Subject picker — kept visible after bootDemoMode so a human can switch
// Relay A ↔ B in-place. Active key is highlighted; click another to
// re-boot with that key (also re-imports the current ?assign=/?redeem=).
function renderDemoSubjects(activeKey) {
  const host = $('wallets');
  host.innerHTML =
    '<p class="err" style="background:#fee;padding:0.4rem;border-radius:4px">' +
    '⚠ Demo mode — using local key. Do NOT use on a real chain.</p>';
  for (const op of (cfg.demoOperators || [])) {
    if (!op.privateKey) continue;
    const btn = document.createElement('button');
    const active = activeKey && op.privateKey.toLowerCase() === activeKey.toLowerCase();
    btn.textContent = `${active ? '✓ ' : ''}Use ${op.label || op.name}`;
    btn.onclick = () => bootDemoMode(op.privateKey);
    btn.style.background = active ? '#cfc' : '#fee';
    btn.style.marginRight = '0.3rem';
    btn.disabled = active;
    host.appendChild(btn);
  }
}

async function renderWallets() {
  const list = await discoverProviders();
  const host = $('wallets');
  host.innerHTML = '';
  // Quick-pick buttons for each registered demo operator. cfg.demoOperators
  // carries `{label, address, privateKey}` per relay so a human can switch
  // identity in-place without changing the URL.
  const ops = cfg.demoOperators || [];
  for (const op of ops) {
    if (!op.privateKey) continue;            // real operators have no key in cfg
    const btn = document.createElement('button');
    btn.textContent = `Use ${op.label || op.name} (demo)`;
    btn.onclick = () => bootDemoMode(op.privateKey);
    btn.style.background = '#fee';
    btn.style.marginRight = '0.3rem';
    host.appendChild(btn);
  }
  for (const w of list) {
    const b = document.createElement('button');
    b.textContent = `Connect ${w.info.name}`;
    b.onclick = () => connect(w.provider, w.info.name);
    host.appendChild(b);
  }
  if (list.length === 0 && ops.length === 0) {
    const p = document.createElement('p');
    p.className = 'mut';
    p.style.marginTop = '0.4rem';
    p.textContent = 'No extension wallet detected. Use one of the demo keys above for a local demo.';
    host.appendChild(p);
  }
}

async function connect(eip1193, name) {
  userAddr = await connectEvm(eip1193, { chainIdHex: cfg.chainIdHex });
  const browser = new ethers.BrowserProvider(eip1193);
  signer = await browser.getSigner();
  pool = new ethers.Contract(cfg.poolAddress, POOL_ABI, signer);
  provider = browser;
  usdc = new ethers.Contract(cfg.stablecoinAddress, ERC20_ABI, provider);
  $('walletStatus').textContent = `${name} • ${userAddr}`;
  $('walletStatus').className = 'ok';
  $('queue').hidden = false;
  $('credit').hidden = false;
  await refreshAll();
  await checkInboundUrl();
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
  // Keep the original URL alongside the parsed bundle so the per-row
  // inspector can show the on-wire size of the handover.
  queue.push({ ...parsed, sourceUrl: url });
  renderQueue();
}

const inFlight = new Map();        // queue-idx → status text
function renderQueue() {
  const host = $('queueList');
  host.innerHTML = '';
  if (queue.length === 0) {
    host.innerHTML = '<p class="mut">Queue empty.</p>';
    return;
  }
  queue.forEach((item, i) => {
    // Outer wrapper so the per-row inspector sits *under* the label/Submit row.
    const wrap = document.createElement('div');
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
    const right = document.createElement('span');
    const busy = inFlight.get(i);
    if (busy) {
      right.className = 'mut';
      right.textContent = busy;
    } else {
      const submit = document.createElement('button');
      submit.textContent = 'Submit';
      submit.disabled = !canSubmit;
      submit.onclick = () => submitBundle(i);
      right.appendChild(submit);
    }
    row.appendChild(left);
    row.appendChild(right);
    wrap.appendChild(row);
    // No witness on the relay side — only the decoded handover is shown.
    wrap.appendChild(buildInspectorPanel({
      handoverKind: item.kind,
      handoverPayload: b,
      handoverUrl: item.sourceUrl,
    }));
    host.appendChild(wrap);
  });
}

async function submitBundle(idx) {
  if (inFlight.has(idx)) return;
  const item = queue[idx];
  const b = item.bundle;
  const { pA, pB, pC } = unpackProof(b.proof);
  inFlight.set(idx, '⏳ sending…');
  renderQueue();
  try {
    const tx = await sendWithNonceRetry(() =>
      item.kind === 'assign'
        ? pool.assign(b.nullifier, b.expiryEpoch, b.cmDest, b.cmChange, b.root, pA, pB, pC)
        : pool.redeem(b.nullifier, b.expiryEpoch, b.redeemValue, b.cmChange, b.root, b.operatorId, pA, pB, pC),
    );
    inFlight.set(idx, `⏳ mining ${tx.hash.slice(0, 10)}…`);
    renderQueue();
    await tx.wait();
    queue.splice(idx, 1);
    inFlight.delete(idx);
    // Compact remaining inFlight indices (since splice shifted them).
    const reindexed = new Map();
    for (const [k, v] of inFlight) reindexed.set(k > idx ? k - 1 : k, v);
    inFlight.clear();
    for (const [k, v] of reindexed) inFlight.set(k, v);
    renderQueue();
    await refreshAll();
  } catch (e) {
    inFlight.delete(idx);
    renderQueue();
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
    await (await sendWithNonceRetry(() => pool.withdraw(c))).wait();
    status.innerHTML = `<span class="ok">Withdrew ${c} tUSDC.</span>`;
    await refreshAll();
  } catch (e) {
    status.innerHTML = `<span class="err">${e.shortMessage || e.message}</span>`;
  }
};

async function checkInboundUrl() {
  const parsed = parseDeepLink(location.href);
  if (parsed) {
    addToQueue(location.href);
    // Strip the one-shot ?assign=/?redeem= but preserve ?demoKey= so
    // reload keeps the demo session.
    const u = new URL(location.href);
    for (const k of ['assign', 'redeem', 'import', 'community-import', 'community-id']) {
      u.searchParams.delete(k);
    }
    history.replaceState({}, '', u.toString());
  }
}

const _demoKey = getDemoKey();
if (_demoKey) await bootDemoMode(_demoKey);
else renderWallets();
