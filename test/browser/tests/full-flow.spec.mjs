// Full happy-path E2E across the three dapps + chopsticks fork.
//   buy (purchaser, BUYER key)
//   → checkpoint
//   → import in chat (user mode), assign to community → produces relay link
//   → checkpoint
//   → admin imports community-import link in chat (admin mode)
//   → admin redeems → produces relay link
//   → checkpoint
//   → relay (RELAY key) submits both assign + redeem txs
//   → relay withdraws → on-chain credit & tUSDC balance asserted
//
// Pre-conditions established by global-setup.mjs:
//   - chopsticks fork of Polkadot Asset Hub + eth-rpc bridge are running
//   - tools/deploy.mjs has been executed (config.json in each dapp,
//     last-deploy.json with addresses)

import { test, expect } from '@playwright/test';
import { ethers } from 'ethers';
import { buyerWallet, relayWallet } from '../../../tools/keys.mjs';
import {
  readDeployManifest,
  runCheckpointer,
} from '../support/runtime.mjs';

const PURCHASER_URL = 'http://localhost:5173';
const CHAT_URL      = 'http://localhost:5174';
const RELAY_URL     = 'http://localhost:5175';
const VOUCHER_VALUE = 100n;
const COMMUNITY_ID  = '1';

const POOL_ABI = [
  'function credit(address) view returns (uint256)',
];
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
];

