#[starknet::interface]
pub trait IActions<T> {
    fn create_post(
        ref self: T,
        image_url: ByteArray,
        caption: ByteArray,
        creator_username: ByteArray,
        x_position: i32,
        y_position: i32,
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

#[dojo::contract]
pub mod actions {
    use super::IActions;
    use crate::models::{Post, PostCounter};
    use dojo::model::ModelStorage;
    use starknet::get_block_timestamp;

    #[abi(embed_v0)]
    impl ActionsImpl of IActions<ContractState> {
        fn create_post(
            ref self: ContractState,
            image_url: ByteArray,
            caption: ByteArray,
            creator_username: ByteArray,
            x_position: i32,
            y_position: i32,
            is_paid: bool
        ) -> u64 {
            let mut world = self.world_default();
            let caller = starknet::get_caller_address();

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
                size: 1, // Always 1
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
            
            // TODO: In a real implementation, you would handle payment here
            // For now, we just transfer ownership
            
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
