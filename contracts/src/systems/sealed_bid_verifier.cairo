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
        salt + slot_post_id.into() + group_id.into() + bidder.into() + bid_amount.into()
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
