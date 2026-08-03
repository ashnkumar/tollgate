#!/usr/bin/env bash
#
# Bring up the whole thing and open the browser walkthrough: chain -> deploy -> server.
#
# Unlike smoke.sh this stays running, because the point is to click through it. Ctrl-C
# stops everything it started.
#
#   ./scripts/walkthrough.sh                  # fake model, no API key needed
#   USE_FAKE_MODEL=false ./scripts/walkthrough.sh   # real Anthropic API
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
  echo
  echo "→ stopping"
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "$CHAIN_PID" ] && kill "$CHAIN_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

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
pnpm --filter @tollgate/web build >>"$LOG_DIR/build.log" 2>&1 || fail "web build failed"

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

URL="http://localhost:$SERVER_PORT"
if [ "$RPC_PORT" != "8545" ]; then
  # The page talks to the chain directly, so it needs to be told where a non-default one is.
  URL="$URL/?rpc=http://127.0.0.1:$RPC_PORT"
fi

echo
if [ "$USE_FAKE_MODEL" = "true" ]; then
  echo "  model:  fake (set USE_FAKE_MODEL=false with an ANTHROPIC_API_KEY for real calls)"
else
  echo "  model:  Anthropic API"
fi
echo "  open:   $URL"
echo
echo "  Ctrl-C to stop the chain and the server."
echo

if [ -z "${NO_OPEN:-}" ]; then
  if command -v open >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL"
  fi
fi

# Hold the terminal until the user stops it, or until something we started dies.
wait -n "$CHAIN_PID" "$SERVER_PID" 2>/dev/null || wait "$SERVER_PID" 2>/dev/null || true
fail "a process exited unexpectedly"
