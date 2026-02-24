#!/bin/bash
# Envía 1000 ETH (token de Katana) a una dirección.
# Uso: ./scripts/faucet.sh 0xTU_DIRECCION
# Requiere: starkli instalado, Katana en marcha

set -e
TO="$1"
if [ -z "$TO" ] || [[ ! "$TO" =~ ^0x[0-9a-fA-F]+$ ]]; then
  echo "Uso: $0 0xDIRECCION"
  echo "Ejemplo: $0 0x0123...abcd"
  exit 1
fi

ETH="0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7"
ACCOUNT="0x127fd5f1fe78a71f8bcd1fec63e3fe2f0486b6ecd5c86a0466c3a21fa5cfcec"
KEY="0xc5b2fcab997346f3ea1c00b002ecf6f382c5f9c9659a3894eb783c5320f912"
RPC="http://localhost:5050"

KEYFILE=$(mktemp)
trap "rm -f $KEYFILE" EXIT
echo "$KEY" | starkli signer keystore from-key "$KEYFILE"

echo "Enviando 1000 ETH a $TO..."
starkli invoke "$ETH" transfer "$TO" u256:1000000000000000000000 \
  --rpc "$RPC" \
  --account "$ACCOUNT" \
  --keystore "$KEYFILE"

echo "Listo."
