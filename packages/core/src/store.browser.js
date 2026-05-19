// IndexedDB-backed note store for the chat dapp. Stores per-profile keys +
// notes received via deep link or recovered from chain events.
//
// Schema is one key per note keyed by `commitment`, plus a `__keys` doc per
// scope (self / community-<id>) holding sk.

import { get, set, del, keys as idbKeys } from 'idb-keyval';

const PREFIX = 'cc:';

function k(scope, commitment) {
  return `${PREFIX}note:${scope}:${commitment}`;
}
function keyDoc(scope) {
  return `${PREFIX}sk:${scope}`;
}

export async function openStore() {
  return {
    async putKey(scope, sk) {
      await set(keyDoc(scope), sk.toString());
    },
    async getKey(scope) {
      const v = await get(keyDoc(scope));
      return v ? BigInt(v) : null;
    },
    async add(scope, note) {
      await set(k(scope, note.commitment), {
        ...note,
        value: note.value?.toString(),
        ownerPkHash: note.ownerPkHash?.toString(),
        randomness: note.randomness?.toString(),
        redeemerHash: note.redeemerHash?.toString(),
      });
    },
    async markSpent(scope, commitment) {
      const v = await get(k(scope, commitment));
      if (v) await set(k(scope, commitment), { ...v, spent: true });
    },
    async list(scope) {
      const all = await idbKeys();
      const prefix = `${PREFIX}note:${scope}:`;
      const out = [];
      for (const key of all) {
        if (typeof key === 'string' && key.startsWith(prefix)) {
          const v = await get(key);
          out.push({
            ...v,
            value: v.value !== undefined ? BigInt(v.value) : undefined,
            ownerPkHash: v.ownerPkHash !== undefined ? BigInt(v.ownerPkHash) : undefined,
            randomness: v.randomness !== undefined ? BigInt(v.randomness) : undefined,
            redeemerHash: v.redeemerHash !== undefined ? BigInt(v.redeemerHash) : undefined,
          });
        }
      }
      return out;
    },
    async clear(scope) {
      const all = await idbKeys();
      const prefix = `${PREFIX}note:${scope}:`;
      for (const key of all) {
        if (typeof key === 'string' && key.startsWith(prefix)) await del(key);
      }
    },
  };
}
