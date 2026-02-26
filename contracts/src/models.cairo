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
