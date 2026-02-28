fn main(
    slot_post_id: Field,
    group_id: Field,
    bidder: Field,
    bid_amount: Field,
    salt: Field,
    expected_commitment: pub Field,
) {
    let computed = slot_post_id + group_id + bidder + bid_amount + salt;
    assert(computed == expected_commitment);
    assert(bid_amount != 0);
}
fn main(
    slot_post_id: Field,
    group_id: Field,
    bidder: Field,
    bid_amount: Field,
    salt: Field,
    expected_commitment: pub Field,
) {
    // Keep circuit constraints aligned with onchain commitment relation.
    let computed = slot_post_id + group_id + bidder + bid_amount + salt;
    assert(computed == expected_commitment);
    assert(bid_amount != 0);
}
