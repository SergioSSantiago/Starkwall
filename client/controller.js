/**
 * Setups controller options:
 * https://docs.cartridge.gg/controller/getting-started
 *
 * This example uses Katana for local host development.
 */
import manifest from '../contracts/manifest_dev.json' assert { type: 'json' };
import { STRK_TOKEN_ADDRESS } from './config.js';

const actionsContract = manifest.contracts.find((contract) => contract.tag === 'di-actions');
const KATANA_ETH = '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7';
const paymentToken = STRK_TOKEN_ADDRESS || KATANA_ETH;

const controllerOpts = {
  chains: [{ rpcUrl: 'http://localhost:5050' }],
  // "KATANA"
  defaultChainId: '0x4b4154414e41',
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
      [paymentToken]: {
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
};

export default controllerOpts;
