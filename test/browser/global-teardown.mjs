// Tear down what globalSetup created. If chopsticks/hardhat was already
// running before the test, leave it alone.

import { killChopsticks, killHardhat, loadState } from './support/runtime.mjs';

export default async function globalTeardown() {
  const s = loadState();
  if (s.chopsticks?.started && s.chopsticks?.pid) {
    console.log(`[browser-e2e] stopping chopsticks (pid ${s.chopsticks.pid})…`);
    await killChopsticks(s.chopsticks.pid);
  }
  if (s.hardhat?.started && s.hardhat?.pid) {
    console.log(`[browser-e2e] stopping hardhat (pid ${s.hardhat.pid})…`);
    await killHardhat(s.hardhat.pid);
  }
}
