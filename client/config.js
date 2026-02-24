/**
 * Runtime config for Starkwall.
 *
 * Production (Sepolia) is configured via Vite env vars:
 * - VITE_NETWORK=sepolia
 * - VITE_RPC_URL=https://...
 * - VITE_TORII_URL=https://...
 * - VITE_STRK_TOKEN=0x... (optional; defaults to Sepolia STRK)
 */

export const NETWORK = String(import.meta.env?.VITE_NETWORK || 'dev').toLowerCase()
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
  import.meta.env?.VITE_TORII_URL || (IS_SEPOLIA ? '' : 'http://127.0.0.1:8080'),
)

// Cartridge expects hex chain ids.
export const CHAIN_ID_HEX = IS_SEPOLIA ? '0x534e5f5345504f4c4941' : '0x4b4154414e41'

// Dojo SDK domain uses string ids (matches what sozo prints).
export const DOMAIN_CHAIN_ID = IS_SEPOLIA ? 'SN_SEPOLIA' : 'KATANA'

// Payment token config.
export const SEPOLIA_STRK_TOKEN =
  '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d'
export const KATANA_ETH_TOKEN = '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7'

export const STRK_TOKEN_ADDRESS = String(import.meta.env?.VITE_STRK_TOKEN || '')

// If VITE_STRK_TOKEN is not set:
// - on Sepolia, default to official STRK
// - on dev, default to Katana's ETH token (same ERC20 interface)
export const PAYMENT_TOKEN_ADDRESS = STRK_TOKEN_ADDRESS || (IS_SEPOLIA ? SEPOLIA_STRK_TOKEN : KATANA_ETH_TOKEN)

// Optional local-only faucet.
export const FAUCET_URL = String(import.meta.env?.VITE_FAUCET_URL || 'http://127.0.0.1:3001')
