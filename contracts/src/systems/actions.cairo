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

    fn create_auction_post_3x3(
        ref self: T,
        center_image_url: ByteArray,
        center_caption: ByteArray,
        creator_username: ByteArray,
        center_x_position: i32,
        center_y_position: i32,
        end_time: u64
    ) -> u64;

    fn place_bid(
        ref self: T,
        slot_post_id: u64,
        bid_amount: u128
    );

    fn finalize_auction_slot(
        ref self: T,
        slot_post_id: u64
    );

    fn set_won_slot_content(
        ref self: T,
        slot_post_id: u64,
        image_url: ByteArray,
        caption: ByteArray
    );

    fn set_profile(
        ref self: T,
        username: ByteArray,
        username_norm_hash: felt252
    );

    fn follow(
        ref self: T,
        following: starknet::ContractAddress
    );

    fn unfollow(
        ref self: T,
        following: starknet::ContractAddress
    );

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

    fn transfer(
        ref self: T,
        recipient: starknet::ContractAddress,
        amount: u256
    ) -> bool;
}

#[dojo::contract]
pub mod actions {
    use super::{IActions, IERC20Dispatcher, IERC20DispatcherTrait};
    use core::traits::TryInto;
    use starknet::{ContractAddress, get_block_timestamp, get_contract_address};
    use crate::models::{AuctionGroup, AuctionSlot, FollowRelation, FollowStats, Post, PostCounter, UserProfile, UsernameIndex};
    use dojo::model::ModelStorage;

    const STRK_DECIMALS_FACTOR: u128 = 1000000000000000000;
    const AUCTION_POST_CREATION_PRICE_STRK: u128 = 10;
    const POST_KIND_NORMAL: u8 = 0;
    const POST_KIND_AUCTION_CENTER: u8 = 1;
    const POST_KIND_AUCTION_SLOT: u8 = 2;
    const AUCTION_SLOT_COUNT: u8 = 8;

    // Keep aligned with frontend tile dimensions.
    const TILE_W: i32 = 393;
    const TILE_H: i32 = 852;

