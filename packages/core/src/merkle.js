// In-memory incremental Merkle tree with Poseidon(2) hash. Used by:
//   - the core test harness (mirror of the on-chain tree)
//   - the chat dapp's witness builder, fed by event indexing
//
// Must match the on-chain IncrementalMerkleTree.sol byte-for-byte (same depth,
// same Poseidon constants, same zero-value scheme).

import { poseidonHash } from './poseidon.js';

export const DEFAULT_DEPTH = 20;

// Default zero-value used by Tornado/Semaphore-style trees. Any field element
// works; this one is "keccak256('community-credits-poc') mod r" rounded down,
// but for the PoC we just use 0n since that matches a fresh storage slot.
const ZERO_LEAF = 0n;

export class IncrementalMerkleTree {
  constructor(depth = DEFAULT_DEPTH) {
    this.depth = depth;
    this.leaves = []; // bigint[]
    this.zeros = null; // bigint[depth+1], lazily computed
    this._cachedRoot = null;
  }

  async _zeros() {
    if (this.zeros) return this.zeros;
    const z = new Array(this.depth + 1);
    z[0] = ZERO_LEAF;
    for (let i = 1; i <= this.depth; i++) {
      z[i] = await poseidonHash([z[i - 1], z[i - 1]]);
    }
    this.zeros = z;
    return z;
  }

  async insert(leaf) {
    this.leaves.push(BigInt(leaf));
    this._cachedRoot = null;
    return this.leaves.length - 1;
  }

  async root() {
    if (this._cachedRoot !== null) return this._cachedRoot;
    const zeros = await this._zeros();
    let level = this.leaves.slice();
    for (let d = 0; d < this.depth; d++) {
      const next = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i];
        const right = i + 1 < level.length ? level[i + 1] : zeros[d];
        next.push(await poseidonHash([left, right]));
      }
      level = next;
    }
    this._cachedRoot = level.length ? level[0] : zeros[this.depth];
    return this._cachedRoot;
  }

  // Returns { pathElements: bigint[depth], pathIndices: 0|1[depth], root }
  async proof(leafIndex) {
    const zeros = await this._zeros();
    const pathElements = [];
    const pathIndices = [];
    let level = this.leaves.slice();
    let idx = leafIndex;
    for (let d = 0; d < this.depth; d++) {
      const isRight = idx & 1;
      const sibling =
        (isRight ? level[idx - 1] : level[idx + 1]) ?? zeros[d];
      pathElements.push(sibling);
      pathIndices.push(isRight);
      const next = [];
      for (let i = 0; i < level.length; i += 2) {
        const l = level[i];
        const r = i + 1 < level.length ? level[i + 1] : zeros[d];
        next.push(await poseidonHash([l, r]));
      }
      level = next;
      idx = idx >> 1;
    }
    const root = level.length ? level[0] : zeros[this.depth];
    return { pathElements, pathIndices, root };
  }
}
