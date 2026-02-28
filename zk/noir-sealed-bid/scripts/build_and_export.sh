#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v nargo >/dev/null 2>&1; then
  echo "nargo not found. Install noirup/nargo first."
  exit 1
fi

echo "Compiling Noir sealed bid circuit..."
nargo compile

echo "Generating witness from Prover.toml..."
nargo execute

echo "Done. Use generated artifacts to integrate Garaga verifier export."
#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> Compiling Noir circuit"
nargo compile

echo "==> Executing sample witness generation"
nargo execute

echo "==> Exporting verifier via Garaga (requires garaga CLI in PATH)"
echo "Run your environment-specific Garaga command here, for example:"
echo "garaga gen --noir-target \"$ROOT_DIR/target/sealed_bid_commitment.json\" --output ../../contracts/src/systems/sealed_bid_verifier.cairo"
