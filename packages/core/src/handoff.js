// Deep-link builders + parser. Format defined in plan §8.5.
import {
  encodeNote,
  decodeNote,
  encodeAssign,
  decodeAssign,
  encodeRedeem,
  decodeRedeem,
} from './note-codec.js';

export function buildImportLink(chatBaseUrl, note) {
  const u = new URL(chatBaseUrl);
  u.searchParams.set('import', encodeNote(note));
  return u.toString();
}

export function buildCommunityImportLink(chatBaseUrl, note, communityId) {
  const u = new URL(chatBaseUrl);
  // Drop sk before handing to the community — only the community owner can spend.
  const safe = { ...note };
  delete safe.sk;
  u.searchParams.set('community-import', encodeNote(safe));
  u.searchParams.set('community-id', String(communityId));
  return u.toString();
}

export function buildAssignLink(relayBaseUrl, bundle) {
  const u = new URL(relayBaseUrl);
  u.searchParams.set('assign', encodeAssign(bundle));
  return u.toString();
}

export function buildRedeemLink(relayBaseUrl, bundle) {
  const u = new URL(relayBaseUrl);
  u.searchParams.set('redeem', encodeRedeem(bundle));
  return u.toString();
}

// Parse any of the known query args; returns { kind, payload, ...extras }.
export function parseDeepLink(url) {
  const u = new URL(url);
  const imp = u.searchParams.get('import');
  if (imp) return { kind: 'import', note: decodeNote(imp) };
  const cimp = u.searchParams.get('community-import');
  if (cimp)
    return {
      kind: 'community-import',
      note: decodeNote(cimp),
      communityId: u.searchParams.get('community-id'),
    };
  const a = u.searchParams.get('assign');
  if (a) return { kind: 'assign', bundle: decodeAssign(a) };
  const r = u.searchParams.get('redeem');
  if (r) return { kind: 'redeem', bundle: decodeRedeem(r) };
  return null;
}
