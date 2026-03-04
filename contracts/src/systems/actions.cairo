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

    fn create_auction_post_3x3_sealed(
        ref self: T,
        center_image_url: ByteArray,
        center_caption: ByteArray,
        creator_username: ByteArray,
        center_x_position: i32,
        center_y_position: i32,
        commit_end_time: u64,
        reveal_end_time: u64,
        verifier: starknet::ContractAddress
    ) -> u64;

    fn configure_auction_sealed(
        ref self: T,
        group_id: u64,
        commit_end_time: u64,
        reveal_end_time: u64,
        verifier: starknet::ContractAddress
    );

    fn sync_occupancy_index(ref self: T, max_posts: u32) -> (u64, u64);
    fn occupancy_sync_progress(self: @T) -> (u64, u64);

    fn place_bid(
        ref self: T,
        slot_post_id: u64,
        bid_amount: u128
    );

    fn commit_bid(
        ref self: T,
        slot_post_id: u64,
        commitment: felt252,
        escrow_amount: u128
    );

    fn reveal_bid(
        ref self: T,
        slot_post_id: u64,
        bidder: starknet::ContractAddress,
        bid_amount: u128,
        salt: felt252,
        full_proof_with_hints: Span<felt252>
    );

    fn claim_commit_refund(
        ref self: T,
        slot_post_id: u64,
        bidder: starknet::ContractAddress
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

    fn yield_deposit(
        ref self: T,
        amount: u128,
        use_btc_mode: bool
    );

    fn yield_withdraw(
        ref self: T,
        amount: u128
    );

    fn yield_claim(ref self: T) -> u128;

    fn yield_set_btc_mode(
        ref self: T,
        use_btc_mode: bool
    );

    fn yield_fund_earnings_pool(
        ref self: T,
        amount: u128
    );

    fn yield_configure_strategy(
        ref self: T,
        strategy_kind: u8,
        adapter: starknet::ContractAddress,
        staking_target: starknet::ContractAddress,
        rewards_target: starknet::ContractAddress,
        enabled: bool,
        paused: bool
    );

    fn yield_set_risk_params(
        ref self: T,
        target_buffer_bps: u32,
        max_exposure_bps: u32,
        rebalance_threshold: u128,
        protocol_fee_bps: u32
    );

    fn yield_rebalance(ref self: T);
    fn yield_harvest(ref self: T) -> u128;
    fn yield_process_exit_queue(ref self: T, user: starknet::ContractAddress) -> u128;
    fn yield_set_admin(ref self: T, admin: starknet::ContractAddress);
    fn yield_configure_strategy_for_pool(
        ref self: T,
        pool_id: u8,
        strategy_kind: u8,
        adapter: starknet::ContractAddress,
        staking_target: starknet::ContractAddress,
        rewards_target: starknet::ContractAddress,
        enabled: bool,
        paused: bool
    );
    fn yield_set_risk_params_for_pool(
        ref self: T,
        pool_id: u8,
        target_buffer_bps: u32,
        max_exposure_bps: u32,
        rebalance_threshold: u128,
        protocol_fee_bps: u32
    );
    fn yield_rebalance_pool(ref self: T, pool_id: u8);
    fn yield_harvest_pool(ref self: T, pool_id: u8) -> u128;
    fn yield_get_user_state(
        self: @T,
        user: starknet::ContractAddress
    ) -> (u128, u128, u128, bool, u8, u128, u128, u32);
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

    fn balance_of(
        self: @T,
        account: starknet::ContractAddress
    ) -> u256;

    fn allowance(
        self: @T,
        owner: starknet::ContractAddress,
        spender: starknet::ContractAddress
    ) -> u256;
}

#[starknet::interface]
pub trait IStakingAdapter<T> {
    fn stake(ref self: T, amount: u128) -> bool;
    fn request_unstake(ref self: T, amount: u128) -> bool;
    fn claim_rewards(ref self: T) -> u128;
    fn staked_balance(self: @T) -> u128;
    fn pending_unstake(self: @T) -> u128;
}

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

#[dojo::contract]
pub mod actions {
    use super::{
        IActions, IERC20Dispatcher, IERC20DispatcherTrait, IStakingAdapterDispatcher,
        IStakingAdapterDispatcherTrait, ISealedBidVerifierDispatcher,
        ISealedBidVerifierDispatcherTrait
    };
    use core::array::ArrayTrait;
    use core::poseidon::poseidon_hash_span;
    use core::traits::TryInto;
    use starknet::{ContractAddress, get_block_timestamp, get_contract_address};
    use crate::models::{
        AuctionCommit, AuctionGroup, AuctionRevealNullifier, AuctionSealedConfig, AuctionSlot,
        AuctionSlotPricing, OccupancySyncState, OccupiedCell,
        FollowRelation, FollowStats, Post, PostCounter, UserProfile, UsernameIndex, YieldAdminState,
        YieldExitQueue, YieldPoolState, YieldPosition, YieldRiskState, YieldStrategyState
    };
    use dojo::model::ModelStorage;

    const STRK_DECIMALS_FACTOR: u128 = 1000000000000000000;
    const AUCTION_POST_CREATION_PRICE_STRK: u128 = 10;
    const POST_KIND_NORMAL: u8 = 0;
    const POST_KIND_AUCTION_CENTER: u8 = 1;
    const POST_KIND_AUCTION_SLOT: u8 = 2;
    const AUCTION_SLOT_COUNT: u8 = 8;
    const YIELD_POOL_STRK_ID: u8 = 0;
    const YIELD_POOL_BTC_ID: u8 = 1;
    const YIELD_DEFAULT_TARGET_BUFFER_BPS: u32 = 3000; // 30%
    const YIELD_DEFAULT_MAX_EXPOSURE_BPS: u32 = 7000; // 70%
    const YIELD_DEFAULT_REBALANCE_THRESHOLD: u128 = 1_000_000_000_000_000_000; // 1 STRK
    const YIELD_DEFAULT_PROTOCOL_FEE_BPS: u32 = 1000; // 10%
    const YIELD_DEFAULT_USER_SHARE_BPS: u32 = 2500; // 25%
    const REWARD_INDEX_SCALE: u128 = 1_000_000_000_000_000_000; // 1e18
    const OCCUPANCY_SYNC_STATE_ID: u8 = 0;

    // Keep aligned with frontend tile dimensions.
    const TILE_W: i32 = 393;
    const TILE_H: i32 = 852;

    fn assert_supported_pool(pool_id: u8) {
        assert!(pool_id == YIELD_POOL_STRK_ID || pool_id == YIELD_POOL_BTC_ID, "Unsupported pool");
    }

    fn pool_id_from_mode(use_btc_mode: bool) -> u8 {
        if use_btc_mode { YIELD_POOL_BTC_ID } else { YIELD_POOL_STRK_ID }
    }

