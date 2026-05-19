// snarkjs proof generation in a Web Worker so the main thread stays responsive.
// The dapp posts { kind: 'assign'|'redeem', input }. Worker replies
// { ok, proofFlat, publicSignals } or { err }.

import { proveAssignBrowser, proveRedeemBrowser } from '@community-credits/core/proof-browser';

self.onmessage = async (ev) => {
  const { id, kind, input, basePath } = ev.data;
  try {
    const fn = kind === 'assign' ? proveAssignBrowser : proveRedeemBrowser;
    const r = await fn(input, basePath || '/zk');
    // bigints don't serialize via structured clone in older browsers; stringify.
    self.postMessage({
      id, ok: true,
      proofFlat: r.proofFlat.map((x) => x.toString()),
      publicSignals: r.publicSignals.map((x) => x.toString()),
    });
  } catch (e) {
    self.postMessage({ id, ok: false, err: e.message || String(e) });
  }
};