test('full voucher flow across all three dapps', async ({ browser }) => {
  const manifest = readDeployManifest();
  const provider = new ethers.JsonRpcProvider(manifest.ethRpcUrl);
  const pool = new ethers.Contract(manifest.poolAddress, POOL_ABI, provider);
  const tUsdc = new ethers.Contract(manifest.tUsdcAddress, ERC20_ABI, provider);

  const buyerKey = buyerWallet.privateKey;
  const relayKey = relayWallet.privateKey;
  const relayAddr = relayWallet.address;

  const relayCreditBefore = await pool.credit(relayAddr);
  const relayUsdcBefore = await tUsdc.balanceOf(relayAddr);

  // =====================================================================
  // 1) PURCHASER — buyAndCreate
  // =====================================================================
  const buyer = await browser.newContext();
  const buyerPage = await buyer.newPage();
  buyerPage.on('console', (m) => console.log(`[purchaser] ${m.type()} ${m.text()}`));
  buyerPage.on('pageerror', (e) => console.log(`[purchaser] pageerror ${e.message}`));

  await buyerPage.goto(`${PURCHASER_URL}/?demoKey=${buyerKey}`);
  await expect(buyerPage.locator('#walletStatus.ok')).toBeVisible();
  await buyerPage.fill('#value', VOUCHER_VALUE.toString());
  await buyerPage.fill('#expiryEpoch', '9999');
  await buyerPage.click('#goBuy');
  await expect(buyerPage.locator('#result')).toBeVisible({ timeout: 120_000 });
  const importLink = await buyerPage.locator('#chatLink').getAttribute('href');
  expect(importLink).toContain('import=');

  // =====================================================================
  // 2) CHECKPOINT — roll the buy cm into the tree
  // =====================================================================
  runCheckpointer({ target: 'hardhat' });

  // =====================================================================
  // 3) CHAT (USER) — import + assign
  // =====================================================================
  const userCtx = await browser.newContext();
  const userPage = await userCtx.newPage();
  userPage.on('console', (m) => console.log(`[chat-user] ${m.type()} ${m.text()}`));
  userPage.on('pageerror', (e) => console.log(`[chat-user] pageerror ${e.message}`));
  userPage.on('worker', (w) => {
    console.log(`[chat-user-worker] created ${w.url()}`);
    w.on('console', (m) => console.log(`[chat-user-worker] ${m.type()} ${m.text()}`));
    w.on('pageerror', (e) => console.log(`[chat-user-worker] pageerror ${e.message}`));
  });
  await userPage.goto(importLink);

  // Note should land in #notesList and become spendable (not "pending").
  await expect(userPage.locator('#notesList')).toContainText(`${VOUCHER_VALUE} tUSDC`);
  await expect(userPage.locator('#notesList')).not.toContainText('pending checkpoint');
  await expect(userPage.locator('#assignNote option')).toHaveCount(1);

  // Fill assign form. Explicit option selection because headless
  // Chromium doesn't reliably default-select dynamically added options.
  // Community + dest pkHash are now a single dropdown — the dapp derives
  // the pkHash from the cid via demoCommunityPkHash.
  await userPage.selectOption('#assignNote', { index: 0 });
  await userPage.selectOption('#assignCommunity', COMMUNITY_ID);
  await userPage.fill('#destValue', '60');                       // 60 dest / 40 change

  await userPage.click('#proveAssignBtn');
  try {
    await expect(userPage.locator('#assignResult')).toBeVisible({ timeout: 120_000 });
  } catch (e) {
    const status = await userPage.locator('#assignStatus').innerText();
    console.log(`[chat-user] assignStatus = ${JSON.stringify(status)}`);
    throw e;
  }

  const assignLink = await userPage.locator('#assignLink').getAttribute('href');
  const cImportLink = await userPage.locator('#communityImportLink').getAttribute('href');
  expect(assignLink).toContain('assign=');
  expect(cImportLink).toContain('community-import=');

  // =====================================================================
  // 4) RELAY — submit assign
  // =====================================================================
  const relayCtx = await browser.newContext();
  const relayPage = await relayCtx.newPage();
  relayPage.on('console', (m) => console.log(`[relay] ${m.type()} ${m.text()}`));
  relayPage.on('pageerror', (e) => console.log(`[relay] pageerror ${e.message}`));

  // Build a single URL: ?demoKey=…&assign=… (parseDeepLink ignores demoKey,
  // demoKeyFromUrl ignores assign).
  const assignParam = new URL(assignLink).searchParams.get('assign');
  await relayPage.goto(`${RELAY_URL}/?demoKey=${relayKey}&assign=${assignParam}`);
  await expect(relayPage.locator('#walletStatus.ok')).toBeVisible();
  await expect(relayPage.locator('#queueList')).toContainText('assign nf=', { timeout: 30_000 });
  await relayPage.locator('#queueList button:has-text("Submit")').click();
  await expect(relayPage.locator('#queueList')).toContainText('Queue empty', { timeout: 120_000 });

  // =====================================================================
  // 5) CHECKPOINT — roll cmDest + cmChange into the tree
  // =====================================================================
  runCheckpointer({ target: 'hardhat' });

  // =====================================================================
  // 6) CHAT (ADMIN) — import community link, then redeem
  // =====================================================================
  const adminCtx = await browser.newContext();
  const adminPage = await adminCtx.newPage();
  adminPage.on('console', (m) => console.log(`[chat-admin] ${m.type()} ${m.text()}`));
  adminPage.on('pageerror', (e) => console.log(`[chat-admin] pageerror ${e.message}`));

  // Admin's community sk is now derived from cid via demoCommunitySk, so
  // user and admin agree without any IDB seeding.
  await adminPage.goto(cImportLink);
  await adminPage.click('#modeAdmin');
  // Note row uses "60 tUSDC" (new format dropped the (#cid) suffix).
  // Wait until at least one row says "redeemable" (i.e. not pending).
  await expect(adminPage.locator('#adminNotes')).toContainText('redeemable', { timeout: 30_000 });
  await expect(adminPage.locator('#redeemNote option')).toHaveCount(1);

  // Operator dropdown is populated from cfg.demoOperators by the dapp.
  await adminPage.selectOption('#redeemOperator', { index: 0 });
  await adminPage.fill('#redeemValue', '60');

  await adminPage.click('#proveRedeemBtn');
  try {
    await expect(adminPage.locator('#redeemResult')).toBeVisible({ timeout: 120_000 });
  } catch (e) {
    const status = await adminPage.locator('#redeemStatus').innerText();
    console.log(`[chat-admin] redeemStatus = ${JSON.stringify(status)}`);
    throw e;
  }
  const redeemLink = await adminPage.locator('#redeemLink').getAttribute('href');
  expect(redeemLink).toContain('redeem=');

  // =====================================================================
  // 7) RELAY — submit redeem
  // =====================================================================
  const redeemParam = new URL(redeemLink).searchParams.get('redeem');
  await relayPage.goto(`${RELAY_URL}/?demoKey=${relayKey}&redeem=${redeemParam}`);
  await expect(relayPage.locator('#queueList')).toContainText('redeem v=60', { timeout: 30_000 });
  await relayPage.locator('#queueList button:has-text("Submit")').click();
  await expect(relayPage.locator('#queueList')).toContainText('Queue empty', { timeout: 120_000 });

  // Credit should now reflect the redeem.
  await expect(relayPage.locator('#creditBal')).toHaveText('60', { timeout: 30_000 });

  // =====================================================================
  // 8) RELAY — withdraw
  // =====================================================================
  await relayPage.click('#withdrawBtn');
  await expect(relayPage.locator('#withdrawStatus')).toContainText('Withdrew 60', { timeout: 120_000 });
  await expect(relayPage.locator('#creditBal')).toHaveText('0');

  // =====================================================================
  // On-chain assertions
  // =====================================================================
  const relayCreditAfter = await pool.credit(relayAddr);
  const relayUsdcAfter = await tUsdc.balanceOf(relayAddr);
  expect(relayCreditAfter - relayCreditBefore).toBe(0n);          // credit cleared by withdraw
  expect(relayUsdcAfter - relayUsdcBefore).toBe(60n);             // 60 tUSDC moved to relay

  // Cleanup contexts (Playwright closes the browser automatically).
  await buyer.close();
  await userCtx.close();
  await adminCtx.close();
  await relayCtx.close();
});
