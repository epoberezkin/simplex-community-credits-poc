#!/usr/bin/env node
// Live human-readable event/balance feed for the demo. Spawned by
// `tools/demo.mjs`; output prefixed [events] in the demo log.
//
// Implemented over ethers/eth-rpc (NOT @polkadot/api). The substrate
// side of chopsticks-forked Polkadot Asset Hub is fragile under
// repeated `Metadata_metadata` queries — even one @polkadot/api
// client tips it into a wasm-runtime trap. eth-rpc avoids that surface.
//
// Surfaced:
//   - VoucherPool events decoded against its ABI (VoucherCreated,
//     Assigned, Redeemed, Withdrawn)
//   - DOT balance deltas for the 3 known accounts (deployer/buyer/relay),
//     on every new block
//
// Not surfaced (cost of dropping @polkadot/api):
//   - substrate-only events (Balances.Reserved, Assets.Issued, etc.)
//   - per-extrinsic gas vs deposit breakdown
//
// Polls every new block. Best-effort: errors logged once and skipped.

import { ethers } from 'ethers';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { deployerWallet, buyerWalletA, buyerWalletB, relayWalletA, relayWalletB } from './keys.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const ETH_RPC_URL = process.env.ETH_RPC_URL || 'http://localhost:8545';
// Default 6s. Lower = more responsive logs; higher = less load on
// chopsticks's runtime executor (every poll triggers eth-rpc → subxt
// metadata-cache checks, and chopsticks bumps runtime_version per
// forked block which forces subxt to re-fetch). At 1 Hz we saw the
// wasm-runtime trap after a few minutes; 6s keeps it stable.
const POLL_DEPLOY_MS = Number(process.env.EVENTS_POLL_MS || 6000);

const ACCOUNTS = [
  { label: 'deployer', address: deployerWallet.address },
  { label: 'userA',    address: buyerWalletA.address },
  { label: 'userB',    address: buyerWalletB.address },
  { label: 'relayA',   address: relayWalletA.address },
  { label: 'relayB',   address: relayWalletB.address },
];

function fmtDot(wei) {
  const sign = wei < 0n ? '-' : '';
  const n = wei < 0n ? -wei : wei;
  return `${sign}${(Number(n) / 1e18).toFixed(6)} DOT`;
}
function shortHex(v, n = 12) {
  const s = typeof v === 'bigint' ? '0x' + v.toString(16) : String(v);
  return s.length > n + 2 ? s.slice(0, n + 2) + '…' : s;
}
function tUsdcText(raw) {
  const s = (Number(raw) / 1e6).toString();
  return `${s} tUSDC`;
}

// One human sentence per pool event — attributes the action to the
// dapp/agent that submitted the underlying tx. Returns null to suppress.
function describePoolEvent(name, args) {
  switch (name) {
    case 'OperatorRegistered':
      return `[deployer    → chain] registered operator ${args.operator}`;
    case 'VoucherCreated':
      return `[Dapp A      → chain] buyer minted voucher ${tUsdcText(args.value)} ` +
        `(cm ${shortHex(args.cm)}, leafIdx ${args.leafIndex}, expires epoch ${args.expiryEpoch})`;
    case 'Assigned':
      return `[Dapp C      → chain] relay submitted ASSIGN — ` +
        `dest leafIdx ${args.destLeafIndex} / change leafIdx ${args.changeLeafIndex}, ` +
        `nullifier ${shortHex(args.nullifier)}`;
    case 'Redeemed':
      return `[Dapp C      → chain] relay submitted REDEEM ${tUsdcText(args.redeemValue)} ` +
        `to operator ${args.operator.slice(0, 10)}… ` +
        `(change leafIdx ${args.changeLeafIndex}, nullifier ${shortHex(args.nullifier)})`;
    case 'Withdrawn':
      return `[Dapp C      → chain] operator ${args.operator.slice(0, 10)}… withdrew ${tUsdcText(args.amount)}`;
  }
  return null;
}

