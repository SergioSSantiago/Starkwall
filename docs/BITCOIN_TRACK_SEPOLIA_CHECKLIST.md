# Bitcoin Track Sepolia Demo Checklist

This checklist is the operator runbook for the Starkwall Bitcoin track demo.

## Prerequisites

- Run frontend over HTTPS local dev (`https://localhost:5173`).
- Use a wallet with test balances in Sepolia (`STRK` and `ETH`, plus `WBTC` if available).
- Keep browser popups/cookies enabled for Cartridge Controller.

## Environment

In `client/.env.local`:

- `VITE_NETWORK=sepolia`
- `VITE_RPC_URL=https://api.cartridge.gg/x/starknet/sepolia`
- `VITE_TORII_URL=<your torii endpoint>`
- `VITE_STRK_TOKEN=0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d`
- `VITE_SWAP_WBTC_TOKEN=0x020d208b9e57a7f92bfa9f61135446e0961afc340378be97dbd317453c0950ae`

## Start App

From `client/`:

```bash
pnpm dev
```

Open:

- `https://localhost:5173`

## End-to-End Demo Flow

1. Connect wallet.
2. Open `Swap Tokens`, execute one valid route into BTC representation (`ETH -> WBTC` or `STRK -> WBTC`).
3. Confirm wallet panel updates balances and shows swap entry in `Bitcoin Track Evidence (Sepolia)`.
4. Click `Stake`, choose BTC strategy, stake a small amount.
5. Confirm `Staked/Rewards/Total` line updates and action appears in evidence panel.
6. Trigger `Claim`:
   - If rewards are zero: verify skip message is shown.
   - If rewards are positive: verify tx hash is shown and evidence records success.
7. Trigger `Unstake` twice:
   - First call should request exit intent.
   - Second call (after cooldown) should complete exit.
8. Confirm evidence panel shows:
   - BTC inflow via swaps
   - Starkzap success count
   - fallback success count
   - recent activity rows with timestamps/status/tx hash shorthand

## What To Capture For Judges

- Wallet panel with `Bitcoin Track Evidence (Sepolia)` visible.
- At least one tx hash per operation type:
  - swap
  - stake
  - claim or claim skip
  - unstake intent
  - unstake exit
- Console logs for action traces:
  - `[Swap] ...`
  - `[Stake] ...`
  - `[Claim] ...`
  - `[Unstake] ...`
  - `[Starkzap] ...`

## Expected Fallback Behavior

- If Controller init fails, user should see non-technical toast and action should continue via Dojo fallback when possible.
- Evidence panel should still record provider path (`starkzap`, `dojo`, `dojo-fallback`) so behavior is transparent.
