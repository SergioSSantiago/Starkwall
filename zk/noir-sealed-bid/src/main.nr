use poseidon::poseidon::bn254;

fn main(
    slot_post_id: Field,
    group_id: Field,
    bidder: Field,
    bid_amount: Field,
    salt: Field,
) -> pub Field {
    let commitment = bn254::hash_5([
        slot_post_id,
        group_id,
        bidder,
        bid_amount,
        salt,
    ]);
    assert(bid_amount != 0);
    commitment
}
