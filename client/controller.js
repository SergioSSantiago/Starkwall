/**
 * Cartridge Controller options.
 *
 * This file is environment-driven (dev vs Sepolia) via `client/config.js`.
 */

import manifest from './manifest.js'
import { CHAIN_ID_HEX, RPC_URL, PAYMENT_TOKEN_ADDRESS, SEPOLIA_WBTC_TOKEN } from './config.js'

const actionsContract = manifest.contracts.find((contract) => contract.tag === 'di-actions')
const actionsSystems = new Set(actionsContract?.systems || [])

if (!actionsContract?.address) {
  throw new Error('Actions contract not found in manifest (tag: di-actions)')
}

const actionMethods = [
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
  {
    name: 'Create Auction 3x3',
    entrypoint: 'create_auction_post_3x3',
    description: 'Create a 3x3 auction post',
  },
  {
    name: 'Place Bid',
    entrypoint: 'place_bid',
    description: 'Place bid on auction slot',
  },
  {
    name: 'Finalize Auction Slot',
    entrypoint: 'finalize_auction_slot',
    description: 'Finalize auction slot after end time',
  },
  {
    name: 'Set Won Slot Content',
    entrypoint: 'set_won_slot_content',
    description: 'Winner sets image and caption for finalized auction slot',
  },
]

if (actionsSystems.has('set_profile')) {
  actionMethods.push({
    name: 'Set Profile',
    entrypoint: 'set_profile',
    description: 'Set on-chain username profile',
  })
}

if (actionsSystems.has('follow')) {
  actionMethods.push({
    name: 'Follow User',
    entrypoint: 'follow',
    description: 'Follow another user on-chain',
  })
}

if (actionsSystems.has('unfollow')) {
  actionMethods.push({
    name: 'Unfollow User',
    entrypoint: 'unfollow',
    description: 'Unfollow another user on-chain',
  })
}

if (actionsSystems.has('yield_deposit')) {
  actionMethods.push({
    name: 'Yield Deposit',
    entrypoint: 'yield_deposit',
    description: 'Deposit STRK into yield vault',
  })
}

if (actionsSystems.has('yield_withdraw')) {
  actionMethods.push({
    name: 'Yield Withdraw',
    entrypoint: 'yield_withdraw',
    description: 'Withdraw principal from yield vault',
  })
}

if (actionsSystems.has('yield_claim')) {
  actionMethods.push({
    name: 'Yield Claim',
    entrypoint: 'yield_claim',
    description: 'Claim available earnings from yield vault',
  })
}

if (actionsSystems.has('yield_set_btc_mode')) {
  actionMethods.push({
    name: 'Yield BTC Mode',
    entrypoint: 'yield_set_btc_mode',
    description: 'Toggle BTC strategy mode for yield position',
  })
}

if (actionsSystems.has('yield_rebalance')) {
  actionMethods.push({
    name: 'Yield Rebalance',
    entrypoint: 'yield_rebalance',
    description: 'Rebalance liquid buffer and staked principal',
  })
}

if (actionsSystems.has('yield_harvest')) {
  actionMethods.push({
    name: 'Yield Harvest',
    entrypoint: 'yield_harvest',
    description: 'Harvest realized rewards into earnings pool',
  })
}

if (actionsSystems.has('yield_process_exit_queue')) {
  actionMethods.push({
    name: 'Yield Process Exit Queue',
    entrypoint: 'yield_process_exit_queue',
    description: 'Process queued principal withdrawals',
  })
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
        methods: actionMethods,
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

const wbtcAddress = String(SEPOLIA_WBTC_TOKEN || '').trim()
if (wbtcAddress && wbtcAddress !== PAYMENT_TOKEN_ADDRESS) {
  controllerOpts.policies.contracts[wbtcAddress] = {
    name: 'WBTC Strategy Token',
    description: 'WBTC token used for BTC yield strategy',
    methods: [
      {
        name: 'WBTC Approve',
        entrypoint: 'approve',
        description: 'Approve WBTC spending for BTC strategy deposits',
      },
      {
        name: 'WBTC Transfer',
        entrypoint: 'transfer',
        description: 'Transfer WBTC for BTC strategy operations',
      },
    ],
  }
}

export default controllerOpts
