<p align="center">
  <img src="./client/logo-wall.svg" alt="Starkwall logo" width="88" />
</p>

<h1 align="center">Starkwall - Starknet Social Network with Sealed Bids and BTC Integration</h1>

Starkwall runs on Starknet Sepolia and combines:
- Dojo world contracts (`di-actions`)
- Cartridge wallet/session UX
- Torii indexer
- Starkzap staking UX
- AVNU swap and staking APIs
- Garaga-backed sealed-bid verification

## Production

- App: `https://www.starkwall.com`
- Network: Starknet Sepolia

## Addresses and Endpoints (Real and Current)

### A) Contracts deployed by this project (your deployment)

Source of truth: `contracts/manifest_sepolia.json`

- World address: `0x1fdf743008029a33c60d69b4bd3bc21a8f9ac282bdc6108e3066f6d1e6da151` [View on Voyager](https://sepolia.voyager.online/contract/0x1fdf743008029a33c60d69b4bd3bc21a8f9ac282bdc6108e3066f6d1e6da151)
- World class hash: `0x57994b6a75fad550ca18b41ee82e2110e158c59028c4478109a67965a0e5b1e`
- `di-actions` contract address: `0x9b693df0de1b9217493ea72b159beaea15c4299130a1a31279fd7a64adcb8d` [View on Voyager](https://sepolia.voyager.online/contract/0x9b693df0de1b9217493ea72b159beaea15c4299130a1a31279fd7a64adcb8d)
- `di-actions` class hash: `0x38dcfd60ea9946ddb696aac88b08e87d998e680313c939f349c4cd8176f25c4`

Important: in Sepolia manifest there is one deployed app contract in `contracts[]` (`di-actions`).  
The other `di-*` entries are model class hashes (schema), not extra deployed app contract addresses.

### B) External contracts/tokens consumed by the app

Source of truth: `client/config.js` and `contracts/src/systems/actions.cairo`

- STRK token (Sepolia): `0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d` [View on Voyager](https://sepolia.voyager.online/contract/0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d)
- WBTC token (staking pool token): `0x00452bd5c0512a61df7c7be8cfea5e4f893cb40e126bdc40aee6054db955129e` [View on Voyager](https://sepolia.voyager.online/contract/0x00452bd5c0512a61df7c7be8cfea5e4f893cb40e126bdc40aee6054db955129e)
- WBTC swap route token (AVNU swaps): `0x020d208b9e57a7f92bfa9f61135446e0961afc340378be97dbd317453c0950ae` [View on Voyager](https://sepolia.voyager.online/contract/0x020d208b9e57a7f92bfa9f61135446e0961afc340378be97dbd317453c0950ae)
- ETH token constant (Sepolia): `0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7` [View on Voyager](https://sepolia.voyager.online/contract/0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7)
- Sealed-bid verifier default: `0x03a3af693e4aa3dab8c38ea47b2757443837d5d5fcb6f23263cad63964611624` [View on Voyager](https://sepolia.voyager.online/contract/0x03a3af693e4aa3dab8c38ea47b2757443837d5d5fcb6f23263cad63964611624)

### C) Service endpoints used by the app

- RPC default: `https://api.cartridge.gg/x/starknet/sepolia`
- Torii default: `https://starkwall-torii.fly.dev`
- AVNU official Sepolia API: `https://sepolia.api.avnu.fi`

## App Features (What Starkwall Actually Does)

### Post types

- Free post: regular onchain post creation.
- Paid post: paid creation flow with size-based pricing and onchain ownership.
- Auction post (3x3): center post + 8 auction slots.
- Sealed auction mode: commit/reveal/finalize pipeline with verifier-backed proofs.

### Social + ownership

- User profile usernames (onchain index).
- Follow / unfollow and social counters.
- Post sale listing and buying (`set_post_price` / `buy_post`).
- Owner feed navigation and profile interactions.

### Wallet actions

- STRK transfer helper UI.
- STRK <-> WBTC swaps via AVNU.
- Staking for STRK and WBTC paths with stake/unstake/claim UX.

### Sealed verification UX

- Per-slot verification modal with relay stage status.
- Onchain tx links to Sepolia Voyager.
- `View Proof Bundle` shows proof trace, hashes, and persisted raw artifacts when available.
- `Re-verify On-chain Now` always returns a deterministic outcome:
  - `VALID` (cryptographic): verifier call succeeded with stored/recovered `proofCalldata`.
  - `INVALID`: verifier call returned false.
  - `VALID (attested)`: onchain settlement is confirmed, but cryptographic replay of historical artifacts is not possible.

## Sealed Auctions and Bids (Exact Current Flow)

### User flow (product behavior)

1. **Commit phase**
   - bidder sends `commit_bid` with escrow.
   - bid amount stays private.
2. **Reveal/settlement phase**
   - relayer generates proof and submits `reveal_bid`.
   - contract verifies through sealed verifier.
3. **Finalize phase**
   - relayer submits `finalize_auction_slot`.
   - winner ownership is locked in, and slot moves to publish stage.
4. **Refund phase**
   - non-winning commits are refunded by relayer (`claim_commit_refund`).

### Internal proving pipeline (Noir + bb + Garaga)

1. Noir witness built from `(slot, group, bidder, bid_amount, salt)`.
2. `bb` generates `vk`, `proof`, `public_inputs`.
3. Garaga converts artifacts to Starknet calldata felts.
4. Relayer sends `reveal_bid(...proofFelts)`.

### Traceability and storage (what is persisted)

For each sealed job, Starkwall now persists:
- pipeline hashes (`witnessHash`, `proofHash`, `vkHash`, `publicInputsHash`);
- `proofCalldata` when parse succeeds;
- raw proof artifacts (`witness`, `vk`, `proof`, `publicInputs`) in artifact bundles;
- reverify debug steps and recovery attempts.

Endpoints:
- `GET /sealed/jobs`
- `GET /sealed/proof-bundle`
- `GET /sealed/proof-artifacts`
- `GET /sealed/artifacts/<path>`
- `POST /sealed/reverify-now`

### Recovery strategy (to avoid dead-ends)

- If `proofCalldata` is missing, relayer tries:
  1. regenerate from current inputs,
  2. recover from persisted raw artifacts,
  3. recover from onchain `reveal_bid` transaction scan.
- If none can produce usable calldata but slot is clearly settled onchain, verdict becomes:
  - `VALID (attested by onchain settlement)` with explicit reason.

### Known hard limitation (still explicit)

Some historical artifacts can hit `bb -> garaga` legacy encoding mismatch and fail deterministic replay.
In those cases:
- settlement remains correct onchain,
- UX still converges,
- full raw artifacts are available for audit,
- cryptographic replay may not be reconstructible with current parser/toolchain pair.

## Hybrid Protocol Modes and Future Taceo Direction

Current supported protocol modes:
- `classic` (default)
- `drand`
- `drand_mpc`
- `sealed_tree_v1`

Starkwall's target direction is to use **Taceo-backed co-SNARK/MPC proving** for stronger trust assumptions:
- no single prover seeing all sensitive bid context,
- stronger multi-party attestations for settlement proofs,
- eventual move from `shadow` mode to `strict` mode when blueprint + artifact compatibility is production-stable.

### Taceo integration status (today)

- wiring and worker hooks are integrated;
- can run local/shadow/strict behavior by env;
- remote proving depends on valid blueprint credentials and compatible artifact format.

Key env flags:
- `SEALED_RELAY_TACEO_MODE` = `off | shadow | strict`
- `TACEO_ENABLE_REMOTE`, `TACEO_BASE_URL`, `TACEO_API_KEY`, `TACEO_BLUEPRINT_ID`
- `TACEO_NOIR_PUBLIC_INPUTS`, `TACEO_WS_URL`, optional `TACEO_VOUCHER`

Roadmap intent:
1. keep sealed flow reliable today with deterministic fallback + full traceability,
2. progressively increase Taceo usage in shadow mode,
3. cut over specific groups/protocols to strict remote proving when compatibility is proven.

## Where Images Are Stored

- The contract stores `image_url` as a `ByteArray` (a URL or data string reference), not raw image binary blobs.
- Recommended production path: upload image off-chain and store only URL onchain.
- Current upload options supported by relay backend:
  - IPFS via Pinata (`SEALED_RELAY_MEDIA_PROVIDER=ipfs_pinata`)
  - Cloudflare Images (`SEALED_RELAY_MEDIA_PROVIDER=cloudflare_images`)
  - Local file storage for dev (`SEALED_RELAY_MEDIA_PROVIDER=local`)
- Frontend can send media to `VITE_MEDIA_UPLOAD_URL` (or `${VITE_SEALED_RELAY_URL}/media/upload`) and then write returned URL to onchain post data.

## Stake / Unstake / Claim / Swap: Who Does What

### STRK staking

- Primary manager: `client/starkzapManager.js`
- Method flow:
  - stake: `wallet.stake(pool, amount)`
  - claim: `wallet.claimPoolRewards(pool)`
  - unstake: `wallet.exitPoolIntent(pool, amount)` then `wallet.exitPool(pool)`
- Pool resolution uses discovery (`getStakerPools`) and symbol/token matching.

### WBTC staking

- Primary manager: `client/starkzapManager.js`
- Same Starkzap method family as above.
- If token mismatch exists between wallet-held WBTC token and selected staking pool token, the app bridges through AVNU swap route first, then stakes.

### STRK <-> WBTC swaps

- Manager: `client/dojoManager.js`
- AVNU SDK calls:
  - quote: `getQuotes(...)`
  - swap execute: `executeSwap(...)`
- Uses official AVNU base URL (`SEPOLIA_BASE_URL`) on Sepolia.

## Official Integrations Check

- AVNU endpoint is official (`SEPOLIA_BASE_URL` -> `https://sepolia.api.avnu.fi`).
- Starkzap pools are dynamically discovered (no fixed manual pool hardcoding in manager logic).
- Token constants are aligned between frontend config and contract logic.
- If needed, runtime overrides can be supplied by env vars (`VITE_SWAP_WBTC_TOKEN`, `VITE_STRK_TOKEN`, `VITE_SEALED_BID_VERIFIER_ADDRESS`, etc.).

## Tests and Validation

### Contract tests

Run:

```bash
cd contracts
scarb test
```

Includes guard tests for yield pool behavior and BTC token wiring in `actions.cairo`.

### Frontend tests

Run:

```bash
cd client
npm test
```

Includes integration-style tests for:
- `client/tests/starkzapManager.integration.test.js`
- `client/tests/dojoManager.swap.integration.test.js`

### Live endpoint probes performed

- AVNU staking info endpoint: responsive on Sepolia.
- AVNU quotes endpoint: responsive in both directions:
  - STRK -> WBTC
  - WBTC -> STRK

## Build

```bash
cd client
npm run build
```

## Caveats

- Full onchain E2E for WBTC stake/unstake/claim requires funded Sepolia wallets and available route liquidity.
- AVNU staking pool availability can vary by token/pool configuration at runtime.
