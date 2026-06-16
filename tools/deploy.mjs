#!/usr/bin/env node
// Standalone deployment CLI for the manual demo.
//
// Connects to the eth-rpc bridge (default http://localhost:8545), deploys
// the full contract set via test/e2e/deploy.mjs's deployAll(), then:
//   1. mints 1_000_000 tUSDC (1 unit, 6 decimals) to the buyer EOA
//   2. registers the relay EOA as an operator
//   3. writes the deployed addresses into each dapp's public/config.json
//   4. dumps tools/last-deploy.json with all the addresses
//
// Usage:
//   node tools/deploy.mjs
//   ETH_RPC_URL=http://localhost:8545 node tools/deploy.mjs  # e.g. chopsticks eth-rpc bridge

import { ethers } from 'ethers';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deployAll } from '../test/e2e/deploy.mjs';
import {
  deployerWallet,
  buyerWalletA, buyerWalletB,
  relayWalletA, relayWalletB,
  buyerWallets, relayWallets,
} from './keys.mjs';
import { demoCommunityPkHash } from '../packages/core/src/identity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const ETH_RPC_URL = process.env.ETH_RPC_URL || 'http://localhost:8545';
// Mint 1,000,000 tUSDC (6 decimals → 10^12 base units) to the buyer so
// the demo has comfortable headroom — earlier 1-tUSDC mint was too small
// for the default voucher amounts.
const TUSDC_MINT = BigInt(process.env.TUSDC_MINT || '1000000000000');
const EPOCH_SIZE = BigInt(process.env.EPOCH_SIZE || '100');
const TX_GAS = process.env.TX_GAS ? BigInt(process.env.TX_GAS) : 100_000_000n;

const provider = new ethers.JsonRpcProvider(ETH_RPC_URL);
const chainId = (await provider.getNetwork()).chainId;
const chainIdHex = '0x' + chainId.toString(16);
console.log(`> connected to ${ETH_RPC_URL} (chainId ${chainId} = ${chainIdHex})`);

const admin = new ethers.NonceManager(deployerWallet.connect(provider));
const txOpts = { gasLimit: TX_GAS };

// Per-step cost tracking via eth_getBalance — gives us "delta DOT spent"
// per tx without needing a second @polkadot/api connection (which would
// double up the metadata-query load on chopsticks and contributed to a
// runtime wasm trap on heavy demos). eth_getBalance returns the native
// DOT balance scaled to 18 decimals via pallet-revive's eth-rpc.
async function getDot(addr) {
  try {
    return await provider.getBalance(addr);
  } catch {
    return null;
  }
}
function fmtDot(wei) {
  if (wei === null || wei === undefined) return '?';
  const n = wei < 0n ? -wei : wei;
  const sign = wei < 0n ? '-' : '';
  return `${sign}${(Number(n) / 1e18).toFixed(6)} DOT`;
}
async function trackFee(label, fn) {
  const before = await getDot(deployerWallet.address);
  const result = await fn();
  const after = await getDot(deployerWallet.address);
  if (before !== null && after !== null) {
    console.log(`  ${label.padEnd(20)} cost: ${fmtDot(before - after)}`);
  }
  return result;
}

console.log(`> deploying as ${deployerWallet.address}…`);
const totalBefore = await getDot(deployerWallet.address);
// Chopsticks 1.3.1 (and 1.4) sometimes duplicates a tx in its own block
// when an upstream RPC stalls and ethers retries internally. The dedup
// suppresses the resulting duplicate step log lines.
let _lastLog = '';
const dedupLog = (msg) => { if (msg !== _lastLog) console.log(msg); _lastLog = msg; };
const { tUsdc, pool, createV, assignV, redeemV, poseidonT3 } = await trackFee('all contracts', () =>
  deployAll({
    signer: admin,
    epochSize: EPOCH_SIZE,
    txOpts,
    log: dedupLog,
  })
);

const tUsdcAddr = await tUsdc.getAddress();
const poolAddr = await pool.getAddress();

