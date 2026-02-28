# Noir Sealed Bid Circuit

This circuit validates the sealed bid commitment relation used by Starkwall:

`commitment = slot_post_id + group_id + bidder + bid_amount + salt`

Current status:
- Noir circuit implemented for commitment verification.
- Cairo verifier contract is a placeholder-compatible verifier interface.
- Garaga proof generation/export is expected to be wired in the next deployment step.

## Local usage

```bash
cd zk/noir-sealed-bid
./scripts/build_and_export.sh
```

The script compiles and executes the circuit with `Prover.toml` sample inputs.
# Noir sealed-bid circuit

This workspace contains the commitment circuit used by Starkwall sealed-bid auctions.

## What it proves

- `expected_commitment = slot_post_id + group_id + bidder + bid_amount + salt`
- `bid_amount > 0`

The relation intentionally mirrors the current onchain commitment function in
`contracts/src/systems/actions.cairo` and `contracts/src/systems/sealed_bid_verifier.cairo`.

## Commands

- `nargo compile`
- `nargo execute`
- `./scripts/build_and_export.sh`

## Notes

- Browser-side proving is handled in the web client flow.
- Garaga verifier generation is wired through the script placeholder and should be
  replaced with your exact Garaga CLI invocation in CI/release automation.
