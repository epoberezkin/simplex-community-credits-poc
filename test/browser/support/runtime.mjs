// Shared lifecycle helpers for the browser-e2e test:
//   - detect / boot chopsticks + eth-rpc
//   - persist "did we start it" state so teardown only kills what we started
//   - thin wrapper around tools/deploy.mjs + tools/checkpoint.mjs

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';
import { ethers } from 'ethers';
import { deployerWallet, buyerWallets, relayWallets } from '../../../tools/keys.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..', '..', '..');
export const STATE_DIR = resolve(__dirname, '..', '.runtime');
export const STATE_FILE = resolve(STATE_DIR, 'state.json');

export const CHOPSTICKS_WS_PORT = 8000;
export const ETH_RPC_PORT = 8545;
export const HARDHAT_PORT = 8546;

export function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
export function saveState(s) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

export async function isTcpOpen(port, host = '127.0.0.1') {
  return new Promise((res) => {
    const s = net.connect({ port, host });
    s.once('connect', () => { s.destroy(); res(true); });
    s.once('error', () => { s.destroy(); res(false); });
    setTimeout(() => { s.destroy(); res(false); }, 1000);
  });
}

async function waitForTcp(port, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await isTcpOpen(port)) return;
    await sleep(1000);
  }
  throw new Error(`port :${port} did not open within ${timeoutMs}ms`);
}

// Bring up a hardhat node on HARDHAT_PORT if nothing is listening yet.
// Used as the default chain backend for browser-e2e — fast (~5s) and
// reliable, at the cost of fee/runtime realism (no pallet-revive).
export async function ensureHardhat() {
  let started = false;
  let child = null;
  if (await isTcpOpen(HARDHAT_PORT)) {
    console.log(`[browser-e2e] hardhat already up on :${HARDHAT_PORT} — reusing`);
  } else {
    console.log(`[browser-e2e] starting hardhat node on :${HARDHAT_PORT}…`);
    child = spawn(
      'pnpm',
      ['--filter', 'contracts', 'exec', 'hardhat', 'node', '--port', String(HARDHAT_PORT)],
      {
        cwd: REPO_ROOT,
        env: process.env,
        stdio: ['ignore', 'inherit', 'inherit'],
        detached: false,
      },
    );
    child.unref();
    await waitForTcp(HARDHAT_PORT, 60_000);
    await sleep(500); // give RPC a moment after socket opens
    started = true;
  }
  // Fund the five PoC keys (deployer + 2 buyers + 2 relays). On a fresh
  // hardhat node only the default-mnemonic accounts are funded; our keys
  // are derived from PoC-unique seeds and have zero balance. Run on
  // every invocation so that an already-up hardhat from a previous,
  // 3-key version of this file also gets the new keys topped up.
  const provider = new ethers.JsonRpcProvider(`http://localhost:${HARDHAT_PORT}`);
  for (const w of [deployerWallet, ...buyerWallets, ...relayWallets]) {
    await provider.send('hardhat_setBalance', [w.address, '0x21e19e0c9bab2400000']); // 10000 ETH
  }
  console.log(`[browser-e2e] hardhat ${started ? 'up' : 'reused'} + PoC keys funded`);
  return { started, pid: child?.pid };
}

export async function killHardhat(pid) {
  if (!pid) return;
  try { process.kill(pid, 'SIGKILL'); } catch {}
  await sleep(500);
}

export async function ensureChopsticks({ chain = 'polkadot' } = {}) {
  const wsOpen = await isTcpOpen(CHOPSTICKS_WS_PORT);
  const rpcOpen = await isTcpOpen(ETH_RPC_PORT);
  if (wsOpen && rpcOpen) {
    console.log(`[browser-e2e] chopsticks + eth-rpc already up — reusing`);
    return { started: false };
  }
  if (wsOpen || rpcOpen) {
    throw new Error(
      `partial chopsticks state: ws=${wsOpen} rpc=${rpcOpen}. ` +
        `Stop whatever is on these ports and retry.`,
    );
  }

  // Clean dirty eth-rpc db (chain-mismatch trap) and stale logs.
  const dbGlob = resolve(homedir(), '.local/share/eth-rpc');
  if (existsSync(dbGlob)) {
    for (const f of ['eth-rpc.db', 'eth-rpc.db-shm', 'eth-rpc.db-wal']) {
      try { rmSync(resolve(dbGlob, f)); } catch {}
    }
  }
  for (const f of ['chopsticks.log', 'eth-rpc.log']) {
    try { rmSync(resolve(REPO_ROOT, 'chopsticks', f)); } catch {}
  }

  console.log(`[browser-e2e] starting chopsticks (CHAIN=${chain})…`);
  const child = spawn('bash', ['chopsticks/run.sh'], {
    cwd: REPO_ROOT,
    env: { ...process.env, CHAIN: chain },
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: false,
  });
  child.unref();
  // Wait up to 4 min — cold Polkadot Asset Hub fork is slow first time.
  await waitForTcp(CHOPSTICKS_WS_PORT, 240_000);
  await waitForTcp(ETH_RPC_PORT, 60_000);
  console.log(`[browser-e2e] chopsticks + eth-rpc up`);
  return { started: true, pid: child.pid };
}

export async function killChopsticks(pid) {
  if (!pid) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch { /* already dead */ }
  // run.sh's `trap` should propagate, but give it a chance.
  await sleep(2000);
}

export function runDeploy({ ethRpcUrl, target = 'hardhat' } = {}) {
  console.log(`[browser-e2e] running tools/deploy.mjs (RPC ${ethRpcUrl})…`);
  const env = { ...process.env, ETH_RPC_URL: ethRpcUrl };
  // pallet-revive needs a 100M PVM-weight cap; hardhat has a 30M EVM gas
  // cap. Let deploy.mjs use ethers's auto-estimate on hardhat.
  if (target === 'hardhat') env.TX_GAS = '15000000';
  execFileSync('node', ['tools/deploy.mjs'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env,
  });
}

export function runCheckpointer({ target = 'hardhat' } = {}) {
  const env = { ...process.env };
  if (target === 'hardhat') env.TX_GAS = '15000000';
  execFileSync('node', ['tools/checkpoint.mjs'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env,
  });
}

export function readDeployManifest() {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, 'tools/last-deploy.json'), 'utf8'));
}

// Pre-seed the chat dapp's IndexedDB with a known sk for a given community
// scope. Must be called AFTER `page.goto(chatBaseUrl)` so the IDB origin is
// localhost:5174. The chat dapp's `idb-keyval` uses db `keyval-store`,
// store `keyval`, keys `cc:sk:community-<cid>` and `cc:note:…`.
export async function seedCommunitySk(page, communityId, sk) {
  await page.evaluate(
    async ({ key, value }) => {
      await new Promise((resolve, reject) => {
        const req = indexedDB.open('keyval-store', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('keyval');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('keyval', 'readwrite');
          tx.objectStore('keyval').put(value, key);
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      });
    },
    { key: `cc:sk:community-${communityId}`, value: sk.toString() },
  );
}
