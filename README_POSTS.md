# Dojo Posts - On-Chain Social Canvas

A decentralized social media canvas built with Dojo where posts are stored on-chain and displayed on an infinite pannable canvas.

## 🎯 Overview

This project adapts the Dojo starter template to create an on-chain post system where:

- Posts are stored as NFTs on Starknet
- Each post has a position on an infinite 2D canvas
- Posts are displayed like Instagram stories in a grid layout
- Users can create posts that are permanently stored on-chain
- All posts have a consistent phone screen size (393×852px)

## 📁 Project Structure

```
dojo-intro/
├── contracts/              # Cairo smart contracts
│   ├── src/
│   │   ├── models.cairo   # Post and PostCounter models
│   │   └── systems/
│   │       └── actions.cairo  # create_post action
│   ├── Scarb.toml
│   └── manifest_dev.json
│
├── client/                # Frontend application
│   ├── canvas.js         # Infinite canvas renderer
│   ├── postManager.js    # Post management (mock + Dojo)
│   ├── dojoManager.js    # Dojo blockchain interface
│   ├── utils.js          # ByteArray utilities
│   ├── controller.js     # Wallet configuration
│   ├── spiralLayout.js   # Post layout logic
│   ├── main.js          # App entry point
│   ├── index.html       # HTML UI
│   └── style.css        # Styles
│
└── Documentation/
    ├── DOJO_CHANGES.md          # Contract changes
    └── FRONTEND_INTEGRATION.md  # Frontend integration guide
```

## 🚀 Quick Start

### 1. Install Dependencies

```bash
# Install Dojo (if not installed)
curl -L https://install.dojoengine.org | bash
dojoup

# Install Node dependencies
cd client
npm install
```

### 2. Run with Mock Data (No Blockchain)

```bash
cd client
npm run dev
```

Open `http://localhost:5173` and you'll see 4 mock posts on the canvas.

### 3. Run with Dojo (On-Chain)

**Terminal 1 - Start Katana (Local Devnet):**

```bash
cd contracts
katana --disable-fee
```

**Terminal 2 - Deploy Contracts:**

```bash
cd contracts
sozo build
sozo migrate apply
```

**Terminal 3 - Start Torii (Indexer):**

```bash
torii --world <WORLD_ADDRESS_FROM_MIGRATION>
```

**Terminal 4 - Start Frontend:**

```bash
cd client
npm run dev
```

Then connect your wallet in the UI to switch to Dojo mode.

## 📝 Post Model

Each post contains:

| Field           | Type            | Description                       |
| --------------- | --------------- | --------------------------------- |
| `id`            | u64             | Unique auto-incremented ID        |
| `image_url`     | ByteArray       | URL of the image                  |
| `caption`       | ByteArray       | Post caption text                 |
| `x_position`    | i32             | X coordinate on canvas            |
| `y_position`    | i32             | Y coordinate on canvas            |
| `size`          | u8              | Always 1 (one phone screen)       |
| `is_paid`       | bool            | Premium post flag (golden border) |
| `created_at`    | u64             | Unix timestamp                    |
| `created_by`    | ContractAddress | Creator's address                 |
| `current_owner` | ContractAddress | Current owner's address           |

## 🎨 Features

### Canvas

- ✅ Infinite pannable 2D canvas
- ✅ Zoom in/out (0.1x - 1.0x)
- ✅ Mouse and touch controls
- ✅ Grid background for alignment
- ✅ Smooth rendering with clipping

### Posts

- ✅ Uniform phone screen size (393×852px)
- ✅ Images with "cover" fit (cropped to fill)
- ✅ Owner name displayed at top
- ✅ Caption overlay at bottom
- ✅ Golden border for paid posts
- ✅ Auto-placement next to existing posts

### Blockchain

- ✅ On-chain post storage
- ✅ Auto-incrementing post IDs
- ✅ Wallet integration via Cartridge Controller
- ✅ Real-time updates via Torii subscriptions
- ✅ Transaction confirmation

## 🔧 Smart Contracts

### Models

**Post Model** (`models.cairo`):

