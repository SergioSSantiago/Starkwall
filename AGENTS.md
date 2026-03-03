# AGENTS.md

Operational context for AI agents working on Starkwall.

## Mission

Ship stable, demo-ready Starknet product features with clear UX and reliable Sepolia behavior.

## Code Areas

- `client/`: Vite frontend, wallet UX, swap/staking interactions.
- `contracts/`: Dojo/Cairo world logic.
- `scripts/`: local ops helpers.

## Primary Runtime Services

- Cartridge Controller for wallet/session UX.
- Starknet Sepolia RPC for reads/writes.
- Dojo world (`di-actions`) for app-specific onchain logic.
- Torii indexer for query hydration.
- Starkzap for staking flows; AVNU for swap routing.
- Garaga for verifier generation and onchain proof verification workflows.

## Interaction Standards

- Prefer small, incremental changes with explicit user feedback.
- Do not run broad tests unless user asks; do run targeted build checks after major edits.
- Never hide chain limitations; communicate liquidity/cooldown constraints clearly.
- Avoid auto-generated content/actions that the user did not request.

## Product UX Bar

- No “frozen” interactions: always use busy states and completion/error messaging.
- Keep staking language simple: Stake, Unstake (2-step), Claim.
- Ensure wallet summary reflects real state (staked/rewards/total/unpooling/exit time when available).
