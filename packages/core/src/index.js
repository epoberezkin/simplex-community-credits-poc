// Public surface for `@community-credits/core` — DOM-free + Node-free.
// Anything Node-specific (proof.js with snarkjs+fs) is reached via subpath
// imports so browser bundlers don't pull node:fs / node:path into the bundle.

export { poseidon, poseidonHash, field } from './poseidon.js';
export {
  FIELD,
  randomFieldElement,
  deriveOwnerPkHash,
  generateKeypair,
  deriveCommitment,
  deriveNullifier,
} from './crypto.js';
export { redeemerHashFromId } from './identity.js';
export { IncrementalMerkleTree, DEFAULT_DEPTH } from './merkle.js';
export {
  encodeNote,
  decodeNote,
  encodeAssign,
  decodeAssign,
  encodeRedeem,
  decodeRedeem,
} from './note-codec.js';
export {
  buildImportLink,
  buildCommunityImportLink,
  buildAssignLink,
  buildRedeemLink,
  parseDeepLink,
} from './handoff.js';
export { discoverProviders, connectEvm } from './eip6963.js';
