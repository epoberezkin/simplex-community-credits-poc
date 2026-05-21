#!/usr/bin/env bash
# Launch chopsticks fork of Paseo Asset Hub + eth-rpc bridge so the E2E
# harness can submit EVM transactions to the forked chain.
#
# Prereqs:
#   - npm i -g @acala-network/chopsticks
#   - the polkadot-sdk eth-rpc binary (cargo build --release -p eth-rpc) or
#     a downloaded binary (set ETH_RPC_BIN)
#
# Both processes log to ./chopsticks/{chopsticks,eth-rpc}.log. Kill with Ctrl+C.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"
cd "$ROOT"

CHOPSTICKS_PORT="${CHOPSTICKS_PORT:-8000}"
ETH_RPC_PORT="${ETH_RPC_PORT:-8545}"
ETH_RPC_BIN="${ETH_RPC_BIN:-eth-rpc}"
# CHAIN=paseo|polkadot — picks the YAML to fork. Default paseo for
# back-compat; polkadot is what fee-measurement runs use.
CHAIN="${CHAIN:-paseo}"
case "${CHAIN}" in
  paseo)    CFG="chopsticks/paseo-asset-hub.yml" ;;
  polkadot) CFG="chopsticks/polkadot-asset-hub.yml" ;;
  *)        echo "Unknown CHAIN=${CHAIN}; expected paseo|polkadot" >&2; exit 1 ;;
esac
echo "[chopsticks] using ${CFG}"

echo "[chopsticks] starting on ws://127.0.0.1:${CHOPSTICKS_PORT}"
npx @acala-network/chopsticks \
  --config "${CFG}" \
  --port "${CHOPSTICKS_PORT}" \
  > chopsticks/chopsticks.log 2>&1 &
CHOPSTICKS_PID=$!
trap "kill ${CHOPSTICKS_PID} 2>/dev/null || true" EXIT

# Wait for chopsticks to be ready (it prints "Listening" once the WS is up).
echo "[chopsticks] waiting for WS to come up…"
for i in $(seq 1 60); do
  if grep -qi "listening" chopsticks/chopsticks.log 2>/dev/null; then break; fi
  sleep 1
done
if ! grep -qi "listening" chopsticks/chopsticks.log 2>/dev/null; then
  echo "[chopsticks] failed to start; see chopsticks/chopsticks.log"
  exit 1
fi
echo "[chopsticks] up."

if ! command -v "${ETH_RPC_BIN}" >/dev/null 2>&1; then
  echo
  echo "[eth-rpc] '${ETH_RPC_BIN}' not in PATH. To finish the bridge:"
  echo "  cargo install --git https://github.com/paritytech/polkadot-sdk eth-rpc"
  echo "or set ETH_RPC_BIN=/path/to/eth-rpc and re-run."
  echo
  echo "[eth-rpc] skipping; chopsticks is still running on ws://127.0.0.1:${CHOPSTICKS_PORT}"
  wait
  exit 0
fi

echo "[eth-rpc] starting on http://127.0.0.1:${ETH_RPC_PORT}"
"${ETH_RPC_BIN}" \
  --node-rpc-url "ws://127.0.0.1:${CHOPSTICKS_PORT}" \
  --rpc-port "${ETH_RPC_PORT}" \
  --rpc-cors all \
  > chopsticks/eth-rpc.log 2>&1 &
ETH_RPC_PID=$!
trap "kill ${CHOPSTICKS_PID} ${ETH_RPC_PID} 2>/dev/null || true" EXIT

echo
echo "[ready] chopsticks ws://127.0.0.1:${CHOPSTICKS_PORT}"
echo "[ready] eth-rpc    http://127.0.0.1:${ETH_RPC_PORT}"
echo "[ready] export CHOPSTICKS_RPC_URL=http://127.0.0.1:${ETH_RPC_PORT}"
echo
echo "Press Ctrl+C to stop both."
wait
