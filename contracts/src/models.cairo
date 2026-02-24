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
}

#[derive(Copy, Drop, Serde)]
#[dojo::model]
pub struct PostCounter {
    #[key]
    pub counter_id: u8, // Always 0, used as singleton
    pub count: u64,
}
