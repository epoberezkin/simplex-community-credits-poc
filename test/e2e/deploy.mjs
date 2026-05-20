// Deployment helpers shared by the e2e test + dapp config emitters.
//
// Two artifact sources:
//   - TARGET=hardhat (default) : contracts/artifacts/  (EVM bytecode from solc)
//   - TARGET=chopsticks       : contracts/artifacts-pvm/  (PVM bytecode from resolc)
// The ABI is identical between the two; only the bytecode and linkRefs differ.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARDHAT_ROOT = resolve(__dirname, '..', '..', 'contracts', 'artifacts', 'contracts');
const HARDHAT_PSOL_T3 = resolve(
  __dirname, '..', '..', 'contracts', 'artifacts', 'poseidon-solidity', 'PoseidonT3.sol', 'PoseidonT3.json',
);
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

function loadPoseidon() {
  if (USE_PVM) return loadArtifact('PoseidonT3');
  return JSON.parse(readFileSync(HARDHAT_PSOL_T3, 'utf8'));
}

// Deploy PoseidonT3 as a fresh contract. Skips the canonical deterministic-
// deployment proxy because (a) it nonce-conflicts on a fresh hardhat node,
// (b) on pallet-revive the proxy address has no special meaning anyway —
// we link the library at deploy time either way.
async function deployPoseidonT3(signer, txOpts) {
  const art = loadPoseidon();
  const factory = new ethers.ContractFactory(art.abi, art.bytecode, signer);
  const c = await factory.deploy(txOpts || {});
  await c.waitForDeployment();
  return c.getAddress();
}

// Link the (PoseidonT3) external library reference inside VoucherPool.bytecode
// to the deployed Poseidon contract address.
//
// Two flavours — EVM (hardhat) uses solc's linkReferences placeholder scheme;
// PVM (resolc) ships raw ELF objects that need `resolc --link` to relocate
// against the library address, producing a PolkaVM blob in place.
function linkLibrariesEvm(bytecode, linkRefs, libraryAddresses) {
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

function linkLibrariesPvm(bytecodeHex, libraryAddresses) {
  // ELF object → tmpfile → `resolc --link` → PVM blob (rewritten in place).
  const tmp = resolve(tmpdir(), `vp-${process.pid}-${Date.now()}.elf`);
  writeFileSync(tmp, Buffer.from(bytecodeHex.replace(/^0x/, ''), 'hex'));
  const libArgs = Object.entries(libraryAddresses)
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  execFileSync('resolc', ['--link', '--libraries', libArgs, tmp], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const linked = readFileSync(tmp);
  return '0x' + linked.toString('hex');
}

export async function deployAll({ signer, epochSize = 100, txOpts = {} }) {
  const poseidonAddr = await deployPoseidonT3(signer, txOpts);

  const tUsdcArt = loadArtifact('TestUSDC');
  const tUsdc = await new ethers.ContractFactory(
    tUsdcArt.abi, tUsdcArt.bytecode, signer,
  ).deploy(0n, txOpts);
  await tUsdc.waitForDeployment();

  const createArt = loadVerifier('CreateVerifier');
  const assignArt = loadVerifier('AssignVerifier');
  const redeemArt = loadVerifier('RedeemVerifier');
  const createV = await new ethers.ContractFactory(createArt.abi, createArt.bytecode, signer).deploy(txOpts);
  await createV.waitForDeployment();
  const assignV = await new ethers.ContractFactory(assignArt.abi, assignArt.bytecode, signer).deploy(txOpts);
  await assignV.waitForDeployment();
  const redeemV = await new ethers.ContractFactory(redeemArt.abi, redeemArt.bytecode, signer).deploy(txOpts);
  await redeemV.waitForDeployment();

  const poolArt = loadArtifact('VoucherPool');
  // PVM artifacts from resolc inline the (internal) MerkleTreeLib but still
  // surface PoseidonT3 as an external library reference. Hardhat encodes that
  // as solc placeholder bytes (patched with linkLibrariesEvm); resolc emits a
  // raw ELF object that needs `resolc --link` to relocate against the deployed
  // PoseidonT3 address and become a PolkaVM blob.
  const linkedBytecode = USE_PVM
    ? linkLibrariesPvm(poolArt.bytecode, {
        'poseidon-solidity/PoseidonT3.sol:PoseidonT3': poseidonAddr,
      })
    : linkLibrariesEvm(poolArt.bytecode, poolArt.linkReferences || {}, {
        'poseidon-solidity/PoseidonT3.sol:PoseidonT3': poseidonAddr,
      });
  const pool = await new ethers.ContractFactory(poolArt.abi, linkedBytecode, signer).deploy(
    await tUsdc.getAddress(),
    await createV.getAddress(),
    await assignV.getAddress(),
    await redeemV.getAddress(),
    epochSize,
    txOpts,
  );
  await pool.waitForDeployment();

  return { tUsdc, createV, assignV, redeemV, pool, poseidonAddr };
}
