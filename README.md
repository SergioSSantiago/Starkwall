<p align="center">
  <img src="./client/logo-wall.svg" alt="Starkwall logo" width="72" />
</p>

# Starkwall

Starkwall is an onchain social canvas on Starknet built with Dojo, Torii, and Cartridge Controller.

## Live Deployment

- **Production URL:** `https://www.starkwall.com`
- **Network:** Starknet Sepolia

## Current Product Status

### Stable and validated

- Wallet auth and session restore with Cartridge Controller
- Onchain post creation (free/paid), marketplace listing/purchase, and ownership transfer
- Auction flow (3x3 groups, bids, finalization, winner slot content)
- Social graph (profile, follow, unfollow, followers/following UI)
- STRK yield flow:
  - deposit (`+`)
  - return to balance (`↩`)
  - claim rewards (`✨`)
  - queue handling and direct onchain state reads

### Integrated but pending practical validation

- WBTC strategy path is fully wired (contracts + frontend + wallet policies), but user E2E validation depends on obtaining WBTC test liquidity in Sepolia.

## Tech Stack

- **Contracts:** Cairo `2.12.2`, Dojo `1.7.1`
- **Indexer:** Torii
- **Frontend:** Vanilla JS + Vite
- **Wallet:** Cartridge Controller
- **Environments:** local Katana + Starknet Sepolia

## Feature Inventory (Actual Behavior)

### Wallet and auth

- Connect/disconnect via Cartridge Controller
- Session restore when available
- Network-aware runtime behavior (`dev` vs `sepolia`)

### Posts

- Free and paid post creation onchain
- Contract-level constraints:
  - no negative coordinates
  - no overlap
- Paid post pricing is size-based exponential

### Marketplace

- Owner can set/remove sale price
- Buyer flow uses token approval + contract purchase
- Ownership is transferred onchain

### Auctions

- Create 3x3 auction groups
- Place bids with previous top-bid refund logic
- Finalize slots after end time
- Winner can publish slot content

### Social

- Set unique profile username
- Follow/unfollow
- Follower/following counters and modals

### Yield

- Two pools in contract logic:
  - pool `0`: STRK
  - pool `1`: BTC-wrapper strategy (currently WBTC config in Sepolia)
- Direct view method `yield_get_user_state` is used by frontend as source of truth (Torii fallback if needed)
- Queue processing, harvest, and rebalance entrypoints are permissionless calls

## Contracts Overview

Main system contract:
- `contracts/src/systems/actions.cairo` (`di-actions`)

Adapter contracts:
- `contracts/src/systems/yield_adapter.cairo`
  - `mock_native_staking_adapter`
  - `official_native_staking_adapter`

Primary entrypoint groups in `di-actions`:
- Posts: `create_post`, `set_post_price`, `buy_post`
- Auctions: `create_auction_post_3x3`, `place_bid`, `finalize_auction_slot`, `set_won_slot_content`
- Social: `set_profile`, `follow`, `unfollow`
- Yield user: `yield_deposit`, `yield_withdraw`, `yield_claim`, `yield_set_btc_mode`
- Yield operations: `yield_harvest`, `yield_rebalance`, `yield_process_exit_queue`
- Yield admin: `yield_set_admin`, `yield_configure_strategy_for_pool`, `yield_set_risk_params_for_pool`, `yield_rebalance_pool`, `yield_harvest_pool`
- Yield view: `yield_get_user_state`

## Important Addresses (Sepolia config)

- STRK: `0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d`
- WBTC: `0x00452bd5c0512a61df7c7be8cfea5e4f893cb40e126bdc40aee6054db955129e`

## Local Development

### Prerequisites

- Dojo/Sozo toolchain compatible with this repo (Sozo `1.8.6` used in operations)
- Node.js 18+
- pnpm 10+

### Run locally

1) Start Katana
```bash
cd contracts
katana --config katana.toml
```

2) Build and migrate contracts
```bash
cd contracts
sozo build
sozo migrate
```

3) Start Torii
```bash
cd contracts
torii --config torii.toml
```

4) Start frontend
```bash
cd client
pnpm install
pnpm run dev
```

## Client Env Vars

Defined in `client/config.js`:

