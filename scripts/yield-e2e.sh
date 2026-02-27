#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./scripts/yield-e2e.sh <world_profile> <amount_wei>
#
# Example:
#   ./scripts/yield-e2e.sh dev 1000000000000000000
#
# This script validates the native-yield user flow using sozo executes:
# 1) deposit
# 2) claim
# 3) withdraw
# 4) process exit queue

PROFILE="${1:-dev}"
AMOUNT_WEI="${2:-1000000000000000000}"
CONTRACTS_DIR="/Users/sss/Webs/Starkwall/contracts"
MANIFEST_JSON="${CONTRACTS_DIR}/manifest_${PROFILE}.json"
if [[ ! -f "${MANIFEST_JSON}" ]]; then
  MANIFEST_JSON="${CONTRACTS_DIR}/manifest_dev.json"
fi
ACTIONS_ADDRESS="$(jq -r '.contracts[] | select(.tag=="di-actions") | .address' "${MANIFEST_JSON}")"

echo "== Yield E2E (${PROFILE}) =="
echo "amount_wei=${AMOUNT_WEI}"
echo "actions=${ACTIONS_ADDRESS}"

echo "-> approve STRK for actions"
sozo --manifest-path "${CONTRACTS_DIR}/Scarb.toml" --profile "${PROFILE}" execute 0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7 approve "${ACTIONS_ADDRESS}" "${AMOUNT_WEI}" 0 --wait

echo "-> yield_deposit"
sozo --manifest-path "${CONTRACTS_DIR}/Scarb.toml" --profile "${PROFILE}" execute di-actions yield_deposit "${AMOUNT_WEI}" 0 --wait

echo "-> yield_claim"
sozo --manifest-path "${CONTRACTS_DIR}/Scarb.toml" --profile "${PROFILE}" execute di-actions yield_claim --wait || true

echo "-> yield_withdraw"
sozo --manifest-path "${CONTRACTS_DIR}/Scarb.toml" --profile "${PROFILE}" execute di-actions yield_withdraw "${AMOUNT_WEI}" --wait

CALLER="$(python3 - <<'PY'
from pathlib import Path
p=Path('/Users/sss/Webs/Starkwall/contracts/dojo_dev.toml')
addr='0x0'
for line in p.read_text().splitlines():
    s=line.strip()
    if s.startswith('account_address'):
        addr=s.split('=',1)[1].strip().strip('"')
        break
print(addr)
PY
)"
echo "-> yield_process_exit_queue for ${CALLER}"
sozo --manifest-path "${CONTRACTS_DIR}/Scarb.toml" --profile "${PROFILE}" execute di-actions yield_process_exit_queue "${CALLER}" --wait

echo "Yield E2E flow finished."
