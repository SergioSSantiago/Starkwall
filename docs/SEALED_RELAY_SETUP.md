# Sealed Reveal Relayer Setup

This service automates the `reveal_bid` step for sealed auctions.

## 1) Configure env vars

Copy `sealed-relayer.env.example` values into your shell or `.env` runner:

- `SEALED_RELAY_ACTIONS_ADDRESS`: deployed `di-actions` contract address
- `SEALED_RELAY_ACCOUNT_ADDRESS`: relayer account address
- `SEALED_RELAY_PRIVATE_KEY`: relayer account private key
- `SEALED_RELAY_RPC_URL`: Sepolia RPC endpoint (optional override)

## 2) Run relayer

```bash
node sealed-relayer-server.js
```

Health endpoint:

```bash
curl http://127.0.0.1:3002/health
```

## 3) Point frontend to relay

In `client/.env.local`:

```bash
VITE_SEALED_RELAY_URL=http://127.0.0.1:3002
```

## 4) Behavior

- On **Commit Bid**, client schedules an auto-reveal job at `commit_end_time`.
- On **Reveal Bid** button, client requests immediate reveal via relayer.
- Relayer generates Noir proof + Garaga calldata and submits onchain `reveal_bid`.
