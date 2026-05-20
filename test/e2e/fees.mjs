// Fee-measurement helper: queries substrate-side balance (free + reserved)
// for an EVM-mapped account before/after a tx, computes the inclusion fee
// and the storage_deposit lockup delta, and prints a per-tx line.
//
// Connects to chopsticks's substrate WS port (default 8000). The eth-rpc
// bridge is at 8545 for the eth side.
//
// On pallet-revive:
//   - tx caller's free balance decreases by (inclusion fee + storage_deposit_locked)
//   - tx caller's reserved balance increases by storage_deposit_locked
//   - Net: free.delta + reserved.delta = -inclusion_fee
//          reserved.delta = +storage_deposit_locked
//
// EVM address → substrate AccountId32 mapping: h160 || 0xee*12 (pallet-revive
// canonical mapping). See chopsticks/polkadot-asset-hub.yml prefund block
// for examples.

import { ApiPromise, WsProvider } from '@polkadot/api';

const DECIMALS = 10n; // DOT
const PLANCK_PER_DOT = 10n ** DECIMALS;

let _api = null;
export async function connectSubstrate(url = 'ws://127.0.0.1:8000') {
  if (_api) return _api;
  const ws = new WsProvider(url);
  _api = await ApiPromise.create({ provider: ws, noInitWarn: true });
  return _api;
}

export async function disconnectSubstrate() {
  if (_api) {
    await _api.disconnect();
    _api = null;
  }
}

export function evmToSubstrate(evmAddr) {
  // pallet-revive: AccountId32 = h160 || 0xee*12
  const hex = evmAddr.toLowerCase().replace(/^0x/, '');
  if (hex.length !== 40) throw new Error(`bad EVM addr ${evmAddr}`);
  return '0x' + hex + 'ee'.repeat(12);
}

export async function readBalance(evmAddr) {
  const api = await connectSubstrate();
  const subAddr = evmToSubstrate(evmAddr);
  const info = await api.query.system.account(subAddr);
  return {
    free: info.data.free.toBigInt(),
    reserved: info.data.reserved.toBigInt(),
    // Frozen = balance locked by pallet_balances::Hold or ::Freeze (vesting,
    // staking, governance). Not used by pallet-revive's storage_deposit
    // (which goes to `reserved`), but we read it anyway so the report can
    // confirm it doesn't change under our flow.
    frozen: info.data.frozen.toBigInt(),
    nonce: Number(info.nonce),
  };
}

// Wrap a tx-sending function so we measure fee + storage_deposit delta.
//   label    — short string for the report line
//   payer    — EVM address of the account paying gas
//   sendFn   — async fn that returns the ethers TransactionResponse (or wraps wait())
//
// Returns { fee, storageDeposit, total, txHash } in plancks.
const records = [];

// Returns the underlying TransactionReceipt (so the harness can access logs
// and status), and records a fee row as a side effect.
export async function measured(label, payer, sendFn) {
  const before = await readBalance(payer);
  const txResp = await sendFn();
  const receipt = txResp?.wait ? await txResp.wait() : await txResp;
  const after = await readBalance(payer);

  const freeDelta = before.free - after.free;             // positive = paid
  const reservedDelta = after.reserved - before.reserved; // positive = locked
  const frozenDelta = after.frozen - before.frozen;       // positive = newly frozen
  const fee = freeDelta - reservedDelta;                  // inclusion fee
  const storageDeposit = reservedDelta;
  const total = freeDelta;

  const rec = {
    label, payer,
    txHash: receipt?.hash ?? txResp?.hash ?? null,
    fee, storageDeposit, frozenDelta, total,
    gasUsed: receipt?.gasUsed ? BigInt(receipt.gasUsed) : null,
    gasPrice: receipt?.gasPrice ? BigInt(receipt.gasPrice) : null,
  };
  records.push(rec);
  printRow(rec);
  return receipt;
}

function fmt(plancks) {
  if (plancks === 0n) return '       0';
  const dot = Number(plancks) / Number(PLANCK_PER_DOT);
  return dot.toExponential(3);
}

// Polkadot Asset Hub blockspace constants (from polkadot-fellows runtime
// + pallet-revive config). Used to report per-tx blockspace fraction.
//   MAX_BLOCK_WEIGHT.ref_time = 0.5 s = 5×10¹¹ ps
//   NORMAL_DISPATCH_RATIO     = 75% (85% under async backing)
//   GasScale (eth-rpc)        = 80_000 ps / gas
//   ⇒ per-block normal gas budget = 0.5 s × 0.75 / 80_000 ps ≈ 4_687_500 gas
const PER_BLOCK_NORMAL_GAS = 4_687_500n;

function printRow(r) {
  let pctStr = '';
  if (r.gasUsed != null) {
    const pct = (Number(r.gasUsed) / Number(PER_BLOCK_NORMAL_GAS)) * 100;
    const txPerBlock = Math.floor(Number(PER_BLOCK_NORMAL_GAS) / Number(r.gasUsed));
    pctStr = `  block=${pct.toFixed(3)}%  fits/block=${txPerBlock}`;
  }
  process.stdout.write(
    `  fee[${r.label.padEnd(28)}] ` +
      `inclusion=${fmt(r.fee).padStart(11)} DOT  ` +
      `storage=${fmt(r.storageDeposit).padStart(11)} DOT  ` +
      `frozen=${fmt(r.frozenDelta).padStart(11)} DOT  ` +
      `total=${fmt(r.total).padStart(11)} DOT` +
      (r.gasUsed != null ? `  gas=${r.gasUsed}` : '') +
      pctStr +
      '\n',
  );
}

export function feeReport({ dotUsd = 1.30 } = {}) {
  if (records.length === 0) return;
  console.log('\n── Fee summary (chopsticks fork of Polkadot Asset Hub) ──');
  let totalFee = 0n;
  let totalStorage = 0n;
  let totalFrozen = 0n;
  let totalGas = 0n;
  for (const r of records) {
    totalFee += r.fee;
    totalStorage += r.storageDeposit;
    totalFrozen += r.frozenDelta;
    if (r.gasUsed != null) totalGas += r.gasUsed;
  }
  const totalDot = Number(totalFee + totalStorage) / Number(PLANCK_PER_DOT);
  const blockPct = (Number(totalGas) / Number(PER_BLOCK_NORMAL_GAS)) * 100;
  const flowsPerBlock = Math.floor(Number(PER_BLOCK_NORMAL_GAS) / Number(totalGas));

  console.log(
    `  TOTAL inclusion fees: ${fmt(totalFee)} DOT (${totalFee} plancks)`,
  );
  console.log(
    `  TOTAL storage locked: ${fmt(totalStorage)} DOT (${totalStorage} plancks)`,
  );
  console.log(
    `  TOTAL frozen delta:   ${fmt(totalFrozen)} DOT (${totalFrozen} plancks)`,
  );
  console.log(
    `  All-in:               ${fmt(totalFee + totalStorage)} DOT (${totalFee + totalStorage} plancks)`,
  );
  console.log(
    `  All-in @ DOT=$${dotUsd}: $${(totalDot * dotUsd).toFixed(4)}`,
  );
  console.log(
    `  Blockspace:           gas=${totalGas}  ` +
      `block-fraction=${blockPct.toFixed(2)}%  ` +
      `full-flows/block=${flowsPerBlock}`,
  );
  console.log(
    `  (Per-block normal gas budget = ${PER_BLOCK_NORMAL_GAS} ` +
      `= MAX_BLOCK_WEIGHT × NORMAL_DISPATCH_RATIO / GasScale.)`,
  );
}
