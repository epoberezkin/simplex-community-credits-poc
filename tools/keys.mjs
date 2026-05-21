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
export const buyerWallet = deriveKey('buyer');
export const relayWallet = deriveKey('relay');

export const DEPLOYER_PRIVATE_KEY = deployerWallet.privateKey;
export const BUYER_PRIVATE_KEY = buyerWallet.privateKey;
export const RELAY_PRIVATE_KEY = relayWallet.privateKey;
