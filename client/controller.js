/**
 * Cartridge Controller options.
 *
 * This file is environment-driven (dev vs Sepolia) via `client/config.js`.
 */

import manifest from './manifest.js'
import { CHAIN_ID_HEX, RPC_URL, PAYMENT_TOKEN_ADDRESS } from './config.js'

const actionsContract = manifest.contracts.find((contract) => contract.tag === 'di-actions')

if (!actionsContract?.address) {
  throw new Error('Actions contract not found in manifest (tag: di-actions)')
}

const controllerOpts = {
  // Avoid eager iframe mount on page load (Firefox tracking/cookie settings can
  // make this fail early). We'll mount when the user clicks "Connect".
  lazyload: true,
  chains: [{ rpcUrl: RPC_URL }],
  defaultChainId: CHAIN_ID_HEX,
  policies: {
    contracts: {
      [actionsContract.address]: {
        name: 'Post Actions',
        description: 'Actions contract to create posts',
        methods: [
          {
            name: 'Create Post',
            entrypoint: 'create_post',
            description: 'Create a new post on the canvas',
          },
          {
            name: 'Set Post Price',
            entrypoint: 'set_post_price',
            description: 'Set a price to sell your post',
          },
          {
            name: 'Buy Post',
            entrypoint: 'buy_post',
            description: 'Buy a post that is for sale',
          },
        ],
      },
      [PAYMENT_TOKEN_ADDRESS]: {
        name: 'Payment Token',
        description: 'Token used to pay for paid posts',
        methods: [
          {
            name: 'Token Approve',
            entrypoint: 'approve',
            description: 'Approve token spending for paid post creation',
          },
          {
            name: 'Token Transfer',
            entrypoint: 'transfer',
            description: 'Transfer token for paid operations',
          },
        ],
      },
    },
  },
}

export default controllerOpts
