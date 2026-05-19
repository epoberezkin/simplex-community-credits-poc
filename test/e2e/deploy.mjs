// Deployment helpers shared by the e2e test + dapp config emitters.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_ROOT = resolve(__dirname, '..', '..', 'contracts', 'artifacts');
const ARTIFACTS = resolve(CONTRACTS_ROOT, 'contracts');
const PSOL_T3 = resolve(CONTRACTS_ROOT, 'poseidon-solidity', 'PoseidonT3.sol', 'PoseidonT3.json');

function loadArtifact(name) {
  return JSON.parse(
    readFileSync(resolve(ARTIFACTS, `${name}.sol`, `${name}.json`), 'utf8'),
  );
}

function loadVerifier(name) {
  return JSON.parse(
    readFileSync(
      resolve(ARTIFACTS, 'verifiers', `${name}.sol`, `${name}.json`),
      'utf8',
    ),
  );
}

// Deploy PoseidonT3 as a fresh contract on whatever chain we're on. We skip
// the deterministic-deployment proxy because (a) on a fresh local node it
// fails with "nonce already used" depending on provider quirks, and (b) the
// canonical address isn't valuable for our PoC — we link the library at
// deploy time anyway.
async function deployPoseidonT3(signer) {
  const art = JSON.parse(readFileSync(PSOL_T3, 'utf8'));
  const factory = new ethers.ContractFactory(art.abi, art.bytecode, signer);
  const c = await factory.deploy();
  await c.waitForDeployment();
  return c.getAddress();
}

// Link the (PoseidonT3) external library reference inside VoucherPool.bytecode
// to the deployed Poseidon contract address.
function linkLibraries(bytecode, linkRefs, libraryAddresses) {
  let out = bytecode;
  for (const [filePath, contracts] of Object.entries(linkRefs)) {
    for (const [contractName, refs] of Object.entries(contracts)) {
      const addr = libraryAddresses[`${filePath}:${contractName}`];
      if (!addr) continue;
      const clean = addr.toLowerCase().replace(/^0x/, '');
      for (const { start, length } of refs) {
        const offset = start * 2 + 2; // skip 0x
        out = out.slice(0, offset) + clean + out.slice(offset + length * 2);
      }
    }
  }
  return out;
}

export async function deployAll({ signer, epochSize = 100 }) {
  const poseidonAddr = await deployPoseidonT3(signer);

  // Stablecoin (mint everything to the deployer; e2e then transfers to buyer).
  const tUsdcArt = loadArtifact('TestUSDC');
  const tUsdcFactory = new ethers.ContractFactory(
    tUsdcArt.abi,
    tUsdcArt.bytecode,
    signer,
  );
  const tUsdc = await tUsdcFactory.deploy(0n);
  await tUsdc.waitForDeployment();

  // Three verifiers.
  const createArt = loadVerifier('CreateVerifier');
  const assignArt = loadVerifier('AssignVerifier');
  const redeemArt = loadVerifier('RedeemVerifier');
  const createV = await new ethers.ContractFactory(createArt.abi, createArt.bytecode, signer).deploy();
  await createV.waitForDeployment();
  const assignV = await new ethers.ContractFactory(assignArt.abi, assignArt.bytecode, signer).deploy();
  await assignV.waitForDeployment();
  const redeemV = await new ethers.ContractFactory(redeemArt.abi, redeemArt.bytecode, signer).deploy();
  await redeemV.waitForDeployment();

  // VoucherPool, linking PoseidonT3.
  const poolArt = loadArtifact('VoucherPool');
  const linkedBytecode = linkLibraries(poolArt.bytecode, poolArt.linkReferences, {
    'poseidon-solidity/PoseidonT3.sol:PoseidonT3': poseidonAddr,
  });
  const poolFactory = new ethers.ContractFactory(poolArt.abi, linkedBytecode, signer);
  const pool = await poolFactory.deploy(
    await tUsdc.getAddress(),
    await createV.getAddress(),
    await assignV.getAddress(),
    await redeemV.getAddress(),
    epochSize,
  );
  await pool.waitForDeployment();

  return {
    tUsdc,
    createV,
    assignV,
    redeemV,
    pool,
    poseidonAddr,
  };
}
