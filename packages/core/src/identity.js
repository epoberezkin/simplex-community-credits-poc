// Community identity → redeemerHash mapping.
// `communityId` is an arbitrary field element drawn by the community owner
// (e.g., hash of a SimpleX address). The note carries Poseidon(communityId)
// so on-chain redemption only requires preimage knowledge.

import { poseidonHash } from './poseidon.js';

export async function redeemerHashFromId(communityId) {
  return poseidonHash([BigInt(communityId)]);
}
