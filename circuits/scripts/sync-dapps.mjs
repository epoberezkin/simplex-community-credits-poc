#!/usr/bin/env node
// Copy the latest *.wasm + *_final.zkey out of circuits/build + circuits/keys
// into each dapp's public/zk/ directory so the browser proofs and the
// deployed verifier stay in sync. Run automatically as part of `pnpm
// --filter circuits run build`.
//
// (The trusted-setup phase regenerates the zkey with fresh entropy on
// every invocation; without this sync the dapp keeps the previous zkey
// and the deployed verifier rejects every proof with `pool/proof`.)

import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

const MAP = [
  { circ: 'create',  dapp: 'purchaser' },
  { circ: 'assign',  dapp: 'chat' },
  { circ: 'redeem',  dapp: 'chat' },
];

for (const { circ, dapp } of MAP) {
  const wasmSrc = resolve(ROOT, 'circuits/build', circ, `${circ}_js`, `${circ}.wasm`);
  const zkeySrc = resolve(ROOT, 'circuits/keys', `${circ}_final.zkey`);
  const dst = resolve(ROOT, 'packages', dapp, 'public/zk');
  mkdirSync(dst, { recursive: true });
  copyFileSync(wasmSrc, resolve(dst, `${circ}.wasm`));
  copyFileSync(zkeySrc, resolve(dst, `${circ}_final.zkey`));
  console.log(`  ${circ} → packages/${dapp}/public/zk/`);
}
console.log('dapp zk artifacts in sync.');
