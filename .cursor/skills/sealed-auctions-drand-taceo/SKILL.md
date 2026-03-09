---
name: sealed-auctions-drand-taceo
description: Designs and implements sealed auction flows using drand timelock encryption with Garaga and optional co-SNARK MPC attestations via Taceo. Use when working on sealed auction protocol redesign, removing manual reveal, integrating drand rounds, or adding Taceo MPC trust-minimized settlement.
---

# Sealed Auctions: drand + Taceo

Use this skill when implementing or debugging Starkwall sealed auctions in hybrid modes:

- `classic`: current commit/reveal/finalize.
- `drand`: timelock encryption with delayed decrypt payload.
- `drand_mpc`: drand + MPC attestation anchors.

## Goals

1. Eliminate bidder-return dependency for reveal.
2. Keep deterministic on-chain settlement and replayable verification.
3. Preserve backward compatibility with existing `classic` slots.

## Current Starkwall Hooks (must use)

- On-chain protocol models:
  - `AuctionSealProtocolCfg`
  - `AuctionTimelockCommit`
  - `AuctionMpcSettlement`
- On-chain systems:
  - `configure_auction_sealed_protocol(...)`
  - `commit_bid_timelock(...)`
  - `submit_mpc_settlement_attestation(...)`
- Relayer endpoints:
  - `POST /sealed/schedule`
  - `POST /sealed/timelock-payload`
  - `POST /sealed/mpc-attestation`
  - `POST /sealed/reverify-now`

## Implementation Workflow

Copy this checklist and update it while working:

```text
Hybrid sealed flow checklist
- [ ] Confirm group protocol mode in `AuctionSealProtocolCfg`
- [ ] For timelock modes, store ciphertext hash + drand round on commit
- [ ] Ingest decrypt payload (`bidAmount`, `salt`) via `/sealed/timelock-payload`
- [ ] Generate Noir witness + proof + Garaga calldata
- [ ] Submit reveal/finalize/refund sequence safely
- [ ] For `drand_mpc`, submit MPC attestation (off-chain + optional on-chain tx)
- [ ] Verify reverify endpoint returns deterministic outcome
```

## Required Protocol Rules

- Never mix classic and timelock commit paths for a given group.
- If mode is `drand_mpc`, do not reveal until MPC attestation requirement is satisfied.
- Keep trace persistence durable (`proofCalldata`, hashes, tx links).
- For historical slots, return explicit unavailable reason; do not hang.

## drand Integration Rules

- Commit phase stores only commitment + escrow + timelock anchors.
- Decrypt payload is accepted only after target round is reached.
- Decrypt step should be done in Python/Rust worker (Garaga-compatible tooling).
- Treat decrypt payload as sensitive until written into reveal job.

## Taceo Integration Rules

- Treat Taceo output as attestation metadata + transcript anchors.
- Persist:
  - `mpcTranscriptHash`
  - `mpcAttestationRoot`
  - `mpcSignerBitmapHash`
- If configured, submit `submit_mpc_settlement_attestation` before reveal/finalize.

## Validation Commands

Use these after changes:

```bash
cd contracts && sozo build
node --check sealed-relayer-server.js
cd client && npm run build
```

## Production Safety

- Keep `classic` as default unless user explicitly migrates groups.
- Do not remove existing relayer fallback/reverify behavior during migration.
- Prefer additive schema/endpoint changes over destructive rewrites.

## Additional Reference

- Detailed runbook: [reference.md](reference.md)
