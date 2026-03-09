#!/usr/bin/env node
import { promises as fs } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Base64 } from 'js-base64';

const execFileAsync = promisify(execFile);

const REPO_ROOT = process.env.SEALED_RELAY_REPO_ROOT || '/app';
const NOIR_DIR = path.join(REPO_ROOT, 'zk/noir-sealed-bid');
const TARGET_DIR = path.join(NOIR_DIR, 'target');
const PROVER_TOML_PATH = path.join(NOIR_DIR, 'Prover.toml');
const NARGO_BIN = process.env.SEALED_RELAY_NARGO_BIN || 'nargo';
const GARAGA_BIN = process.env.SEALED_RELAY_GARAGA_BIN || 'garaga';
const TACEO_BASE_URL = String(process.env.TACEO_BASE_URL || '').trim();
const TACEO_API_KEY = String(process.env.TACEO_API_KEY || '').trim();
const TACEO_VOUCHER = String(process.env.TACEO_VOUCHER || '').trim();
const TACEO_WS_URL = String(process.env.TACEO_WS_URL || '').trim();
const TACEO_TIMEOUT_MS = Number(process.env.TACEO_TIMEOUT_MS || 120000);
const TACEO_NOIR_ABI_PATH = String(process.env.TACEO_NOIR_ABI_PATH || path.join(NOIR_DIR, 'target', 'noir_sealed_bid.json')).trim();
const TACEO_FAIL_OPEN = String(process.env.TACEO_FAIL_OPEN || 'true').toLowerCase() !== 'false';
const TACEO_ENABLE_REMOTE = String(process.env.TACEO_ENABLE_REMOTE || 'false').toLowerCase() === 'true';

function parseJob() {
  const raw = String(process.env.STARKWALL_JOB_JSON || '').trim();
  if (!raw) throw new Error('Missing STARKWALL_JOB_JSON');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid STARKWALL_JOB_JSON payload');
  return parsed;
}

function toDecimalField(value) {
  const asString = String(value || '').trim();
  if (!asString) return '0';
  return BigInt(asString.startsWith('0x') ? asString : asString).toString(10);
}

function proverToml(job) {
  return [
    `slot_post_id = "${toDecimalField(job.slotPostId)}"`,
    `group_id = "${toDecimalField(job.groupId)}"`,
    `bidder = "${toDecimalField(job.bidder)}"`,
    `bid_amount = "${toDecimalField(job.bidAmount)}"`,
    `salt = "${toDecimalField(job.salt)}"`,
    '',
  ].join('\n');
}

async function runCommand(command, args, cwd) {
  const { stdout, stderr } = await execFileAsync(command, args, { cwd });
  if (stderr && stderr.trim()) {
    // keep as warning only; many zk tools write progress to stderr
    console.warn(stderr.trim());
  }
  return stdout;
}

function parsePublicInputIndices(raw) {
  const tokens = String(raw || '')
    .split(',')
    .map((x) => Number(String(x || '').trim()))
    .filter((x) => Number.isFinite(x) && x >= 0);
  if (!tokens.length) throw new Error('Invalid TACEO_NOIR_PUBLIC_INPUTS');
  return new Uint32Array(tokens);
}

function toWsUrl(baseUrl) {
  const url = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!url) return '';
  if (url.startsWith('ws://') || url.startsWith('wss://')) return url;
  if (url.startsWith('https://')) return `wss://${url.slice('https://'.length)}/api/v1/reports/subs`;
  if (url.startsWith('http://')) return `ws://${url.slice('http://'.length)}/api/v1/reports/subs`;
  return '';
}

async function withTimeout(promise, timeoutMs, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs)),
  ]);
}

