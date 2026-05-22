#!/usr/bin/env node
// One-command demo orchestrator. Boots chopsticks (CHAIN=polkadot) +
// eth-rpc if not already running, deploys the contract suite, spawns
// the three Vite dev servers, prints the dapp URLs (with demoKey for
// purchaser+relay) and blocks until Ctrl+C.
//
// Reuses anything already running (chopsticks, dev servers) — running
// this twice is safe.

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';
import { ethers } from 'ethers';
import { buyerWallet, relayWallet, deployerWallet } from './keys.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const children = [];
// 'fatal' children (chain backend, dapp dev servers) bring down the demo
// if they die. 'optional' children (events subscriber) log + carry on.
// 'lineFilter(line)' lets a child suppress noisy stdout per-line.
function spawnChild(label, cmd, args, env = {}, { fatal = true, lineFilter = null } = {}) {
  const child = spawn(cmd, args, {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  const prefix = label === 'chopsticks' ? '' : `[${label}] `;
  function attach(stream, sink, filter) {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i + 1);
        buf = buf.slice(i + 1);
        if (filter && !filter(line)) continue;
        sink.write(prefix + line);
      }
    });
  }
  attach(child.stdout, process.stdout, lineFilter);
  attach(child.stderr, process.stderr, null);
  child.on('exit', (code, signal) => {
    if (stopping) return;
    if (fatal) {
      console.error(`\n[demo] ✘ child '${label}' exited unexpectedly (code=${code} signal=${signal}). Stopping.`);
      cleanup();
    } else {
      console.error(`[demo] ⚠ child '${label}' exited (code=${code} signal=${signal}). Continuing.`);
    }
  });
  children.push({ label, child });
  return child;
}

// Vite prints a ready banner + the local URL on startup, then a flood of
// (mostly harmless) Node-module-externalization warnings and HMR reconnect
// noise. Keep the ready banner; drop the rest.
function makeViteFilter() {
  return (line) => {
    if (line.includes('Module ') && line.includes(' has been externalized for browser compatibility')) return false;
    if (line.startsWith('[vite]')) return false;
    if (/\(client\)/.test(line)) return false;
    if (/^\s+(>|✔|VITE\s+v|➜)/.test(line)) return true;   // ready banner + URL
    if (/(^|\s)(error|warning|✘)/i.test(line)) return true;
    if (line.trim() === '') return false;
    return true;
  };
}

// Hardhat prints every JSON-RPC call (ANSI-coloured). Group lines into
// "blocks" (a header followed by indented detail lines) and keep only
// the interesting ones — txs / contract deployments / errors. Drop view
// eth_call blocks and bare bookkeeping lines.
function makeHardhatFilter() {
  let suppressBlock = false;
  // \x1b[...m sequences strip cleanly. After stripping, hardhat also
  // appends " (N)" for repeated calls, so we just look at the prefix.
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const DROP_PREFIXES = [
    'eth_chainId', 'eth_blockNumber', 'eth_getLogs',
    'eth_getBalance', 'eth_getTransactionCount', 'eth_gasPrice',
    'eth_maxPriorityFeePerGas', 'eth_estimateGas',
    'eth_getBlockByNumber', 'web3_clientVersion', 'net_version',
    'eth_getCode', 'eth_subscribe', 'eth_unsubscribe',
    'eth_feeHistory', 'eth_getTransactionByHash', 'eth_getTransactionReceipt',
    'hardhat_setBalance', 'hardhat_metadata', 'hardhat_mine',
  ];
  return (line) => {
    if (line.length > 0 && (line.startsWith(' ') || line.startsWith('\t'))) {
      return !suppressBlock;
    }
    if (line === '\n') {
      const out = !suppressBlock;
      suppressBlock = false;
      return out;
    }
    const bare = stripAnsi(line).trimEnd();
    // eth_call blocks are usually polled view calls; only sendRawTransaction /
    // sendTransaction blocks carry real txs.
    if (bare.startsWith('eth_call')) {
      suppressBlock = true;
      return false;
    }
    if (DROP_PREFIXES.some((p) => bare.startsWith(p))) {
      suppressBlock = true;
      return false;
    }
    suppressBlock = false;
    return true;
  };
}

