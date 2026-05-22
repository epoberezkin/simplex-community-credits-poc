// Shared deterministic-but-PoC-unique keys derived from
// keccak256("simplex-community-credits-poc-{role}-v1"). These map (via the
// pallet-revive h160||0xee*12 substrate-address scheme) to accounts the
// chopsticks/{paseo,polkadot}-asset-hub.yml prefund blocks fund with DOT
// and (for the buyer) tUSDC. They have no real history on either chain.

import { ethers } from 'ethers';

function deriveKey(role) {
  const pk = ethers.keccak256(ethers.toUtf8Bytes(`simplex-community-credits-poc-${role}-v1`));
  return new ethers.Wallet(pk);
}

export const deployerWallet = deriveKey('deployer');

// Two end users and two relays. A-side keeps the legacy role names
// (buyer-v1 / relay-v1) so the existing chopsticks-yaml prefund entries
// + adversary suite + checkpoint script stay valid without churn.
export const buyerWalletA = deriveKey('buyer');
export const buyerWalletB = deriveKey('buyer-b');
export const relayWalletA = deriveKey('relay');
export const relayWalletB = deriveKey('relay-b');

export const buyerWallets = [buyerWalletA, buyerWalletB];
export const relayWallets = [relayWalletA, relayWalletB];

// Legacy single-subject aliases.
export const buyerWallet = buyerWalletA;
export const relayWallet = relayWalletA;

export const DEPLOYER_PRIVATE_KEY = deployerWallet.privateKey;
export const BUYER_PRIVATE_KEY = buyerWalletA.privateKey;
export const RELAY_PRIVATE_KEY = relayWalletA.privateKey;
