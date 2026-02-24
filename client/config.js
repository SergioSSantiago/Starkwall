/**
 * Config for Starkwall. Set STRK_TOKEN_ADDRESS after deploying the STRK token
 * (see contracts/DEPLOY_STRK.md).
 */
export const STRK_TOKEN_ADDRESS = import.meta.env?.VITE_STRK_TOKEN || ""
