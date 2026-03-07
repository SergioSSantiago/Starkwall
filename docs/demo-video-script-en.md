# Starkwall Full App Demo (2m30s)

Use this script to record a complete English-speaking product demo while actively using the webapp.

Target duration: **2:30** (max 3:00)  
Voice style: clear, energetic, product-demo tone  
URL: `https://www.starkwall.com`

## Recording setup (before pressing record)

- Browser zoom: 100%
- Clean tab/session (already logged in is fine, but include a quick wallet step)
- Keep mouse movements deliberate and slow
- Turn on system audio only if wallet popup sounds are useful (optional)
- Record at 1080p

## Timeline: actions + voiceover

### 0:00 - 0:12 | Intro + value proposition

**On screen**
- Show homepage and app branding.

**Voiceover**
> "Welcome to Starkwall, a social trading app on Starknet where posts are onchain assets. In this quick walkthrough, I’ll show the full product flow in under three minutes."

---

### 0:12 - 0:28 | Connect wallet

**On screen**
- Click `🎮 Connect Wallet`.
- Complete connection (Cartridge).

**Voiceover**
> "First, connect your wallet with Cartridge. Once connected, you get access to posting, auctions, trading, social actions, and wallet-native utilities."

---

### 0:28 - 0:48 | Top controls + wallet utilities

**On screen**
- Highlight action buttons: `Add Post`, `Add Paid Post`, `Create Auction Post`.
- Highlight wallet actions: `⇄ Send STRK`, `⇄ Swap STRK/WBTC`.
- Briefly point to staking actions if visible: `🔒 Stake`, `💰 Unstake`, `✨ Claim`.

**Voiceover**
> "From the top controls, I can create standard, paid, or auction posts. Wallet tools are built in too: send STRK, swap STRK and WBTC, and staking actions like stake, unstake, and claim rewards."

---

### 0:48 - 1:15 | Create content flows

**On screen**
- Open `Add Post` -> show `📷 Cámara`, `🖼️ Galería`, caption field.
- Close or create quickly.
- Open `Add Paid Post` and show size options.
- Open `Create Auction Post` and show `Public` / `Sealed` mode + end date.

**Voiceover**
> "Post creation is simple: pick media from camera or gallery, add a caption, and publish onchain. Paid posts support different sizes. Auction posts can run in public mode, or sealed mode for private bidding."

---

### 1:15 - 1:42 | Post details + trading

**On screen**
- Open a post (`Post Details` modal).
- Show `📚 Open in Owner Feed`, `🧭 Locate on Canvas`, `Open Contract in Voyager`.
- Show trading actions: `💰 Sell Post`, `🛒 Buy Post`, `❌ Remove from Sale`.

**Voiceover**
> "Each post has transparent onchain details and explorer access. Owners can list for sale, buyers can purchase directly, and every interaction stays anchored to Starknet state."

---

### 1:42 - 2:15 | Auction + sealed verification flow

**On screen**
- Open an auction slot.
- Show either `🏷️ Place Bid` (public) or `🔐 Commit Bid`, `🧾 Reveal Bid`, `💸 Claim Refund` (sealed).
- Click `🧪 Verify Sealed Result`.
- In modal, show `Sealed Verification` and `Re-verify On-chain Now` (if available).

**Voiceover**
> "For auctions, public mode is straightforward bidding. Sealed mode uses commit and reveal phases for privacy. After settlement, I can open Sealed Verification to inspect status, transactions, and re-verify the result onchain."

---

### 2:15 - 2:30 | Social layer + close

**On screen**
- Open `Followers` / `Following`, show search and `Follow` / `Unfollow`.
- Return to main canvas.

**Voiceover**
> "Starkwall combines social discovery, ownership, and market mechanics in one onchain experience. That’s the full app flow: create, trade, auction, verify, and engage."

## Fast fallback lines (if a step is unavailable live)

- If no sealed slot is active:
  - "This account has no active sealed slot right now, but the verification flow appears here after reveal/finalize."
- If staking controls are hidden:
  - "Staking controls are environment-dependent and appear when enabled for this deployment."
- If wallet popup takes long:
  - "Connection can take a few seconds depending on wallet session state."

## Delivery tips

- Keep transitions tight; avoid dead time between modal opens.
- If one action fails due to phase/funds, narrate it as a chain-state guardrail and continue.
- Best final export: `MP4`, H.264, 1080p, 30fps.
