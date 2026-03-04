/**
 * Runtime config for Starkwall.
 *
 * Production (Sepolia) is configured via Vite env vars:
 * - VITE_NETWORK=sepolia
 * - VITE_RPC_URL=https://...
 * - VITE_TORII_URL=https://...
 * - VITE_STRK_TOKEN=0x... (optional; defaults to Sepolia STRK)
 */

export const NETWORK = String(import.meta.env?.VITE_NETWORK || 'sepolia').toLowerCase()
export const IS_SEPOLIA = NETWORK === 'sepolia'

// RPC endpoint (JSON-RPC).
//
// Important: Cartridge Controller runs inside an iframe on `x.cartridge.gg` and
// needs browser CORS access to the RPC. Many public RPCs block CORS, so we
// default Sepolia to Cartridge's RPC.
//
// For Katana, the default endpoint includes /rpc.
export const RPC_URL = String(
  import.meta.env?.VITE_RPC_URL || (IS_SEPOLIA ? 'https://api.cartridge.gg/x/starknet/sepolia' : 'http://127.0.0.1:5050/rpc'),
)

export const TORII_URL = String(
  import.meta.env?.VITE_TORII_URL || (IS_SEPOLIA ? 'https://starkwall-torii.fly.dev' : 'http://127.0.0.1:8080'),
)

// Cartridge expects hex chain ids.
export const CHAIN_ID_HEX = IS_SEPOLIA ? '0x534e5f5345504f4c4941' : '0x4b4154414e41'

// Dojo SDK domain uses string ids (matches what sozo prints).
export const DOMAIN_CHAIN_ID = IS_SEPOLIA ? 'SN_SEPOLIA' : 'KATANA'

// Payment token config.
export const SEPOLIA_STRK_TOKEN =
  '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d'
export const SEPOLIA_WBTC_TOKEN =
  '0x00452bd5c0512a61df7c7be8cfea5e4f893cb40e126bdc40aee6054db955129e'
export const SEPOLIA_ETH_TOKEN = '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7'
// Token used by AVNU spot swaps on Sepolia (STRK/ETH <-> BTC-represented routes).
export const SEPOLIA_SWAP_WBTC_TOKEN = String(
  import.meta.env?.VITE_SWAP_WBTC_TOKEN || '0x020d208b9e57a7f92bfa9f61135446e0961afc340378be97dbd317453c0950ae',
)
// Canonical Bitcoin-track metadata for the app/hackathon demo.
export const BTC_TRACK_SYMBOL = 'WBTC'
export const SEPOLIA_BTC_SWAP_TOKEN = SEPOLIA_SWAP_WBTC_TOKEN
export const SEPOLIA_BTC_STAKING_TOKEN = SEPOLIA_WBTC_TOKEN
export const KATANA_ETH_TOKEN = '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7'

export const STRK_TOKEN_ADDRESS = String(import.meta.env?.VITE_STRK_TOKEN || '')

// If VITE_STRK_TOKEN is not set:
// - on Sepolia, default to official STRK
// - on dev, default to Katana's ETH token (same ERC20 interface)
export const PAYMENT_TOKEN_ADDRESS = STRK_TOKEN_ADDRESS || (IS_SEPOLIA ? SEPOLIA_STRK_TOKEN : KATANA_ETH_TOKEN)

// Optional local-only faucet.
export const FAUCET_URL = String(import.meta.env?.VITE_FAUCET_URL || 'http://127.0.0.1:3001')
export const WBTC_FAUCET_URL = String(import.meta.env?.VITE_WBTC_FAUCET_URL || import.meta.env?.VITE_TBTC1_FAUCET_URL || '')
export const SEALED_BID_VERIFIER_ADDRESS = String(
  import.meta.env?.VITE_SEALED_BID_VERIFIER_ADDRESS ||
    (IS_SEPOLIA ? '0x03a3af693e4aa3dab8c38ea47b2757443837d5d5fcb6f23263cad63964611624' : ''),
)
export const SEALED_RELAY_URL = String(import.meta.env?.VITE_SEALED_RELAY_URL || '')
export const MEDIA_UPLOAD_URL = String(
  import.meta.env?.VITE_MEDIA_UPLOAD_URL || (SEALED_RELAY_URL ? `${SEALED_RELAY_URL.replace(/\/+$/, '')}/media/upload` : ''),
)

// Yield strategy adapter config (optional runtime metadata used by UI/ops scripts).
export const YIELD_STRATEGY_KIND = Number(import.meta.env?.VITE_YIELD_STRATEGY_KIND || 0)
export const YIELD_ADAPTER_ADDRESS = String(import.meta.env?.VITE_YIELD_ADAPTER_ADDRESS || '')
export const YIELD_STAKING_TARGET = String(import.meta.env?.VITE_YIELD_STAKING_TARGET || '')
export const YIELD_REWARDS_TARGET = String(import.meta.env?.VITE_YIELD_REWARDS_TARGET || '')
export const YIELD_OPERATIONAL_TARGET = String(import.meta.env?.VITE_YIELD_OPERATIONAL_TARGET || '')
export const YIELD_MODE = String(import.meta.env?.VITE_YIELD_MODE || 'user_direct').toLowerCase()
export const YIELD_DUAL_POOL_ENABLED = String(
  import.meta.env?.VITE_YIELD_DUAL_POOL_ENABLED || (IS_SEPOLIA ? 'true' : ''),
).toLowerCase() === 'true'
