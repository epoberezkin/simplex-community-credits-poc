// EIP-6963 multi-wallet discovery (https://eips.ethereum.org/EIPS/eip-6963)
// with a window.ethereum fallback for in-app browsers that haven't adopted
// 6963 yet (Nova mobile, SubWallet mobile as of writing).
//
// Returns providers with a `provider` (EIP-1193) + `info` ({name, icon, uuid, rdns}).

const providers = new Map(); // uuid → { info, provider }

function announce(detail) {
  if (!detail?.info?.uuid) return;
  providers.set(detail.info.uuid, detail);
}

if (typeof window !== 'undefined') {
  window.addEventListener('eip6963:announceProvider', (ev) => announce(ev.detail));
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

export function discoverProviders({ fallbackTimeoutMs = 150 } = {}) {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') return resolve([]);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    setTimeout(() => {
      if (providers.size === 0 && window.ethereum) {
        // Sniff the well-known fields so the picker can show something useful.
        const e = window.ethereum;
        const name = e.isMetaMask
          ? 'MetaMask'
          : e.isTalisman
            ? 'Talisman'
            : e.isSubWallet
              ? 'SubWallet'
              : e.isNovaWallet
                ? 'Nova Wallet'
                : 'Browser wallet';
        providers.set('fallback', {
          info: { uuid: 'fallback', name, icon: '', rdns: '' },
          provider: e,
        });
      }
      resolve([...providers.values()]);
    }, fallbackTimeoutMs);
  });
}

export async function connectEvm(eip1193, { chainIdHex } = {}) {
  const accounts = await eip1193.request({ method: 'eth_requestAccounts' });
  if (chainIdHex) {
    const cur = await eip1193.request({ method: 'eth_chainId' });
    if (cur.toLowerCase() !== chainIdHex.toLowerCase()) {
      try {
        await eip1193.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: chainIdHex }],
        });
      } catch (e) {
        // 4902 = chain not added. The dapp can add it via wallet_addEthereumChain
        // — caller decides which RPC URL + name to use.
        throw new Error(`wallet rejected chain switch: ${e.message}`);
      }
    }
  }
  return accounts[0];
}
