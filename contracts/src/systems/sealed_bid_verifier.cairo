#[starknet::interface]
pub trait ISealedBidVerifier<T> {
    fn verify_sealed_bid(
        self: @T,
        slot_post_id: u64,
        group_id: u64,
        bidder: starknet::ContractAddress,
        bid_amount: u128,
        salt: felt252,
        commitment: felt252,
        proof_blob_hash: felt252
    ) -> bool;
}

#[starknet::contract]
pub mod sealed_bid_verifier {
    use core::array::ArrayTrait;
    use core::poseidon::poseidon_hash_span;
    use super::ISealedBidVerifier;

    #[storage]
    struct Storage {}

    fn compute_commitment(
        slot_post_id: u64,
        group_id: u64,
        bidder: starknet::ContractAddress,
        bid_amount: u128,
        salt: felt252
    ) -> felt252 {
        let mut inputs = array![];
        inputs.append(slot_post_id.into());
        inputs.append(group_id.into());
        inputs.append(bidder.into());
        inputs.append(bid_amount.into());
        inputs.append(salt);
        poseidon_hash_span(inputs.span())
    }

    #[abi(embed_v0)]
    impl SealedBidVerifierImpl of ISealedBidVerifier<ContractState> {
        fn verify_sealed_bid(
            self: @ContractState,
            slot_post_id: u64,
            group_id: u64,
            bidder: starknet::ContractAddress,
            bid_amount: u128,
            salt: felt252,
            commitment: felt252,
            proof_blob_hash: felt252
        ) -> bool {
            if proof_blob_hash == 0 {
                return false;
            }
            compute_commitment(slot_post_id, group_id, bidder, bid_amount, salt) == commitment
        }
    }
}