- `VITE_NETWORK` (`dev` | `sepolia`)
- `VITE_RPC_URL`
- `VITE_TORII_URL`
- `VITE_STRK_TOKEN` (optional override)
- `VITE_FAUCET_URL` (local/dev helper)
- `VITE_WBTC_FAUCET_URL` (optional UI helper)
- `VITE_SEALED_RELAY_URL` (sealed automation + optional media upload endpoint)
- `VITE_MEDIA_UPLOAD_URL` (recommended: `${VITE_SEALED_RELAY_URL}/media/upload`)
- `VITE_YIELD_DUAL_POOL_ENABLED`
- Optional yield metadata:
  - `VITE_YIELD_STRATEGY_KIND`
  - `VITE_YIELD_ADAPTER_ADDRESS`
  - `VITE_YIELD_STAKING_TARGET`
  - `VITE_YIELD_REWARDS_TARGET`
  - `VITE_YIELD_OPERATIONAL_TARGET`
  - `VITE_YIELD_MODE`

## Yield Operations and Keeper

- GitHub Actions cron keeper is intentionally removed.
- If needed, run the local script manually:

```bash
./scripts/yield-keeper.sh sepolia 30
```

## Known Caveats

- WBTC test acquisition on Sepolia can be difficult and is the main blocker for BTC-path E2E user testing.
- If Torii lags, frontend still relies on direct onchain yield view.
- Yield admin protections apply after admin initialization.
- Large inline `data:image/...` payloads can exceed Starknet tx L2 gas bounds; configure media upload to store URLs onchain instead.

## Relay Media Upload (Recommended)

To avoid `Insufficient max L2Gas` in post/auction creation, upload media off-chain and store only the URL in `image_url`.

`sealed-relayer-server.js` supports `POST /media/upload` providers:

- `SEALED_RELAY_MEDIA_PROVIDER=ipfs_pinata` (recommended for IPFS flow)
- `SEALED_RELAY_MEDIA_PROVIDER=cloudflare_images`
- `SEALED_RELAY_MEDIA_PROVIDER=local` (local/dev only)

IPFS (Pinata) env vars:

- `SEALED_RELAY_PINATA_JWT`
- `SEALED_RELAY_IPFS_GATEWAY_BASE_URL` (optional, default `https://gateway.pinata.cloud/ipfs`)

Cloudflare Images env vars (alternative):

- `SEALED_RELAY_CF_ACCOUNT_ID`
- `SEALED_RELAY_CF_IMAGES_API_TOKEN`
- `SEALED_RELAY_PUBLIC_BASE_URL` (optional)

Optional shared vars:

- `SEALED_RELAY_MEDIA_MAX_BYTES` (default `1500000`)
- `SEALED_RELAY_MEDIA_LOCAL_DIR` (used by `local` provider)

## Repo Structure

```text
contracts/
  src/
    models.cairo
    systems/
      actions.cairo
      yield_adapter.cairo
  dojo_dev.toml
  dojo_sepolia.toml
  torii.toml
  torii_sepolia.toml

client/
  main.js
  dojoManager.js
  postManager.js
  controller.js
  config.js
  canvas.js
  index.html
  style.css

scripts/
  faucet.sh
  yield-e2e.sh
  yield-keeper.sh
```

# Starkwall

Starkwall is an onchain social canvas on Starknet built with Dojo + Torii + Cartridge Controller.

The app combines:
- immutable post ownership,
- social graph actions (profile/follow),
- marketplace and auctions,
- yield flows with a live STRK pool and a WBTC strategy path.

## Current Status

What is production-ready today:
- STRK staking flow (deposit/withdraw/claim/queue processing) is live and validated on Sepolia.
- Social and post marketplace flows are live.
- Auction flows are live (3x3 auction groups, bidding, finalization, winner content).

What is integrated but still pending practical validation:
- WBTC strategy path is wired end-to-end (contract + client + policies), but Sepolia test liquidity/acquisition remains the blocker for full user validation.

## Tech Stack

- **Contracts:** Cairo 2.12.2, Dojo 1.7.1
- **Indexer:** Torii
- **Frontend:** Vanilla JS + Vite
- **Wallet:** Cartridge Controller
- **Network targets:** local Katana + Starknet Sepolia

## What The App Actually Does

### Wallet & Auth

- Connects via Cartridge Controller.
- Restores previous session when possible.
- Uses manifest-gated feature policies (if an entrypoint is missing in manifest, related UI/actions are disabled or degraded gracefully).

### Posts

- Creates free or paid posts onchain.
- Enforces non-negative coordinates and no overlap at contract level.
- Paid posts use exponential pricing by size.
- Stores image/caption as Cairo byte arrays.

### Marketplace

- Post owners can list/unlist posts with a sale price.
- Buyers purchase through ERC20 approval + contract purchase.
- Ownership updates onchain.

### Auctions

- Creates 3x3 auction groups:
  - center tile (auction center),
  - 8 auction slots.
- Supports bidding, refund of previous top bidder, finalization, and winner slot content publishing.

