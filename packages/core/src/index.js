// Public surface for `@community-credits/core`.

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
export { proveCreate, proveAssign, proveRedeem, verify, formatProofForSolidity } from './proof.js';
