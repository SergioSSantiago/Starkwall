#!/bin/bash
# Transfer STRK to your wallet
# Usage: ./transfer_strk.sh YOUR_WALLET_ADDRESS AMOUNT

STRK_CONTRACT="0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d"
TO_ADDRESS=$1
AMOUNT=$2

# Use Katana's first pre-funded account (you'll need to get this from Katana output)
# This is a typical Katana pre-funded account private key
FROM_PRIVATE_KEY="0x00c1cf1490de1352865301bb8705143f3ef938f97fdf892f1090dcb5ac7bcd1d"

echo "Transferring $AMOUNT STRK to $TO_ADDRESS..."
echo "Note: Make sure Katana is running!"

# You would use starkli or similar tool here
# Example:
# starkli invoke $STRK_CONTRACT transfer $TO_ADDRESS $AMOUNT 0 --private-key $FROM_PRIVATE_KEY

echo "Done!"
