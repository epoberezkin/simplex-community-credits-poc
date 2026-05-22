// Adversary scenarios. The happy path is covered by full-flow.spec.mjs;
// here we exercise expected failures so future regressions either to the
// circuit constraints or the contract reverts are caught.
//
// Layout: a single serial block that buys one voucher, then runs each
// attack as a sub-test on shared chain state. The dapp-level wipe on
// new `deployId` keeps stored notes consistent across the suite.

import { test, expect } from '@playwright/test';
import { ethers } from 'ethers';
import { buyerWallet, relayWallet } from '../../../tools/keys.mjs';
import { readDeployManifest, runCheckpointer } from '../support/runtime.mjs';

const PURCHASER = 'http://localhost:5173';
const CHAT      = 'http://localhost:5174';
const RELAY     = 'http://localhost:5175';
const CID       = '1';

const buyerKey = buyerWallet.privateKey;
const relayKey = relayWallet.privateKey;
const relayAddr = relayWallet.address;

test.describe.serial('adversary scenarios', () => {
  let importLink;
  let assignLinkOk;
  let cImportLinkOk;
  let manifest;

  test.beforeAll(async ({ browser }) => {
    manifest = readDeployManifest();
    // -------- happy-path setup: buy + (optional) assign --------
    const ctx = await browser.newContext();
    const buyerPage = await ctx.newPage();
    await buyerPage.goto(`${PURCHASER}/?demoKey=${buyerKey}`);
    await buyerPage.locator('#walletStatus.ok').waitFor({ timeout: 30_000 });
    await buyerPage.fill('#value', '100');
    await buyerPage.fill('#expiryEpoch', '9999');
    await buyerPage.click('#goBuy');
    await buyerPage.locator('#result').waitFor({ state: 'visible', timeout: 120_000 });
    importLink = await buyerPage.locator('#chatLink').getAttribute('href');
    runCheckpointer({ target: 'hardhat' });
    await ctx.close();
  });

  // ---------------------------------------------------------------------
  // 1) BUY (purchaser dapp) — request more tUSDC than buyer holds.
  //    Contract reverts at the ERC-20 transferFrom step ("pool/transferFrom").
  // ---------------------------------------------------------------------
  test('buy of more tUSDC than buyer holds reverts at transferFrom', async ({ browser }) => {
    const ctx = await browser.newContext();
    const buyerPage = await ctx.newPage();
    const logs = [];
    buyerPage.on('console', (m) => logs.push(m.text()));
    buyerPage.on('pageerror', (e) => logs.push('pageerror ' + e.message));
    await buyerPage.goto(`${PURCHASER}/?demoKey=${buyerKey}`);
    await buyerPage.locator('#walletStatus.ok').waitFor({ timeout: 30_000 });
    await buyerPage.fill('#value', '999999999999');     // way > 1M minted
    await buyerPage.fill('#expiryEpoch', '9999');
    await buyerPage.click('#goBuy');
    // The dapp's status renders the revert reason.
    await expect(buyerPage.locator('#buyStatus.err, #buyStatus span.err'))
      .toContainText(/pool|transfer|revert/i, { timeout: 60_000 });
    await ctx.close();
  });

  // ---------------------------------------------------------------------
  // 2) ASSIGN (chat user) — request destValue > note value.
  //    Circuit constraint Num2Bits(64) on changeValue rejects the witness.
  //    UI must show a humanized error instead of the raw circom assert.
  // ---------------------------------------------------------------------
  test('assign with destValue > note value is rejected at witness-gen', async ({ browser }) => {
    const ctx = await browser.newContext();
    const userPage = await ctx.newPage();
    userPage.on('console', (m) => console.log(`[chat-user] ${m.text()}`));
    await userPage.goto(importLink);
    // wait for spendable status
    await expect(userPage.locator('#notesList')).toContainText('✓ spendable', { timeout: 60_000 });

    await userPage.selectOption('#assignNote', { index: 0 });
    await userPage.selectOption('#assignCommunity', CID);
    await userPage.fill('#destValue', '999');  // > 100 (note value)
    // The pre-submit warning must be visible.
    await expect(userPage.locator('#assignStatus .err'))
      .toContainText(/exceeds the note's value/i, { timeout: 5_000 });

    // Click anyway — circuit rejects with a humanized error.
    await userPage.click('#proveAssignBtn');
    await expect(userPage.locator('#assignStatus .err'))
      .toContainText(/Circuit rejected the proof/i, { timeout: 120_000 });
    await ctx.close();
  });

  // ---------------------------------------------------------------------
  // 3) ASSIGN happy-path (sets up state for cases 4+5 below).
  //    Stored as module state so the redeem / double-spend tests reuse it.
  // ---------------------------------------------------------------------
  test('happy-path assign for downstream tests', async ({ browser }) => {
    const ctx = await browser.newContext();
    const userPage = await ctx.newPage();
    await userPage.goto(importLink);
    await expect(userPage.locator('#notesList')).toContainText('✓ spendable', { timeout: 60_000 });
    await userPage.selectOption('#assignNote', { index: 0 });
    await userPage.selectOption('#assignCommunity', CID);
    await userPage.fill('#destValue', '60');
    await userPage.click('#proveAssignBtn');
    await userPage.locator('#assignResult').waitFor({ state: 'visible', timeout: 120_000 });
    assignLinkOk = await userPage.locator('#assignLink').getAttribute('href');
    cImportLinkOk = await userPage.locator('#communityImportLink').getAttribute('href');
    await ctx.close();
  });

  // ---------------------------------------------------------------------
  // 4) RELAY (assign tx) — submit then re-submit the same assign URL.
  //    Second submission reverts with "pool/nullifier" (double-spend).
  // ---------------------------------------------------------------------
  test('relay double-submit of the same assign reverts on nullifier reuse', async ({ browser }) => {
    const ctx = await browser.newContext();
    const relayPage = await ctx.newPage();
    let alertText = null;
    relayPage.on('dialog', (d) => { alertText = d.message(); d.accept(); });

    const assignParam = new URL(assignLinkOk).searchParams.get('assign');
    // First submit (legitimate).
    await relayPage.goto(`${RELAY}/?demoKey=${relayKey}&assign=${assignParam}`);
    await relayPage.locator('#walletStatus.ok').waitFor({ timeout: 30_000 });
    await relayPage.locator('#queueList:has-text("assign nf=")').waitFor({ timeout: 30_000 });
    await relayPage.locator('#queueList button:has-text("Submit")').click();
    await relayPage.locator('#queueList:has-text("Queue empty")').waitFor({ timeout: 120_000 });

    // Second submit (replay attack).
    await relayPage.locator('#pasteUrl').fill(assignLinkOk);
    await relayPage.locator('#pasteBtn').click();
    await relayPage.locator('#queueList button:has-text("Submit")').click();
    // Wait for the alert text the dapp shows on revert.
    await expect.poll(() => alertText, { timeout: 60_000 })
      .toMatch(/nullifier|pool|revert/i);
    await ctx.close();
  });

  // ---------------------------------------------------------------------
  // 5) REDEEM (chat admin) — request redeemValue > note value.
  //    Circuit's new changeValue range check rejects the witness.
  // ---------------------------------------------------------------------
  test('redeem with redeemValue > note value is rejected at witness-gen', async ({ browser }) => {
    runCheckpointer({ target: 'hardhat' });  // ensure cmDest is checkpointed
    const ctx = await browser.newContext();
    const adminPage = await ctx.newPage();
    adminPage.on('console', (m) => console.log(`[chat-admin] ${m.text()}`));
    await adminPage.goto(cImportLinkOk);
    await adminPage.click('#modeAdmin');
    await expect(adminPage.locator('#adminNotes')).toContainText('redeemable', { timeout: 60_000 });
    await adminPage.selectOption('#redeemNote', { index: 0 });
    await adminPage.selectOption('#redeemOperator', { index: 0 });
    await adminPage.fill('#redeemValue', '999');  // > 60 (note value)
    await expect(adminPage.locator('#redeemStatus .err'))
      .toContainText(/exceeds the note's value/i, { timeout: 5_000 });
    await adminPage.click('#proveRedeemBtn');
    await expect(adminPage.locator('#redeemStatus .err'))
      .toContainText(/Circuit rejected the proof/i, { timeout: 120_000 });
    await ctx.close();
  });

  // ---------------------------------------------------------------------
  // 6) WITHDRAW (relay) — withdraw with zero credit.
  //    The dapp short-circuits and shows "Nothing to withdraw" — no tx.
  // ---------------------------------------------------------------------
  test('withdraw with zero credit shows "nothing" and does not tx', async ({ browser }) => {
    // Fresh wallet that has DOT (from demo bootstrap) but no operator credit.
    const provider = new ethers.JsonRpcProvider(manifest.ethRpcUrl);
    const fresh = ethers.Wallet.createRandom().connect(provider);
    // Fund with 1 ETH for gas — hardhat_setBalance.
    await provider.send('hardhat_setBalance', [fresh.address, '0xde0b6b3a7640000']);
    const ctx = await browser.newContext();
    const relayPage = await ctx.newPage();
    await relayPage.goto(`${RELAY}/?demoKey=${fresh.privateKey}`);
    await relayPage.locator('#walletStatus.ok').waitFor({ timeout: 30_000 });
    await relayPage.locator('#withdrawBtn').click();
    await expect(relayPage.locator('#withdrawStatus'))
      .toContainText(/Nothing to withdraw/i, { timeout: 10_000 });
    await ctx.close();
  });
});
