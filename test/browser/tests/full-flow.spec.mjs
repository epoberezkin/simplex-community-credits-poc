// 2x2x2 voucher flow across all three dapps, driven through the UI.
//
// Subjects:
//   userA, userB           — end users (buyer + chat-user roles)
//   commA (cid=1)          — community A (chat-admin role)
//   commB (cid=2)          — community B (chat-admin role)
//   relayA, relayB         — paymaster relays (relay-dapp role)
//
// Flow:
//   each user buys 1 voucher (100 tUSDC)
//   each user assigns 20 to commA + 30 to commB     → 4 assigns total
//   each community redeems 5 with relayA + 8 with relayB → 4 redeems total
//   relayA withdraws 10; relayB withdraws 16
//
// Browser contexts:
//   purchaserCtx   — one tab; switch demoKey between buys
//   userAChatCtx   — userA's chat IDB (imports userA's note, assigns ×2)
//   userBChatCtx   — userB's chat IDB
//   commAChatCtx   — commA admin (imports both dest notes, redeems ×2)
//   commBChatCtx   — commB admin
//   relayCtx       — one tab; switch demoKey between submits/withdraws

import { test, expect } from '@playwright/test';
import { ethers } from 'ethers';
import {
  buyerWalletA, buyerWalletB, relayWalletA, relayWalletB,
} from '../../../tools/keys.mjs';
import {
  readDeployManifest,
} from '../support/runtime.mjs';

const PURCHASER_URL = 'http://localhost:5173';
const CHAT_URL      = 'http://localhost:5174';
const RELAY_URL     = 'http://localhost:5175';
const BUY_VALUE     = 100n;
const TO_COMM_A     = 20n;
const TO_COMM_B     = 30n;
const RED_TO_RA     = 5n;
const RED_TO_RB     = 8n;
const COMM_A_ID     = '1';
const COMM_B_ID     = '2';

const POOL_ABI  = [
  'function credit(address) view returns (uint256)',
  'event Assigned(uint256 nullifier, uint32 expiryEpoch, uint256 cmDest, uint256 cmChange, uint32 destLeafIndex, uint32 changeLeafIndex)',
  'event Redeemed(uint256 nullifier, uint32 expiryEpoch, address operator, uint256 redeemValue, uint256 cmChange, uint32 changeLeafIndex)',
];
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

