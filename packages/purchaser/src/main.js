// Dapp A — Purchaser. EVM signer via EIP-6963.
//   1) connect wallet (chain-switch to configured chain)
//   2) buy form → prove `create` → approve + buyAndCreate
//   3) emit ?import=<note> link + QR pointing at chat dapp

// MUST be first — see ./buffer-polyfill.js. (Inline `import { Buffer } from
// 'buffer'; globalThis.Buffer = Buffer` here does NOT work: ES module
// imports are hoisted, so circomlibjs would init before the polyfill ran.)
import './buffer-polyfill.js';

import { ethers } from 'ethers';
import QRCode from 'qrcode';
import {
  generateKeypair,
  deriveCommitment,
  randomFieldElement,
  buildImportLink,
  discoverProviders,
  connectEvm,
} from '@community-credits/core';
import { proveCreateBrowser } from '@community-credits/core/proof-browser';

const cfg = await fetch('./config.json').then((r) => r.json());

const POOL_ABI = [
  'function buyAndCreate(uint256 cm, uint256 value, uint32 expiryEpoch, uint256[2] pA, uint256[2][2] pB, uint256[2] pC)',
];
const ERC20_ABI = [
  'function approve(address spender, uint256 value) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
];

let signer; // ethers signer (BrowserProvider-bound, or local Wallet in demo mode)
let userAddr;
let provider;
let usdc;

const $ = (id) => document.getElementById(id);

// eth_getBalance returns 18-decimal wei on both hardhat and pallet-
// revive's eth-rpc bridge.
function fmtDot(wei) { return (Number(wei) / 1e18).toFixed(4); }
// TestUSDC has 6 decimals — UI is fully human-readable. Strip trailing
// ".0" so whole-number amounts display as e.g. "100" rather than "100.0".
function fmtUsdc(raw) {
  const s = ethers.formatUnits(raw, 6);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}
function parseUsdc(s) { return ethers.parseUnits(String(s), 6); }
async function refreshBalances() {
  if (!userAddr || !provider) return;
  try {
    const [dot, u] = await Promise.all([
      provider.getBalance(userAddr),
      usdc.balanceOf(userAddr),
    ]);
    $('balDot').textContent = fmtDot(dot);
    $('balUsdc').textContent = fmtUsdc(u);
    $('balances').hidden = false;
  } catch { /* RPC blip; try again next tick */ }
}
setInterval(refreshBalances, 3_000);

// Demo / Playwright path: ?demoKey=<0x-prefixed-privkey> skips EIP-6963
// and uses a local ethers.Wallet against cfg.ethRpcUrl. URL is the only
// source of truth — reload preserves it (browser keeps the query), close
// + reopen forgets. The URL with the key IS the bookmark.
const TEST_BUYER_KEY = ethers.keccak256(
  ethers.toUtf8Bytes('simplex-community-credits-poc-buyer-v1'),
);

function getDemoKey() {
  const k = new URL(location.href).searchParams.get('demoKey');
  return k && /^0x[0-9a-fA-F]{64}$/.test(k) ? k : null;
}

async function bootDemoMode(key) {
  provider = new ethers.JsonRpcProvider(cfg.ethRpcUrl);
  signer = new ethers.NonceManager(new ethers.Wallet(key, provider));
  userAddr = await signer.getAddress();
  usdc = new ethers.Contract(cfg.stablecoinAddress, ERC20_ABI, provider);
  $('wallets').innerHTML =
    '<p class="err" style="background:#fee;padding:0.4rem;border-radius:4px">' +
    '⚠ Demo mode — using local key. Do NOT use on a real chain.</p>';
  $('walletStatus').textContent = `demo • ${userAddr}`;
  $('walletStatus').className = 'ok';
  $('buy').hidden = false;
  await refreshBalances();
}

