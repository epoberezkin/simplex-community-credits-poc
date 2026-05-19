// Node fallback store — in-memory only, used by the test harness.

export async function openStore() {
  const notes = new Map();
  const keys = new Map();
  return {
    async putKey(scope, sk) {
      keys.set(scope, sk);
    },
    async getKey(scope) {
      return keys.get(scope) || null;
    },
    async add(scope, note) {
      notes.set(`${scope}:${note.commitment}`, { ...note });
    },
    async markSpent(scope, commitment) {
      const k = `${scope}:${commitment}`;
      const v = notes.get(k);
      if (v) notes.set(k, { ...v, spent: true });
    },
    async list(scope) {
      const out = [];
      for (const [k, v] of notes) if (k.startsWith(`${scope}:`)) out.push(v);
      return out;
    },
    async clear(scope) {
      for (const k of [...notes.keys()]) if (k.startsWith(`${scope}:`)) notes.delete(k);
    },
  };
}