async function waitForEventCount(pool, eventName, expected, timeoutMs = 60_000) {
  const t0 = Date.now();
  for (;;) {
    const evs = await pool.queryFilter(eventName, 0, 'latest');
    if (evs.length >= expected) return;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`waited ${timeoutMs}ms for ${eventName} count ≥ ${expected}, got ${evs.length}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ---- per-page helpers ----

async function buyVoucher(page, buyerKey, value) {
  await page.goto(`${PURCHASER_URL}/?demoKey=${buyerKey}`);
  await expect(page.locator('#walletStatus.ok')).toBeVisible();
  await page.fill('#value', value.toString());
  await page.fill('#expiryEpoch', '9999');
  await page.click('#goBuy');
  await expect(page.locator('#result')).toBeVisible({ timeout: 120_000 });
  return page.locator('#chatLink').getAttribute('href');
}

async function chatAssign(page, importLinkOrNoteIndex, communityId, destValue) {
  if (typeof importLinkOrNoteIndex === 'string') {
    await page.goto(importLinkOrNoteIndex);
  }
  // Reset the result panel + link href so the post-click waits below are
  // real signals for THIS click, not stale signals from a previous
  // chatAssign in the same page (the dapp doesn't hide #assignResult
  // before each prove).
  await page.evaluate(() => {
    const r = document.getElementById('assignResult');
    if (r) r.hidden = true;
    const a = document.getElementById('assignLink');
    if (a) a.setAttribute('href', '');
  });
  // Pick the first not-yet-spent spendable note in the user's list.
  await expect(page.locator('#assignNote option')).not.toHaveCount(0);
  await page.selectOption('#assignNote', { index: 0 });
  await page.selectOption('#assignCommunity', communityId);
  await page.fill('#destValue', destValue.toString());
  await page.click('#proveAssignBtn');
  try {
    await expect(page.locator('#assignResult')).toBeVisible({ timeout: 120_000 });
    // Also wait for the link href to actually populate.
    await expect(page.locator('#assignLink')).toHaveAttribute('href', /assign=/, { timeout: 30_000 });
  } catch (e) {
    const status = await page.locator('#assignStatus').innerText();
    throw new Error(`assignStatus: ${JSON.stringify(status)}\n${e.message}`);
  }
  const assignLink = await page.locator('#assignLink').getAttribute('href');
  const cImport    = await page.locator('#communityImportLink').getAttribute('href');
  expect(assignLink).toContain('assign=');
  expect(cImport).toContain('community-import=');
  return { assignLink, cImport };
}

async function chatRedeem(page, operatorAddr, redeemValue) {
  // Reset signals — same reason as chatAssign.
  await page.evaluate(() => {
    const r = document.getElementById('redeemResult');
    if (r) r.hidden = true;
    const a = document.getElementById('redeemLink');
    if (a) a.setAttribute('href', '');
  });
  // Pick the first redeemable note for this admin scope.
  await expect(page.locator('#redeemNote option')).not.toHaveCount(0);
  await page.selectOption('#redeemNote', { index: 0 });
  await page.selectOption('#redeemOperator', operatorAddr);
  await page.fill('#redeemValue', redeemValue.toString());
  await page.click('#proveRedeemBtn');
  try {
    await expect(page.locator('#redeemResult')).toBeVisible({ timeout: 120_000 });
    await expect(page.locator('#redeemLink')).toHaveAttribute('href', /redeem=/, { timeout: 30_000 });
  } catch (e) {
    const status = await page.locator('#redeemStatus').innerText();
    throw new Error(`redeemStatus: ${JSON.stringify(status)}\n${e.message}`);
  }
  const link = await page.locator('#redeemLink').getAttribute('href');
  expect(link).toContain('redeem=');
  return link;
}

// Drive the relay dapp's submit button, but wait on the *on-chain* event
// count rather than the UI's "Queue empty" signal. Reason: the relay
// dapp uses `sendWithNonceRetry` to survive a nonce race between senders.
// That retry can occasionally re-broadcast a tx that already landed,
// surfacing as a `pool/nullifier` alert even though the chain has
// accepted the assign. The chain is the source of truth.
async function relaySubmit(page, deepLink, relayKey, kind, pool, expectedCount) {
  const param = new URL(deepLink).searchParams.get(kind);
  await page.goto(`${RELAY_URL}/?demoKey=${relayKey}&${kind}=${param}`);
  await expect(page.locator('#walletStatus.ok')).toBeVisible();
  await expect(page.locator('#queueList')).toContainText(
    kind === 'assign' ? 'assign nf=' : 'redeem v=', { timeout: 30_000 },
  );
  await page.locator('#queueList button:has-text("Submit")').click();
  await waitForEventCount(pool, kind === 'assign' ? 'Assigned' : 'Redeemed', expectedCount);
}

async function relayWithdraw(page, relayKey, expectedAmount) {
  await page.goto(`${RELAY_URL}/?demoKey=${relayKey}`);
  await expect(page.locator('#walletStatus.ok')).toBeVisible();
  await expect(page.locator('#creditBal')).toHaveText(expectedAmount.toString(), { timeout: 30_000 });
  await page.click('#withdrawBtn');
  await expect(page.locator('#withdrawStatus'))
    .toContainText(`Withdrew ${expectedAmount}`, { timeout: 120_000 });
  await expect(page.locator('#creditBal')).toHaveText('0');
}

// ---------------------------------------------------------------- the test --

test('2x2x2 voucher flow across all three dapps', async ({ browser }) => {
  const manifest = readDeployManifest();
  const provider = new ethers.JsonRpcProvider(manifest.ethRpcUrl);
  const pool   = new ethers.Contract(manifest.poolAddress, POOL_ABI, provider);
  const tUsdc  = new ethers.Contract(manifest.tUsdcAddress, ERC20_ABI, provider);

  const userAKey  = buyerWalletA.privateKey;
  const userBKey  = buyerWalletB.privateKey;
  const relayAKey = relayWalletA.privateKey;
  const relayBKey = relayWalletB.privateKey;
  const relayAAddr = relayWalletA.address;
  const relayBAddr = relayWalletB.address;

  const relayAUsdcBefore = await tUsdc.balanceOf(relayAAddr);
  const relayBUsdcBefore = await tUsdc.balanceOf(relayBAddr);

  // Baselines so we count *our* events, not whatever adversary tests left
  // on the same contracts when the full Playwright suite runs in sequence.
  const baseAssigned  = (await pool.queryFilter('Assigned', 0, 'latest')).length;
  const baseRedeemed  = (await pool.queryFilter('Redeemed', 0, 'latest')).length;
  const baseCreditA   = await pool.credit(relayAAddr);
  const baseCreditB   = await pool.credit(relayBAddr);

  // ----- one purchaser context, reused across both buys -----
  const purchaserCtx = await browser.newContext();
  const purchaserPage = await purchaserCtx.newPage();
  purchaserPage.on('pageerror', (e) => console.log(`[purchaser] pageerror ${e.message}`));

  const userAImport = await buyVoucher(purchaserPage, userAKey, BUY_VALUE);
  const userBImport = await buyVoucher(purchaserPage, userBKey, BUY_VALUE);
  expect(userAImport).toContain('import=');
  expect(userBImport).toContain('import=');

  // (no checkpoint step — notes are spendable as soon as the buy tx lands.)

  // ----- chat contexts: one per user; each does 2 assigns -----
  const userACtx = await browser.newContext();
  const userAPage = await userACtx.newPage();
  userAPage.on('pageerror', (e) => console.log(`[chat-userA] pageerror ${e.message}`));

  const userBCtx = await browser.newContext();
  const userBPage = await userBCtx.newPage();
  userBPage.on('pageerror', (e) => console.log(`[chat-userB] pageerror ${e.message}`));

  // userA: import buy note, assign 20 to commA
  await userAPage.goto(userAImport);
  await expect(userAPage.locator('#notesList')).toContainText(`${BUY_VALUE} tUSDC`);
  await expect(userAPage.locator('#notesList')).toContainText('spendable', { timeout: 30_000 });
  const userAToCommA = await chatAssign(userAPage, null, COMM_A_ID, TO_COMM_A);

  // userB: import buy note, assign 20 to commA
  await userBPage.goto(userBImport);
  await expect(userBPage.locator('#notesList')).toContainText(`${BUY_VALUE} tUSDC`);
  await expect(userBPage.locator('#notesList')).toContainText('spendable', { timeout: 30_000 });
  const userBToCommA = await chatAssign(userBPage, null, COMM_A_ID, TO_COMM_A);

  // ----- single relay context, reused; submit both assigns as relayA -----
  const relayCtx = await browser.newContext();
  const relayPage = await relayCtx.newPage();
  relayPage.on('pageerror', (e) => console.log(`[relay] pageerror ${e.message}`));
  // Always dismiss alert dialogs so the page stays interactive — the
  // relay dapp's send-retry can pop a spurious "Submit failed" alert
  // when the chain has actually accepted the tx (see relaySubmit).
  relayPage.on('dialog', async (d) => {
    console.log(`[relay] dialog: ${d.message()}`);
    await d.dismiss();
  });

  await relaySubmit(relayPage, userAToCommA.assignLink, relayAKey, 'assign', pool, baseAssigned + 1);
  await relaySubmit(relayPage, userBToCommA.assignLink, relayAKey, 'assign', pool, baseAssigned + 2);

  // Each user now has a 80-value change note. Assign 30 from it to commB.
  // Wait for the chat dapp's poll to surface the change note (~5 s).
  await expect(userAPage.locator('#notesList')).toContainText(`${BUY_VALUE - TO_COMM_A} tUSDC`, { timeout: 30_000 });
  const userAToCommB = await chatAssign(userAPage, null, COMM_B_ID, TO_COMM_B);
  await expect(userBPage.locator('#notesList')).toContainText(`${BUY_VALUE - TO_COMM_A} tUSDC`, { timeout: 30_000 });
  const userBToCommB = await chatAssign(userBPage, null, COMM_B_ID, TO_COMM_B);

  await relaySubmit(relayPage, userAToCommB.assignLink, relayAKey, 'assign', pool, baseAssigned + 3);
  await relaySubmit(relayPage, userBToCommB.assignLink, relayAKey, 'assign', pool, baseAssigned + 4);

  // ----- admin chat contexts: one per community, each redeems twice -----
  const commACtx  = await browser.newContext();
  const commAPage = await commACtx.newPage();
  commAPage.on('pageerror', (e) => console.log(`[chat-commA] pageerror ${e.message}`));

  const commBCtx  = await browser.newContext();
  const commBPage = await commBCtx.newPage();
  commBPage.on('pageerror', (e) => console.log(`[chat-commB] pageerror ${e.message}`));

  // commA admin: open BOTH community-import links so it sees both dest notes.
  await commAPage.goto(userAToCommA.cImport);
  await commAPage.click('#modeAdmin');
  await commAPage.goto(userBToCommA.cImport);
  await commAPage.click('#modeAdmin');
  // Wait until both dest notes are redeemable.
  await expect(commAPage.locator('#adminNotes')).toContainText('redeemable', { timeout: 30_000 });
  await expect(commAPage.locator('#redeemNote option')).toHaveCount(2);

  // commA redeem 1: 5 → relayA
  const commAToRA = await chatRedeem(commAPage, relayAAddr, RED_TO_RA);
  await relaySubmit(relayPage, commAToRA, relayAKey, 'redeem', pool, baseRedeemed + 1);

  // commA redeem 2: 8 → relayB
  // (After the first redeem, the spent source note disappears from the
  // dropdown; the change note becomes spendable once its tx lands.)
  await expect(commAPage.locator('#redeemNote option')).toHaveCount(1, { timeout: 30_000 });
  const commAToRB = await chatRedeem(commAPage, relayBAddr, RED_TO_RB);
  await relaySubmit(relayPage, commAToRB, relayBKey, 'redeem', pool, baseRedeemed + 2);

  // Same dance for commB.
  await commBPage.goto(userAToCommB.cImport);
  await commBPage.click('#modeAdmin');
  await commBPage.goto(userBToCommB.cImport);
  await commBPage.click('#modeAdmin');
  await expect(commBPage.locator('#adminNotes')).toContainText('redeemable', { timeout: 30_000 });
  await expect(commBPage.locator('#redeemNote option')).toHaveCount(2);

  const commBToRA = await chatRedeem(commBPage, relayAAddr, RED_TO_RA);
  await relaySubmit(relayPage, commBToRA, relayAKey, 'redeem', pool, baseRedeemed + 3);

  await expect(commBPage.locator('#redeemNote option')).toHaveCount(1, { timeout: 30_000 });
  const commBToRB = await chatRedeem(commBPage, relayBAddr, RED_TO_RB);
  await relaySubmit(relayPage, commBToRB, relayBKey, 'redeem', pool, baseRedeemed + 4);

  // ----- on-chain credit deltas before withdraw -----
  // The chat dapp parses user input (5, 8, etc.) through parseUsdc which
  // scales to 6-decimal raw units. Chain stores raw; UI shows human.
  // Compare deltas relative to baselines so adversary-suite state doesn't
  // skew the totals when the full suite runs.
  const SCALE = 1_000_000n;
  const expectedCreditA_human = RED_TO_RA * 2n;          // 10 (UI text)
  const expectedCreditB_human = RED_TO_RB * 2n;          // 16 (UI text)
  const expectedCreditA_raw   = expectedCreditA_human * SCALE; // chain
  const expectedCreditB_raw   = expectedCreditB_human * SCALE;
  expect((await pool.credit(relayAAddr)) - baseCreditA).toBe(expectedCreditA_raw);
  expect((await pool.credit(relayBAddr)) - baseCreditB).toBe(expectedCreditB_raw);

  // ----- relays withdraw -----
  // The dapp withdraws the *full* credit balance — baseline + delta.
  await relayWithdraw(relayPage, relayAKey, (baseCreditA + expectedCreditA_raw) / SCALE);
  await relayWithdraw(relayPage, relayBKey, (baseCreditB + expectedCreditB_raw) / SCALE);

  const relayAUsdcAfter = await tUsdc.balanceOf(relayAAddr);
  const relayBUsdcAfter = await tUsdc.balanceOf(relayBAddr);
  expect(relayAUsdcAfter - relayAUsdcBefore).toBe(baseCreditA + expectedCreditA_raw);
  expect(relayBUsdcAfter - relayBUsdcBefore).toBe(baseCreditB + expectedCreditB_raw);

  await purchaserCtx.close();
  await userACtx.close();
  await userBCtx.close();
  await commACtx.close();
  await commBCtx.close();
  await relayCtx.close();
});
