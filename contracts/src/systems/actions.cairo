#[starknet::interface]
pub trait IActions<T> {
    fn create_post(
        ref self: T,
        image_url: ByteArray,
        caption: ByteArray,
        x_position: i32,
        y_position: i32,
        is_paid: bool
    ) -> u64;
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
                current_owner: caller,
            };

            world.write_model(@post);

            post_id
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn world_default(self: @ContractState) -> dojo::world::WorldStorage {
            self.world(@"di")
        }
    }
}