function loadDeploy() {
  const p = resolve(REPO_ROOT, 'tools/last-deploy.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}
function loadPoolInterface() {
  const p = resolve(REPO_ROOT, 'contracts/artifacts/contracts/VoucherPool.sol/VoucherPool.json');
  if (!existsSync(p)) return null;
  try { return new ethers.Interface(JSON.parse(readFileSync(p, 'utf8')).abi); } catch { return null; }
}

const provider = new ethers.JsonRpcProvider(ETH_RPC_URL);
const ERC20_BAL_ABI = ['function balanceOf(address) view returns (uint256)'];

let manifest = loadDeploy();
let poolIface = loadPoolInterface();
let usdc = manifest?.tUsdcAddress ? new ethers.Contract(manifest.tUsdcAddress, ERC20_BAL_ABI, provider) : null;

let lastDot = new Map();             // label → BigInt
let lastUsdc = new Map();            // label → BigInt
let lastBlock = await provider.getBlockNumber().catch(() => 0);
let registeredFilter = false;

async function refreshDeployArtifacts() {
  if (!manifest || !poolIface) {
    manifest = loadDeploy();
    poolIface = loadPoolInterface();
    if (manifest?.tUsdcAddress && !usdc) {
      usdc = new ethers.Contract(manifest.tUsdcAddress, ERC20_BAL_ABI, provider);
    }
  }
}

function fmtUsdc(units) {
  return (Number(units) / 1e6).toString() + ' tUSDC';
}
async function reportBalanceDelta(blockNumber) {
  for (const { label, address } of ACCOUNTS) {
    // DOT (gas).
    try {
      const bal = await provider.getBalance(address, blockNumber);
      const prev = lastDot.get(label);
      lastDot.set(label, bal);
      if (prev !== undefined && bal !== prev) {
        console.log(`[balance] ${label.padEnd(8)} DOT   ${fmtDot(bal - prev).padStart(11)}   (now ${fmtDot(bal)})`);
      }
    } catch {}
    // tUSDC (stablecoin) — only when we know the deployed contract address.
    if (usdc) {
      try {
        const bal = await usdc.balanceOf(address);
        const prev = lastUsdc.get(label);
        lastUsdc.set(label, bal);
        if (prev !== undefined && bal !== prev) {
          const delta = bal - prev;
          const sign = delta < 0n ? '-' : '+';
          const abs = delta < 0n ? -delta : delta;
          console.log(`[balance] ${label.padEnd(8)} tUSDC ${sign}${(Number(abs)/1e6).toString().padStart(9)} tUSDC   (now ${fmtUsdc(bal)})`);
        }
      } catch {}
    }
  }
}

async function fetchPoolLogs(fromBlock, toBlock) {
  if (!manifest?.poolAddress || !poolIface) return;
  let logs;
  try {
    logs = await provider.getLogs({
      address: manifest.poolAddress,
      fromBlock,
      toBlock,
    });
  } catch { return; }
  for (const log of logs) {
    try {
      const parsed = poolIface.parseLog(log);
      if (!parsed) continue;
      const named = {};
      parsed.fragment.inputs.forEach((inp, i) => { named[inp.name] = parsed.args[i]; });
      const line = describePoolEvent(parsed.name, named);
      if (line) console.log(line);
    } catch { /* unknown topic — skip */ }
  }
}

console.log(`watching ${ETH_RPC_URL} for VoucherPool events + DOT / tUSDC balance changes…`);

while (true) {
  await refreshDeployArtifacts();
  let current;
  try { current = await provider.getBlockNumber(); }
  catch { await sleep(POLL_DEPLOY_MS); continue; }
  if (current > lastBlock) {
    await fetchPoolLogs(lastBlock + 1, current);
    await reportBalanceDelta(current);
    lastBlock = current;
  }
  void registeredFilter;
  await sleep(POLL_DEPLOY_MS);
}
