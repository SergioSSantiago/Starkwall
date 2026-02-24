#!/usr/bin/env bash
set -euo pipefail

echo "[torii] starting"
if [ -f /etc/os-release ]; then
  echo "[torii] os-release:"; cat /etc/os-release
fi

echo "[torii] glibc: $(getconf GNU_LIBC_VERSION 2>/dev/null || echo unknown)"


RPC_URL="${TORII_RPC_URL:-}"
if [ -z "$RPC_URL" ]; then
  echo "[torii] TORII_RPC_URL is not set"
  echo "[torii] refusing to start (Torii 1.7.x needs RPC spec v0.9)"
  exit 1
fi

echo "[torii] rpc: $RPC_URL"

exec /usr/local/bin/torii --config /app/torii.toml --rpc "$RPC_URL"
