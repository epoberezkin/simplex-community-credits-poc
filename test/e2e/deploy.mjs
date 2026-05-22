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

  const createArt = loadVerifier('CreateVerifier');
  const assignArt = loadVerifier('AssignVerifier');
  const redeemArt = loadVerifier('RedeemVerifier');
  const checkpointArt = loadVerifier('CheckpointVerifier');
  const createV = await step('CreateVerifier',
    new ethers.ContractFactory(createArt.abi, createArt.bytecode, signer), []);
  const assignV = await step('AssignVerifier',
    new ethers.ContractFactory(assignArt.abi, assignArt.bytecode, signer), []);
  const redeemV = await step('RedeemVerifier',
    new ethers.ContractFactory(redeemArt.abi, redeemArt.bytecode, signer), []);
  const checkpointV = await step('CheckpointVerifier',
    new ethers.ContractFactory(checkpointArt.abi, checkpointArt.bytecode, signer), []);

  const poolArt = loadArtifact('VoucherPool');
  const pool = await step('VoucherPool',
    new ethers.ContractFactory(poolArt.abi, poolArt.bytecode, signer), [
      await tUsdc.getAddress(),
      await createV.getAddress(),
      await assignV.getAddress(),
      await redeemV.getAddress(),
      await checkpointV.getAddress(),
      epochSize,
    ]);

  return { tUsdc, createV, assignV, redeemV, checkpointV, pool };
}