    fn payment_token() -> ContractAddress {
        let chain_id = starknet::get_tx_info().unbox().chain_id;

        // Use official STRK on Sepolia; keep local dev token for Katana.
        if chain_id == 'SN_SEPOLIA' {
            return 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d
                .try_into()
                .unwrap();
        }

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

    fn next_post_id(ref world: dojo::world::WorldStorage) -> u64 {
        let mut counter: PostCounter = world.read_model(0_u8);
        let post_id = counter.count + 1;
        counter.count = post_id;
        world.write_model(@counter);
        post_id
    }


    fn assert_region_free(
        ref world: dojo::world::WorldStorage,
        new_x: i32,
        new_y: i32,
        new_size: u8,
    ) {
        assert!(new_size > 0, "Invalid post size");

        let new_size_i32: i32 = new_size.try_into().unwrap();
        let new_right = new_x + (new_size_i32 * TILE_W);
        let new_bottom = new_y + (new_size_i32 * TILE_H);

        let counter: PostCounter = world.read_model(0_u8);
        let mut existing_id: u64 = 1;

        loop {
            if existing_id > counter.count {
                break;
            }

            let existing: Post = world.read_model(existing_id);
            let existing_size_i32: i32 = existing.size.try_into().unwrap();
            let existing_right = existing.x_position + (existing_size_i32 * TILE_W);
            let existing_bottom = existing.y_position + (existing_size_i32 * TILE_H);

            let overlaps_x = new_x < existing_right && new_right > existing.x_position;
            let overlaps_y = new_y < existing_bottom && new_bottom > existing.y_position;
            if overlaps_x && overlaps_y {
                assert!(false, "Post overlaps an occupied area");
            }

            existing_id += 1;
        };
    }

    fn zero_address() -> ContractAddress {
        0.try_into().unwrap()
    }

    fn read_follow_stats_or_default(
        ref world: dojo::world::WorldStorage,
        user: ContractAddress,
    ) -> FollowStats {
        let stats: FollowStats = world.read_model(user);
        if stats.user == zero_address() {
            return FollowStats { user, followers_count: 0, following_count: 0 };
        }
        stats
    }

    fn write_post(
        ref world: dojo::world::WorldStorage,
        id: u64,
        image_url: ByteArray,
        caption: ByteArray,
        x_position: i32,
        y_position: i32,
        size: u8,
        is_paid: bool,
        created_by: ContractAddress,
        initial_owner: ContractAddress,
        creator_username: ByteArray,
        post_kind: u8,
        auction_group_id: u64,
        auction_slot_index: u8,
    ) {
        let post = Post {
            id,
            image_url,
            caption,
            x_position,
            y_position,
            size,
            is_paid,
            created_at: get_block_timestamp(),
            created_by,
            creator_username,
            current_owner: initial_owner,
            sale_price: 0,
            post_kind,
            auction_group_id,
            auction_slot_index,
        };

        world.write_model(@post);
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

            assert!(x_position >= 0, "x_position must be non-negative");
            assert!(y_position >= 0, "y_position must be non-negative");
            assert_region_free(ref world, x_position, y_position, size);

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

            let post_id = next_post_id(ref world);

            write_post(
                ref world,
                post_id,
                image_url,
                caption,
                x_position,
                y_position,
                size,
                is_paid,
                caller,
                caller,
                creator_username,
                POST_KIND_NORMAL,
                0,
                0,
            );

            post_id
        }

        fn create_auction_post_3x3(
            ref self: ContractState,
            center_image_url: ByteArray,
            center_caption: ByteArray,
            creator_username: ByteArray,
            center_x_position: i32,
            center_y_position: i32,
            end_time: u64
        ) -> u64 {
            let mut world = self.world_default();
            let caller = starknet::get_caller_address();
            let now = get_block_timestamp();

            assert!(end_time > now, "Auction end time must be in the future");

            let auction_fee_low: u128 = AUCTION_POST_CREATION_PRICE_STRK * STRK_DECIMALS_FACTOR;
            let token = IERC20Dispatcher { contract_address: payment_token() };
            let fee_paid = token.transfer_from(
                caller,
                get_contract_address(),
                u256 { low: auction_fee_low, high: 0 },
            );
            assert!(fee_paid, "Auction creation payment failed");

            let auction_top_left_x = center_x_position - TILE_W;
            let auction_top_left_y = center_y_position - TILE_H;
            assert!(auction_top_left_x >= 0, "Auction 3x3 would exceed left boundary");
            assert!(auction_top_left_y >= 0, "Auction 3x3 would exceed top boundary");
            assert_region_free(ref world, auction_top_left_x, auction_top_left_y, 3);

            // 1) Create center tile (owner=creator)
            let center_post_id = next_post_id(ref world);
            write_post(
                ref world,
                center_post_id,
                center_image_url.clone(),
                center_caption.clone(),
                center_x_position,
                center_y_position,
                1,
                false,
                caller,
                caller,
                creator_username.clone(),
                POST_KIND_AUCTION_CENTER,
                center_post_id,
                0,
            );

            // 2) Create auction group
            let group = AuctionGroup {
                group_id: center_post_id,
                center_post_id,
                creator: caller,
                end_time,
                active: true,
            };
            world.write_model(@group);

            // 3) Create the 8 auction slot tiles around center
            let mut slot_idx: u8 = 1;
            let offsets = array![
                (center_x_position - TILE_W, center_y_position - TILE_H), // top-left
                (center_x_position, center_y_position - TILE_H),          // top
                (center_x_position + TILE_W, center_y_position - TILE_H), // top-right
                (center_x_position - TILE_W, center_y_position),          // left
                (center_x_position + TILE_W, center_y_position),          // right
                (center_x_position - TILE_W, center_y_position + TILE_H), // bottom-left
                (center_x_position, center_y_position + TILE_H),          // bottom
                (center_x_position + TILE_W, center_y_position + TILE_H), // bottom-right
            ];

            for (slot_x, slot_y) in offsets {
                let slot_post_id = next_post_id(ref world);

                // Empty placeholders; winner can update later through normal post ownership flow.
                write_post(
                    ref world,
                    slot_post_id,
                    creator_username.clone(),
                    creator_username.clone(),
                    slot_x,
                    slot_y,
                    1,
                    false,
                    caller,
                    get_contract_address(),
                    creator_username.clone(),
                    POST_KIND_AUCTION_SLOT,
                    center_post_id,
                    slot_idx,
                );

                let slot = AuctionSlot {
                    slot_post_id,
                    group_id: center_post_id,
                    highest_bid: 0,
                    highest_bidder: caller,
                    has_bid: false,
                    finalized: false,
                    content_initialized: false,
                };
                world.write_model(@slot);

                slot_idx += 1;
            }

            center_post_id
        }

        fn place_bid(
            ref self: ContractState,
            slot_post_id: u64,
            bid_amount: u128
        ) {
            let mut world = self.world_default();
            let bidder = starknet::get_caller_address();
            let now = get_block_timestamp();

            assert!(bid_amount > 0, "Bid must be > 0");

            let mut slot: AuctionSlot = world.read_model(slot_post_id);
            assert!(!slot.finalized, "Auction slot already finalized");

            let group: AuctionGroup = world.read_model(slot.group_id);
            assert!(group.active, "Auction group inactive");
            assert!(now < group.end_time, "Auction already ended");
            assert!(bid_amount > slot.highest_bid, "Bid must be higher than current highest");

            let post: Post = world.read_model(slot_post_id);
            assert!(post.post_kind == POST_KIND_AUCTION_SLOT, "Not an auction slot");
            assert!(post.current_owner != bidder, "Owner cannot bid on this slot");

            let token = IERC20Dispatcher { contract_address: payment_token() };

            // Pull new bidder funds into auction escrow (this contract)
            let new_amount_low: u128 = bid_amount * STRK_DECIMALS_FACTOR;
            let paid = token.transfer_from(
                bidder,
                get_contract_address(),
                u256 { low: new_amount_low, high: 0 },
            );
            assert!(paid, "Bid payment failed");

            // Refund previous highest bidder (if any)
            if slot.has_bid {
                let old_amount_low: u128 = slot.highest_bid * STRK_DECIMALS_FACTOR;
                let refunded = token.transfer(
                    slot.highest_bidder,
                    u256 { low: old_amount_low, high: 0 },
                );
                assert!(refunded, "Refund failed");
            }
            let updated_slot = AuctionSlot {
                slot_post_id: slot.slot_post_id,
                group_id: slot.group_id,
                highest_bid: bid_amount,
                highest_bidder: bidder,
                has_bid: true,
                finalized: slot.finalized,
                content_initialized: slot.content_initialized,
            };

            world.write_model(@updated_slot);
        }

        fn finalize_auction_slot(
            ref self: ContractState,
            slot_post_id: u64
        ) {
            let mut world = self.world_default();
            let now = get_block_timestamp();

            let mut slot: AuctionSlot = world.read_model(slot_post_id);
            assert!(!slot.finalized, "Auction slot already finalized");

            let group: AuctionGroup = world.read_model(slot.group_id);
            assert!(group.active, "Auction group inactive");
            assert!(now >= group.end_time, "Auction has not ended yet");

            let mut post: Post = world.read_model(slot_post_id);
            assert!(post.post_kind == POST_KIND_AUCTION_SLOT, "Not an auction slot");

            if slot.has_bid {
                // Release escrowed winning bid to auction creator.
                let amount_low: u128 = slot.highest_bid * STRK_DECIMALS_FACTOR;
                let token = IERC20Dispatcher { contract_address: payment_token() };
                let paid_out = token.transfer(
                    group.creator,
                    u256 { low: amount_low, high: 0 },
                );
                assert!(paid_out, "Creator payout failed");

                post.current_owner = slot.highest_bidder;
                post.sale_price = 0;
                world.write_model(@post);

                let finalized_slot = AuctionSlot {
                    slot_post_id: slot.slot_post_id,
                    group_id: slot.group_id,
                    highest_bid: slot.highest_bid,
                    highest_bidder: slot.highest_bidder,
                    has_bid: slot.has_bid,
                    finalized: true,
                    content_initialized: slot.content_initialized,
                };
                world.write_model(@finalized_slot);
            } else {
                // No bids: return slot to creator and list at symbolic 1 STRK.
                post.current_owner = group.creator;
                post.sale_price = 1;
                world.write_model(@post);

                let finalized_slot = AuctionSlot {
                    slot_post_id: slot.slot_post_id,
                    group_id: slot.group_id,
                    highest_bid: slot.highest_bid,
                    highest_bidder: slot.highest_bidder,
                    has_bid: slot.has_bid,
                    finalized: true,
                    content_initialized: false,
                };
                world.write_model(@finalized_slot);
            }
        }

        fn set_won_slot_content(
            ref self: ContractState,
            slot_post_id: u64,
            image_url: ByteArray,
            caption: ByteArray
        ) {
            let mut world = self.world_default();
            let caller = starknet::get_caller_address();

            let mut post: Post = world.read_model(slot_post_id);
            assert!(post.post_kind == POST_KIND_AUCTION_SLOT, "Not an auction slot");
            assert!(post.current_owner == caller, "Only owner can set slot content");

            let slot: AuctionSlot = world.read_model(slot_post_id);
            assert!(slot.finalized, "Auction slot not finalized");
            assert!(slot.content_initialized == false, "Slot content already initialized");

            let group: AuctionGroup = world.read_model(slot.group_id);
            if slot.has_bid == false {
                assert!(caller != group.creator, "Creator cannot initialize unsold slot");
            }

            post.image_url = image_url;
            post.caption = caption;
            world.write_model(@post);

            let updated_slot = AuctionSlot {
                slot_post_id: slot.slot_post_id,
                group_id: slot.group_id,
                highest_bid: slot.highest_bid,
                highest_bidder: slot.highest_bidder,
                has_bid: slot.has_bid,
                finalized: slot.finalized,
                content_initialized: true,
            };
            world.write_model(@updated_slot);
        }

        fn set_profile(
            ref self: ContractState,
            username: ByteArray,
            username_norm_hash: felt252
        ) {
            let mut world = self.world_default();
            let caller = starknet::get_caller_address();
            let zero = zero_address();

            let existing_profile: UserProfile = world.read_model(caller);
            if existing_profile.user != zero {
                let old_hash = existing_profile.username_norm_hash;
                if old_hash != username_norm_hash {
                    let old_index = UsernameIndex { username_norm_hash: old_hash, user: zero };
                    world.write_model(@old_index);
                }
            }

            let existing_index: UsernameIndex = world.read_model(username_norm_hash);
            assert!(
                existing_index.user == zero || existing_index.user == caller,
                "Username already taken"
            );

            let profile = UserProfile { user: caller, username, username_norm_hash };
            world.write_model(@profile);

            let index = UsernameIndex { username_norm_hash, user: caller };
            world.write_model(@index);
        }

        fn follow(
            ref self: ContractState,
            following: starknet::ContractAddress
        ) {
            let mut world = self.world_default();
            let follower = starknet::get_caller_address();
            assert!(follower != following, "Cannot follow yourself");

            let existing: FollowRelation = world.read_model((follower, following));
            assert!(existing.created_at == 0, "Already following");

            let relation = FollowRelation {
                follower,
                following,
                created_at: get_block_timestamp(),
            };
            world.write_model(@relation);

            let mut follower_stats = read_follow_stats_or_default(ref world, follower);
            follower_stats.following_count += 1;
            world.write_model(@follower_stats);

            let mut following_stats = read_follow_stats_or_default(ref world, following);
            following_stats.followers_count += 1;
            world.write_model(@following_stats);
        }

        fn unfollow(
            ref self: ContractState,
            following: starknet::ContractAddress
        ) {
            let mut world = self.world_default();
            let follower = starknet::get_caller_address();
            assert!(follower != following, "Cannot unfollow yourself");

            let existing: FollowRelation = world.read_model((follower, following));
            assert!(existing.created_at > 0, "Follow relation does not exist");

            let relation = FollowRelation { follower, following, created_at: 0 };
            world.write_model(@relation);

            let mut follower_stats = read_follow_stats_or_default(ref world, follower);
            if follower_stats.following_count > 0 {
                follower_stats.following_count -= 1;
            }
            world.write_model(@follower_stats);

            let mut following_stats = read_follow_stats_or_default(ref world, following);
            if following_stats.followers_count > 0 {
                following_stats.followers_count -= 1;
            }
            world.write_model(@following_stats);
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
            assert!(post.post_kind != POST_KIND_AUCTION_CENTER, "Auction center is not tradeable");

            // Auction slots become tradeable only after settlement.
            if post.post_kind == POST_KIND_AUCTION_SLOT {
                let slot_state: AuctionSlot = world.read_model(post.id);
                assert!(slot_state.finalized, "Auction slot not finalized");

                if slot_state.content_initialized == false {
                    assert!(false, "Uninitialized slot sale is fixed at 1 STRK");
                }
            }

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
            assert!(post.post_kind != POST_KIND_AUCTION_CENTER, "Auction center is not tradeable");

            // Auction slots become tradeable only after settlement.
            if post.post_kind == POST_KIND_AUCTION_SLOT {
                let slot_state: AuctionSlot = world.read_model(post.id);
                assert!(slot_state.finalized, "Auction slot not finalized");

                if slot_state.content_initialized == false {
                    assert!(post.sale_price == 1, "Winner must set slot content first");
                }
            }

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