    fn payment_token(pool_id: u8) -> ContractAddress {
        assert_supported_pool(pool_id);
        if pool_id == YIELD_POOL_BTC_ID {
            // WBTC wrapper on Starknet Sepolia (supports transfer_from for staking flows).
            return 0x00452bd5c0512a61df7c7be8cfea5e4f893cb40e126bdc40aee6054db955129e
                .try_into()
                .unwrap();
        }

        let chain_id = starknet::get_tx_info().unbox().chain_id;

        // Use official STRK on Sepolia; keep local dev token for Katana.
        if chain_id == 'SN_SEPOLIA' {
            return 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d.try_into().unwrap();
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

    fn read_occupancy_sync_state(ref world: dojo::world::WorldStorage) -> OccupancySyncState {
        let state: OccupancySyncState = world.read_model(OCCUPANCY_SYNC_STATE_ID);
        if state.state_id == OCCUPANCY_SYNC_STATE_ID {
            state
        } else {
            OccupancySyncState { state_id: OCCUPANCY_SYNC_STATE_ID, synced_post_id: 0 }
        }
    }

    fn write_occupancy_sync_state(ref world: dojo::world::WorldStorage, synced_post_id: u64) {
        world.write_model(@OccupancySyncState { state_id: OCCUPANCY_SYNC_STATE_ID, synced_post_id });
    }

    fn tile_cell_x(x_position: i32) -> i32 {
        x_position / TILE_W
    }

    fn tile_cell_y(y_position: i32) -> i32 {
        y_position / TILE_H
    }

    fn is_cell_occupied(ref world: dojo::world::WorldStorage, cell_x: i32, cell_y: i32) -> bool {
        if cell_x < 0 || cell_y < 0 {
            return false;
        }
        let cell: OccupiedCell = world.read_model((cell_x, cell_y));
        cell.cell_x == cell_x && cell.cell_y == cell_y && cell.occupied
    }

    fn mark_block_cells_occupied(
        ref world: dojo::world::WorldStorage,
        top_left_x: i32,
        top_left_y: i32,
        size: u8,
        occupied: bool,
    ) {
        let base_cell_x = tile_cell_x(top_left_x);
        let base_cell_y = tile_cell_y(top_left_y);
        let size_i32: i32 = size.try_into().unwrap();
        let mut dx: i32 = 0;
        loop {
            if dx >= size_i32 {
                break;
            }
            let mut dy: i32 = 0;
            loop {
                if dy >= size_i32 {
                    break;
                }
                world.write_model(
                    @OccupiedCell {
                        cell_x: base_cell_x + dx,
                        cell_y: base_cell_y + dy,
                        occupied,
                    }
                );
                dy += 1;
            };
            dx += 1;
        };
    }

    fn assert_region_free_indexed(
        ref world: dojo::world::WorldStorage,
        new_x: i32,
        new_y: i32,
        new_size: u8,
    ) {
        assert!(new_size > 0, "Invalid post size");
        let base_cell_x = tile_cell_x(new_x);
        let base_cell_y = tile_cell_y(new_y);
        let size_i32: i32 = new_size.try_into().unwrap();
        let mut dx: i32 = 0;
        loop {
            if dx >= size_i32 {
                break;
            }
            let mut dy: i32 = 0;
            loop {
                if dy >= size_i32 {
                    break;
                }
                assert!(
                    !is_cell_occupied(ref world, base_cell_x + dx, base_cell_y + dy),
                    "Post overlaps an occupied area"
                );
                dy += 1;
            };
            dx += 1;
        };
    }

    fn assert_adjacent_to_existing_indexed(
        ref world: dojo::world::WorldStorage,
        new_x: i32,
        new_y: i32,
        new_size: u8,
    ) {
        let counter: PostCounter = world.read_model(0_u8);
        if counter.count == 0 {
            return;
        }
        let base_cell_x = tile_cell_x(new_x);
        let base_cell_y = tile_cell_y(new_y);
        let size_i32: i32 = new_size.try_into().unwrap();
        let min_x = base_cell_x - 1;
        let max_x = base_cell_x + size_i32;
        let min_y = base_cell_y - 1;
        let max_y = base_cell_y + size_i32;

        let mut found_adjacent = false;
        let mut x = min_x;
        loop {
            if x > max_x {
                break;
            }
            let mut y = min_y;
            loop {
                if y > max_y {
                    break;
                }
                let is_border = x == min_x || x == max_x || y == min_y || y == max_y;
                if is_border && is_cell_occupied(ref world, x, y) {
                    found_adjacent = true;
                    break;
                }
                y += 1;
            };
            if found_adjacent {
                break;
            }
            x += 1;
        };
        assert!(found_adjacent, "New post must be adjacent to an existing post");
    }

    fn sync_occupancy_index_step(
        ref world: dojo::world::WorldStorage, max_posts: u32
    ) -> (u64, u64) {
        let mut state = read_occupancy_sync_state(ref world);
        let counter: PostCounter = world.read_model(0_u8);
        if state.synced_post_id >= counter.count {
            if state.synced_post_id != counter.count {
                state.synced_post_id = counter.count;
                write_occupancy_sync_state(ref world, state.synced_post_id);
            }
            return (state.synced_post_id, counter.count);
        }

        let mut processed: u32 = 0;
        let mut next_post_id = state.synced_post_id + 1;
        loop {
            if next_post_id > counter.count || processed >= max_posts {
                break;
            }
            let post: Post = world.read_model(next_post_id);
            mark_block_cells_occupied(
                ref world,
                post.x_position,
                post.y_position,
                post.size,
                true
            );
            state.synced_post_id = next_post_id;
            processed += 1;
            next_post_id += 1;
        };

        write_occupancy_sync_state(ref world, state.synced_post_id);
        (state.synced_post_id, counter.count)
    }

    fn should_use_indexed_occupancy(
        ref world: dojo::world::WorldStorage, counter_before: u64
    ) -> bool {
        let state = read_occupancy_sync_state(ref world);
        state.synced_post_id >= counter_before
    }

    fn maybe_advance_occupancy_cursor_after_writes(
        ref world: dojo::world::WorldStorage,
        counter_before: u64,
    ) {
        let state = read_occupancy_sync_state(ref world);
        if state.synced_post_id < counter_before {
            return;
        }
        let counter: PostCounter = world.read_model(0_u8);
        if state.synced_post_id < counter.count {
            write_occupancy_sync_state(ref world, counter.count);
        }
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

    fn ranges_overlap(a_start: i32, a_end: i32, b_start: i32, b_end: i32) -> bool {
        a_start < b_end && a_end > b_start
    }

    fn is_adjacent_rect_to_post(new_x: i32, new_y: i32, new_size: u8, existing: Post) -> bool {
        let new_size_i32: i32 = new_size.try_into().unwrap();
        let new_right = new_x + (new_size_i32 * TILE_W);
        let new_bottom = new_y + (new_size_i32 * TILE_H);

        let existing_size_i32: i32 = existing.size.try_into().unwrap();
        let existing_right = existing.x_position + (existing_size_i32 * TILE_W);
        let existing_bottom = existing.y_position + (existing_size_i32 * TILE_H);

        let touches_left = new_right == existing.x_position
            && ranges_overlap(new_y, new_bottom, existing.y_position, existing_bottom);
        let touches_right = new_x == existing_right
            && ranges_overlap(new_y, new_bottom, existing.y_position, existing_bottom);
        let touches_top = new_bottom == existing.y_position
            && ranges_overlap(new_x, new_right, existing.x_position, existing_right);
        let touches_bottom = new_y == existing_bottom
            && ranges_overlap(new_x, new_right, existing.x_position, existing_right);

        touches_left || touches_right || touches_top || touches_bottom
    }

    fn assert_adjacent_to_existing(
        ref world: dojo::world::WorldStorage,
        new_x: i32,
        new_y: i32,
        new_size: u8,
    ) {
        let counter: PostCounter = world.read_model(0_u8);
        // Bootstrap: allow first post in an empty world.
        if counter.count == 0 {
            return;
        }

        let mut existing_id: u64 = 1;
        let mut found_adjacent = false;
        loop {
            if existing_id > counter.count {
                break;
            }

            let existing: Post = world.read_model(existing_id);
            if is_adjacent_rect_to_post(new_x, new_y, new_size, existing) {
                found_adjacent = true;
                break;
            }

            existing_id += 1;
        };

        assert!(found_adjacent, "New post must be adjacent to an existing post");
    }

    fn zero_address() -> ContractAddress {
        0.try_into().unwrap()
    }

    fn read_sealed_config_or_default(
        ref world: dojo::world::WorldStorage, group_id: u64, fallback_end_time: u64
    ) -> AuctionSealedConfig {
        let config: AuctionSealedConfig = world.read_model(group_id);
        if config.group_id == group_id {
            return config;
        }
        AuctionSealedConfig {
            group_id,
            sealed_mode: false,
            commit_end_time: fallback_end_time,
            reveal_end_time: fallback_end_time,
            verifier: zero_address(),
        }
    }

    fn compute_bid_commitment(
        slot_post_id: u64,
        group_id: u64,
        bidder: ContractAddress,
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

    fn compute_bid_nullifier(
        slot_post_id: u64, group_id: u64, bidder: ContractAddress, salt: felt252
    ) -> felt252 {
        let mut inputs = array![];
        inputs.append(slot_post_id.into());
        inputs.append(group_id.into());
        inputs.append(bidder.into());
        inputs.append(salt);
        poseidon_hash_span(inputs.span())
    }

    fn read_follow_stats_or_default(
        ref world: dojo::world::WorldStorage,
        user: ContractAddress,
    ) -> FollowStats {
        let stats: FollowStats = world.read_model(user);
        if stats.user == zero_address() {
            return FollowStats { user, followers_count: 0, following_count: 0, schema_version: 1 };
        }
        stats
    }

    fn read_yield_pool_or_default(ref world: dojo::world::WorldStorage, pool_id: u8) -> YieldPoolState {
        let mut state: YieldPoolState = world.read_model(pool_id);
        if state.pool_id != pool_id {
            return YieldPoolState {
                pool_id,
                principal_pool: 0,
                earnings_pool: 0,
                total_pending_rewards: 0,
                apr_bps: 0,
                reward_index: 0,
                user_share_bps: YIELD_DEFAULT_USER_SHARE_BPS,
            };
        }
        if state.user_share_bps == 0 {
            state.user_share_bps = YIELD_DEFAULT_USER_SHARE_BPS;
        }
        state
    }

    fn read_risk_state_or_default(ref world: dojo::world::WorldStorage, pool_id: u8) -> YieldRiskState {
        let state: YieldRiskState = world.read_model(pool_id);
        if state.pool_id != pool_id {
            return YieldRiskState {
                pool_id,
                liquid_buffer: 0,
                staked_principal: 0,
                target_buffer_bps: YIELD_DEFAULT_TARGET_BUFFER_BPS,
                max_exposure_bps: YIELD_DEFAULT_MAX_EXPOSURE_BPS,
                rebalance_threshold: YIELD_DEFAULT_REBALANCE_THRESHOLD,
                protocol_fee_bps: YIELD_DEFAULT_PROTOCOL_FEE_BPS,
                last_harvest_ts: 0,
            };
        }
        state
    }

    fn read_strategy_state_or_default(ref world: dojo::world::WorldStorage, pool_id: u8) -> YieldStrategyState {
        let state: YieldStrategyState = world.read_model(pool_id);
        if state.pool_id != pool_id {
            return YieldStrategyState {
                pool_id,
                strategy_kind: 0,
                adapter: zero_address(),
                staking_target: zero_address(),
                rewards_target: zero_address(),
                enabled: false,
                paused: false,
            };
        }
        state
    }

    fn read_exit_queue_or_default(
        ref world: dojo::world::WorldStorage,
        user: ContractAddress,
    ) -> YieldExitQueue {
        let item: YieldExitQueue = world.read_model(user);
        if item.user == zero_address() {
            return YieldExitQueue { user, queued_principal: 0, requested_at: 0, processed_at: 0 };
        }
        item
    }

    fn read_admin_or_default(ref world: dojo::world::WorldStorage) -> YieldAdminState {
        let state: YieldAdminState = world.read_model(YIELD_POOL_STRK_ID);
        if state.pool_id != YIELD_POOL_STRK_ID {
            return YieldAdminState { pool_id: YIELD_POOL_STRK_ID, admin: zero_address() };
        }
        state
    }

    fn read_yield_position_or_default(
        ref world: dojo::world::WorldStorage,
        user: ContractAddress,
    ) -> YieldPosition {
        let position: YieldPosition = world.read_model(user);
        if position.user == zero_address() {
            return YieldPosition {
                user,
                principal: 0,
                pending_rewards: 0,
                last_accrual_ts: 0,
                use_btc_mode: false,
                reward_index_snapshot: 0,
            };
        }
        position
    }

    fn sync_yield_position_timestamp(
        ref world: dojo::world::WorldStorage,
        mut position: YieldPosition,
    ) -> YieldPosition {
        position.last_accrual_ts = get_block_timestamp();
        world.write_model(@position);
        position
    }

    fn settle_user_rewards(
        ref world: dojo::world::WorldStorage,
        mut pool: YieldPoolState,
        mut position: YieldPosition,
    ) -> (YieldPoolState, YieldPosition) {
        if position.principal == 0 {
            position.reward_index_snapshot = pool.reward_index;
            world.write_model(@position);
            world.write_model(@pool);
            return (pool, position);
        }

        if pool.reward_index <= position.reward_index_snapshot {
            return (pool, position);
        }

        let delta_index = pool.reward_index - position.reward_index_snapshot;
        let accrued = (position.principal * delta_index) / REWARD_INDEX_SCALE;
        if accrued > 0 {
            position.pending_rewards += accrued;
            pool.total_pending_rewards += accrued;
        }
        position.reward_index_snapshot = pool.reward_index;
        world.write_model(@position);
        world.write_model(@pool);
        (pool, position)
    }

    fn ratio_amount(base: u128, bps: u32) -> u128 {
        if base == 0 || bps == 0 {
            return 0;
        }
        let bps_u128: u128 = bps.try_into().unwrap();
        (base * bps_u128) / 10_000
    }

    fn min_u128(a: u128, b: u128) -> u128 {
        if a < b { a } else { b }
    }

    fn u256_covers_u128(value: u256, needed: u128) -> bool {
        if value.high > 0 {
            true
        } else {
            value.low >= needed
        }
    }

    fn assert_yield_admin(ref world: dojo::world::WorldStorage, caller: ContractAddress) {
        let admin_state = read_admin_or_default(ref world);
        if admin_state.admin == zero_address() {
            return;
        }
        assert!(caller == admin_state.admin, "Only yield admin");
    }

    fn rebalance_pool_impl(ref world: dojo::world::WorldStorage, pool_id: u8) {
        assert_supported_pool(pool_id);
        let pool = read_yield_pool_or_default(ref world, pool_id);
        let mut risk = read_risk_state_or_default(ref world, pool_id);
        let strategy = read_strategy_state_or_default(ref world, pool_id);

        if !strategy.enabled || strategy.paused || strategy.adapter == zero_address() {
            return;
        }

        let adapter = IStakingAdapterDispatcher { contract_address: strategy.adapter };
        let target_buffer = ratio_amount(pool.principal_pool, risk.target_buffer_bps);
        let max_staked = ratio_amount(pool.principal_pool, risk.max_exposure_bps);

        if risk.liquid_buffer > target_buffer {
            let excess = risk.liquid_buffer - target_buffer;
            if excess >= risk.rebalance_threshold && risk.staked_principal < max_staked {
                let capacity = max_staked - risk.staked_principal;
                let to_stake = min_u128(excess, capacity);
                if to_stake > 0 {
                    let token = IERC20Dispatcher { contract_address: payment_token(pool_id) };
                    let moved = token.transfer(strategy.adapter, u256 { low: to_stake, high: 0 });
                    assert!(moved, "Rebalance transfer to adapter failed");
                    let ok = adapter.stake(to_stake);
                    assert!(ok, "Adapter stake failed");
                    risk.liquid_buffer -= to_stake;
                    risk.staked_principal += to_stake;
                }
            }
        } else {
            let needed = target_buffer - risk.liquid_buffer;
            if needed >= risk.rebalance_threshold && risk.staked_principal > 0 {
                let to_unstake = risk.staked_principal;
                if to_unstake > 0 {
                    let ok = adapter.request_unstake(to_unstake);
                    if ok {
                        risk.staked_principal -= to_unstake;
                        risk.liquid_buffer += to_unstake;
                    }
                }
            }
        }
        world.write_model(@risk);
    }

    fn harvest_pool_impl(ref world: dojo::world::WorldStorage, pool_id: u8) -> u128 {
        assert_supported_pool(pool_id);
        let mut pool = read_yield_pool_or_default(ref world, pool_id);
        let mut risk = read_risk_state_or_default(ref world, pool_id);
        let strategy = read_strategy_state_or_default(ref world, pool_id);

        if !strategy.enabled || strategy.paused || strategy.adapter == zero_address() {
            return 0;
        }

        let adapter = IStakingAdapterDispatcher { contract_address: strategy.adapter };
        let harvested = adapter.claim_rewards();
        if harvested == 0 {
            return 0;
        }

        let fee_cut = ratio_amount(harvested, risk.protocol_fee_bps);
        let net_rewards = harvested - fee_cut;
        let users_cut = ratio_amount(net_rewards, pool.user_share_bps);
        if users_cut > 0 {
            pool.earnings_pool += users_cut;
            if pool.principal_pool > 0 {
                let delta_index = (users_cut * REWARD_INDEX_SCALE) / pool.principal_pool;
                if delta_index > 0 {
                    pool.reward_index += delta_index;
                }
            }
        }
        risk.last_harvest_ts = get_block_timestamp();
        world.write_model(@pool);
        world.write_model(@risk);
        users_cut
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
        mark_block_cells_occupied(ref world, x_position, y_position, size, true);
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
            let counter_before: PostCounter = world.read_model(0_u8);

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
            if should_use_indexed_occupancy(ref world, counter_before.count) {
                assert_region_free_indexed(ref world, x_position, y_position, size);
                assert_adjacent_to_existing_indexed(ref world, x_position, y_position, size);
            } else {
                assert_region_free(ref world, x_position, y_position, size);
                assert_adjacent_to_existing(ref world, x_position, y_position, size);
            }

            if is_paid {
                let price_strk = paid_post_price(size);
                assert!(price_strk > 0, "Invalid paid post price");

                let amount_low: u128 = price_strk * STRK_DECIMALS_FACTOR;
                let token = IERC20Dispatcher { contract_address: payment_token(YIELD_POOL_STRK_ID) };
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
            maybe_advance_occupancy_cursor_after_writes(ref world, counter_before.count);

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
            let counter_before: PostCounter = world.read_model(0_u8);

            assert!(end_time > now, "Auction end time must be in the future");

            let auction_fee_low: u128 = AUCTION_POST_CREATION_PRICE_STRK * STRK_DECIMALS_FACTOR;
            let token = IERC20Dispatcher { contract_address: payment_token(YIELD_POOL_STRK_ID) };
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
            if should_use_indexed_occupancy(ref world, counter_before.count) {
                assert_region_free_indexed(ref world, auction_top_left_x, auction_top_left_y, 3);
                assert_adjacent_to_existing_indexed(ref world, auction_top_left_x, auction_top_left_y, 3);
            } else {
                assert_region_free(ref world, auction_top_left_x, auction_top_left_y, 3);
                assert_adjacent_to_existing(ref world, auction_top_left_x, auction_top_left_y, 3);
            }

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
            world.write_model(
                @AuctionSealedConfig {
                    group_id: center_post_id,
                    sealed_mode: false,
                    commit_end_time: end_time,
                    reveal_end_time: end_time,
                    verifier: zero_address(),
                }
            );

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
                world.write_model(@AuctionSlotPricing { slot_post_id, second_highest_bid: 0 });

                slot_idx += 1;
            }
            maybe_advance_occupancy_cursor_after_writes(ref world, counter_before.count);

            center_post_id
        }

        fn create_auction_post_3x3_sealed(
            ref self: ContractState,
            center_image_url: ByteArray,
            center_caption: ByteArray,
            creator_username: ByteArray,
            center_x_position: i32,
            center_y_position: i32,
            commit_end_time: u64,
            reveal_end_time: u64,
            verifier: ContractAddress
        ) -> u64 {
            let mut world = self.world_default();
            let caller = starknet::get_caller_address();
            let now = get_block_timestamp();
            let counter_before: PostCounter = world.read_model(0_u8);

            assert!(verifier != zero_address(), "Verifier required");
            assert!(commit_end_time > now, "Commit end must be in the future");
            assert!(reveal_end_time > commit_end_time, "Reveal end must be after commit end");

            let auction_fee_low: u128 = AUCTION_POST_CREATION_PRICE_STRK * STRK_DECIMALS_FACTOR;
            let token = IERC20Dispatcher { contract_address: payment_token(YIELD_POOL_STRK_ID) };
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
            if should_use_indexed_occupancy(ref world, counter_before.count) {
                assert_region_free_indexed(ref world, auction_top_left_x, auction_top_left_y, 3);
                assert_adjacent_to_existing_indexed(ref world, auction_top_left_x, auction_top_left_y, 3);
            } else {
                assert_region_free(ref world, auction_top_left_x, auction_top_left_y, 3);
                assert_adjacent_to_existing(ref world, auction_top_left_x, auction_top_left_y, 3);
            }

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

            world.write_model(
                @AuctionGroup {
                    group_id: center_post_id,
                    center_post_id,
                    creator: caller,
                    end_time: reveal_end_time,
                    active: true,
                }
            );

            world.write_model(
                @AuctionSealedConfig {
                    group_id: center_post_id,
                    sealed_mode: true,
                    commit_end_time,
                    reveal_end_time,
                    verifier,
                }
            );

            let mut slot_idx: u8 = 1;
            let offsets = array![
                (center_x_position - TILE_W, center_y_position - TILE_H),
                (center_x_position, center_y_position - TILE_H),
                (center_x_position + TILE_W, center_y_position - TILE_H),
                (center_x_position - TILE_W, center_y_position),
                (center_x_position + TILE_W, center_y_position),
                (center_x_position - TILE_W, center_y_position + TILE_H),
                (center_x_position, center_y_position + TILE_H),
                (center_x_position + TILE_W, center_y_position + TILE_H),
            ];

            for (slot_x, slot_y) in offsets {
                let slot_post_id = next_post_id(ref world);
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

                world.write_model(
                    @AuctionSlot {
                        slot_post_id,
                        group_id: center_post_id,
                        highest_bid: 0,
                        highest_bidder: caller,
                        has_bid: false,
                        finalized: false,
                        content_initialized: false,
                    }
                );
                world.write_model(@AuctionSlotPricing { slot_post_id, second_highest_bid: 0 });
                slot_idx += 1;
            }
            maybe_advance_occupancy_cursor_after_writes(ref world, counter_before.count);

            center_post_id
        }

        fn configure_auction_sealed(
            ref self: ContractState,
            group_id: u64,
            commit_end_time: u64,
            reveal_end_time: u64,
            verifier: ContractAddress
        ) {
            let mut world = self.world_default();
            let caller = starknet::get_caller_address();
            let now = get_block_timestamp();

            assert!(verifier != zero_address(), "Verifier required");
            assert!(commit_end_time > now, "Commit end must be in the future");
            assert!(reveal_end_time > commit_end_time, "Reveal end must be after commit end");

            let mut group: AuctionGroup = world.read_model(group_id);
            assert!(group.group_id == group_id, "Auction group not found");
            assert!(group.creator == caller, "Only creator can configure sealed mode");
            assert!(group.active, "Auction group inactive");
            assert!(now < group.end_time, "Auction already ended");

            // Prevent mode switch after bidding activity starts.
            let mut idx: u8 = 1;
            loop {
                if idx > 8_u8 {
                    break;
                }
                let slot_post_id = group_id + idx.into();
                let slot: AuctionSlot = world.read_model(slot_post_id);
                assert!(!slot.has_bid, "Cannot configure sealed after bids");
                idx += 1_u8;
            };

            group.end_time = reveal_end_time;
            world.write_model(@group);
            world.write_model(
                @AuctionSealedConfig {
                    group_id,
                    sealed_mode: true,
                    commit_end_time,
                    reveal_end_time,
                    verifier,
                }
            );
        }

        fn sync_occupancy_index(ref self: ContractState, max_posts: u32) -> (u64, u64) {
            let mut world = self.world_default();
            let batch = if max_posts == 0 { 1_u32 } else { max_posts };
            sync_occupancy_index_step(ref world, batch)
        }

        fn occupancy_sync_progress(self: @ContractState) -> (u64, u64) {
            let mut world = self.world_default();
            let state = read_occupancy_sync_state(ref world);
            let counter: PostCounter = world.read_model(0_u8);
            (state.synced_post_id, counter.count)
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
            let sealed_cfg = read_sealed_config_or_default(ref world, slot.group_id, group.end_time);
            assert!(group.active, "Auction group inactive");
            assert!(!sealed_cfg.sealed_mode, "Use commit/reveal for sealed auction");
            assert!(now < group.end_time, "Auction already ended");
            assert!(bid_amount > slot.highest_bid, "Bid must be higher than current highest");
            assert!(bidder != group.creator, "Creator cannot bid in own auction");

            let post: Post = world.read_model(slot_post_id);
            assert!(post.post_kind == POST_KIND_AUCTION_SLOT, "Not an auction slot");
            assert!(post.current_owner != bidder, "Owner cannot bid on this slot");

            let token = IERC20Dispatcher { contract_address: payment_token(YIELD_POOL_STRK_ID) };

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
            let prev_second = if slot.has_bid { slot.highest_bid } else { 0 };
            world.write_model(@AuctionSlotPricing { slot_post_id: slot.slot_post_id, second_highest_bid: prev_second });

            world.write_model(@updated_slot);
        }

        fn commit_bid(
            ref self: ContractState,
            slot_post_id: u64,
            commitment: felt252,
            escrow_amount: u128
        ) {
            let mut world = self.world_default();
            let bidder = starknet::get_caller_address();
            let now = get_block_timestamp();
            assert!(escrow_amount > 0, "Escrow must be > 0");
            assert!(commitment != 0, "Commitment required");

            let mut slot: AuctionSlot = world.read_model(slot_post_id);
            assert!(!slot.finalized, "Auction slot already finalized");
            let group: AuctionGroup = world.read_model(slot.group_id);
            assert!(group.active, "Auction group inactive");
            assert!(bidder != group.creator, "Creator cannot bid in own auction");

            let sealed_cfg = read_sealed_config_or_default(ref world, slot.group_id, group.end_time);
            assert!(sealed_cfg.sealed_mode, "Not a sealed auction");
            assert!(now < sealed_cfg.commit_end_time, "Commit phase closed");

            let existing: AuctionCommit = world.read_model((slot_post_id, bidder));

            let post: Post = world.read_model(slot_post_id);
            assert!(post.post_kind == POST_KIND_AUCTION_SLOT, "Not an auction slot");
            assert!(post.current_owner != bidder, "Owner cannot bid on this slot");

            let token = IERC20Dispatcher { contract_address: payment_token(YIELD_POOL_STRK_ID) };
            if existing.commitment == 0 {
                let escrow_low: u128 = escrow_amount * STRK_DECIMALS_FACTOR;
                let paid = token.transfer_from(
                    bidder,
                    get_contract_address(),
                    u256 { low: escrow_low, high: 0 },
                );
                assert!(paid, "Commit escrow payment failed");
            } else {
                assert!(!existing.revealed, "Bid already revealed");
                assert!(!existing.refunded, "Commit already refunded");
                assert!(escrow_amount > existing.escrow_amount, "New sealed bid must increase escrow");
                let additional_escrow = escrow_amount - existing.escrow_amount;
                let additional_low: u128 = additional_escrow * STRK_DECIMALS_FACTOR;
                let paid_more = token.transfer_from(
                    bidder,
                    get_contract_address(),
                    u256 { low: additional_low, high: 0 },
                );
                assert!(paid_more, "Additional commit escrow payment failed");
            }

            world.write_model(
                @AuctionCommit {
                    slot_post_id,
                    bidder,
                    commitment,
                    escrow_amount,
                    committed_at: now,
                    revealed: false,
                    revealed_bid: 0,
                    refunded: false,
                }
            );

            // Hard invariant for sealed slots:
            // once there is at least one commit, keep a valid deterministic winner
            // candidate using escrow amount (equal to revealed bid in this flow).
            let mut pricing: AuctionSlotPricing = world.read_model(slot_post_id);
            if !slot.has_bid {
                slot.highest_bid = escrow_amount;
                slot.highest_bidder = bidder;
                slot.has_bid = true;
                pricing.second_highest_bid = 0;
            } else if bidder == slot.highest_bidder {
                if escrow_amount > slot.highest_bid {
                    slot.highest_bid = escrow_amount;
                }
            } else if escrow_amount > slot.highest_bid {
                pricing.second_highest_bid = slot.highest_bid;
                slot.highest_bid = escrow_amount;
                slot.highest_bidder = bidder;
            } else if escrow_amount > pricing.second_highest_bid {
                pricing.second_highest_bid = escrow_amount;
            }
            world.write_model(@pricing);
            world.write_model(@slot);
        }

        fn reveal_bid(
            ref self: ContractState,
            slot_post_id: u64,
            bidder: ContractAddress,
            bid_amount: u128,
            salt: felt252,
            full_proof_with_hints: Span<felt252>
        ) {
            let mut world = self.world_default();
            let now = get_block_timestamp();
            assert!(bid_amount > 0, "Bid must be > 0");
            assert!(full_proof_with_hints.len() > 0, "Proof required");
            assert!(bidder != zero_address(), "Bidder required");

            let mut slot: AuctionSlot = world.read_model(slot_post_id);
            assert!(!slot.finalized, "Auction slot already finalized");
            let group: AuctionGroup = world.read_model(slot.group_id);
            let sealed_cfg = read_sealed_config_or_default(ref world, slot.group_id, group.end_time);
            assert!(sealed_cfg.sealed_mode, "Not a sealed auction");
            assert!(now >= sealed_cfg.commit_end_time, "Reveal phase not started");
            assert!(now < sealed_cfg.reveal_end_time, "Reveal phase closed");

            let mut commit: AuctionCommit = world.read_model((slot_post_id, bidder));
            assert!(commit.commitment != 0, "No commit found");
            assert!(!commit.revealed, "Bid already revealed");
            assert!(commit.escrow_amount == bid_amount, "Revealed bid must equal escrow");

            let verifier = ISealedBidVerifierDispatcher { contract_address: sealed_cfg.verifier };
            let verified = verifier.verify_sealed_bid(
                slot_post_id,
                slot.group_id,
                bidder,
                bid_amount,
                salt,
                commit.commitment,
                full_proof_with_hints,
            );
            assert!(verified, "Invalid reveal proof");
            assert!(
                compute_bid_commitment(slot_post_id, slot.group_id, bidder, bid_amount, salt)
                    == commit.commitment,
                "Commitment mismatch"
            );

            let nullifier = compute_bid_nullifier(slot_post_id, slot.group_id, bidder, salt);
            let used_nullifier: AuctionRevealNullifier = world.read_model(nullifier);
            assert!(!used_nullifier.used, "Nullifier already used");
            world.write_model(@AuctionRevealNullifier { nullifier, used: true });

            commit.revealed = true;
            commit.revealed_bid = bid_amount;
            world.write_model(@commit);

            if !slot.has_bid {
                slot.highest_bid = bid_amount;
                slot.highest_bidder = bidder;
                slot.has_bid = true;
                world.write_model(@AuctionSlotPricing { slot_post_id, second_highest_bid: 0 });
                world.write_model(@slot);
            } else if bidder != slot.highest_bidder && bid_amount > slot.highest_bid {
                world.write_model(@AuctionSlotPricing { slot_post_id, second_highest_bid: slot.highest_bid });
                slot.highest_bid = bid_amount;
                slot.highest_bidder = bidder;
                world.write_model(@slot);
            } else if bidder != slot.highest_bidder {
                let pricing: AuctionSlotPricing = world.read_model(slot_post_id);
                if bid_amount > pricing.second_highest_bid {
                    world.write_model(@AuctionSlotPricing { slot_post_id, second_highest_bid: bid_amount });
                }
            }
        }

        fn claim_commit_refund(
            ref self: ContractState,
            slot_post_id: u64,
            bidder: ContractAddress
        ) {
            let mut world = self.world_default();
            let now = get_block_timestamp();
            assert!(bidder != zero_address(), "Bidder required");

            let slot: AuctionSlot = world.read_model(slot_post_id);
            let group: AuctionGroup = world.read_model(slot.group_id);
            let sealed_cfg = read_sealed_config_or_default(ref world, slot.group_id, group.end_time);
            assert!(sealed_cfg.sealed_mode, "Not a sealed auction");
            assert!(now >= sealed_cfg.reveal_end_time, "Refund available after reveal");

            let mut commit: AuctionCommit = world.read_model((slot_post_id, bidder));
            assert!(commit.commitment != 0, "No commit found");
            assert!(!commit.refunded, "Already refunded");
            assert!(commit.escrow_amount > 0, "Nothing to refund");
            if commit.revealed {
                assert!(commit.revealed_bid <= commit.escrow_amount, "Invalid revealed bid");
            }
            assert!(
                !(slot.has_bid && slot.highest_bidder == bidder),
                "Highest bidder cannot refund"
            );

            if slot.finalized && slot.has_bid && slot.highest_bidder == bidder {
                assert!(commit.revealed_bid != slot.highest_bid, "Winner cannot refund");
            }

            commit.refunded = true;
            world.write_model(@commit);

            let token = IERC20Dispatcher { contract_address: payment_token(YIELD_POOL_STRK_ID) };
            let refund_low: u128 = commit.escrow_amount * STRK_DECIMALS_FACTOR;
            let refunded = token.transfer(
                bidder,
                u256 { low: refund_low, high: 0 },
            );
            assert!(refunded, "Refund transfer failed");
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
            let sealed_cfg = read_sealed_config_or_default(ref world, slot.group_id, group.end_time);
            assert!(group.active, "Auction group inactive");
            if sealed_cfg.sealed_mode {
                assert!(now >= sealed_cfg.reveal_end_time, "Reveal phase not ended");
            } else {
                assert!(now >= group.end_time, "Auction has not ended yet");
            }

            let mut post: Post = world.read_model(slot_post_id);
            assert!(post.post_kind == POST_KIND_AUCTION_SLOT, "Not an auction slot");

            if slot.has_bid {
                let token = IERC20Dispatcher { contract_address: payment_token(YIELD_POOL_STRK_ID) };
                let mut clearing_price = slot.highest_bid;
                if sealed_cfg.sealed_mode {
                    let pricing: AuctionSlotPricing = world.read_model(slot_post_id);
                    let second_plus_one = pricing.second_highest_bid + 1;
                    if second_plus_one < clearing_price {
                        clearing_price = second_plus_one;
                    }
                }

                // Release winner payment to auction creator.
                let amount_low: u128 = clearing_price * STRK_DECIMALS_FACTOR;
                let paid_out = token.transfer(
                    group.creator,
                    u256 { low: amount_low, high: 0 },
                );
                assert!(paid_out, "Creator payout failed");

                post.current_owner = slot.highest_bidder;
                post.sale_price = 0;
                world.write_model(@post);

                if sealed_cfg.sealed_mode {
                    let mut winner_commit: AuctionCommit = world.read_model(
                        (slot_post_id, slot.highest_bidder)
                    );
                    if winner_commit.commitment != 0 {
                        // Winner pays only clearing price; return any extra escrow.
                        if winner_commit.escrow_amount > clearing_price {
                            let winner_refund = winner_commit.escrow_amount - clearing_price;
                            let winner_refund_low: u128 = winner_refund * STRK_DECIMALS_FACTOR;
                            let winner_refunded = token.transfer(
                                slot.highest_bidder,
                                u256 { low: winner_refund_low, high: 0 },
                            );
                            assert!(winner_refunded, "Winner refund transfer failed");
                        }
                        winner_commit.refunded = true;
                        world.write_model(@winner_commit);
                    }
                }

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
                    let old_index = UsernameIndex {
                        username_norm_hash: old_hash,
                        user: zero,
                        schema_version: 1,
                    };
                    world.write_model(@old_index);
                }
            }

            let existing_index: UsernameIndex = world.read_model(username_norm_hash);
            assert!(
                existing_index.user == zero || existing_index.user == caller,
                "Username already taken"
            );

            let profile = UserProfile {
                user: caller,
                username,
                username_norm_hash,
                schema_version: 1,
            };
            world.write_model(@profile);

            let index = UsernameIndex { username_norm_hash, user: caller, schema_version: 1 };
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
                schema_version: 1,
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

            let relation = FollowRelation { follower, following, created_at: 0, schema_version: 1 };
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
            let token = IERC20Dispatcher { contract_address: payment_token(YIELD_POOL_STRK_ID) };
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

        fn yield_deposit(
            ref self: ContractState,
            amount: u128,
            use_btc_mode: bool
        ) {
            assert!(amount > 0, "Amount must be greater than 0");
            let mut world = self.world_default();
            let caller = starknet::get_caller_address();
            let mut position = read_yield_position_or_default(ref world, caller);
            let target_pool_id = pool_id_from_mode(use_btc_mode);
            if position.principal > 0 {
                assert!(
                    pool_id_from_mode(position.use_btc_mode) == target_pool_id,
                    "Active position in another pool"
                );
            }
            let queue_item = read_exit_queue_or_default(ref world, caller);
            if queue_item.queued_principal > 0 {
                assert!(
                    pool_id_from_mode(position.use_btc_mode) == target_pool_id,
                    "Queued exit in another pool"
                );
            }

            let mut pool = read_yield_pool_or_default(ref world, target_pool_id);
            let mut risk = read_risk_state_or_default(ref world, target_pool_id);
            let strategy = read_strategy_state_or_default(ref world, target_pool_id);
            let (mut pool, mut position) = settle_user_rewards(ref world, pool, position);

            let token = IERC20Dispatcher { contract_address: payment_token(target_pool_id) };
            let balance = token.balance_of(caller);
            assert!(u256_covers_u128(balance, amount), "Insufficient token balance");
            let allowance = token.allowance(caller, get_contract_address());
            assert!(u256_covers_u128(allowance, amount), "Insufficient token allowance");
            let ok = token.transfer_from(
                caller,
                get_contract_address(),
                u256 { low: amount, high: 0 },
            );
            assert!(ok, "Deposit transfer failed");

            position.principal += amount;
            position.use_btc_mode = use_btc_mode;
            position.reward_index_snapshot = pool.reward_index;
            pool.principal_pool += amount;
            risk.liquid_buffer += amount;
            position = sync_yield_position_timestamp(ref world, position);

            if strategy.enabled && !strategy.paused && strategy.adapter != zero_address() {
                let target_buffer = ratio_amount(pool.principal_pool, risk.target_buffer_bps);
                let max_staked = ratio_amount(pool.principal_pool, risk.max_exposure_bps);
                if risk.liquid_buffer > target_buffer && risk.staked_principal < max_staked {
                    let excess = risk.liquid_buffer - target_buffer;
                    let capacity = max_staked - risk.staked_principal;
                    let to_stake = min_u128(excess, capacity);
                    if to_stake > 0 {
                        let moved = token.transfer(strategy.adapter, u256 { low: to_stake, high: 0 });
                        assert!(moved, "Stake transfer to adapter failed");
                        let adapter = IStakingAdapterDispatcher { contract_address: strategy.adapter };
                        let staked = adapter.stake(to_stake);
                        assert!(staked, "Adapter stake failed");
                        risk.liquid_buffer -= to_stake;
                        risk.staked_principal += to_stake;
                    }
                }
            }

            world.write_model(@position);
            world.write_model(@pool);
            world.write_model(@risk);
        }

        fn yield_withdraw(
            ref self: ContractState,
            amount: u128
        ) {
            assert!(amount > 0, "Amount must be greater than 0");
            let mut world = self.world_default();
            let caller = starknet::get_caller_address();
            let mut position = read_yield_position_or_default(ref world, caller);
            let pool_id = pool_id_from_mode(position.use_btc_mode);
            let mut pool = read_yield_pool_or_default(ref world, pool_id);
            let mut risk = read_risk_state_or_default(ref world, pool_id);
            let strategy = read_strategy_state_or_default(ref world, pool_id);
            let now = get_block_timestamp();
            let (_pool, mut position) = settle_user_rewards(ref world, pool, position);

            assert!(position.principal >= amount, "Insufficient staked principal");
            position.principal -= amount;
            position.reward_index_snapshot = pool.reward_index;
            position = sync_yield_position_timestamp(ref world, position);

            let immediate = min_u128(amount, risk.liquid_buffer);
            let queued = amount - immediate;

            let mut queue_item = read_exit_queue_or_default(ref world, caller);
            if queued > 0 {
                queue_item.queued_principal += queued;
            }
            queue_item.requested_at = now;
            world.write_model(@queue_item);

            if immediate > 0 {
                let token = IERC20Dispatcher { contract_address: payment_token(pool_id) };
                let paid = token.transfer(caller, u256 { low: immediate, high: 0 });
                assert!(paid, "Principal withdraw transfer failed");
                assert!(pool.principal_pool >= immediate, "Principal pool accounting mismatch");
                pool.principal_pool -= immediate;
                risk.liquid_buffer -= immediate;
            }

            if queued > 0 && strategy.enabled && !strategy.paused && strategy.adapter != zero_address() {
                let adapter = IStakingAdapterDispatcher { contract_address: strategy.adapter };
                let to_unstake = risk.staked_principal;
                let requested = if to_unstake > 0 { adapter.request_unstake(to_unstake) } else { false };
                if requested {
                    risk.staked_principal = 0;
                    risk.liquid_buffer += to_unstake;
                }
            }

            if queue_item.queued_principal > 0 && risk.liquid_buffer > 0 {
                let queued_ready = min_u128(queue_item.queued_principal, risk.liquid_buffer);
                if queued_ready > 0 {
                    let token = IERC20Dispatcher { contract_address: payment_token(pool_id) };
                    let paid = token.transfer(caller, u256 { low: queued_ready, high: 0 });
                    if paid {
                        if queue_item.queued_principal >= queued_ready {
                            queue_item.queued_principal -= queued_ready;
                        } else {
                            queue_item.queued_principal = 0;
                        }
                        queue_item.processed_at = now;
                        world.write_model(@queue_item);
                        assert!(pool.principal_pool >= queued_ready, "Principal pool accounting mismatch");
                        pool.principal_pool -= queued_ready;
                        risk.liquid_buffer -= queued_ready;
                    }
                }
            }

            if queue_item.queued_principal > 0 {
                let token = IERC20Dispatcher { contract_address: payment_token(pool_id) };
                let contract_balance = token.balance_of(get_contract_address());
                let contract_balance_u128 = if contract_balance.high == 0 {
                    contract_balance.low
                } else {
                    contract_balance.low
                };
                let observed_liquid = if contract_balance_u128 > pool.earnings_pool {
                    contract_balance_u128 - pool.earnings_pool
                } else {
                    0
                };
                if observed_liquid > risk.liquid_buffer {
                    risk.liquid_buffer = observed_liquid;
                }
            }

            if queue_item.queued_principal > 0 && risk.liquid_buffer > 0 {
                let queued_ready = min_u128(queue_item.queued_principal, risk.liquid_buffer);
                if queued_ready > 0 {
                    let token = IERC20Dispatcher { contract_address: payment_token(pool_id) };
                    let paid = token.transfer(caller, u256 { low: queued_ready, high: 0 });
                    if paid {
                        if queue_item.queued_principal >= queued_ready {
                            queue_item.queued_principal -= queued_ready;
                        } else {
                            queue_item.queued_principal = 0;
                        }
                        queue_item.processed_at = now;
                        world.write_model(@queue_item);
                        assert!(pool.principal_pool >= queued_ready, "Principal pool accounting mismatch");
                        pool.principal_pool -= queued_ready;
                        risk.liquid_buffer -= queued_ready;
                    }
                }
            }

            world.write_model(@position);
            world.write_model(@pool);
            world.write_model(@risk);
        }

        fn yield_claim(ref self: ContractState) -> u128 {
            let mut world = self.world_default();
            let caller = starknet::get_caller_address();
            let mut position = read_yield_position_or_default(ref world, caller);
            let pool_id = pool_id_from_mode(position.use_btc_mode);
            let mut pool = read_yield_pool_or_default(ref world, pool_id);
            let (mut pool, mut position) = settle_user_rewards(ref world, pool, position);

            let claimable = if position.pending_rewards < pool.earnings_pool {
                position.pending_rewards
            } else {
                pool.earnings_pool
            };
            if claimable == 0 {
                return 0;
            }

            let token = IERC20Dispatcher { contract_address: payment_token(pool_id) };
            let ok = token.transfer(caller, u256 { low: claimable, high: 0 });
            assert!(ok, "Earnings payout transfer failed");

            pool.earnings_pool -= claimable;
            if pool.total_pending_rewards >= claimable {
                pool.total_pending_rewards -= claimable;
            } else {
                pool.total_pending_rewards = 0;
            }
            if position.pending_rewards >= claimable {
                position.pending_rewards -= claimable;
            } else {
                position.pending_rewards = 0;
            }
            position = sync_yield_position_timestamp(ref world, position);
            world.write_model(@position);
            world.write_model(@pool);
            claimable
        }

        fn yield_set_btc_mode(
            ref self: ContractState,
            use_btc_mode: bool
        ) {
            let mut world = self.world_default();
            let caller = starknet::get_caller_address();
            let mut position = read_yield_position_or_default(ref world, caller);
            let current_pool = pool_id_from_mode(position.use_btc_mode);
            let mut pool = read_yield_pool_or_default(ref world, current_pool);
            let (_pool, mut position) = settle_user_rewards(ref world, pool, position);
            let queue_item = read_exit_queue_or_default(ref world, caller);
            assert!(position.principal == 0, "Withdraw before switching pool");
            assert!(queue_item.queued_principal == 0, "Queue must be empty");
            position.use_btc_mode = use_btc_mode;
            position = sync_yield_position_timestamp(ref world, position);
            world.write_model(@position);
        }

        fn yield_fund_earnings_pool(
            ref self: ContractState,
            amount: u128
        ) {
            assert!(amount > 0, "Amount must be greater than 0");
            let mut world = self.world_default();
            let caller = starknet::get_caller_address();
            let position = read_yield_position_or_default(ref world, caller);
            let pool_id = pool_id_from_mode(position.use_btc_mode);
            let mut pool = read_yield_pool_or_default(ref world, pool_id);
            let token = IERC20Dispatcher { contract_address: payment_token(pool_id) };
            let ok = token.transfer_from(
                caller,
                get_contract_address(),
                u256 { low: amount, high: 0 },
            );
            assert!(ok, "Fund earnings transfer failed");
            pool.earnings_pool += amount;
            if pool.principal_pool > 0 {
                let delta_index = (amount * REWARD_INDEX_SCALE) / pool.principal_pool;
                if delta_index > 0 {
                    pool.reward_index += delta_index;
                }
            }
            world.write_model(@pool);
        }

        fn yield_configure_strategy(
            ref self: ContractState,
            strategy_kind: u8,
            adapter: ContractAddress,
            staking_target: ContractAddress,
            rewards_target: ContractAddress,
            enabled: bool,
            paused: bool
        ) {
            let mut world = self.world_default();
            let caller = starknet::get_caller_address();
            assert_yield_admin(ref world, caller);
            let strategy = YieldStrategyState {
                pool_id: YIELD_POOL_STRK_ID,
                strategy_kind,
                adapter,
                staking_target,
                rewards_target,
                enabled,
                paused,
            };
            world.write_model(@strategy);
        }

        fn yield_set_risk_params(
            ref self: ContractState,
            target_buffer_bps: u32,
            max_exposure_bps: u32,
            rebalance_threshold: u128,
            protocol_fee_bps: u32
        ) {
            assert!(target_buffer_bps <= 10_000, "target_buffer_bps out of range");
            assert!(max_exposure_bps <= 10_000, "max_exposure_bps out of range");
            assert!(protocol_fee_bps <= 10_000, "protocol_fee_bps out of range");

            let mut world = self.world_default();
            let caller = starknet::get_caller_address();
            assert_yield_admin(ref world, caller);
            let mut risk = read_risk_state_or_default(ref world, YIELD_POOL_STRK_ID);
            risk.target_buffer_bps = target_buffer_bps;
            risk.max_exposure_bps = max_exposure_bps;
            risk.rebalance_threshold = rebalance_threshold;
            risk.protocol_fee_bps = protocol_fee_bps;
            world.write_model(@risk);
        }

        fn yield_rebalance(ref self: ContractState) {
            let mut world = self.world_default();
            rebalance_pool_impl(ref world, YIELD_POOL_STRK_ID);
            rebalance_pool_impl(ref world, YIELD_POOL_BTC_ID);
        }

        fn yield_harvest(ref self: ContractState) -> u128 {
            let mut world = self.world_default();
            let strk = harvest_pool_impl(ref world, YIELD_POOL_STRK_ID);
            let tbtc = harvest_pool_impl(ref world, YIELD_POOL_BTC_ID);
            strk + tbtc
        }

        fn yield_process_exit_queue(
            ref self: ContractState,
            user: ContractAddress
        ) -> u128 {
            let mut world = self.world_default();
            let mut queue_item = read_exit_queue_or_default(ref world, user);
            if queue_item.queued_principal == 0 {
                return 0;
            }

            let position = read_yield_position_or_default(ref world, user);
            let pool_id = pool_id_from_mode(position.use_btc_mode);
            let strategy = read_strategy_state_or_default(ref world, pool_id);
            let mut pool = read_yield_pool_or_default(ref world, pool_id);
            let mut risk = read_risk_state_or_default(ref world, pool_id);
            let mut total_payout: u128 = 0;

            let immediate = min_u128(queue_item.queued_principal, risk.liquid_buffer);
            if immediate > 0 {
                let token = IERC20Dispatcher { contract_address: payment_token(pool_id) };
                let ok = token.transfer(user, u256 { low: immediate, high: 0 });
                assert!(ok, "Queued withdraw transfer failed");
                risk.liquid_buffer -= immediate;
                assert!(pool.principal_pool >= immediate, "Principal pool accounting mismatch");
                pool.principal_pool -= immediate;
                if queue_item.queued_principal >= immediate {
                    queue_item.queued_principal -= immediate;
                } else {
                    queue_item.queued_principal = 0;
                }
                total_payout += immediate;
            }

            if queue_item.queued_principal > 0 && strategy.enabled && !strategy.paused && strategy.adapter != zero_address() {
                let adapter = IStakingAdapterDispatcher { contract_address: strategy.adapter };
                let to_unstake = risk.staked_principal;
                let requested = if to_unstake > 0 { adapter.request_unstake(to_unstake) } else { false };
                if requested {
                    risk.staked_principal = 0;
                    risk.liquid_buffer += to_unstake;
                }
            }

            if queue_item.queued_principal > 0 && risk.liquid_buffer > 0 {
                let payout = min_u128(queue_item.queued_principal, risk.liquid_buffer);
                if payout > 0 {
                    let token = IERC20Dispatcher { contract_address: payment_token(pool_id) };
                    let ok = token.transfer(user, u256 { low: payout, high: 0 });
                    if ok {
                        assert!(pool.principal_pool >= payout, "Principal pool accounting mismatch");
                        pool.principal_pool -= payout;
                        if queue_item.queued_principal >= payout {
                            queue_item.queued_principal -= payout;
                        } else {
                            queue_item.queued_principal = 0;
                        }
                        risk.liquid_buffer -= payout;
                        total_payout += payout;
                    }
                }
            }

            if queue_item.queued_principal > 0 {
                let token = IERC20Dispatcher { contract_address: payment_token(pool_id) };
                let contract_balance = token.balance_of(get_contract_address());
                let contract_balance_u128 = if contract_balance.high == 0 {
                    contract_balance.low
                } else {
                    contract_balance.low
                };
                let observed_liquid = if contract_balance_u128 > pool.earnings_pool {
                    contract_balance_u128 - pool.earnings_pool
                } else {
                    0
                };
                if observed_liquid > risk.liquid_buffer {
                    risk.liquid_buffer = observed_liquid;
                }
            }

            if queue_item.queued_principal > 0 && risk.liquid_buffer > 0 {
                let payout = min_u128(queue_item.queued_principal, risk.liquid_buffer);
                if payout > 0 {
                    let token = IERC20Dispatcher { contract_address: payment_token(pool_id) };
                    let ok = token.transfer(user, u256 { low: payout, high: 0 });
                    if ok {
                        assert!(pool.principal_pool >= payout, "Principal pool accounting mismatch");
                        pool.principal_pool -= payout;
                        if queue_item.queued_principal >= payout {
                            queue_item.queued_principal -= payout;
                        } else {
                            queue_item.queued_principal = 0;
                        }
                        risk.liquid_buffer -= payout;
                        total_payout += payout;
                    }
                }
            }

            if total_payout > 0 {
                queue_item.processed_at = get_block_timestamp();
            }

            world.write_model(@pool);
            world.write_model(@risk);
            world.write_model(@queue_item);
            total_payout
        }

        fn yield_set_admin(
            ref self: ContractState,
            admin: ContractAddress
        ) {
            assert!(admin != zero_address(), "admin cannot be zero");
            let mut world = self.world_default();
            let caller = starknet::get_caller_address();
            let current = read_admin_or_default(ref world);
            if current.admin != zero_address() {
                assert!(caller == current.admin, "Only current admin");
            }
            let next = YieldAdminState { pool_id: YIELD_POOL_STRK_ID, admin };
            world.write_model(@next);
        }

        fn yield_configure_strategy_for_pool(
            ref self: ContractState,
            pool_id: u8,
            strategy_kind: u8,
            adapter: ContractAddress,
            staking_target: ContractAddress,
            rewards_target: ContractAddress,
            enabled: bool,
            paused: bool
        ) {
            assert_supported_pool(pool_id);
            let mut world = self.world_default();
            let caller = starknet::get_caller_address();
            assert_yield_admin(ref world, caller);
            let strategy = YieldStrategyState {
                pool_id,
                strategy_kind,
                adapter,
                staking_target,
                rewards_target,
                enabled,
                paused,
            };
            world.write_model(@strategy);
        }

        fn yield_set_risk_params_for_pool(
            ref self: ContractState,
            pool_id: u8,
            target_buffer_bps: u32,
            max_exposure_bps: u32,
            rebalance_threshold: u128,
            protocol_fee_bps: u32
        ) {
            assert_supported_pool(pool_id);
            assert!(target_buffer_bps <= 10_000, "target_buffer_bps out of range");
            assert!(max_exposure_bps <= 10_000, "max_exposure_bps out of range");
            assert!(protocol_fee_bps <= 10_000, "protocol_fee_bps out of range");
            let mut world = self.world_default();
            let caller = starknet::get_caller_address();
            assert_yield_admin(ref world, caller);
            let mut risk = read_risk_state_or_default(ref world, pool_id);
            risk.target_buffer_bps = target_buffer_bps;
            risk.max_exposure_bps = max_exposure_bps;
            risk.rebalance_threshold = rebalance_threshold;
            risk.protocol_fee_bps = protocol_fee_bps;
            world.write_model(@risk);
        }

        fn yield_rebalance_pool(ref self: ContractState, pool_id: u8) {
            let mut world = self.world_default();
            rebalance_pool_impl(ref world, pool_id);
        }

        fn yield_harvest_pool(ref self: ContractState, pool_id: u8) -> u128 {
            let mut world = self.world_default();
            harvest_pool_impl(ref world, pool_id)
        }

        fn yield_get_user_state(
            self: @ContractState,
            user: ContractAddress
        ) -> (u128, u128, u128, bool, u8, u128, u128, u32) {
            let mut world = self.world_default();
            let position = read_yield_position_or_default(ref world, user);
            let queue_item = read_exit_queue_or_default(ref world, user);
            let pool_id = pool_id_from_mode(position.use_btc_mode);
            let pool = read_yield_pool_or_default(ref world, pool_id);
            let risk = read_risk_state_or_default(ref world, pool_id);
            (
                position.principal,
                position.pending_rewards,
                queue_item.queued_principal,
                position.use_btc_mode,
                pool_id,
                pool.earnings_pool,
                risk.liquid_buffer,
                pool.apr_bps
            )
        }
    }

    #[generate_trait]
    impl InternalImpl of InternalTrait {
        fn world_default(self: @ContractState) -> dojo::world::WorldStorage {
            self.world(@"di")
        }
    }

    #[cfg(test)]
    mod tests {
        use super::{
            YIELD_POOL_BTC_ID, YIELD_POOL_STRK_ID, assert_supported_pool, min_u128, paid_post_price,
            pool_id_from_mode, ratio_amount
        };

        #[test]
        fn test_ratio_amount_handles_zero_values() {
            assert(ratio_amount(0, 5000) == 0, 'ratio zero base');
            assert(ratio_amount(1000, 0) == 0, 'ratio zero bps');
        }

        #[test]
        fn test_ratio_amount_bps_conversion() {
            // 25% of 2000 = 500
            assert(ratio_amount(2000, 2500) == 500, 'ratio 25 percent');
            // 100% of amount should be unchanged.
            assert(ratio_amount(123456789, 10000) == 123456789, 'ratio 100 percent');
        }

        #[test]
        fn test_min_u128_selects_smaller_value() {
            assert(min_u128(3, 9) == 3, 'min first');
            assert(min_u128(9, 3) == 3, 'min second');
            assert(min_u128(7, 7) == 7, 'min equal');
        }

        #[test]
        fn test_paid_post_price_growth() {
            assert(paid_post_price(0) == 0, 'size 0 no price');
            assert(paid_post_price(1) == 0, 'size 1 free');
            assert(paid_post_price(2) == 1, 'size 2 base');
            assert(paid_post_price(3) == 4, 'size 3');
            assert(paid_post_price(4) == 16, 'size 4');
            assert(paid_post_price(5) == 64, 'size 5');
        }

        #[test]
        fn test_pool_id_from_mode_mapping() {
            assert(pool_id_from_mode(false) == YIELD_POOL_STRK_ID, 'strk pool id');
            assert(pool_id_from_mode(true) == YIELD_POOL_BTC_ID, 'btc pool id');
        }

        #[test]
        fn test_assert_supported_pool_accepts_known_ids() {
            assert_supported_pool(YIELD_POOL_STRK_ID);
            assert_supported_pool(YIELD_POOL_BTC_ID);
        }

        #[test]
        #[should_panic]
        fn test_assert_supported_pool_rejects_invalid_id() {
            assert_supported_pool(9);
        }
    }
}
