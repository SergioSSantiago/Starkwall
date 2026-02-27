import manifestDev from '../contracts/manifest_dev.json' assert { type: 'json' }
import manifestSepolia from '../contracts/manifest_sepolia.json' assert { type: 'json' }
import { IS_SEPOLIA } from './config.js'

const manifest = IS_SEPOLIA ? manifestSepolia : manifestDev

export default manifest
