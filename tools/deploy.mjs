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
//   TARGET=chopsticks node tools/deploy.mjs  # use PVM artifacts
//   ETH_RPC_URL=http://localhost:8545 node tools/deploy.mjs

import { ethers } from 'ethers';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deployAll } from '../test/e2e/deploy.mjs';
import { deployerWallet, buyerWallet, relayWallet } from './keys.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const ETH_RPC_URL = process.env.ETH_RPC_URL || 'http://localhost:8545';
const TUSDC_MINT = BigInt(process.env.TUSDC_MINT || '1000000');  // 1 unit at 6 decimals
const EPOCH_SIZE = BigInt(process.env.EPOCH_SIZE || '100');
const TX_GAS = process.env.TX_GAS ? BigInt(process.env.TX_GAS) : 100_000_000n;

const provider = new ethers.JsonRpcProvider(ETH_RPC_URL);
const chainId = (await provider.getNetwork()).chainId;
const chainIdHex = '0x' + chainId.toString(16);
console.log(`> connected to ${ETH_RPC_URL} (chainId ${chainId} = ${chainIdHex})`);

const admin = new ethers.NonceManager(deployerWallet.connect(provider));
const txOpts = { gasLimit: TX_GAS };

console.log(`> deploying as ${deployerWallet.address}…`);
const { tUsdc, pool, createV, assignV, redeemV, checkpointV } = await deployAll({
  signer: admin,
  epochSize: EPOCH_SIZE,
  txOpts,
});

const tUsdcAddr = await tUsdc.getAddress();
const poolAddr = await pool.getAddress();
console.log(`  tUSDC                : ${tUsdcAddr}`);
console.log(`  VoucherPool          : ${poolAddr}`);
console.log(`  CreateVerifier       : ${await createV.getAddress()}`);
console.log(`  AssignVerifier       : ${await assignV.getAddress()}`);
console.log(`  RedeemVerifier       : ${await redeemV.getAddress()}`);
console.log(`  CheckpointVerifier   : ${await checkpointV.getAddress()}`);

// Mint tUSDC to the buyer + register the relay as an operator.
console.log(`> minting ${TUSDC_MINT} tUSDC to buyer ${buyerWallet.address}…`);
await (await tUsdc.connect(admin).mint(buyerWallet.address, TUSDC_MINT, txOpts)).wait();
console.log(`> registering relay ${relayWallet.address} as operator…`);
await (await pool.connect(admin).registerOperator(relayWallet.address, txOpts)).wait();

// Write addresses into each dapp's public/config.json.
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

// Dump a manifest the checkpointer + tutorial can read.
const manifest = {
  ethRpcUrl: ETH_RPC_URL,
  chainId: Number(chainId),
  poolAddress: poolAddr,
  tUsdcAddress: tUsdcAddr,
  createVerifier: await createV.getAddress(),
  assignVerifier: await assignV.getAddress(),
  redeemVerifier: await redeemV.getAddress(),
  checkpointVerifier: await checkpointV.getAddress(),
  deployer: deployerWallet.address,
  buyer: buyerWallet.address,
  relay: relayWallet.address,
  deployedAt: new Date().toISOString(),
};
const manifestPath = resolve(__dirname, 'last-deploy.json');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`\n> manifest: ${manifestPath}`);
console.log('\ndeploy complete.');