// Mint tUSDC to each end-user + register each relay as an operator.
for (const w of buyerWallets) {
  console.log(`> minting ${TUSDC_MINT} tUSDC to ${w.address}…`);
  await trackFee('mint', async () => {
    const r = await (await tUsdc.connect(admin).mint(w.address, TUSDC_MINT, txOpts)).wait();
    console.log(`  tx ${r.hash.slice(0, 14)}…  gas ${r.gasUsed}`);
  });
}
for (const w of relayWallets) {
  console.log(`> registering relay ${w.address} as operator…`);
  await trackFee('registerOperator', async () => {
    const r = await (await pool.connect(admin).registerOperator(w.address, txOpts)).wait();
    console.log(`  tx ${r.hash.slice(0, 14)}…  gas ${r.gasUsed}`);
  });
}

const totalAfter = await getDot(deployerWallet.address);
if (totalBefore !== null && totalAfter !== null) {
  console.log(`> deployer spent total: ${fmtDot(totalBefore - totalAfter)}`);
}

// Write addresses into each dapp's public/config.json.
// `deployId` is a freshly-generated marker so the chat dapp can detect
// "new deploy, even at the same address" (hardhat resets state per
// process spawn and our deterministic deployer key produces identical
// CREATE addresses each run — without this, stored notes from a
// previous run would linger as permanently-pending orphans).
const deployId = Date.now().toString();
const dappCfg = {
  ethRpcUrl: ETH_RPC_URL,
  chainIdHex,
  chainName: chainId === 420420419n ? 'Polkadot Asset Hub (chopsticks fork)' :
             chainId === 420420417n ? 'Paseo Asset Hub (chopsticks fork)' :
             chainId === 31337n      ? 'Hardhat local' :
             `chain ${chainId}`,
  chatBaseUrl: process.env.CHAT_BASE_URL || 'http://localhost:5174/',
  relayBaseUrl: process.env.RELAY_BASE_URL || 'http://localhost:5175/',
  poolAddress: poolAddr,
  stablecoinAddress: tUsdcAddr,
  deployId,
  // Demo-time pre-configured subject lists so each dapp can render
  // quick-pick buttons. Real flows: buyers/relays bring their own keys,
  // communities publish their pkHash via their own onboarding.
  demoBuyers: [
    { label: 'User A', address: buyerWalletA.address, privateKey: buyerWalletA.privateKey },
    { label: 'User B', address: buyerWalletB.address, privateKey: buyerWalletB.privateKey },
  ],
  demoOperators: [
    { label: 'Relay A', name: 'Relay A', address: relayWalletA.address, privateKey: relayWalletA.privateKey },
    { label: 'Relay B', name: 'Relay B', address: relayWalletB.address, privateKey: relayWalletB.privateKey },
  ],
  demoCommunities: [
    { label: 'Community A', cid: '1', pkHash: (await demoCommunityPkHash('1')).toString() },
    { label: 'Community B', cid: '2', pkHash: (await demoCommunityPkHash('2')).toString() },
  ],
};
const dappDirs = ['purchaser', 'chat', 'relay'];
for (const d of dappDirs) {
  const p = resolve(ROOT, 'packages', d, 'public', 'config.json');
  // preserve existing extra keys if the file already had any
  let existing = {};
  if (existsSync(p)) {
    try { existing = JSON.parse(readFileSync(p, 'utf8')); } catch {}
  }
  writeFileSync(p, JSON.stringify({ ...existing, ...dappCfg }, null, 2) + '\n');
  console.log(`> wrote ${p}`);
}

// Dump a manifest the e2e + tutorial can read.
const manifest = {
  ethRpcUrl: ETH_RPC_URL,
  chainId: Number(chainId),
  poolAddress: poolAddr,
  tUsdcAddress: tUsdcAddr,
  createVerifier: await createV.getAddress(),
  assignVerifier: await assignV.getAddress(),
  redeemVerifier: await redeemV.getAddress(),
  poseidonT3: await poseidonT3.getAddress(),
  deployer: deployerWallet.address,
  buyers: buyerWallets.map((w) => w.address),
  relays: relayWallets.map((w) => w.address),
  deployedAt: new Date().toISOString(),
};
const manifestPath = resolve(__dirname, 'last-deploy.json');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`\n> manifest: ${manifestPath}`);
console.log('\ndeploy complete.');
