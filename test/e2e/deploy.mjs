// Deployment helpers shared by the e2e test + dapp config emitters.
//
// EVM bytecode only: the pool now folds commitments into an on-chain
// Tornado-style Merkle tree (PoseidonT3 hashes per insert), so the same solc
// (hardhat) bytecode runs on a local hardhat node AND on pallet-revive's REVM
// (chopsticks-forked Asset Hub). There is no PVM/resolc path anymore — the
// TARGET=chopsticks run just points at the eth-rpc bridge.
//
// On-chain Poseidon(2) is deployed from circomlibjs bytecode (poseidonT3Bytecode),
// bit-identical to the circuits' Poseidon(2). No library linking is needed —
// VoucherPool calls it through the IPoseidonT3 interface.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { poseidonT3Bytecode } from '@community-credits/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARDHAT_ROOT = resolve(__dirname, '..', '..', 'contracts', 'artifacts', 'contracts');

function loadArtifact(name) {
  return JSON.parse(
    readFileSync(resolve(HARDHAT_ROOT, `${name}.sol`, `${name}.json`), 'utf8'),
  );
}

function loadVerifier(name) {
  return JSON.parse(
    readFileSync(
      resolve(HARDHAT_ROOT, 'verifiers', `${name}.sol`, `${name}.json`),
      'utf8',
    ),
  );
}

export async function deployAll({ signer, epochSize = 100, txOpts = {}, log = () => {} }) {
  async function step(name, artFactory, ctorArgs) {
    const t0 = Date.now();
    const c = await artFactory.deploy(...ctorArgs, txOpts);
    const dt = await c.deploymentTransaction()?.wait();
    await c.waitForDeployment();
    const addr = await c.getAddress();
    log(`  ${name.padEnd(22)} ${addr}  (tx ${dt?.hash?.slice(0, 14)}…  gas ${dt?.gasUsed ?? '?'}, ${(Date.now() - t0) / 1000}s)`);
    return c;
  }

  const tUsdcArt = loadArtifact('TestUSDC');
  const tUsdc = await step('TestUSDC',
    new ethers.ContractFactory(tUsdcArt.abi, tUsdcArt.bytecode, signer), [0n]);

  // On-chain Poseidon(2), deployed from raw circomlibjs bytecode (no ABI).
  const poseidonT3 = await step('PoseidonT3',
    new ethers.ContractFactory([], poseidonT3Bytecode, signer), []);

  const createArt = loadVerifier('CreateVerifier');
  const assignArt = loadVerifier('AssignVerifier');
  const redeemArt = loadVerifier('RedeemVerifier');
  const createV = await step('CreateVerifier',
    new ethers.ContractFactory(createArt.abi, createArt.bytecode, signer), []);
  const assignV = await step('AssignVerifier',
    new ethers.ContractFactory(assignArt.abi, assignArt.bytecode, signer), []);
  const redeemV = await step('RedeemVerifier',
    new ethers.ContractFactory(redeemArt.abi, redeemArt.bytecode, signer), []);

  const poolArt = loadArtifact('VoucherPool');
  const pool = await step('VoucherPool',
    new ethers.ContractFactory(poolArt.abi, poolArt.bytecode, signer), [
      await tUsdc.getAddress(),
      await createV.getAddress(),
      await assignV.getAddress(),
      await redeemV.getAddress(),
      await poseidonT3.getAddress(),
      epochSize,
    ]);

  return { tUsdc, createV, assignV, redeemV, poseidonT3, pool };
}
