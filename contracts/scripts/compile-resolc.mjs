#!/usr/bin/env node
// Compile every Solidity source we deploy to pallet-revive using resolc,
// which emits PVM (PolkaVM) bytecode that pallet_revive executes natively.
// Standard EVM bytecode from solc/hardhat is rejected by the chain.
//
// Sources are passed inline as `content:` (not `urls:`). Recent resolc
// builds (1.x) reject the `urls:` form even with --allow-paths, complaining
// "missing field `content`" while parsing the standard-JSON input.
// stdin can get large (~hundreds of KB) so we route it through a tmpfile
// to avoid pipe-buffer deadlock.
//
// Output: artifacts-pvm/<ContractName>.json   { abi, bytecode, linkReferences }

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CONTRACTS = resolve(ROOT, 'contracts');
const OUT = resolve(ROOT, 'artifacts-pvm');
const NODE_MODULES = resolve(ROOT, 'node_modules');

mkdirSync(OUT, { recursive: true });

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
// Bare imports (`import "poseidon-solidity/PoseidonT3.sol"`) resolve
// against the sources map by key, so just register the file under its
// import path with inlined content.
const externalImports = ['poseidon-solidity/PoseidonT3.sol'];
for (const imp of externalImports) {
  sources[imp] = { content: readFileSync(resolve(NODE_MODULES, imp), 'utf8') };
}

const input = {
  language: 'Solidity',
  sources,
  settings: {
    // NOTE: solc optimizer is disabled below via --disable-solc-optimizer.
    // poseidon-solidity/PoseidonT3.sol has a ~50 KB inline-assembly block
    // with thousands of precomputed BN254 constants. With the solc optimizer
    // ON, solc hangs indefinitely on that file (was the cause of the earlier
    // 30-min "empty solc error"). PVM bytecode size grows ~3× without the
    // solc optimizer, but resolc's own LLVM optimizer (-O default `z`)
    // recovers most of the loss.
    optimizer: { enabled: false },
    outputSelection: {
      '*': { '*': ['abi', 'evm.bytecode'] },
    },
  },
};

console.log('> resolc --standard-json');
// Write input to a tmpfile so we don't deadlock on the input pipe — large
// inline verifier sources blow past the default 64 KB pipe buffer.
const inFile = resolve(tmpdir(), `resolc-in-${process.pid}.json`);
const outFile = resolve(tmpdir(), `resolc-out-${process.pid}.json`);
writeFileSync(inFile, JSON.stringify(input));
const inFd = openSync(inFile, 'r');
const outFd = openSync(outFile, 'w');
try {
  execFileSync(
    'resolc',
    ['--standard-json'],
    { stdio: [inFd, outFd, 'inherit'] },
  );
} finally {
  closeSync(inFd);
  closeSync(outFd);
}
const result = JSON.parse(readFileSync(outFile, 'utf8'));

if (result.errors) {
  const fatal = result.errors.filter((e) => e.severity === 'error');
  if (fatal.length) {
    for (const e of fatal) console.error(e.formattedMessage || e.message);
    process.exit(1);
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
