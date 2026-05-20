// Deployment helpers shared by the e2e test + dapp config emitters.
//
// Two artifact sources:
//   - TARGET=hardhat (default) : contracts/artifacts/  (EVM bytecode from solc)
//   - TARGET=chopsticks       : contracts/artifacts-pvm/  (PVM bytecode from resolc)
// The ABI is identical between the two; only the bytecode differs. After the
// stream+checkpoint redesign there's no PoseidonT3 dependency on chain, so
// no library linking is needed in either flavour.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARDHAT_ROOT = resolve(__dirname, '..', '..', 'contracts', 'artifacts', 'contracts');
const PVM_ROOT = resolve(__dirname, '..', '..', 'contracts', 'artifacts-pvm');

const USE_PVM = process.env.TARGET === 'chopsticks';

function loadArtifact(name) {
  if (USE_PVM) {
    const p = resolve(PVM_ROOT, `${name}.json`);
    if (!existsSync(p)) {
      throw new Error(`Missing PVM artifact ${p}. Run: node contracts/scripts/compile-resolc.mjs`);
    }
    return JSON.parse(readFileSync(p, 'utf8'));
  }
  return JSON.parse(
    readFileSync(resolve(HARDHAT_ROOT, `${name}.sol`, `${name}.json`), 'utf8'),
  );
}

function loadVerifier(name) {
  if (USE_PVM) return loadArtifact(name);
  return JSON.parse(
    readFileSync(
      resolve(HARDHAT_ROOT, 'verifiers', `${name}.sol`, `${name}.json`),
      'utf8',
    ),
  );
}

export async function deployAll({ signer, epochSize = 100, txOpts = {} }) {
  const tUsdcArt = loadArtifact('TestUSDC');
  const tUsdc = await new ethers.ContractFactory(
    tUsdcArt.abi, tUsdcArt.bytecode, signer,
  ).deploy(0n, txOpts);
  await tUsdc.waitForDeployment();

  const createArt = loadVerifier('CreateVerifier');
  const assignArt = loadVerifier('AssignVerifier');
  const redeemArt = loadVerifier('RedeemVerifier');
  const checkpointArt = loadVerifier('CheckpointVerifier');
  const createV = await new ethers.ContractFactory(createArt.abi, createArt.bytecode, signer).deploy(txOpts);
  await createV.waitForDeployment();
  const assignV = await new ethers.ContractFactory(assignArt.abi, assignArt.bytecode, signer).deploy(txOpts);
  await assignV.waitForDeployment();
  const redeemV = await new ethers.ContractFactory(redeemArt.abi, redeemArt.bytecode, signer).deploy(txOpts);
  await redeemV.waitForDeployment();
  const checkpointV = await new ethers.ContractFactory(checkpointArt.abi, checkpointArt.bytecode, signer).deploy(txOpts);
  await checkpointV.waitForDeployment();

  const poolArt = loadArtifact('VoucherPool');
  const pool = await new ethers.ContractFactory(poolArt.abi, poolArt.bytecode, signer).deploy(
    await tUsdc.getAddress(),
    await createV.getAddress(),
    await assignV.getAddress(),
    await redeemV.getAddress(),
    await checkpointV.getAddress(),
    epochSize,
    txOpts,
  );
  await pool.waitForDeployment();

  return { tUsdc, createV, assignV, redeemV, checkpointV, pool };
}
