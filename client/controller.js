/**
 * Setups controller options:
 * https://docs.cartridge.gg/controller/getting-started
 *
 * This example uses Katana for local host development.
 */
import manifest from '../contracts/manifest_dev.json' assert { type: 'json' };

const actionsContract = manifest.contracts.find((contract) => contract.tag === 'di-actions');

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
    },
  },
};

export default controllerOpts;
