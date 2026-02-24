#!/usr/bin/env node
/**
 * Faucet server: sends ETH (Katana token) to any address for local dev.
 * Run: node faucet-server.js
 * Requires: Katana running on localhost:5050
 */
import { createServer } from 'http';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Account } = require('/Users/sss/Webs/Starkwall/client/node_modules/starknet');

const PORT = 3001;
const RPC = 'http://127.0.0.1:5050/rpc';
const ETH_TOKEN = '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7';
const FAUCET_ACCOUNT = {
  address: '0x127fd5f1fe78a71f8bcd1fec63e3fe2f0486b6ecd5c86a0466c3a21fa5cfcec',
  privateKey: '0xc5b2fcab997346f3ea1c00b002ecf6f382c5f9c9659a3894eb783c5320f912',
};
const AMOUNT_WEI = 1000n * 10n ** 18n;

function u256ToCalldata(val) {
  const n = BigInt(val);
  const low = (n & ((1n << 128n) - 1n)).toString();
  const high = (n >> 128n).toString();
  return [low, high];
}

async function sendTokens(toAddress) {
  const account = new Account({
    provider: { nodeUrl: RPC },
    address: FAUCET_ACCOUNT.address,
    signer: FAUCET_ACCOUNT.privateKey,
  });
  const [low, high] = u256ToCalldata(AMOUNT_WEI);
  const tx = await account.execute([
    {
      contractAddress: ETH_TOKEN,
      entrypoint: 'transfer',
      calldata: [toAddress, low, high],
    },
  ]);

  const txHash = tx.transaction_hash || tx.transactionHash;
  if (account.provider && typeof account.provider.waitForTransaction === 'function') {
    await account.provider.waitForTransaction(txHash);
  }
  return txHash;
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== 'POST' || req.url !== '/faucet') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'POST /faucet with { "address": "0x..." }' }));
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  let address;
  try {
    const json = JSON.parse(body);
    address = json?.address?.toString?.()?.trim();
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }
  if (!address || !address.startsWith('0x')) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing or invalid address' }));
    return;
  }
  try {
    const txHash = await sendTokens(address);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, txHash }));
  } catch (e) {
    console.error('Faucet error:', e);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message || 'Transfer failed' }));
  }
});

server.listen(PORT, () => {
  console.log('Faucet server: http://localhost:' + PORT);
  console.log('POST /faucet { "address": "0x..." }');
});
