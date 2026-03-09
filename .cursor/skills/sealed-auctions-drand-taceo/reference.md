# Reference: drand + Taceo Runbook

## 1) End-to-end target architecture

1. Bidder commits encrypted bid intent (`timelockCiphertextHash`, `drandRound`) with escrow.
2. After drand round unlock, relayer/worker receives decrypted payload (`bidAmount`, `salt`).
3. Relayer runs Noir + bb + Garaga and submits reveal verification onchain.
4. If mode is `drand_mpc`, MPC transcript and attestation roots are persisted and optionally anchored onchain.
5. Finalize and refund run as idempotent automation.

## 2) API payloads

### `/sealed/schedule` (timelock mode)

```json
{
  "slotPostId": 388,
  "groupId": 382,
  "bidder": "0x...",
  "protocolMode": "drand_mpc",
  "drandRound": 1234567,
  "timelockCiphertextHash": "0xabc...",
  "mpcSessionId": "session-01",
  "requireMpcAttestation": true,
  "revealAfterUnix": 1773000000,
  "finalizeAfterUnix": 1773000200
}
```

### `/sealed/timelock-payload`

```json
{
  "jobId": "job_...",
  "slotPostId": 388,
  "bidder": "0x...",
  "drandRound": 1234567,
  "bidAmount": 9,
  "salt": "0x123..."
}
```

### `/sealed/mpc-attestation`

```json
{
  "jobId": "job_...",
  "slotPostId": 388,
  "bidder": "0x...",
  "mpcTranscriptHash": "0x...",
  "mpcAttestationRoot": "0x...",
  "mpcSignerBitmapHash": "0x...",
  "submitOnchain": true
}
```

## 3) Failure handling policy

- `timelock_payload_pending`: keep job scheduled, no reveal attempt.
- `mpc_attestation_pending`: keep job scheduled for `drand_mpc`.
- `already_finalized`: terminal idempotent success signal.
- `reverify unavailable`: return explicit reason + debug steps.

## 4) Operational notes

- Browser tooling for drand encrypt/decrypt is immature; use backend workers.
- Keep decrypt and MPC worker logs separate from relayer transaction logs.
- Ensure RPC timeouts are bounded and retriable.
- Never block UI with long historical scans.

## 5) Taceo docs

- [Taceo Documentation](https://docs.taceo.io/)

Use docs to map:
- MPC session creation
- participant policy
- transcript export
- attestation object format

Then map exported attestation fields to:
- `mpcTranscriptHash`
- `mpcAttestationRoot`
- `mpcSignerBitmapHash`

