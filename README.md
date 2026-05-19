# simplex-community-credits-poc

Implementation of the Community Credits PoC V1.1 described in
[`community-credits-poc-plan.md`](./community-credits-poc-plan.md).

## Layout

```
circuits/        Circom sources, trusted-setup scripts, generated zkeys + verifiers
contracts/       Hardhat project: VoucherPool + Poseidon Merkle + verifiers
packages/
  core/          Shared ES module (poseidon, codec, handoff, proof, ethers, polkadot-api)
  purchaser/     Dapp A: EVM-signed buyAndCreate
  chat/          Dapp B: NO signer, proves assign + redeem, deep-link to relay
  relay/         Dapp C: EVM-signed assign/redeem/withdraw on behalf of chat users
test/e2e/        Node E2E harness using core
chopsticks/      YAML config to fork Paseo Asset Hub locally
```

## Quick start

```bash
pnpm install
pnpm --filter circuits run build       # compile circuits + ceremony + export verifiers
pnpm --filter contracts run build      # compile + hardhat tests
pnpm --filter test/e2e run test        # full flow on hardhat local
```

To run against a chopsticks-forked Paseo Asset Hub:

```bash
npx @acala-network/chopsticks --config chopsticks/paseo-asset-hub.yml &
pnpm --filter test/e2e run test:chopsticks
```