```cairo
#[derive(Drop, Serde)]
#[dojo::model]
pub struct Post {
    #[key]
    pub id: u64,
    pub image_url: ByteArray,
    pub caption: ByteArray,
    pub x_position: i32,
    pub y_position: i32,
    pub size: u8,
    pub is_paid: bool,
    pub created_at: u64,
    pub created_by: ContractAddress,
    pub current_owner: ContractAddress,
}
```

**PostCounter Model** (for auto-increment):

```cairo
#[derive(Copy, Drop, Serde)]
#[dojo::model]
pub struct PostCounter {
    #[key]
    pub counter_id: u8,
    pub count: u64,
}
```

### Actions

**create_post** (`systems/actions.cairo`):

```cairo
fn create_post(
    ref self: ContractState,
    image_url: ByteArray,
    caption: ByteArray,
    x_position: i32,
    y_position: i32,
    is_paid: bool
) -> u64
```

Creates a new post and returns its ID.

## 💻 Frontend API

### DojoManager

```javascript
import { DojoManager } from "./dojoManager.js";

const dojoManager = new DojoManager(account, manifest, toriiClient);

// Create a post
await dojoManager.createPost(
  "https://example.com/image.jpg",
  "My awesome post!",
  393, // x position
  0, // y position
  false // is_paid
);

// Query all posts
const posts = await dojoManager.queryAllPosts();
```

### PostManager

```javascript
import { PostManager } from "./postManager.js";

// Mock mode (no Dojo)
const postManager = new PostManager(canvas);

// Dojo mode
const postManager = new PostManager(canvas, dojoManager);

// Load posts
await postManager.loadPosts();

// Create post (auto-positions next to existing posts)
await postManager.createPost(imageUrl, caption, 1, isPaid);
```

## 🎮 Controls

### Mouse/Trackpad

- **Click + Drag**: Pan the canvas
- **Scroll**: Zoom in/out
- **Buttons**: Add posts, reset view

### Touch (Mobile)

- **Single finger drag**: Pan
- **Two finger pinch**: Zoom
- **Buttons**: Add posts, reset view

## 📊 Data Flow

### Creating a Post (Dojo Mode)

1. User fills form and clicks "Create Post"
2. Frontend finds available position next to existing post
3. DojoManager converts strings to Cairo ByteArray format
4. Transaction sent to create_post action
5. Contract assigns ID, timestamp, and creator
6. Post stored on-chain
7. Torii detects new post
8. Frontend receives update via subscription
9. Post loaded and rendered on canvas

### Creating a Post (Mock Mode)

1. User fills form and clicks "Create Post"
2. Frontend finds available position
3. Post created locally with mock data
4. Image loaded and cached
5. Canvas re-rendered

## 🔐 Security Considerations

- Posts are public and permanent on-chain
- Image URLs should be IPFS or permanent storage
- No post deletion (by design)
- Creator and owner addresses are public
- Transaction fees apply for on-chain posts

## 🛠️ Development

### Build Contracts

```bash
cd contracts
sozo build
```

### Test Contracts

```bash
cd contracts
sozo test
```

### Run Frontend Dev Server

```bash
cd client
npm run dev
```

### Build Frontend for Production

```bash
cd client
npm run build
```

## 📚 Documentation

- [Dojo Book](https://book.dojoengine.org/)
- [Cartridge Controller](https://docs.cartridge.gg/controller)
- [Starknet Documentation](https://docs.starknet.io/)

## 🐛 Troubleshooting

### Posts not showing

- Check console for errors
- Verify images are CORS-enabled
- Ensure Torii is running (Dojo mode)

### Transaction fails

- Check Katana is running
- Verify account has funds
- Check contract is deployed

### ByteArray errors

- Ensure strings are valid UTF-8
- Check string length limits
- Verify conversion in utils.js

## 🚧 Future Enhancements

- [ ] Post ownership transfer
- [ ] Post marketplace
- [ ] Comments on posts
- [ ] Like/reactions
- [ ] Post filtering by owner
- [ ] Search functionality
- [ ] Post deletion/burning (optional)
- [ ] Image upload to IPFS

## 📄 License

MIT License - See LICENSE file for details

## 🙏 Credits

Built with [Dojo](https://dojoengine.org/) - Provable game engine on Starknet