### Social

- Profile username set onchain with uniqueness index.
- Follow/unfollow onchain.
- Follower/following counts and modals in UI.

### Yield

- Two pools in contract logic:
  - pool `0`: STRK
  - pool `1`: BTC wrapper strategy (currently configured to WBTC address in Sepolia setup)
- User flow:
  - deposit (`+`),
  - return to balance (`↩`, including queued exits),
  - claim rewards (`✨`).
- Contract exposes `yield_get_user_state` for direct onchain reads (frontend uses this first, Torii fallback second).
- Queue processing and rebalance/harvest are permissionless calls.

## Contract Surface (High Level)

Main system contract: `contracts/src/systems/actions.cairo` (`di-actions` tag).

Core families of entrypoints:
- Posts: `create_post`, `set_post_price`, `buy_post`
- Auctions: `create_auction_post_3x3`, `place_bid`, `finalize_auction_slot`, `set_won_slot_content`
- Social: `set_profile`, `follow`, `unfollow`
- Yield user: `yield_deposit`, `yield_withdraw`, `yield_claim`, `yield_set_btc_mode`
- Yield operations: `yield_harvest`, `yield_rebalance`, `yield_process_exit_queue`
- Yield admin: `yield_set_admin`, `yield_configure_strategy_for_pool`, `yield_set_risk_params_for_pool`, `yield_rebalance_pool`, `yield_harvest_pool`
- Yield view: `yield_get_user_state`

Adapter contracts live in `contracts/src/systems/yield_adapter.cairo`:
- `mock_native_staking_adapter`
- `official_native_staking_adapter`

## Local Development

### Prerequisites

- `sozo` / Dojo toolchain compatible with project (`1.8.6` used in this repo flow)
- Node.js 18+
- `pnpm` 10+

### 1) Start Katana

```bash
cd contracts
katana --config katana.toml
```

### 2) Build and migrate contracts

```bash
cd contracts
sozo build
sozo migrate
```

### 3) Start Torii

```bash
cd contracts
torii --config torii.toml
```

### 4) Start frontend

```bash
cd client
pnpm install
pnpm run dev
```

Open the local URL shown by Vite.

## Sepolia Notes

- Sepolia world is tracked in manifests and `contracts/torii_sepolia.toml`.
- Client Sepolia token defaults are in `client/config.js`:
  - STRK token
  - WBTC token
- Production UI requires a valid `VITE_TORII_URL`.

Useful addresses currently used by the app config:
- Sepolia STRK: `0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d`
- Sepolia WBTC: `0x00452bd5c0512a61df7c7be8cfea5e4f893cb40e126bdc40aee6054db955129e`

## Env Vars (Client)

Defined in `client/config.js`:

- `VITE_NETWORK` (`dev` or `sepolia`)
- `VITE_RPC_URL`
- `VITE_TORII_URL`
- `VITE_STRK_TOKEN` (optional override)
- `VITE_FAUCET_URL` (local/dev faucet)
- `VITE_WBTC_FAUCET_URL` (optional helper link in UI)
- `VITE_YIELD_DUAL_POOL_ENABLED`
- Optional yield metadata:
  - `VITE_YIELD_STRATEGY_KIND`
  - `VITE_YIELD_ADAPTER_ADDRESS`
  - `VITE_YIELD_STAKING_TARGET`
  - `VITE_YIELD_REWARDS_TARGET`
  - `VITE_YIELD_OPERATIONAL_TARGET`
  - `VITE_YIELD_MODE`

## Yield Operations

There is **no active GitHub Actions cron keeper** in this repo now.

If you need periodic operations, run the local script manually:

```bash
./scripts/yield-keeper.sh sepolia 30
```

It executes harvest/rebalance and can process queue users if configured by env vars.

## Known Limitations / Caveats

- WBTC test acquisition on Sepolia is the main practical blocker for full BTC-path user testing.
- If Torii indexing lags, UI relies on direct onchain yield reads first and then Torii fallback.
- Yield admin is enforced after admin is set; initialize admin intentionally as part of ops hardening.
- Some legacy helper scripts may not match latest calldata signatures; prefer current `sozo` commands and manifests.

## Project Structure

```text
contracts/
  src/
    models.cairo
    systems/
      actions.cairo
      yield_adapter.cairo
  dojo_dev.toml
  dojo_sepolia.toml
  torii.toml
  torii_sepolia.toml

client/
  main.js
  dojoManager.js
  postManager.js
  controller.js
  config.js
  canvas.js
  index.html

scripts/
  faucet.sh
  yield-e2e.sh
  yield-keeper.sh
```

