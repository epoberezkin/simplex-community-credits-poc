// In-memory incremental Merkle tree with Poseidon(2) hash. Used by:
//   - the core test harness (mirror of the on-chain tree)
//   - the chat dapp's witness builder, fed by event indexing
//   - the checkpointer's witness builder (frontier + new leaves)
//
// Must match the on-chain StreamAndRootRing.sol byte-for-byte (same depth,
// same Poseidon constants, ZERO_LEAF=0).
//
// Internally maintains Tornado-style `filledSubtrees[]` so that frontier()
// and root() are O(1) reads after each insert. `proof(leafIndex)` still
// walks the full leaves array (needed by spenders for inclusion paths).

import { poseidonHash } from './poseidon.js';

export const DEFAULT_DEPTH = 20;

// Matches the on-chain frontier convention (an empty slot hashes as 0).
const ZERO_LEAF = 0n;

export class IncrementalMerkleTree {
  constructor(depth = DEFAULT_DEPTH) {
    this.depth = depth;
    this.leaves = [];                          // bigint[] — needed by proof()
    this.filledSubtrees = null;                // Tornado-style frontier; lazy
    this._zeros = null;                        // zeros[0..depth]
    this._root = null;
  }

  async _ensureInit() {
    if (this._zeros) return;
    const z = new Array(this.depth + 1);
    z[0] = ZERO_LEAF;
    for (let d = 1; d <= this.depth; d++) {
      z[d] = await poseidonHash([z[d - 1], z[d - 1]]);
    }
    this._zeros = z;
    if (!this.filledSubtrees) this.filledSubtrees = new Array(this.depth).fill(0n);
    if (this._root === null) this._root = z[this.depth];
  }

  // Append a leaf and incrementally update filledSubtrees + cached root.
  // Returns the inserted leaf index (= position).
  async insert(leaf) {
    await this._ensureInit();
    const idx = this.leaves.length;
    const value = BigInt(leaf);
    this.leaves.push(value);
    let current = value;
    for (let d = 0; d < this.depth; d++) {
      if (((idx >> d) & 1) === 0) {
        this.filledSubtrees[d] = current;
        current = await poseidonHash([current, this._zeros[d]]);
      } else {
        current = await poseidonHash([this.filledSubtrees[d], current]);
      }
    }
    this._root = current;
    return idx;
  }

  async root() {
    await this._ensureInit();
    return this._root;
  }

  // Snapshot of the current Tornado-style filledSubtrees. Returned as a
  // fresh array so callers can mutate without disturbing this instance.
  async frontier() {
    await this._ensureInit();
    return [...this.filledSubtrees];
  }

  async zeros() {
    await this._ensureInit();
    return [...this._zeros];
  }

  // Sibling path for proving inclusion of leaves[leafIndex].
  // Returns { pathElements: bigint[depth], pathIndices: 0|1[depth], root }.
  async proof(leafIndex) {
    await this._ensureInit();
    const zeros = this._zeros;
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