async function runTaceoRemote({ blueprintId, publicInputsRaw, input }) {
  // Lazy-load Taceo SDK so environments without Node ESM extension resolution
  // can still run in fallback mode.
  const { Configuration, JobApi, NodeApi } = await import('@taceo/proof-api-client');
  const CoNoir = await import('@taceo/proof-client-node/dist/CoNoir.js');
  if (!TACEO_BASE_URL) throw new Error('Missing TACEO_BASE_URL');
  const config = new Configuration({
    basePath: TACEO_BASE_URL,
    apiKey: TACEO_API_KEY || undefined,
  });
  const jobApi = new JobApi(config);
  const nodeApi = new NodeApi(config);
  const nodes = await nodeApi.randomNodeProviders();
  const publicInputs = parsePublicInputIndices(publicInputsRaw);

  const abiRaw = await fs.readFile(TACEO_NOIR_ABI_PATH, 'utf8');
  const abiJson = JSON.parse(abiRaw);
  const noirAbi = abiJson?.abi || abiJson;
  if (!noirAbi || typeof noirAbi !== 'object') {
    throw new Error('Invalid Noir ABI payload for Taceo');
  }

  const voucher = TACEO_VOUCHER || null;
  const jobId = await CoNoir.scheduleFullJob(
    jobApi,
    nodes,
    blueprintId,
    voucher,
    noirAbi,
    publicInputs,
    input,
  );
  const wsUrl = TACEO_WS_URL || toWsUrl(TACEO_BASE_URL);
  if (!wsUrl) throw new Error('Missing TACEO_WS_URL and unable to derive from TACEO_BASE_URL');
  const result = await withTimeout(CoNoir.fetchJobResult(wsUrl, jobId), TACEO_TIMEOUT_MS, 'taceo fetchJobResult');
  return {
    remote: true,
    jobId,
    wsUrl,
    proofBase64: Base64.fromUint8Array(result.proof || new Uint8Array(), true),
    publicInputsBase64: Base64.fromUint8Array(result.public_inputs || new Uint8Array(), true),
    signatureCount: Object.keys(result.signatures || {}).length,
  };
}

async function main() {
  const job = parseJob();
  const blueprintId = String(process.env.TACEO_BLUEPRINT_ID || '').trim();
  const publicInputsRaw = String(process.env.TACEO_NOIR_PUBLIC_INPUTS || '').trim();

  if (!TACEO_ENABLE_REMOTE) {
    process.stdout.write(JSON.stringify({ fallbackLocal: true, reason: 'taceo-remote-disabled' }));
    return;
  }

  // Missing config: caller may choose fallback behavior in relayer.
  if (!blueprintId || !publicInputsRaw) {
    process.stdout.write(JSON.stringify({ fallbackLocal: true, reason: 'missing-taceo-config' }));
    return;
  }

  const input = {
    slot_post_id: toDecimalField(job.slotPostId),
    group_id: toDecimalField(job.groupId),
    bidder: toDecimalField(job.bidder),
    bid_amount: toDecimalField(job.bidAmount),
    salt: toDecimalField(job.salt),
  };

  // Keep local witness generation for determinism diagnostics.
  await fs.writeFile(PROVER_TOML_PATH, proverToml(job), 'utf8');
  await runCommand(NARGO_BIN, ['execute', 'witness'], NOIR_DIR);

  try {
    const remote = await runTaceoRemote({ blueprintId, publicInputsRaw, input });
    process.stdout.write(JSON.stringify({
      remote,
      // Mapping remote coNoir proof/public_inputs to Starknet Garaga calldata
      // is controlled in relayer mode (shadow/strict). This worker now returns
      // real remote outputs instead of forcing fallback.
      fallbackLocal: true,
      reason: 'taceo-proof-format-mapping-pending',
    }));
  } catch (error) {
    if (!TACEO_FAIL_OPEN) throw error;
    process.stdout.write(JSON.stringify({
      fallbackLocal: true,
      reason: 'taceo-remote-error',
      remoteError: String(error?.message || error || 'unknown taceo error'),
    }));
  }
}

main().catch((error) => {
  const message = String(error?.message || error || 'taceo worker failed');
  process.stderr.write(message);
  process.exit(1);
});

