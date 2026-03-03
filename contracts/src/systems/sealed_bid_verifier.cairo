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
    }
}
