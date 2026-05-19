// Dapp A — Purchaser. EVM signer via EIP-6963.
//   1) connect wallet (chain-switch to configured chain)
//   2) buy form → prove `create` → approve + buyAndCreate
//   3) emit ?import=<note> link + QR pointing at chat dapp

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

let signer; // ethers BrowserProvider signer
let userAddr;

const $ = (id) => document.getElementById(id);

async function renderWallets() {
  const list = await discoverProviders();
  const host = $('wallets');
  host.innerHTML = '';
  if (list.length === 0) {
    host.innerHTML = '<p class="err">No EIP-6963 wallet detected. Install MetaMask, Talisman, or SubWallet (EVM mode).</p>';
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
    $('walletStatus').textContent = `${name} • ${userAddr}`;
    $('walletStatus').className = 'ok';
    $('buy').hidden = false;
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
  const value = BigInt($('value').value);
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
renderWallets();
