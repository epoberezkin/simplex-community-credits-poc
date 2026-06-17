#!/usr/bin/env node
// Compile each circom circuit to r1cs + wasm + sym.

import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'src');
const OUT = resolve(ROOT, 'build');

const CIRCUITS = ['create', 'assign', 'redeem'];

mkdirSync(OUT, { recursive: true });

for (const c of CIRCUITS) {
  const outDir = resolve(OUT, c);
  mkdirSync(outDir, { recursive: true });
  const input = resolve(SRC, `${c}.circom`);
  console.log(`> compiling ${c}…`);
  execFileSync(
    'circom',
    [
      input,
      '--r1cs',
      '--wasm',
      '--sym',
      '-o',
      outDir,
      '-l',
      resolve(ROOT, 'node_modules'),
    ],
    { stdio: 'inherit' },
  );
  if (!existsSync(resolve(outDir, `${c}.r1cs`))) {
    throw new Error(`compile failed: ${c}.r1cs missing`);
  }
  console.log(`  ✓ ${c}.r1cs / ${c}_js/${c}.wasm written`);
}

console.log('all circuits compiled.');