# 🌌 Starkwall

> A decentralized social media platform where posts exist as permanent, ownable tiles on an infinite canvas — powered by Dojo on Starknet.

## 🎯 What is Starkwall?

Starkwall reimagines social media by combining **blockchain ownership** with an **infinite canvas interface**. Unlike traditional social platforms where your content exists in a corporate database, here every post is a permanent, verifiable asset on the Starknet blockchain that you truly own.

### The Core Concept

- **📱 Mobile-First Design**: Built specifically for mobile devices with posts sized at iPhone 16 dimensions (393×852px), making every post feel like a full-screen mobile experience
- **🗺️ Infinite Canvas**: Posts are arranged on an unlimited 2D grid, creating a visual, explorable social space
- **🔗 Blockchain-Native**: Every post is minted on-chain with permanent ownership records
- **📍 Adjacent Growth**: New posts must connect to existing ones, creating organic community clusters
- **🎨 Visual Feed**: Navigate through posts like exploring a living art gallery instead of scrolling a feed

## ✨ Key Features

### Current Implementation

- ✅ **Mobile-First Architecture** - Posts designed at iPhone 16 dimensions (393×852px) for optimal mobile viewing
- ✅ **Wallet-Based Authentication** via Cartridge Controller with username display
- ✅ **On-Chain Post Creation** with images, captions, and creator attribution
- ✅ **NFT Marketplace** - Buy and sell post ownership with STRK tokens
- ✅ **Mock Balance System** - Prototype economy with 1000 STRK starting balance
- ✅ **Real-Time Sync** between blockchain and UI using Torii indexer
- ✅ **Infinite Canvas Navigation** with smooth zoom and pan
- ✅ **Ownership Display** showing creator username on each post
- ✅ **Adjacent Positioning** ensuring posts form connected networks with non-negative coordinates
- ✅ **Persistent Storage** - posts survive page reloads and exist permanently on-chain

### Smart Contract Architecture

