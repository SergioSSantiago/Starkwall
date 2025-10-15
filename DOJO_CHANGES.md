# Dojo Contract Changes for Posts

## Overview

The Dojo contracts have been adapted from the basic movement example to support a post-based system matching your frontend requirements.

## Changes Made

### 1. Models (`contracts/src/models.cairo`)

**Removed:**

- `Position` model (player movement)
- `Moves` model (move counter)
- `Direction` enum

**Added:**

- **`Post` model** - Stores individual posts with:

  - `id: u64` - Unique post identifier (key)
  - `image_url: ByteArray` - URL of the post image
  - `caption: ByteArray` - Post caption text
  - `x_position: i32` - X coordinate (supports negative values)
  - `y_position: i32` - Y coordinate (supports negative values)
  - `size: u8` - Post size (always 1)
  - `is_paid: bool` - Whether it's a paid/premium post
  - `created_at: u64` - Timestamp when post was created
  - `created_by: ContractAddress` - Address of post creator
  - `current_owner: ContractAddress` - Current owner of the post

- **`PostCounter` model** - Singleton counter for auto-incrementing post IDs
  - `counter_id: u8` - Always 0 (used as singleton key)
  - `count: u64` - Current count of posts

### 2. Actions (`contracts/src/systems/actions.cairo`)

**Removed:**

- `spawn()` - Player spawning
- `move()` - Player movement
- `move_random()` - Random movement
- VRF provider integration

**Added:**

- **`create_post()`** - Creates a new post
  - **Parameters:**
    - `image_url: ByteArray` - Image URL
    - `caption: ByteArray` - Caption text
    - `x_position: i32` - X coordinate
    - `y_position: i32` - Y coordinate
    - `is_paid: bool` - Premium post flag
  - **Returns:** `u64` - The ID of the newly created post
  - **Automatically sets:**
    - `id` - Auto-incremented from counter
    - `size` - Always 1
    - `created_at` - Current block timestamp
    - `created_by` - Caller's address
    - `current_owner` - Caller's address

## How to Use

### 1. Deploy/Migrate Contracts

```bash
cd contracts

# Build contracts
sozo build

# Start local Katana devnet (in a separate terminal)
katana --disable-fee

# Migrate/deploy contracts
sozo migrate apply

# Start Torii indexer (in another terminal)
torii --world <WORLD_ADDRESS>
```

### 2. Frontend Integration

The frontend needs to be updated to:

1. **Connect to Dojo** instead of using mock data
2. **Query posts** from Torii (the indexer)
3. **Create posts** by calling the `create_post` action

#### Example: Creating a Post

```javascript
// Using the controller account
const tx = await account.execute({
  contractAddress: manifest.contracts.find((c) => c.tag === "di-actions")
    .address,
  entrypoint: "create_post",
  calldata: [
    // image_url (ByteArray)
    imageUrl.length,
    ...imageUrlBytes,
    // caption (ByteArray)
    caption.length,
    ...captionBytes,
    // x_position (i32)
    x_position,
    // y_position (i32)
    y_position,
    // is_paid (bool)
    is_paid ? 1 : 0,
  ],
});
```

#### Example: Querying Posts

```javascript
// Query all posts from Torii
const { data } = await toriiClient.getEntities({
  clause: {
    Keys: {
      keys: [],
      pattern_matching: "VariableLen",
      models: ["di-Post"],
    },
  },
});
```

## Data Mapping

Frontend Post → Dojo Post Model:

- `id` → `id`
- `image_url` → `image_url`
- `caption` → `caption`
- `x_position` → `x_position`
- `y_position` → `y_position`
- `size` → `size` (always 1)
- `is_paid` → `is_paid`
- `created_at` → `created_at` (Unix timestamp)
- `created_by` → `created_by` (ContractAddress)
- `current_owner` → `current_owner` (ContractAddress)

## Next Steps

1. Deploy the contracts to your local Katana instance
2. Update the frontend to use Dojo SDK instead of mock data
3. Connect Torii to listen for new posts
4. Update `postManager.js` to call the `create_post` action
5. Query posts from Torii and display them on the canvas

## Notes

- The contract namespace is `"di"` (dojo_intro)
- Posts are permanently stored on-chain
- Post IDs auto-increment starting from 1
- All posts have `size: 1` (one phone screen size)
- Timestamps are Unix timestamps from `get_block_timestamp()`
