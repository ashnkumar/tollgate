#!/usr/bin/env bash
#
# Full-stack smoke test: chain -> deploy -> server -> one metered call.
#
# Runs against the fake model by default, so it needs no API key and no network. This
# is the check that the pieces actually fit together; the unit suites cover the parts
# in isolation.
#
#   ./scripts/smoke.sh              # offline, fake model
#   USE_FAKE_MODEL=false ./scripts/smoke.sh   # real Anthropic API (needs ANTHROPIC_API_KEY)
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RPC_PORT="${RPC_PORT:-8545}"
SERVER_PORT="${SERVER_PORT:-4000}"
USE_FAKE_MODEL="${USE_FAKE_MODEL:-true}"
LOG_DIR="$(mktemp -d)"

CHAIN_PID=""
SERVER_PID=""

cleanup() {
  # The spawner owns its children: always reap them, even on failure.
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "$CHAIN_PID" ] && kill "$CHAIN_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT

fail() {
  echo "✗ $1" >&2
  echo "--- chain log ---" >&2; tail -20 "$LOG_DIR/chain.log" 2>/dev/null >&2 || true
  echo "--- server log ---" >&2; tail -20 "$LOG_DIR/server.log" 2>/dev/null >&2 || true
  exit 1
}

wait_for() {
  local what="$1" probe="$2" tries="${3:-60}"
  for _ in $(seq "$tries"); do
    if eval "$probe" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  fail "timed out waiting for $what"
}

if lsof -i ":$RPC_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "port $RPC_PORT is already in use — set RPC_PORT to something free"
fi
if lsof -i ":$SERVER_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "port $SERVER_PORT is already in use — set SERVER_PORT to something free"
fi

echo "→ building"
pnpm --filter @tollgate/contracts build >"$LOG_DIR/build.log" 2>&1 || fail "contract build failed"
pnpm --filter @tollgate/server build >>"$LOG_DIR/build.log" 2>&1 || fail "server build failed"

echo "→ starting chain on :$RPC_PORT"
pnpm --filter @tollgate/contracts exec hardhat node --port "$RPC_PORT" >"$LOG_DIR/chain.log" 2>&1 &
CHAIN_PID=$!
wait_for "chain" "curl -s -X POST -H 'Content-Type: application/json' \
  --data '{\"jsonrpc\":\"2.0\",\"method\":\"eth_chainId\",\"params\":[],\"id\":1}' \
  http://127.0.0.1:$RPC_PORT"

echo "→ deploying"
RPC_URL="http://127.0.0.1:$RPC_PORT" \
  pnpm --filter @tollgate/contracts exec hardhat run scripts/deploy.ts --network localhost \
  >"$LOG_DIR/deploy.log" 2>&1 || fail "deploy failed"
grep -q "Tollgate deployed" "$LOG_DIR/deploy.log" || fail "deploy produced no address"

echo "→ starting server on :$SERVER_PORT"
PORT="$SERVER_PORT" RPC_URL="http://127.0.0.1:$RPC_PORT" USE_FAKE_MODEL="$USE_FAKE_MODEL" \
  node packages/server/dist/index.js >"$LOG_DIR/server.log" 2>&1 &
SERVER_PID=$!
wait_for "server" "curl -sf http://127.0.0.1:$SERVER_PORT/health"

echo "→ running a metered call"
OUT="$LOG_DIR/demo.log"
SERVER_URL="http://127.0.0.1:$SERVER_PORT" RPC_URL="http://127.0.0.1:$RPC_PORT" \
  pnpm --filter @tollgate/demo start summarize >"$OUT" 2>&1 || { cat "$OUT" >&2; fail "demo failed"; }

# The assertions that matter: the server and the chain agreed on the price, the call
# settled, and the buyer was charged less than they escrowed.
grep -q "chain agrees" "$OUT"        || { cat "$OUT" >&2; fail "no on-chain quote check"; }
grep -q "✗ MISMATCH" "$OUT"          && { cat "$OUT" >&2; fail "server and chain disagreed on price"; }
grep -q "5. Settlement" "$OUT"       || { cat "$OUT" >&2; fail "call never settled"; }
grep -q "balance now 0.0" "$OUT"     || { cat "$OUT" >&2; fail "refund was not withdrawable"; }

ESCROWED=$(grep "escrowed  " "$OUT" | awk '{print $2}')
PAID=$(grep "actually paid" "$OUT" | awk '{print $3}')
REFUNDED=$(grep "refunded " "$OUT" | awk '{print $2}')
python3 - "$ESCROWED" "$PAID" "$REFUNDED" <<'PY' || fail "settlement arithmetic is wrong"
import sys
escrowed, paid, refunded = (float(x) for x in sys.argv[1:4])
assert paid < escrowed, f"paid {paid} should be below escrow {escrowed}"
assert abs((paid + refunded) - escrowed) < 1e-12, "paid + refunded should equal escrowed"
assert refunded > 0, "expected a refund"
PY

echo
sed -n '/5. Settlement/,/settled in/p' "$OUT"
echo
echo "✓ smoke passed (escrowed $ESCROWED, paid $PAID, refunded $REFUNDED)"
