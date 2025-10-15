# 🌌 Starkwall

> A decentralized social media platform where posts exist as permanent, ownable tiles on an infinite canvas — powered by Dojo on Starknet.

## 🎯 What is Starkwall?

Starkwall reimagines social media by combining **blockchain ownership** with an **infinite canvas interface**. Unlike traditional social platforms where your content exists in a corporate database, here every post is a permanent, verifiable asset on the Starknet blockchain that you truly own.

### The Core Concept

- **🗺️ Infinite Canvas**: Posts are arranged on an unlimited 2D grid, creating a visual, explorable social space
- **🔗 Blockchain-Native**: Every post is minted on-chain with permanent ownership records
- **📍 Adjacent Growth**: New posts must connect to existing ones, creating organic community clusters
- **🎨 Visual Feed**: Navigate through posts like exploring a living art gallery instead of scrolling a feed

## ✨ Key Features

### Current Implementation

- ✅ **Wallet-Based Authentication** via Cartridge Controller
- ✅ **On-Chain Post Creation** with images, captions, and metadata
- ✅ **Real-Time Sync** between blockchain and UI using Torii indexer
- ✅ **Infinite Canvas Navigation** with smooth zoom and pan
- ✅ **Ownership Display** showing current owner on each post (Instagram-style)
- ✅ **Adjacent Positioning** ensuring posts form connected networks
- ✅ **Persistent Storage** - posts survive page reloads and exist permanently on-chain

### Smart Contract Architecture

```cairo
struct Post {
    id: u32,                          // Unique post identifier
    image_url: ByteArray,             // IPFS or CDN URL
    caption: ByteArray,               // Post description
    x_position: i32,                  // X coordinate on canvas
    y_position: i32,                  // Y coordinate on canvas
    size: u8,                         // Post size (standardized)
    is_paid: bool,                    // Payment status
    created_at: u64,                  // Unix timestamp
    created_by: ContractAddress,      // Original creator
    current_owner: ContractAddress,   // Current owner
}
```

## 🏗️ Tech Stack

### Blockchain Layer

