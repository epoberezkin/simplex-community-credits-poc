#!/usr/bin/env node
// Compile every Solidity source we deploy to pallet-revive using the resolc
// compiler. resolc emits PVM (PolkaVM) bytecode that pallet_revive executes
// directly; standard EVM bytecode from solc/hardhat is rejected by the chain.
//
// Output: artifacts-pvm/{ContractName}.json   { abi, bin, linkReferences }
//
// We feed sources via resolc's standard JSON mode so import resolution + the
// library link-reference markers come back in the same shape Hardhat emits.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CONTRACTS = resolve(ROOT, 'contracts');
const OUT = resolve(ROOT, 'artifacts-pvm');
const NODE_MODULES = resolve(ROOT, 'node_modules');

mkdirSync(OUT, { recursive: true });

// Discover .sol files under contracts/ (recursive).
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = resolve(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.sol')) out.push(p);
  }
  return out;
}

const sources = {};
for (const f of walk(CONTRACTS)) {
  sources[relative(ROOT, f)] = { content: readFileSync(f, 'utf8') };
}
// Also pull in any node_modules imports we use directly.
const externalImports = ['poseidon-solidity/PoseidonT3.sol'];
for (const imp of externalImports) {
  const p = resolve(NODE_MODULES, imp);
  sources[imp] = { content: readFileSync(p, 'utf8') };
}

const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: {
      '*': {
        '*': ['abi', 'evm.bytecode'],
      },
    },
  },
};

console.log('> resolc --standard-json');
const stdoutBuf = execFileSync('resolc', ['--standard-json'], {
  input: JSON.stringify(input),
  maxBuffer: 200 * 1024 * 1024,
});
const result = JSON.parse(stdoutBuf.toString());

if (result.errors) {
  const fatal = result.errors.filter((e) => e.severity === 'error');
  if (fatal.length) {
    for (const e of fatal) console.error(e.formattedMessage || e.message);
    process.exit(1);
  }
  for (const e of result.errors) {
    if (process.env.VERBOSE) console.warn(e.formattedMessage || e.message);
  }
}

let written = 0;
for (const [file, contracts] of Object.entries(result.contracts || {})) {
  for (const [name, c] of Object.entries(contracts)) {
    if (!c.evm?.bytecode?.object) continue;
    writeFileSync(
      resolve(OUT, `${name}.json`),
      JSON.stringify(
        {
          contractName: name,
          sourceFile: file,
          abi: c.abi,
          bytecode: '0x' + c.evm.bytecode.object,
          linkReferences: c.evm.bytecode.linkReferences || {},
        },
        null,
        2,
      ),
    );
    written++;
  }
}
console.log(`wrote ${written} artifacts → ${relative(ROOT, OUT)}/`);