```cairo
struct Post {
    id: u64,                          // Unique post identifier
    image_url: ByteArray,             // IPFS or CDN URL
    caption: ByteArray,               // Post description
    x_position: i32,                  // X coordinate on canvas (non-negative enforced)
    y_position: i32,                  // Y coordinate on canvas (non-negative enforced)
    size: u8,                         // Post size (fixed at 1, represents 393×852px)
    is_paid: bool,                    // Payment status
    created_at: u64,                  // Unix timestamp
    created_by: ContractAddress,      // Original creator
    creator_username: ByteArray,      // Creator's display name
    current_owner: ContractAddress,   // Current owner (changes on sale)
    sale_price: u128,                 // Sale price in STRK (0 = not for sale)
}

// Actions
fn create_post() -> u64              // Create new post adjacent to existing ones
fn set_post_price(post_id, price)    // List post for sale
fn buy_post(post_id)                 // Purchase a post (transfers ownership)
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

#### Terminal 5 (opcional): Faucet - Para recibir STRK/ETH en tu wallet

Tu balance está a 0 porque **Cartridge usa tu wallet personal**; Katana solo pre-fondea sus cuentas de desarrollo. Para obtener tokens, usa el script con starkli:

```bash
# Instalar starkli: curl https://get.starkli.sh | sh && source ~/.starkli/env && starkliup
./scripts/faucet.sh 0xTU_DIRECCION
```

Copia tu dirección desde la app (o desde Cartridge) y pégala en el comando. Luego haz clic en **"💧 Obtener STRK"** en la app (o recarga) para actualizar el balance.

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

- **Mobile-First Dimensions**: Each post is 393×852 pixels (iPhone 16 portrait dimensions)
- **First Post**: Always at origin `(0, 0)`
- **Subsequent Posts**: Scans adjacent positions (top, right, bottom, left)
- **Non-Negative Constraint**: Filters out positions with negative x or y coordinates
- **No Overlaps**: Ensures each post occupies unique coordinates
- **Organic Growth**: Creates connected networks of posts that expand from the origin

### 3. Marketplace System (Prototype)

- **Starting Balance**: Each wallet starts with 1000 STRK tokens
- **Selling Posts**: Owners can set a sale price in STRK
- **Buying Posts**: Anyone can purchase posts for sale (if they have sufficient balance)
- **Balance Transfer**: STRK automatically transfers from buyer to seller
- **Ownership Transfer**: `current_owner` updates on-chain after successful purchase
- **Visual Indicators**: Green borders and "FOR SALE" badges on posts listed for sale

### 4. Data Synchronization

- **Real-time Subscriptions**: Torii notifies frontend of new posts
- **GraphQL Queries**: Efficient data fetching on page load
- **Automatic Updates**: Balance and post ownership update after transactions (~5 seconds)

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

### Post model: Free vs Paid

- **Free post**: Size always **1** (one tile). **Position is random** among adjacent slots (user cannot choose).
- **Paid post**: User chooses **size only** (2, 3, 4… → 2×2, 3×3, 4×4 tiles). **Position is still random adjacent** (no choosing where it goes). Bigger = more visible, so **price is exponential** in size (e.g. `base × multiplier^(size-1)` STRK).

### Phase 2: Post Types & Mutability

- [ ] **Free Random Posts** - Create non-modifiable posts that can be sold, transferred, or auctioned
  - Lucky placement next to celebrity posts (with public ownership history)
  - Option to upgrade to modifiable by paying later
- [ ] **Paid posts** - User chooses **size** (2, 3, 4…); position remains **random adjacent**; **exponential pricing** (e.g. 10, 40, 160, 640 STRK).
- [ ] **Paid Modifiable Posts** - Pay upfront to create posts you can edit anytime
- [ ] **Post Ownership History** - Public ledger showing all transfers and ownership changes

### Phase 3: Yield & Economics (WALLD Integration)

- [ ] **Automatic Staking & Yield** - Posts generate yield when paid (e.g., 10 STRK → 1 STRK yield)
  - Automatically staked without user action
  - Yield decreases over time but never reaches 0%
- [ ] **Dynamic Yield Multiplier** - Create more posts to increase yield up to a maximum, then decreases
- [ ] **Monthly Membership** - Subscribe to prevent yield decay and potentially double it
- [ ] **Post Trading Market** - Transfer, sell, or auction your posts
- [ ] **Creator Royalties** - Earn on secondary sales
- [ ] Paid posts with premium content
- [ ] Advertising on adjacent posts

### Phase 4: Social Features & Dual View Modes

- [ ] **Dual View System**
  - Global wall view (dynamic real-time canvas)
  - Instagram-style scrolling feed mode
  - Easy toggle between views
- [ ] **Follow/Follower System** - Build your social graph on-chain
- [ ] Like & comment systems
- [ ] User profiles and galleries
- [ ] Post collections (bookmarks)

### Phase 5: Charity Auctions

- [ ] **Celebrity Charity Auction System**
  - Example: Messi buys 9 posts, auctions 8 adjacent spots
  - Winners get modifiable posts next to celebrity's post
- [ ] **Non-Transferable Center Posts** - Immutable identity posts for auction creators
  - Serves as permanent proof of charity campaign
  - Winner posts can say "I have a post adjacent to [Celebrity]"
- [ ] **Donation Integration** - Direct proceeds to WALLD for specified causes
  - Cause details displayed on center post
  - Examples: "1 million milk bricks for Gaza", humanitarian aid, etc.
- [ ] **Goal Tracking with Color Coding**
  - 🟧 Orange = Goal pending
  - 🟩 Green = Goal achieved
- [ ] **Yield-to-Charity** - Posts generate ongoing revenue until goal is reached
- [ ] Transparent impact tracking on-chain

### Phase 6: Advanced Content Types

- [ ] **Content Evolution** - Start with text/images, expand to:
  - Embedded websites in posts
  - Video and audio support
  - Interactive posts (polls, quizzes, forms)
  - NFT integration and display
  - 3D content and experimental AR/VR
- [ ] Different post sizes (1x1, 2x2, 1x2)
- [ ] Themes and customization

### Phase 7: Scalability & Distribution

- [ ] IPFS integration for decentralized image storage
- [ ] Layer 3 deployment for ultra-low transaction costs
- [ ] Mobile app (iOS/Android)
- [ ] Browser extension for quick post creation
- [ ] API for developers to build on Starkwall's social graph

## 🤝 Contributing

This is a hackathon project, but contributions are welcome! Areas of interest:

- UI/UX improvements
- Smart contract optimizations
- Mobile responsiveness
- Documentation

## 📄 License

This project is licensed under the [AGPL-3.0 License](./LICENSE) - ensuring that modifications and network use remain open source.

## 🙏 Acknowledgments

- **[Dojo Team](https://dojoengine.org/)** for the incredible ECS framework
- **[Cartridge](https://cartridge.gg/)** for seamless wallet UX
- **[Starknet Foundation](https://www.starknet.io/)** for making scalable blockchain possible
- The entire **Starknet community** for inspiration and support

---

**Built with ❤️ for the Starknet ecosystem**

Questions? Issues? Ideas? Open an issue or reach out!
