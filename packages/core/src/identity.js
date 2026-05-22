// Community identity → redeemerHash mapping.
// `communityId` is an arbitrary field element drawn by the community owner
// (e.g., hash of a SimpleX address). The note carries Poseidon(communityId)
// so on-chain redemption only requires preimage knowledge.

import { keccak256, toUtf8Bytes } from 'ethers';
import { poseidonHash } from './poseidon.js';
import { FIELD, deriveOwnerPkHash } from './crypto.js';

export async function redeemerHashFromId(communityId) {
  return poseidonHash([BigInt(communityId)]);
}

// Deterministic demo-community sk: lets both the assigner (purchaser→chat
// user-mode) and the admin (chat admin-mode) derive the *same* owner key
// from a known communityId, with no out-of-band coordination. Real
// communities would publish/agree on a pkHash some other way (their own
// onboarding); this exists purely so the demo can pre-configure.
export function demoCommunitySk(communityId) {
  const h = BigInt(keccak256(toUtf8Bytes(`demo-community-${communityId}-v1`)));
  return h % FIELD;
}
export async function demoCommunityPkHash(communityId) {
  return deriveOwnerPkHash(demoCommunitySk(communityId));
}
