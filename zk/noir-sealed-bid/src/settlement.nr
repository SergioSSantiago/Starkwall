use poseidon::poseidon::bn254;

// sealed_tree_v1 settlement helper circuit skeleton.
// Public outputs are arranged to match on-chain verifier expectations:
// [slot_post_id, group_id, winner_bidder, commit_root, ...]
fn main(
    slot_post_id: Field,
    group_id: Field,
    winner_bidder: Field,
    winning_bid: Field,
    clearing_price: Field,
    commit_root: Field,
    winner_commit_index: Field,
) -> pub [Field; 4] {
    assert(winning_bid != 0);
    assert(clearing_price != 0);
    assert(clearing_price <= winning_bid);
    assert(commit_root != 0);

    // Placeholder consistency digest (to be extended with Merkle path checks).
    let _settlement_digest = bn254::hash_5([
        slot_post_id,
        group_id,
        winner_bidder,
        winner_commit_index,
        winning_bid,
    ]);

    [slot_post_id, group_id, winner_bidder, commit_root]
}
