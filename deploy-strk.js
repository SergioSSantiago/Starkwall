#!/usr/bin/env node
import { RpcProvider, Account } from 'starknet';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RPC = 'http://localhost:5050';
const DOJO_ADDR = '0x127fd5f1fe78a71f8bcd1fec63e3fe2f0486b6ecd5c86a0466c3a21fa5cfcec';
const DOJO_KEY = '0xc5b2fcab997346f3ea1c00b002ecf6f382c5f9c9659a3894eb783c5320f912';
const INITIAL_SUPPLY = 1_000_000n * 10n ** 18n;

async function main() {
  const base = join(__dirname, 'contracts/strk/target/dev');
  const sierra = JSON.parse(readFileSync(join(base, 'strk_token_strk_token.contract_class.json'), 'utf8'));
  const casm = JSON.parse(readFileSync(join(base, 'strk_token_strk_token.compiled_contract_class.json'), 'utf8'));
  const provider = new RpcProvider({ nodeUrl: RPC });
  const account = new Account(provider, DOJO_ADDR, DOJO_KEY);
  const low = (INITIAL_SUPPLY & ((1n << 128n) - 1n)).toString();
  const high = (INITIAL_SUPPLY >> 128n).toString();

  const { deploy } = await account.declareAndDeploy({
    contract: sierra,
    casm,
    constructorCalldata: [low, high, DOJO_ADDR],
    salt: 1n,
  }, { blockIdentifier: 'latest' });
  console.log('STRK deployed at:', deploy.contract_address);
}

main().catch((e) => { console.error(e); process.exit(1); });
