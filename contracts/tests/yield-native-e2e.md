# Yield native E2E checks

This checklist validates that yield no longer depends on synthetic APR accrual and runs through real adapter calls.

## Preconditions

- Katana running
- Torii running
- World migrated with latest contracts
- Strategy configured with a live adapter (`yield_configure_strategy`)

## Run

From repo root:

```bash
./scripts/yield-e2e.sh dev 1000000000000000000
```

## Expected behavior

- `yield_deposit` succeeds and user principal increases.
- `yield_claim` succeeds (may return 0 if adapter has no rewards yet).
- `yield_withdraw` either pays immediately or queues exit.
- `yield_process_exit_queue` pays queued principal when adapter can serve unstake.

## Verify in Torii/UI

- `YieldPosition.principal` reflects deposit/withdraw lifecycle.
- `YieldExitQueue.queued_principal` moves to 0 after processing.
- Wallet line in UI shows mode as variable yield.
