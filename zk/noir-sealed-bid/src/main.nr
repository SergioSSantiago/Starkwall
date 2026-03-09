use poseidon::poseidon::bn254;

fn main(
    slot_post_id: Field,
    group_id: Field,
    bidder: Field,
    bid_amount: Field,
    salt: Field,
) -> pub Field {
    assert(slot_post_id != 0);
    assert(group_id != 0);
    assert(bidder != 0);
    let commitment = bn254::hash_5([
        slot_post_id,
        group_id,
        bidder,
        bid_amount,
        salt,
    ]);
    assert(bid_amount != 0);
    assert(salt != 0);
    commitment
}