let stopping = false;
function cleanup() {
  if (stopping) return;
  stopping = true;
  console.log('\n[demo] stopping children…');
  for (const { child } of children) {
    try { child.kill('SIGTERM'); } catch {}
  }
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

async function isTcpOpen(port) {
  // Try v4 + v6 in parallel. Vite binds only `::` by default; eth-rpc
  // sometimes binds `[::1]` only. Either way `localhost` resolves and
  // dial succeeds, so we use it directly rather than picking a family.
  return new Promise((res) => {
    const s = net.connect({ port, host: 'localhost' });
    s.once('connect', () => { s.destroy(); res(true); });
    s.once('error',   () => { s.destroy(); res(false); });
    setTimeout(() => { s.destroy(); res(false); }, 1000);
  });
}

async function waitTcp(port, msMax, label = `:${port}`) {
  const t0 = Date.now();
  while (Date.now() - t0 < msMax) {
    if (await isTcpOpen(port)) return;
    await sleep(1000);
  }
  throw new Error(`${label} did not open within ${msMax}ms`);
}

async function main() {
  // ---- 1. chain backend ----
  // Default: hardhat-local (fast, reliable, no substrate). The forked
  // Polkadot Asset Hub setup is opt-in via CHAIN=polkadot — it gives real
  // pallet-revive fees but the upstream WS is flaky and chopsticks 1.4
  // has runtime traps we've been fighting.
  const CHAIN = process.env.CHAIN ?? 'hardhat';
  let RPC_URL, RPC_PORT;
  if (CHAIN === 'hardhat') {
    RPC_PORT = 8546;
    RPC_URL = `http://localhost:${RPC_PORT}`;
    if (await isTcpOpen(RPC_PORT)) {
      console.log(`[demo] hardhat already up on :${RPC_PORT} — reusing.`);
    } else {
      console.log('[demo] starting hardhat node…');
      // Hardhat's stdout is dual-purpose: startup banner (20 funded
      // accounts + private keys) and JSON-RPC trace (one line per call,
      // multi-line block per tx). Both are redundant with what deploy.mjs
      // / checkpoint.mjs / events log. Drop everything from stdout by
      // default; errors still surface via stderr. HARDHAT_LOGS=1 to see
      // the full firehose.
      spawnChild('hardhat', 'pnpm', ['--filter', 'contracts', 'exec', 'hardhat', 'node', '--port', String(RPC_PORT)],
        {}, { lineFilter: process.env.HARDHAT_LOGS === '1' ? null : () => false });
      await waitTcp(RPC_PORT, 60_000, `hardhat :${RPC_PORT}`);
      // hardhat funds only its default-mnemonic accounts. Our PoC keys
      // (derived from public strings in tools/keys.mjs) start with 0 ETH;
      // top them up via hardhat_setBalance.
      const provider = new ethers.JsonRpcProvider(RPC_URL);
      for (const w of [deployerWallet, buyerWallet, relayWallet]) {
        await provider.send('hardhat_setBalance', [w.address, '0x21e19e0c9bab2400000']); // 10000 ETH
      }
      console.log(`[demo] hardhat up + PoC keys funded.`);
    }
  } else if (CHAIN === 'polkadot' || CHAIN === 'paseo') {
    RPC_PORT = 8545;
    RPC_URL = `http://localhost:${RPC_PORT}`;
    if (await isTcpOpen(RPC_PORT) && await isTcpOpen(8000)) {
      console.log('[demo] chopsticks + eth-rpc already running — reusing.');
    } else {
      console.log(`[demo] starting chopsticks + eth-rpc (CHAIN=${CHAIN})…`);
      spawnChild('chopsticks', 'bash', ['chopsticks/run.sh'], { CHAIN });
      await waitTcp(8000, 240_000, 'chopsticks WS :8000');
      await waitTcp(RPC_PORT, 60_000, `eth-rpc :${RPC_PORT}`);
      console.log('[demo] chopsticks + eth-rpc up.');
    }
  } else {
    throw new Error(`Unknown CHAIN=${CHAIN}; expected hardhat|polkadot|paseo`);
  }

  // ---- TCP heartbeat ----
  // Backend can become unresponsive without exiting. Poll the RPC port
  // every 5s; if it's closed for 2 consecutive checks, declare it dead.
  let downStrikes = 0;
  setInterval(async () => {
    if (stopping) return;
    const ok = await isTcpOpen(RPC_PORT);
    downStrikes = ok ? 0 : downStrikes + 1;
    if (downStrikes >= 2) {
      console.error(`\n[demo] ✘ RPC :${RPC_PORT} unresponsive. Stopping. (Try: rm -f ~/.local/share/eth-rpc/eth-rpc.db* and re-run.)`);
      cleanup();
    }
  }, 5_000);

  // ---- 2. event subscriber ----
  // On by default. Disable with DEMO_EVENTS=0 if it causes load issues
  // (only seen with chopsticks-polkadot in the past). EVENTS_POLL_MS
  // (default 6000) controls poll cadence.
  if (process.env.DEMO_EVENTS !== '0') {
    console.log('[demo] starting event subscriber…');
    spawnChild('events', 'node', ['tools/substrate-events.mjs'],
      { ETH_RPC_URL: RPC_URL }, { fatal: false });
    await sleep(800);
  }

  // ---- 3a. rebuild contracts ----
  // Belt + suspenders: ensures contracts/artifacts is in sync with the
  // current circuits/contracts/verifiers/*.sol. Without this a circuit
  // regen leaves the dapp emitting new-format proofs that the deployed
  // (stale) verifier rejects with "pool/proof". Hardhat caches when
  // sources are unchanged, so this is a no-op in the common case.
  console.log('[demo] hardhat compile (no-op if cached)…');
  await new Promise((res, rej) => {
    const c = spawn('pnpm', ['--filter', 'contracts', 'run', 'build'], {
      stdio: 'inherit', cwd: REPO_ROOT,
    });
    c.on('exit', (code) => code === 0 ? res() : rej(new Error(`contracts build exited ${code}`)));
    c.on('error', rej);
  });

  // ---- 3b. deploy ----
  console.log('[demo] deploying contracts…');
  const depEnv = { ETH_RPC_URL: RPC_URL };
  if (CHAIN === 'hardhat') depEnv.TX_GAS = '15000000'; // hardhat caps gas at ~30M
  await new Promise((res, rej) => {
    const dep = spawn('node', ['tools/deploy.mjs'], {
      stdio: 'inherit', cwd: REPO_ROOT, env: { ...process.env, ...depEnv },
    });
    dep.on('exit', (code) => code === 0 ? res() : rej(new Error(`deploy exited ${code}`)));
    dep.on('error', rej);
  });

  // ---- 4. checkpointer (watch mode) ----
  // Drains pending leaves into the checkpointed tree as txs come in so
  // the chat dapp never gets stuck on a "⏳ pending" note. Polls every
  // 4s — see tools/checkpoint.mjs.
  console.log('[demo] starting checkpoint watcher…');
  spawnChild('checkpoint', 'node', ['tools/checkpoint.mjs', '--watch'], {}, { fatal: false });

  // ---- 5. dev servers (Vite reuses if already up via its own port check) ----
  console.log('[demo] starting dapp dev servers…');
  const vf = makeViteFilter();
  if (!(await isTcpOpen(5173))) spawnChild('purchaser', 'pnpm', ['--filter', '@community-credits/purchaser', 'run', 'dev'], {}, { lineFilter: vf });
  if (!(await isTcpOpen(5174))) spawnChild('chat',      'pnpm', ['--filter', '@community-credits/chat',      'run', 'dev'], {}, { lineFilter: vf });
  if (!(await isTcpOpen(5175))) spawnChild('relay',     'pnpm', ['--filter', '@community-credits/relay',     'run', 'dev'], {}, { lineFilter: vf });
  await waitTcp(5173, 60_000, 'purchaser :5173');
  await waitTcp(5174, 60_000, 'chat :5174');
  await waitTcp(5175, 60_000, 'relay :5175');

  const bk = buyerWallet.privateKey;
  const rk = relayWallet.privateKey;
  console.log('\n================================================================');
  console.log(`  DEMO READY (CHAIN=${CHAIN}) — open these URLs:`);
  console.log('================================================================');
  console.log(`  Purchaser  http://localhost:5173/?demoKey=${bk}`);
  console.log(`  Chat       http://localhost:5174/`);
  console.log(`  Relay      http://localhost:5175/?demoKey=${rk}`);
  console.log('================================================================');
  console.log('  demoKey is in the URL — reload-safe, bookmarkable.');
  if (CHAIN === 'hardhat') {
    console.log('  For real pallet-revive fees, re-run with CHAIN=polkadot pnpm demo');
  }
  console.log(`  Live VoucherPool event feed: ${process.env.DEMO_EVENTS === '0' ? 'off' : 'on (DEMO_EVENTS=0 to disable)'}`);
  console.log('  Ctrl+C to stop everything.');
  console.log();

  await new Promise(() => {});  // block forever
}

main().catch((e) => { console.error('[demo] fatal:', e); cleanup(); });
