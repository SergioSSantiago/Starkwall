#!/usr/bin/env bash
set -euo pipefail

PROFILE="${1:-sepolia}"
INTERVAL_SECONDS="${2:-30}"
MANIFEST_PATH="${DOJO_MANIFEST_PATH:-/Users/sss/Webs/Starkwall/contracts/Scarb.toml}"
QUEUE_USERS="${YIELD_QUEUE_USERS:-}"
RUN_ONCE="${YIELD_KEEPER_RUN_ONCE:-0}"
DEFAULT_QUEUE_FILE="${YIELD_QUEUE_FILE:-/Users/sss/Webs/Starkwall/.github/yield-queue-users.txt}"

if [[ -z "${QUEUE_USERS}" && -f "${DEFAULT_QUEUE_FILE}" ]]; then
  # Build comma-separated list from file (ignore comments/empty lines).
  QUEUE_USERS="$(awk 'NF && $1 !~ /^#/' "${DEFAULT_QUEUE_FILE}" | paste -sd, -)"
fi

run_iteration() {
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] yield_harvest"
  sozo --manifest-path "${MANIFEST_PATH}" -P "${PROFILE}" execute di-actions yield_harvest --wait || true
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] yield_rebalance"
  sozo --manifest-path "${MANIFEST_PATH}" -P "${PROFILE}" execute di-actions yield_rebalance --wait || true
  if [[ -n "${QUEUE_USERS}" ]]; then
    IFS=',' read -ra USERS <<< "${QUEUE_USERS}"
    for USER in "${USERS[@]}"; do
      USER_TRIMMED="$(echo "${USER}" | xargs)"
      if [[ -n "${USER_TRIMMED}" ]]; then
        echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] yield_process_exit_queue ${USER_TRIMMED}"
        sozo --manifest-path "${MANIFEST_PATH}" -P "${PROFILE}" execute di-actions yield_process_exit_queue "${USER_TRIMMED}" --wait || true
      fi
    done
  fi
}

echo "Starting yield keeper: profile=${PROFILE}, interval=${INTERVAL_SECONDS}s, run_once=${RUN_ONCE}"
if [[ "${RUN_ONCE}" == "1" ]]; then
  run_iteration
  exit 0
fi

while true; do
  run_iteration
  sleep "${INTERVAL_SECONDS}"
done
