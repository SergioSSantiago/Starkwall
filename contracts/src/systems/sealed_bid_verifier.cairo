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
        full_proof_with_hints: Span<felt252>
    ) -> bool;

    fn verify_winner_settlement(
        self: @T,
        slot_post_id: u64,
        group_id: u64,
        winner_bidder: starknet::ContractAddress,
        winning_bid: u128,
        clearing_price: u128,
        commit_root: felt252,
        full_proof_with_hints: Span<felt252>
    ) -> bool;
}

#[starknet::interface]
pub trait IUltraKeccakZKHonkVerifier<T> {
    fn verify_ultra_keccak_zk_honk_proof(
        self: @T, full_proof_with_hints: Span<felt252>,
    ) -> Result<Span<u256>, felt252>;
}

#[starknet::interface]
pub trait IOwner<T> {
    fn set_garaga_verifier(
        ref self: T,
        garaga_verifier: starknet::ContractAddress
    );
}

#[starknet::contract]
pub mod sealed_bid_verifier {
    use core::array::ArrayTrait;
    use core::poseidon::poseidon_hash_span;
    use core::traits::TryInto;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use super::{
        IOwner, ISealedBidVerifier, IUltraKeccakZKHonkVerifierDispatcher,
        IUltraKeccakZKHonkVerifierDispatcherTrait
    };

    #[storage]
    struct Storage {
        garaga_verifier: starknet::ContractAddress,
        owner: starknet::ContractAddress,
    }

    fn zero_address() -> starknet::ContractAddress {
        0.try_into().unwrap()
    }

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

    fn read_public_input_felt(public_inputs: Span<u256>, index: usize) -> felt252 {
        if index >= public_inputs.len() {
            return 0;
        }
        let item = *public_inputs.at(index);
        if item.high != 0 {
            return 0;
        }
        item.low.into()
    }

    #[constructor]
    fn constructor(ref self: ContractState, garaga_verifier: starknet::ContractAddress) {
        self.garaga_verifier.write(garaga_verifier);
        self.owner.write(starknet::get_caller_address());
    }

    #[abi(embed_v0)]
    impl OwnerImpl of IOwner<ContractState> {
        fn set_garaga_verifier(
            ref self: ContractState,
            garaga_verifier: starknet::ContractAddress
        ) {
            let caller = starknet::get_caller_address();
            assert!(caller == self.owner.read(), "Only owner");
            self.garaga_verifier.write(garaga_verifier);
        }
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
            full_proof_with_hints: Span<felt252>
        ) -> bool {
            let expected_commitment = compute_commitment(slot_post_id, group_id, bidder, bid_amount, salt);
            if expected_commitment != commitment {
                return false;
            }

            let garaga_verifier = self.garaga_verifier.read();
            if garaga_verifier == zero_address() {
                return false;
            }

            let verifier = IUltraKeccakZKHonkVerifierDispatcher { contract_address: garaga_verifier };
            let result = verifier.verify_ultra_keccak_zk_honk_proof(full_proof_with_hints);
            match result {
                Result::Ok(public_inputs) => {
                    if public_inputs.len() == 0 {
                        return false;
                    }
                    let first = *public_inputs.at(0);
                    if first.high != 0 {
                        return false;
                    }
                    let public_commitment: felt252 = first.low.into();
                    public_commitment == commitment
                },
                Result::Err(_) => false,
            }
        }

        fn verify_winner_settlement(
            self: @ContractState,
            slot_post_id: u64,
            group_id: u64,
            winner_bidder: starknet::ContractAddress,
            winning_bid: u128,
            clearing_price: u128,
            commit_root: felt252,
            full_proof_with_hints: Span<felt252>
        ) -> bool {
            if winning_bid == 0 || clearing_price == 0 || clearing_price > winning_bid {
                return false;
            }

            let garaga_verifier = self.garaga_verifier.read();
            if garaga_verifier == zero_address() {
                return false;
            }
            let verifier = IUltraKeccakZKHonkVerifierDispatcher { contract_address: garaga_verifier };
            let result = verifier.verify_ultra_keccak_zk_honk_proof(full_proof_with_hints);
            match result {
                Result::Ok(public_inputs) => {
                    // settlement circuit public inputs convention (sealed_tree_v1):
                    // [slot_post_id, group_id, winner_bidder, commit_root, ...]
                    if public_inputs.len() < 4 {
                        return false;
                    }
                    let pub_slot = read_public_input_felt(public_inputs, 0);
                    let pub_group = read_public_input_felt(public_inputs, 1);
                    let pub_winner = read_public_input_felt(public_inputs, 2);
                    let pub_root = read_public_input_felt(public_inputs, 3);
                    pub_slot == slot_post_id.into() &&
                    pub_group == group_id.into() &&
                    pub_winner == winner_bidder.into() &&
                    pub_root == commit_root
                },
                Result::Err(_) => false,
            }
        }
    }
}