- **[Dojo Engine](https://book.dojoengine.org/)** - Entity Component System framework for Starknet
- **[Starknet](https://www.starknet.io/)** - Layer 2 scaling solution on Ethereum
- **[Cairo](https://www.cairo-lang.org/)** - Smart contract language
- **[Torii](https://book.dojoengine.org/toolchain/torii/overview.html)** - Real-time indexer for Dojo worlds

### Frontend

- **Vanilla JavaScript** with Vite for fast development
- **HTML5 Canvas** for infinite 2D rendering
- **[Cartridge Controller](https://docs.cartridge.gg/)** for seamless wallet integration
- **[Dojo.js SDK](https://book.dojoengine.org/client/sdk/javascript)** for blockchain interaction

## 🚀 Quick Start

### Prerequisites

1. **Dojo Toolchain** (0.7.15 or later)

   ```bash
   curl -L https://raw.githubusercontent.com/dojoengine/dojo/main/dojoup/asdf-install | bash
   ```

2. **Node.js** (v18+) and **pnpm**

   ```bash
   npm install -g pnpm
   ```

3. **Cartridge CLI** (for wallet integration)
   ```bash
   curl -L https://raw.githubusercontent.com/cartridge-gg/controller/main/controllerup/install | bash
   controllerup --install
   ```

### Installation & Setup

You'll need **4 terminal windows** to run the full stack:

#### Terminal 1: Katana (Local Blockchain)

```bash
cd contracts
katana --config katana.toml
```

Wait for: `✓ Accounts | seed used to generate random accounts`

#### Terminal 2: Deploy Contracts

```bash
cd contracts
sozo build && sozo migrate
```

Wait for: `✓ Successfully migrated World at address`

#### Terminal 3: Torii (Indexer)

```bash
cd contracts
torii --config torii.toml --world <WORLD_ADDRESS_FROM_TERMINAL_2>
```

Wait for: `Starting torii endpoint on http://localhost:8080`

#### Terminal 4: Frontend

```bash
cd client
pnpm install
pnpm run dev
```

Open the URL shown (should be `https://localhost:5173`)

### 🎮 Using the App

1. **Click "Connect Wallet"** - Cartridge Controller popup will appear
2. **Authorize the connection** - This allows the app to interact with your wallet
3. **Explore existing posts** - Use mouse drag to pan, scroll to zoom
4. **Create your first post** - Click "Add Post", enter an image URL and caption
5. **Wait for confirmation** - Transaction will be sent to blockchain (~5 seconds)
6. **Post appears!** - Your new post is now permanently on-chain

## 📂 Project Structure

```
dojo-intro/
├── contracts/               # Dojo smart contracts (Cairo)
│   ├── src/
│   │   ├── lib.cairo       # Contract entry point
│   │   ├── models.cairo    # Post & PostCounter models
│   │   └── systems/
│   │       └── actions.cairo   # create_post system
│   ├── Scarb.toml          # Cairo dependencies
│   ├── katana.toml         # Local blockchain config
│   └── torii.toml          # Indexer config
│
├── client/                  # Frontend application
│   ├── main.js             # Entry point, Dojo initialization
│   ├── dojoManager.js      # Blockchain interaction layer
│   ├── postManager.js      # Post state management
│   ├── canvas.js           # Infinite canvas renderer
│   ├── controller.js       # Cartridge wallet config
│   ├── utils.js            # Type conversion helpers
│   └── index.html          # HTML structure
│
└── README.md               # You are here!
```

## 🔧 How It Works

### 1. Post Creation Flow

```
User clicks "Add Post"
    ↓
postManager.createPost()
    ↓
dojoManager.createPost() - Converts data to Cairo types
    ↓
Smart Contract: create_post() - Writes to Starknet
    ↓
Torii indexes new entity (~5 seconds)
    ↓
postManager.loadPosts() - Queries Torii
    ↓
Canvas updates - New post appears!
```

### 2. Position Algorithm

- **First Post**: Always at origin `(0, 0)`
- **Subsequent Posts**: Scans adjacent positions (top, right, bottom, left)
- **No Overlaps**: Ensures each post occupies unique coordinates
- **Organic Growth**: Creates connected networks of posts

### 3. Data Synchronization

- **Real-time Subscriptions**: Torii notifies frontend of new posts
- **GraphQL Queries**: Efficient data fetching on page load
- **Optimistic Updates**: UI updates after blockchain confirmation

## 🎨 Why This Matters

### For Users

- **True Ownership**: Your posts are yours forever, no platform can delete them
- **Visual Discovery**: Explore content spatially instead of algorithmically
- **Community Clustering**: Related posts naturally group together
- **Transparent History**: Every action is verifiable on-chain

### For Developers

- **Composability**: Other apps can build on this social graph
- **Censorship Resistance**: Decentralized storage and verification
- **Monetization**: Built-in payment rails for premium features
- **Scalability**: Starknet's L2 ensures low costs and high throughput

## 🐛 Troubleshooting

### Cartridge Controller Won't Connect

- ✅ Use **Google Chrome** (best compatibility)
- ✅ Ensure the "Connect Wallet" button is clicked (browser blocks auto-popups)
- ✅ Check Terminal 1 - Katana must be running
- ✅ Disable popup blockers for `localhost:5173`

### Posts Not Loading

1. Open browser console (F12)
2. Check for `✅ Loaded X posts` message
3. If "0 posts", verify Terminal 3 (Torii) is running
4. Try GraphQL query at `http://localhost:8080/graphql`:
   ```graphql
   query {
     entities(keys: ["%%"]) {
       edges {
         node {
           models {
             __typename
           }
         }
       }
     }
   }
   ```

### Transaction Fails

- **"Controller not connected"**: Reconnect wallet
- **"Contract not found"**: Redeploy contracts (Terminal 2)
- **"Execution reverted"**: Check Katana logs (Terminal 1) for error details

### More Help

See [`QUICK_START.md`](./QUICK_START.md) for detailed troubleshooting steps.

## 🔮 Future Roadmap

### Phase 2: Social Features

- [ ] Like & comment systems
- [ ] User profiles and galleries
- [ ] Follow/follower relationships
- [ ] Post collections (bookmarks)

### Phase 3: Economic Layer

- [ ] Paid posts with premium content
- [ ] Post trading/ownership transfer
- [ ] Creator royalties on resales
- [ ] Advertising on adjacent posts

### Phase 4: Advanced Canvas

- [ ] Different post sizes (1x1, 2x2, 1x2)
- [ ] Video and audio support
- [ ] Interactive posts (polls, quizzes)
- [ ] Themes and customization

### Phase 5: Scalability

- [ ] IPFS integration for images
- [ ] Layer 3 for ultra-low costs
- [ ] Mobile app (iOS/Android)
- [ ] Browser extension

## 🤝 Contributing

This is a hackathon project, but contributions are welcome! Areas of interest:

- UI/UX improvements
- Smart contract optimizations
- Mobile responsiveness
- Documentation

## 📄 License

MIT License - feel free to fork and build upon this concept!

## 🙏 Acknowledgments

- **[Dojo Team](https://dojoengine.org/)** for the incredible ECS framework
- **[Cartridge](https://cartridge.gg/)** for seamless wallet UX
- **[Starknet Foundation](https://www.starknet.io/)** for making scalable blockchain possible
- The entire **Starknet community** for inspiration and support

---

**Built with ❤️ for the Starknet ecosystem**

Questions? Issues? Ideas? Open an issue or reach out!
