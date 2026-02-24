// Free post: size=1, position random adjacent. Paid post: user chooses size (2,3,4...),
// position still random adjacent; price is exponential in size (e.g. base^size).
#[starknet::interface]
pub trait IActions<T> {
    fn create_post(
        ref self: T,
        image_url: ByteArray,
        caption: ByteArray,
        creator_username: ByteArray,
        x_position: i32,
        y_position: i32,
        size: u8,
        is_paid: bool
    ) -> u64;
    
    fn set_post_price(
        ref self: T,
        post_id: u64,
        price: u128
    );
    
    fn buy_post(
        ref self: T,
        post_id: u64
    );
}

#[starknet::interface]
pub trait IERC20<T> {
    fn transfer_from(
        ref self: T,
        sender: starknet::ContractAddress,
        recipient: starknet::ContractAddress,
        amount: u256
    ) -> bool;
}

#[dojo::contract]
pub mod actions {
    use super::{IActions, IERC20Dispatcher, IERC20DispatcherTrait};
    use core::traits::TryInto;
    use starknet::{ContractAddress, get_block_timestamp, get_contract_address};
    use crate::models::{Post, PostCounter};
    use dojo::model::ModelStorage;

    const STRK_DECIMALS_FACTOR: u128 = 1000000000000000000;

    fn payment_token() -> ContractAddress {
        0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7.try_into().unwrap()
    }

    fn paid_post_price(size: u8) -> u128 {
        if size < 2 {
            return 0;
        }

        let mut price: u128 = 1;
        let mut i: u8 = 2;
        loop {
            if i >= size {
                break;
            }
            price *= 4;
            i += 1;
        };
        price
    }

    #[abi(embed_v0)]
    impl ActionsImpl of IActions<ContractState> {
        fn create_post(
            ref self: ContractState,
            image_url: ByteArray,
            caption: ByteArray,
            creator_username: ByteArray,
            x_position: i32,
            y_position: i32,
            size: u8,
            is_paid: bool
        ) -> u64 {
            let mut world = self.world_default();
            let caller = starknet::get_caller_address();

            // Validate size: free posts must be size 1, paid posts can be 2+
            if is_paid {
                if size < 2 {
                    panic(array![])
                }
            } else {
                if size != 1 {
                    panic(array![])
                }
            }

            if is_paid {
                let price_strk = paid_post_price(size);
                assert!(price_strk > 0, "Invalid paid post price");

                let amount_low: u128 = price_strk * STRK_DECIMALS_FACTOR;
                let token = IERC20Dispatcher { contract_address: payment_token() };
                let paid = token.transfer_from(
                    caller,
                    get_contract_address(),
                    u256 { low: amount_low, high: 0 },
                );
                assert!(paid, "Payment failed");
            }

            // Get and increment post counter
            let mut counter: PostCounter = world.read_model(0_u8);
            let post_id = counter.count + 1;
            counter.count = post_id;
            world.write_model(@counter);

            // Create the post
            let post = Post {
                id: post_id,
                image_url,
                caption,
                x_position,
                y_position,
                size,
                is_paid,
                created_at: get_block_timestamp(),
                created_by: caller,
                creator_username,
                current_owner: caller,
                sale_price: 0, // Not for sale initially
            };

            world.write_model(@post);

            post_id
        }
        
        fn set_post_price(
            ref self: ContractState,
            post_id: u64,
            price: u128
        ) {
            let mut world = self.world_default();
            let caller = starknet::get_caller_address();
            
            // Get the post
            let mut post: Post = world.read_model(post_id);
            
            // Verify caller is the current owner
            assert!(post.current_owner == caller, "Only owner can set price");
            
            // Set the price (0 means not for sale)
            post.sale_price = price;
            
            world.write_model(@post);
        }
        
        fn buy_post(
            ref self: ContractState,
            post_id: u64
        ) {
            let mut world = self.world_default();
            let caller = starknet::get_caller_address();
            
            // Get the post
            let mut post: Post = world.read_model(post_id);
            
            // Verify post is for sale
            assert!(post.sale_price > 0, "Post is not for sale");
            
            // Verify caller is not the owner
            assert!(post.current_owner != caller, "Cannot buy your own post");

            let seller = post.current_owner;
            let amount_low: u128 = post.sale_price * STRK_DECIMALS_FACTOR;
            let token = IERC20Dispatcher { contract_address: payment_token() };
            let paid = token.transfer_from(
                caller,
                seller,
                u256 { low: amount_low, high: 0 },
            );
            assert!(paid, "Payment failed");

            // Transfer ownership
            post.current_owner = caller;

            // Remove from sale
            post.sale_price = 0;

            world.write_model(@post);
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn world_default(self: @ContractState) -> dojo::world::WorldStorage {
            self.world(@"di")
        }
    }
}