async function renderWallets() {
  const list = await discoverProviders();
  const host = $('wallets');
  host.innerHTML = '';
  // Test-key shortcut — always available, so a user without MetaMask
  // can still drive the demo.
  const demoBtn = document.createElement('button');
  demoBtn.textContent = 'Use built-in test key (demo)';
  demoBtn.onclick = () => bootDemoMode(TEST_BUYER_KEY);
  demoBtn.style.background = '#fee';
  host.appendChild(demoBtn);
  if (list.length === 0) {
    const p = document.createElement('p');
    p.className = 'mut';
    p.style.marginTop = '0.4rem';
    p.textContent = 'No extension wallet detected. Use the test key for a local demo, or install MetaMask for a real wallet.';
    host.appendChild(p);
    return;
  }
  for (const w of list) {
    const b = document.createElement('button');
    b.textContent = `Connect ${w.info.name}`;
    b.onclick = () => connect(w.provider, w.info.name);
    host.appendChild(b);
  }
}

async function connect(eip1193, name) {
  try {
    userAddr = await connectEvm(eip1193, { chainIdHex: cfg.chainIdHex });
    const browser = new ethers.BrowserProvider(eip1193);
    signer = await browser.getSigner();
    provider = browser;
    usdc = new ethers.Contract(cfg.stablecoinAddress, ERC20_ABI, provider);
    $('walletStatus').textContent = `${name} • ${userAddr}`;
    $('walletStatus').className = 'ok';
    $('buy').hidden = false;
    await refreshBalances();
  } catch (e) {
    $('walletStatus').textContent = `Failed: ${e.message}`;
    $('walletStatus').className = 'err';
  }
}

function unpackProof(flat) {
  return {
    pA: [flat[0], flat[1]],
    pB: [[flat[2], flat[3]], [flat[4], flat[5]]],
    pC: [flat[6], flat[7]],
  };
}

async function buy() {
  const value = parseUsdc($('value').value);
  const expiryEpoch = BigInt($('expiryEpoch').value);
  const status = $('buyStatus');
  $('goBuy').disabled = true;

  try {
    status.textContent = 'Generating note key…';
    const { sk, ownerPkHash } = await generateKeypair();
    const randomness = randomFieldElement();
    const cm = await deriveCommitment({
      value, expiryEpoch, ownerPkHash, randomness, assigned: 0n, redeemerHash: 0n,
    });

    status.textContent = 'Proving create (~0.5–1 s)…';
    const { proofFlat } = await proveCreateBrowser({
      ownerPkHash, randomness, cm, value, expiryEpoch,
    });
    const { pA, pB, pC } = unpackProof(proofFlat);

    status.textContent = 'Approving tUSDC…';
    const usdc = new ethers.Contract(cfg.stablecoinAddress, ERC20_ABI, signer);
    await (await usdc.approve(cfg.poolAddress, value)).wait();

    status.textContent = 'Submitting buyAndCreate…';
    const pool = new ethers.Contract(cfg.poolAddress, POOL_ABI, signer);
    const txr = await (await pool.buyAndCreate(cm, value, Number(expiryEpoch), pA, pB, pC)).wait();

    status.innerHTML = `<span class="ok">Voucher minted (tx ${txr.hash.slice(0, 10)}…)</span>`;
    await refreshBalances();
    await showResult({
      value, expiryEpoch, ownerPkHash, randomness,
      assigned: 0, redeemerHash: 0n, sk,
    });
  } catch (e) {
    console.error(e);
    status.innerHTML = `<span class="err">${e.shortMessage || e.message}</span>`;
  } finally {
    $('goBuy').disabled = false;
  }
}

async function showResult(note) {
  $('result').hidden = false;
  const link = buildImportLink(cfg.chatBaseUrl, note);
  $('chatLink').href = link;
  $('chatLink').textContent = 'Open in chat dapp →';
  $('noteDump').textContent = link;
  await QRCode.toCanvas($('qr'), link, { width: 280, margin: 1 });
}

$('goBuy').addEventListener('click', buy);
const _demoKey = getDemoKey();
if (_demoKey) await bootDemoMode(_demoKey);
else renderWallets();
