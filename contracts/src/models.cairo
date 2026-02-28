use starknet::ContractAddress;

// Post size: 1 = free (1x1 tile). Paid = 2, 3, 4... (user chooses size only).
// Position is always assigned at random among adjacent slots (free and paid).
// Paid posts are just bigger tiles; price grows exponentially with size (more visible = more expensive).
#[derive(Drop, Serde)]
#[dojo::model]
pub struct Post {
    #[key]
    pub id: u64,
    pub image_url: ByteArray,
    pub caption: ByteArray,
    pub x_position: i32,
    pub y_position: i32,
    pub size: u8,       // 1 = free, 2+ = paid (2x2, 3x3, 4x4... tiles)
    pub is_paid: bool,
    pub created_at: u64,
    pub created_by: ContractAddress,
    pub creator_username: ByteArray,
    pub current_owner: ContractAddress,
    pub sale_price: u128, // 0 means not for sale
    pub post_kind: u8, // 0=normal, 1=auction_center, 2=auction_slot
    pub auction_group_id: u64, // 0 when not part of an auction group
    pub auction_slot_index: u8, // 0=center/normal, 1..8=slot in 3x3 auction ring
}

#[derive(Copy, Drop, Serde)]
#[dojo::model]
pub struct PostCounter {
    #[key]
    pub counter_id: u8, // Always 0, used as singleton
    pub count: u64,
}

#[derive(Copy, Drop, Serde)]
#[dojo::model]
pub struct AuctionGroup {
    #[key]
    pub group_id: u64,
    pub center_post_id: u64,
    pub creator: ContractAddress,
    pub end_time: u64,
    pub active: bool,
}

#[derive(Copy, Drop, Serde)]
#[dojo::model]
pub struct AuctionSlot {
    #[key]
    pub slot_post_id: u64,
    pub group_id: u64,
    pub highest_bid: u128, // in STRK (human units, 18 decimals handled on transfer)
    pub highest_bidder: ContractAddress,
    pub has_bid: bool,
    pub finalized: bool,
    pub content_initialized: bool, // winner can set image/caption exactly once
}

#[derive(Copy, Drop, Serde)]
#[dojo::model]
pub struct AuctionCommit {
    #[key]
    pub slot_post_id: u64,
    #[key]
    pub bidder: ContractAddress,
    pub commitment: felt252,
    pub escrow_amount: u128,
    pub committed_at: u64,
    pub revealed: bool,
    pub revealed_bid: u128,
    pub reveal_nullifier: felt252,
    pub refunded: bool,
}

#[derive(Copy, Drop, Serde)]
#[dojo::model]
pub struct AuctionSealedConfig {
    #[key]
    pub group_id: u64,
    pub sealed_mode: bool,
    pub commit_end_time: u64,
    pub reveal_end_time: u64,
    pub verifier: ContractAddress,
}

#[derive(Copy, Drop, Serde)]
#[dojo::model]
pub struct AuctionRevealNullifier {
    #[key]
    pub nullifier: felt252,
    pub used: bool,
}

#[derive(Drop, Serde)]
#[dojo::model]
pub struct UserProfile {
    #[key]
    pub user: ContractAddress,
    pub username: ByteArray,
    pub username_norm_hash: felt252,
    pub schema_version: u8,
}

#[derive(Copy, Drop, Serde)]
#[dojo::model]
pub struct UsernameIndex {
    #[key]
    pub username_norm_hash: felt252,
    pub user: ContractAddress,
    pub schema_version: u8,
}

#[derive(Copy, Drop, Serde)]
#[dojo::model]
pub struct FollowRelation {
    #[key]
    pub follower: ContractAddress,
    #[key]
    pub following: ContractAddress,
    pub created_at: u64,
    pub schema_version: u8,
}

#[derive(Copy, Drop, Serde)]
#[dojo::model]
pub struct FollowStats {
    #[key]
    pub user: ContractAddress,
    pub followers_count: u64,
    pub following_count: u64,
    pub schema_version: u8,
}

#[derive(Copy, Drop, Serde)]
#[dojo::model]
pub struct YieldPoolState {
    #[key]
    pub pool_id: u8, // singleton key = 0
    pub principal_pool: u128, // total principal deposited by users
    pub earnings_pool: u128, // rewards reserve used to pay claims
    pub total_pending_rewards: u128, // accounting for user-earned rewards not yet claimed
    pub apr_bps: u32, // deprecated, kept for backward compatibility
    pub reward_index: u128, // cumulative user rewards per principal unit (scaled)
    pub user_share_bps: u32, // share of harvested net rewards routed to users
}

#[derive(Copy, Drop, Serde)]
#[dojo::model]
pub struct YieldPosition {
    #[key]
    pub user: ContractAddress,
    pub principal: u128,
    pub pending_rewards: u128,
    pub last_accrual_ts: u64,
    pub use_btc_mode: bool,
    pub reward_index_snapshot: u128,
}

#[derive(Copy, Drop, Serde)]
#[dojo::model]
pub struct YieldStrategyState {
    #[key]
    pub pool_id: u8, // singleton key = 0
    pub strategy_kind: u8, // 0=none, 1=mock, 2=official-native
    pub adapter: ContractAddress, // adapter contract address used by actions
    pub staking_target: ContractAddress, // external staking contract/entrypoint receiver
    pub rewards_target: ContractAddress, // optional rewards receiver/source
    pub enabled: bool,
    pub paused: bool,
}

#[derive(Copy, Drop, Serde)]
#[dojo::model]
pub struct YieldRiskState {
    #[key]
    pub pool_id: u8, // singleton key = 0
    pub liquid_buffer: u128, // immediately liquid principal available for withdrawals
    pub staked_principal: u128, // principal currently deployed into strategy
    pub target_buffer_bps: u32, // desired min liquid buffer as bps of principal
    pub max_exposure_bps: u32, // hard cap for % of principal deployed to strategy
    pub rebalance_threshold: u128, // minimum delta before moving funds in/out strategy
    pub protocol_fee_bps: u32, // fee cut from harvested rewards before earnings_pool credit
    pub last_harvest_ts: u64,
}

#[derive(Copy, Drop, Serde)]
#[dojo::model]
pub struct YieldExitQueue {
    #[key]
    pub user: ContractAddress,
    pub queued_principal: u128,
    pub requested_at: u64,
    pub processed_at: u64,
}

#[derive(Copy, Drop, Serde)]
#[dojo::model]
pub struct YieldAdminState {
    #[key]
    pub pool_id: u8, // singleton key = 0
    pub admin: ContractAddress,
}

