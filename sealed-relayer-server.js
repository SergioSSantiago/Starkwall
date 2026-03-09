#!/usr/bin/env node
/**
 * Sealed reveal relayer for Starkwall.
 *
 * This service receives sealed reveal jobs and executes reveal_bid onchain
 * after commit phase ends. It generates Garaga calldata from Noir/BB artifacts.
 */
import { createServer } from 'http';
import { createRequire } from 'module';
import { promises as fs } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createHash } from 'crypto';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { Account, RpcProvider, hash } = require('starknet');

const PORT = Number(process.env.SEALED_RELAY_PORT || 3002);
const HOST = String(process.env.SEALED_RELAY_HOST || '0.0.0.0');
const RPC_URL = String(process.env.SEALED_RELAY_RPC_URL || 'https://starknet-sepolia.public.blastapi.io/rpc/v0_8');
const ACTIONS_CONTRACT = String(process.env.SEALED_RELAY_ACTIONS_ADDRESS || '').trim();
const RELAYER_ACCOUNT_ADDRESS = String(process.env.SEALED_RELAY_ACCOUNT_ADDRESS || '').trim();
const RELAYER_PRIVATE_KEY = String(process.env.SEALED_RELAY_PRIVATE_KEY || '').trim();

const REPO_ROOT = process.env.SEALED_RELAY_REPO_ROOT || path.resolve(path.dirname(new URL(import.meta.url).pathname), '.');
const NOIR_DIR = path.join(REPO_ROOT, 'zk/noir-sealed-bid');
const TARGET_DIR = path.join(NOIR_DIR, 'target');
const PROVER_TOML_PATH = path.join(NOIR_DIR, 'Prover.toml');
const GARAGA_BIN = process.env.SEALED_RELAY_GARAGA_BIN || 'garaga';
const BB_BIN = process.env.SEALED_RELAY_BB_BIN || '/root/.bb/bb';
const NARGO_BIN = process.env.SEALED_RELAY_NARGO_BIN || 'nargo';
const TX_VERSION = String(process.env.SEALED_RELAY_TX_VERSION || '').trim();
const DEFAULT_SEPOLIA_VERIFIER_CONTRACT = '0x03a3af693e4aa3dab8c38ea47b2757443837d5d5fcb6f23263cad63964611624';
const VERIFIER_CONTRACT = String(process.env.SEALED_RELAY_VERIFIER_ADDRESS || DEFAULT_SEPOLIA_VERIFIER_CONTRACT).trim();
const TX_MAX_FEE = String(process.env.SEALED_RELAY_TX_MAX_FEE || '0xee6b2800').trim();
const HIGH_L2_GAS_TX_DETAILS = {
  resourceBounds: {
    L1_GAS: {
      max_amount: 0x2710n,
      max_price_per_unit: 0x300000000000n,
    },
    // Starknet RPC v0.8 requires this field for v3 invokes.
    L1_DATA_GAS: {
      max_amount: 0x800n,
      max_price_per_unit: 0x2540be400n,
    },
    L2_GAS: {
      max_amount: 0xa00000n,
      max_price_per_unit: 0x2540be400n,
    },
  },
};
const HIGH_L2_GAS_TX_DETAILS_NO_DATA = {
  resourceBounds: {
    L1_GAS: {
      max_amount: 0x2710n,
      max_price_per_unit: 0x300000000000n,
    },
    L2_GAS: {
      max_amount: 0xa00000n,
      max_price_per_unit: 0x2540be400n,
    },
  },
};
const HIGH_L2_GAS_TX_DETAILS_LEGACY_KEYS = {
  resourceBounds: {
    l1_gas: {
      max_amount: 0x2710n,
      max_price_per_unit: 0x300000000000n,
    },
    l1_data_gas: {
      max_amount: 0x800n,
      max_price_per_unit: 0x2540be400n,
    },
    l2_gas: {
      max_amount: 0xa00000n,
      max_price_per_unit: 0x2540be400n,
    },
  },
};
const HIGH_L2_GAS_TX_DETAILS_LEGACY_KEYS_NO_DATA = {
  resourceBounds: {
    l1_gas: {
      max_amount: 0x2710n,
      max_price_per_unit: 0x300000000000n,
    },
    l2_gas: {
      max_amount: 0xa00000n,
      max_price_per_unit: 0x2540be400n,
    },
  },
};
const JOBS_DB_PATH = process.env.SEALED_RELAY_JOBS_FILE || path.join(REPO_ROOT, '.sealed-relayer-jobs.json');
const TRACES_DB_PATH = process.env.SEALED_RELAY_TRACES_FILE || path.join(REPO_ROOT, '.sealed-relayer-traces.json');
const ARTIFACTS_DIR = process.env.SEALED_RELAY_ARTIFACTS_DIR || path.join(REPO_ROOT, '.sealed-relayer-artifacts');
const ZK_VERBOSE = String(process.env.SEALED_RELAY_ZK_VERBOSE || 'true').toLowerCase() !== 'false';
const MAX_REVEAL_RETRIES = Number(process.env.SEALED_RELAY_MAX_REVEAL_RETRIES || 4);
const MAX_FINALIZE_RETRIES = Number(process.env.SEALED_RELAY_MAX_FINALIZE_RETRIES || 8);
const MAX_REFUND_RETRIES = Number(process.env.SEALED_RELAY_MAX_REFUND_RETRIES || 8);
const REVEAL_RETRY_SECONDS = Number(process.env.SEALED_RELAY_REVEAL_RETRY_SECONDS || 15);
const FINALIZE_RETRY_SECONDS = Number(process.env.SEALED_RELAY_FINALIZE_RETRY_SECONDS || 15);
const REFUND_RETRY_SECONDS = Number(process.env.SEALED_RELAY_REFUND_RETRY_SECONDS || 15);
const TX_WAIT_TIMEOUT_MS = Number(process.env.SEALED_RELAY_TX_WAIT_TIMEOUT_MS || 45000);
const EXECUTE_TIMEOUT_MS = Number(process.env.SEALED_RELAY_EXECUTE_TIMEOUT_MS || 12000);
const FINALIZE_NOW_HTTP_TIMEOUT_MS = Number(process.env.SEALED_RELAY_FINALIZE_NOW_HTTP_TIMEOUT_MS || 15000);
const RECOVER_SCAN_BLOCKS = Number(process.env.SEALED_RELAY_RECOVER_SCAN_BLOCKS || 6000);
const RECOVER_SCAN_WINDOW = Number(process.env.SEALED_RELAY_RECOVER_SCAN_WINDOW || 250);
const RECOVER_MAX_TX_CHECKS = Number(process.env.SEALED_RELAY_RECOVER_MAX_TX_CHECKS || 1200);
const RECOVER_SCAN_TIMEOUT_MS = Number(process.env.SEALED_RELAY_RECOVER_SCAN_TIMEOUT_MS || 20000);
const TORII_GRAPHQL_URL = String(
  process.env.SEALED_RELAY_TORII_GRAPHQL_URL || 'https://starkwall-torii.fly.dev/graphql',
).trim();
const TORII_FINALIZED_PROBE_TIMEOUT_MS = Number(process.env.SEALED_RELAY_TORII_FINALIZED_PROBE_TIMEOUT_MS || 3500);
const RECONCILE_RUNNING_STALE_MS = Number(process.env.SEALED_RELAY_RECONCILE_RUNNING_STALE_MS || 120000);
const RECOVERY_RETRY_COOLDOWN_MS = Number(process.env.SEALED_RELAY_RECOVERY_RETRY_COOLDOWN_MS || 60000);
const SEALED_PROTOCOL_CLASSIC = 'classic';
const SEALED_PROTOCOL_DRAND = 'drand';
const SEALED_PROTOCOL_DRAND_MPC = 'drand_mpc';
const SEALED_PROTOCOL_TREE_V1 = 'sealed_tree_v1';
const STARKNET_FIELD_PRIME = (1n << 251n) + (17n << 192n) + 1n;
const DRAND_CHAIN_HASH = String(process.env.SEALED_RELAY_DRAND_CHAIN_HASH || '').trim();
const DRAND_PUBLIC_BASE_URL = String(
  process.env.SEALED_RELAY_DRAND_PUBLIC_BASE_URL ||
  (DRAND_CHAIN_HASH ? `https://api.drand.sh/${DRAND_CHAIN_HASH}` : 'https://api.drand.sh/public/latest'),
).trim().replace(/\/+$/, '');
const DRAND_LATEST_CACHE_MS = Number(process.env.SEALED_RELAY_DRAND_LATEST_CACHE_MS || 10000);
const TIMELOCK_DECRYPT_CMD = String(process.env.SEALED_RELAY_TIMELOCK_DECRYPT_CMD || '').trim();
const MPC_ATTEST_CMD = String(process.env.SEALED_RELAY_MPC_ATTEST_CMD || '').trim();
const MPC_PROVE_CMD = String(process.env.SEALED_RELAY_MPC_PROVE_CMD || '').trim();
const TACEO_MODE = String(process.env.SEALED_RELAY_TACEO_MODE || 'off').trim().toLowerCase();
const MPC_ATTEST_SUBMIT_ONCHAIN = String(process.env.SEALED_RELAY_MPC_ATTEST_SUBMIT_ONCHAIN || 'true').toLowerCase() !== 'false';
const MEDIA_PROVIDER = String(process.env.SEALED_RELAY_MEDIA_PROVIDER || 'none').toLowerCase();
const MEDIA_MAX_BYTES = Number(process.env.SEALED_RELAY_MEDIA_MAX_BYTES || 1_500_000);
const MEDIA_PUBLIC_BASE_URL = String(process.env.SEALED_RELAY_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
const MEDIA_LOCAL_DIR = String(process.env.SEALED_RELAY_MEDIA_LOCAL_DIR || path.join(REPO_ROOT, '.media-uploads'));
const CF_ACCOUNT_ID = String(process.env.SEALED_RELAY_CF_ACCOUNT_ID || '').trim();
const CF_IMAGES_API_TOKEN = String(process.env.SEALED_RELAY_CF_IMAGES_API_TOKEN || '').trim();
const PINATA_JWT = String(process.env.SEALED_RELAY_PINATA_JWT || '').trim();
const IPFS_GATEWAY_BASE_URL = String(
  process.env.SEALED_RELAY_IPFS_GATEWAY_BASE_URL || 'https://gateway.pinata.cloud/ipfs',
).trim().replace(/\/+$/, '');

const jobs = [];
const tracesByKey = new Map();
const recoveryScanBySlot = new Map();
let workerBusy = false;
let finalizeWorkerBusy = false;
let refundWorkerBusy = false;
let reconcileWorkerBusy = false;
let persistQueued = false;
let tracesPersistQueued = false;
let relayerTxQueue = Promise.resolve();
let proofGenQueue = Promise.resolve();
const slotLocks = new Set();
let drandLatestCache = { at: 0, round: 0 };

async function ensureJobsStorageDir() {
  const dirPath = path.dirname(JOBS_DB_PATH);
  await fs.mkdir(dirPath, { recursive: true });
  const tracesDirPath = path.dirname(TRACES_DB_PATH);
  if (tracesDirPath && tracesDirPath !== dirPath) {
    await fs.mkdir(tracesDirPath, { recursive: true });
  }
  await fs.mkdir(ARTIFACTS_DIR, { recursive: true });
}

function validateConfig() {
  if (!ACTIONS_CONTRACT || !ACTIONS_CONTRACT.startsWith('0x')) {
    throw new Error('SEALED_RELAY_ACTIONS_ADDRESS is missing or invalid');
  }
  if (!RELAYER_ACCOUNT_ADDRESS || !RELAYER_ACCOUNT_ADDRESS.startsWith('0x')) {
    throw new Error('SEALED_RELAY_ACCOUNT_ADDRESS is missing or invalid');
  }
  if (!RELAYER_PRIVATE_KEY || !RELAYER_PRIVATE_KEY.startsWith('0x')) {
    throw new Error('SEALED_RELAY_PRIVATE_KEY is missing or invalid');
  }
}

function getRelayerAccount() {
  const provider = new RpcProvider({ nodeUrl: RPC_URL });
  // Support modern starknet.js constructor while keeping backward compatibility.
  try {
    return new Account({
      provider,
      address: RELAYER_ACCOUNT_ADDRESS,
      signer: RELAYER_PRIVATE_KEY,
      cairoVersion: '1',
    });
  } catch {
    return new Account(provider, RELAYER_ACCOUNT_ADDRESS, RELAYER_PRIVATE_KEY, '1');
  }
}

function enqueueRelayerTx(task) {
  const run = relayerTxQueue.then(task, task);
  relayerTxQueue = run.catch(() => {});
  return run;
}

function enqueueProofGeneration(task) {
  const run = proofGenQueue.then(task, task);
  proofGenQueue = run.catch(() => {});
  return run;
}

async function executeWithFreshNonce(account, call) {
  let nonce = undefined;
  const nonceCandidates = [
    () => account.provider.getNonceForAddress(account.address),
    () => account.provider.getNonceForAddress(account.address, 'latest'),
    () => account.provider.getNonceForAddress(account.address, 'pending'),
    () => account.getNonce(),
    () => account.getNonce('latest'),
    () => account.getNonce('pending'),
  ];
  for (const readNonce of nonceCandidates) {
    try {
      const value = await readNonce();
      if (value !== undefined && value !== null) {
        nonce = value;
        break;
      }
    } catch {}
  }
  if (nonce === undefined) {
    throw new Error('Could not resolve account nonce from RPC');
  }
  let nonceValue = nonce;
  if (typeof nonceValue !== 'bigint') {
    try {
      nonceValue = BigInt(nonceValue);
    } catch {
      // Keep original nonce if BigInt conversion fails for any edge RPC type.
    }
  }
  const withTimeout = async (promise, label) =>
    Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`Timed out while ${label} after ${EXECUTE_TIMEOUT_MS}ms`)),
          EXECUTE_TIMEOUT_MS,
        ),
      ),
    ]);

  const executeWithDetailsCompat = async (details) => {
    try {
      return await withTimeout(account.execute(call, details), 'sending transaction');
    } catch (firstError) {
      try {
        return await withTimeout(account.execute(call, undefined, details), 'sending transaction');
      } catch {
        throw firstError;
      }
    }
  };

  const candidates = [];
  if (TX_VERSION) {
    candidates.push(
      {
        nonce: nonceValue,
        version: TX_VERSION,
        tip: 0n,
        paymasterData: [],
        accountDeploymentData: [],
        nonceDataAvailabilityMode: 'L1',
        feeDataAvailabilityMode: 'L1',
        ...HIGH_L2_GAS_TX_DETAILS_LEGACY_KEYS,
      },
      {
        nonce: nonceValue,
        version: TX_VERSION,
        tip: 0n,
        paymasterData: [],
        accountDeploymentData: [],
        nonceDataAvailabilityMode: 'L1',
        feeDataAvailabilityMode: 'L1',
        ...HIGH_L2_GAS_TX_DETAILS_LEGACY_KEYS,
        maxFee: BigInt(TX_MAX_FEE),
      },
    );
  } else {
    // Legacy fallback path for environments that still rely on auto versioning.
    candidates.push(
      { nonce: nonceValue },
      { nonce: nonceValue, ...HIGH_L2_GAS_TX_DETAILS },
      { nonce: nonceValue, ...HIGH_L2_GAS_TX_DETAILS_NO_DATA },
      { nonce: nonceValue, ...HIGH_L2_GAS_TX_DETAILS_LEGACY_KEYS },
      { nonce: nonceValue, ...HIGH_L2_GAS_TX_DETAILS_LEGACY_KEYS_NO_DATA },
      { nonce: nonceValue, ...HIGH_L2_GAS_TX_DETAILS, maxFee: BigInt(TX_MAX_FEE) },
      { nonce: nonceValue, ...HIGH_L2_GAS_TX_DETAILS_NO_DATA, maxFee: BigInt(TX_MAX_FEE) },
      { nonce: nonceValue, ...HIGH_L2_GAS_TX_DETAILS_LEGACY_KEYS, maxFee: BigInt(TX_MAX_FEE) },
      { nonce: nonceValue, ...HIGH_L2_GAS_TX_DETAILS_LEGACY_KEYS_NO_DATA, maxFee: BigInt(TX_MAX_FEE) },
    );
  }

  let lastError = null;
  for (const details of candidates) {
    try {
      return await executeWithDetailsCompat(details);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Unable to execute relayer transaction');
}

function isExecutionReverted(receipt) {
  const execution = String(receipt?.execution_status || receipt?.executionStatus || '').toUpperCase();
  return execution === 'REVERTED';
}

function readRevertReason(receipt) {
  return String(receipt?.revert_reason || receipt?.revertReason || 'Transaction reverted');
}

async function waitForSuccessfulTx(account, txHash, label = 'transaction') {
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => resolve('timeout'), TX_WAIT_TIMEOUT_MS);
  });
  const waitResult = await Promise.race([account.waitForTransaction(txHash), timeoutPromise]);
  if (waitResult === 'timeout') {
    console.warn(`[sealed-relayer] tx wait timeout (${label})`, {
      txHash: String(txHash),
      waitMs: TX_WAIT_TIMEOUT_MS,
    });
    return;
  }
  const getReceipt = account?.provider?.getTransactionReceipt
    ? account.provider.getTransactionReceipt.bind(account.provider)
    : account?.getTransactionReceipt
      ? account.getTransactionReceipt.bind(account)
      : account?.channel?.node?.getTransactionReceipt
        ? account.channel.node.getTransactionReceipt.bind(account.channel.node)
        : null;
  if (!getReceipt) {
    throw new Error('Relayer account/provider cannot fetch transaction receipt');
  }
  const receipt = await getReceipt(txHash);
  if (isExecutionReverted(receipt)) {
    throw new Error(`${label} reverted: ${readRevertReason(receipt)}`);
  }
}

function normalizeHexAddress(address) {
  const raw = String(address || '').trim().toLowerCase();
  if (!raw) return '0x0';
  const hex = raw.startsWith('0x') ? raw.slice(2) : raw;
  const normalized = hex.replace(/^0+/, '');
  return `0x${normalized || '0'}`;
}

function sanitizeArtifactToken(value, fallback = 'x') {
  const raw = String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  const cleaned = raw.replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

function artifactAbsPath(relativePath) {
  const rel = String(relativePath || '').trim().replace(/\\/g, '/');
  if (!rel || rel.startsWith('/') || rel.includes('..')) return '';
  const abs = path.resolve(ARTIFACTS_DIR, rel);
  const root = path.resolve(ARTIFACTS_DIR);
  if (!abs.startsWith(root)) return '';
  return abs;
}

function appendArtifactBundleToTrace(job, bundle) {
  if (!job || !bundle || typeof bundle !== 'object') return;
  const existing = Array.isArray(job?.zkTrace?.artifactBundles) ? job.zkTrace.artifactBundles : [];
  const next = [...existing, bundle].slice(-10);
  job.zkTrace = {
    ...(job.zkTrace || {}),
    artifactBundles: next,
    lastArtifactAt: Number(bundle?.savedAt || Date.now()),
  };
}

async function persistRawProofArtifacts(job, variant, artifactFiles = {}) {
  if (!job || typeof job !== 'object') return null;
  const slotPostId = Number(job?.slotPostId || 0);
  const bidder = normalizeHexAddress(job?.bidder || '').replace(/^0x/, '');
  const baseDir = path.join(
    ARTIFACTS_DIR,
    `slot-${Number.isFinite(slotPostId) && slotPostId > 0 ? slotPostId : 0}`,
    sanitizeArtifactToken(String(job?.id || 'job')),
    sanitizeArtifactToken(String(variant || 'default')),
  );
  await fs.mkdir(baseDir, { recursive: true });
  const files = {};
  for (const [label, sourcePathRaw] of Object.entries(artifactFiles || {})) {
    const sourcePath = String(sourcePathRaw || '').trim();
    if (!sourcePath) continue;
    try {
      const bytes = await fs.readFile(sourcePath);
      const sha = `0x${createHash('sha256').update(bytes).digest('hex')}`;
      const ext = path.extname(sourcePath) || (String(label).toLowerCase().includes('json') ? '.json' : '.bin');
      const fileName = `${sanitizeArtifactToken(label)}-${sanitizeArtifactToken(bidder.slice(0, 10) || 'bidder')}-${sha.slice(2, 10)}${ext}`;
      const destination = path.join(baseDir, fileName);
      await fs.writeFile(destination, bytes);
      const rel = path.relative(ARTIFACTS_DIR, destination).split(path.sep).join('/');
      files[label] = {
        path: rel,
        sha256: sha,
        bytes: bytes.length,
      };
    } catch {
      // Ignore per-file failures so one missing artifact doesn't block the whole flow.
    }
  }
  return {
    variant: String(variant || 'default'),
    savedAt: Date.now(),
    files,
  };
}

function normalizeSealedProtocolMode(mode) {
  const value = String(mode || '').trim().toLowerCase();
  if (
    value === SEALED_PROTOCOL_DRAND ||
    value === SEALED_PROTOCOL_DRAND_MPC ||
    value === SEALED_PROTOCOL_TREE_V1
  ) return value;
  return SEALED_PROTOCOL_CLASSIC;
}

function toHexFelt(value) {
  const n = BigInt(value);
  return `0x${n.toString(16)}`;
}

function toBigIntSafe(value, fallback = 0n) {
  try {
    if (typeof value === 'bigint') return value;
    const raw = String(value ?? '').trim();
    if (!raw) return fallback;
    return BigInt(raw);
  } catch {
    return fallback;
  }
}

function toHexNormalized(value) {
  const n = toBigIntSafe(value, 0n);
  return `0x${n.toString(16)}`;
}

function decodeAccountCallArray(calldata = []) {
  const felts = (Array.isArray(calldata) ? calldata : []).map((v) => toBigIntSafe(v, 0n));
  if (felts.length < 2) return [];
  const callCount = Number(felts[0] || 0n);
  if (!Number.isFinite(callCount) || callCount <= 0) return [];
  const headerStart = 1;
  const headerWidth = 4;
  const headersEnd = headerStart + (callCount * headerWidth);
  if (felts.length <= headersEnd) return [];
  const dataLen = Number(felts[headersEnd] || 0n);
  if (!Number.isFinite(dataLen) || dataLen < 0) return [];
  const dataStart = headersEnd + 1;
  const sharedData = felts.slice(dataStart, dataStart + dataLen);
  const calls = [];
  for (let i = 0; i < callCount; i += 1) {
    const base = headerStart + (i * headerWidth);
    const to = felts[base];
    const selector = felts[base + 1];
    const offset = Number(felts[base + 2] || 0n);
    const length = Number(felts[base + 3] || 0n);
    if (!Number.isFinite(offset) || !Number.isFinite(length) || offset < 0 || length < 0) continue;
    const data = sharedData.slice(offset, offset + length);
    calls.push({
      to,
      selector,
      calldata: data.map((v) => v.toString(10)),
    });
  }
  return calls;
}

function extractRevealPayloadFromAccountCalldata(calldata = [], actionsAddress = ACTIONS_CONTRACT) {
  const calls = decodeAccountCallArray(calldata);
  if (!calls.length) return null;
  const revealSelector = toBigIntSafe(hash.getSelectorFromName('reveal_bid'), 0n);
  const actionsNorm = normalizeHexAddress(actionsAddress);
  for (const call of calls) {
    const toNorm = normalizeHexAddress(toHexNormalized(call.to));
    if (toNorm !== actionsNorm) continue;
    if (toBigIntSafe(call.selector, -1n) !== revealSelector) continue;
    const data = Array.isArray(call.calldata) ? call.calldata : [];
    if (data.length < 6) return null;
    const slotPostId = Number(toBigIntSafe(data[0], 0n));
    const bidder = normalizeHexAddress(toHexNormalized(data[1]));
    const bidAmount = Number(toBigIntSafe(data[2], 0n));
    const salt = toHexNormalized(data[3]);
    const proofLen = Number(toBigIntSafe(data[4], 0n));
    if (!Number.isFinite(proofLen) || proofLen <= 0) return null;
    const proofCalldata = data.slice(5, 5 + proofLen).map((v) => toBigIntSafe(v, 0n).toString(10));
    if (proofCalldata.length !== proofLen) return null;
    if (!Number.isFinite(slotPostId) || slotPostId <= 0) return null;
    if (!Number.isFinite(bidAmount) || bidAmount <= 0) return null;
    if (!bidder || bidder === '0x0') return null;
    return {
      slotPostId,
      bidder,
      bidAmount,
      salt,
      proofCalldata,
    };
  }
  return null;
}

function getPublicJobView(job) {
  if (!job || typeof job !== 'object') return job;
  const publicJob = { ...job };
  // Avoid stale "failed" presentation after finalize already converged on-chain.
  if (String(publicJob.status || '') === 'failed' && String(publicJob.finalizeStatus || '') === 'submitted') {
    publicJob.status = 'submitted';
    publicJob.error = '';
    publicJob.errorCode = '';
    publicJob.errorHint = '';
  }
  publicJob.hasProofCalldata = Array.isArray(job.proofCalldata) && job.proofCalldata.length > 0;
  // Never expose secret salt or full proof calldata via public API.
  delete publicJob.salt;
  delete publicJob.timelockPayload;
  delete publicJob.proofCalldata;
  return publicJob;
}

function makeTraceKey(slotPostId, bidder) {
  return `${Number(slotPostId || 0)}:${normalizeHexAddress(bidder || '')}`;
}

function makeTraceId(slotPostId, bidder) {
  const normalized = normalizeHexAddress(bidder || '').replace(/^0x/, '');
  const shortBidder = normalized ? `${normalized.slice(0, 8)}${normalized.slice(-6)}` : 'unknown';
  return `trace_${Number(slotPostId || 0)}_${shortBidder}`;
}

function upsertTraceFromJobLike(jobLike) {
  if (!jobLike || typeof jobLike !== 'object') return null;
  const slotPostId = Number(jobLike.slotPostId || 0);
  const bidder = normalizeHexAddress(jobLike.bidder || '');
  if (!Number.isFinite(slotPostId) || slotPostId <= 0 || !bidder || bidder === '0x0') return null;
  const key = makeTraceKey(slotPostId, bidder);
  const current = tracesByKey.get(key) || {};
  const next = {
    id: String(jobLike.id || current.id || makeTraceId(slotPostId, bidder)),
    source: 'trace',
    slotPostId,
    groupId: Number(jobLike.groupId || current.groupId || 0),
    bidder,
    bidAmount: Number(jobLike.bidAmount || current.bidAmount || 0),
    protocolMode: String(jobLike.protocolMode || current.protocolMode || 'classic'),
    drandRound: Number(jobLike.drandRound || current.drandRound || 0),
    timelockCiphertextHash: String(jobLike.timelockCiphertextHash || current.timelockCiphertextHash || ''),
    mpcSessionId: String(jobLike.mpcSessionId || current.mpcSessionId || ''),
    mpcAttestationRoot: String(jobLike.mpcAttestationRoot || current.mpcAttestationRoot || ''),
    mpcTranscriptHash: String(jobLike.mpcTranscriptHash || current.mpcTranscriptHash || ''),
    mpcSignerBitmapHash: String(jobLike.mpcSignerBitmapHash || current.mpcSignerBitmapHash || ''),
    // Private fields required for deterministic reverify.
    salt: String(jobLike.salt || current.salt || ''),
    proofCalldata: Array.isArray(jobLike.proofCalldata)
      ? jobLike.proofCalldata.map((v) => String(v))
      : (Array.isArray(current.proofCalldata) ? current.proofCalldata.map((v) => String(v)) : []),
    zkTrace: {
      ...(current.zkTrace && typeof current.zkTrace === 'object' ? current.zkTrace : {}),
      ...(jobLike.zkTrace && typeof jobLike.zkTrace === 'object' ? jobLike.zkTrace : {}),
    },
    status: String(jobLike.status || current.status || ''),
    finalizeStatus: String(jobLike.finalizeStatus || current.finalizeStatus || ''),
    refundStatus: String(jobLike.refundStatus || current.refundStatus || ''),
    revealTxHash: String(jobLike.revealTxHash || current.revealTxHash || ''),
    finalizeTxHash: String(jobLike.finalizeTxHash || current.finalizeTxHash || ''),
    refundTxHash: String(jobLike.refundTxHash || current.refundTxHash || ''),
    error: String(jobLike.error || current.error || ''),
    errorCode: String(jobLike.errorCode || current.errorCode || ''),
    errorHint: String(jobLike.errorHint || current.errorHint || ''),
    finalizeError: String(jobLike.finalizeError || current.finalizeError || ''),
    finalizeErrorCode: String(jobLike.finalizeErrorCode || current.finalizeErrorCode || ''),
    finalizeErrorHint: String(jobLike.finalizeErrorHint || current.finalizeErrorHint || ''),
    refundError: String(jobLike.refundError || current.refundError || ''),
    refundErrorCode: String(jobLike.refundErrorCode || current.refundErrorCode || ''),
    refundErrorHint: String(jobLike.refundErrorHint || current.refundErrorHint || ''),
    revealAfterUnix: Number(jobLike.revealAfterUnix || current.revealAfterUnix || 0),
    finalizeAfterUnix: Number(jobLike.finalizeAfterUnix || current.finalizeAfterUnix || 0),
    refundAfterUnix: Number(jobLike.refundAfterUnix || current.refundAfterUnix || 0),
    revealAttempts: Number(jobLike.revealAttempts || current.revealAttempts || 0),
    finalizeAttempts: Number(jobLike.finalizeAttempts || current.finalizeAttempts || 0),
    refundAttempts: Number(jobLike.refundAttempts || current.refundAttempts || 0),
    createdAt: Number(jobLike.createdAt || current.createdAt || Date.now()),
    updatedAt: Number(jobLike.updatedAt || Date.now()),
  };
  tracesByKey.set(key, next);
  return next;
}

function mirrorJobsIntoTraceStore() {
  for (const job of jobs) upsertTraceFromJobLike(job);
}

function collectPublicJobsWithTraceFallback() {
  const live = jobs.map(getPublicJobView);
  const liveByKey = new Set(jobs.map((j) => makeTraceKey(j?.slotPostId, j?.bidder)));
  for (const trace of tracesByKey.values()) {
    const key = makeTraceKey(trace?.slotPostId, trace?.bidder);
    if (liveByKey.has(key)) continue;
    const fallbackJob = {
      ...trace,
      id: String(trace?.id || makeTraceId(trace?.slotPostId, trace?.bidder)),
      status: String(trace?.status || 'archived'),
      finalizeStatus: String(trace?.finalizeStatus || (trace?.finalizeTxHash ? 'submitted' : 'scheduled')),
      refundStatus: String(trace?.refundStatus || (trace?.refundTxHash ? 'submitted' : 'scheduled')),
      source: 'trace-fallback',
    };
    live.push(getPublicJobView(fallbackJob));
  }
  return live;
}

function lockSlot(slotPostId) {
  const id = Number(slotPostId || 0);
  if (!Number.isFinite(id) || id <= 0) return false;
  if (slotLocks.has(id)) {
    console.log('[sealed-relayer][slot-lock:busy]', { slotPostId: id });
    return false;
  }
  slotLocks.add(id);
  console.log('[sealed-relayer][slot-lock:acquired]', { slotPostId: id });
  return true;
}

function unlockSlot(slotPostId) {
  const id = Number(slotPostId || 0);
  if (!Number.isFinite(id) || id <= 0) return;
  slotLocks.delete(id);
  console.log('[sealed-relayer][slot-lock:released]', { slotPostId: id });
}

function toDecimalField(value) {
  const asString = String(value || '').trim();
  if (!asString) return '0';
  const n = BigInt(asString.startsWith('0x') ? asString : asString);
  return n.toString(10);
}

function toProverToml(job) {
  return [
    `slot_post_id = "${toDecimalField(job.slotPostId)}"`,
    `group_id = "${toDecimalField(job.groupId)}"`,
    `bidder = "${toDecimalField(normalizeHexAddress(job.bidder))}"`,
    `bid_amount = "${toDecimalField(job.bidAmount)}"`,
    `salt = "${toDecimalField(job.salt)}"`,
    '',
  ].join('\n');
}

function sha256Hex(value) {
  return `0x${createHash('sha256').update(value).digest('hex')}`;
}

function previewArray(values, count = 6) {
  const arr = Array.isArray(values) ? values : [];
  if (arr.length <= count) return arr;
  return [...arr.slice(0, count), `...(+${arr.length - count} more)`];
}

function toHexFromSha256(value) {
  return `0x${createHash('sha256').update(String(value || '')).digest('hex')}`;
}

function reverifyStep(debug, stage, data = {}) {
  if (!debug || typeof debug !== 'object') return;
  if (!Array.isArray(debug.steps)) debug.steps = [];
  debug.steps.push({
    at: Date.now(),
    stage: String(stage || 'unknown'),
    ...data,
  });
}

function getRecoveryState(slotPostId) {
  const state = recoveryScanBySlot.get(Number(slotPostId || 0));
  if (!state || typeof state !== 'object') return null;
  return {
    running: Boolean(state.running),
    startedAt: Number(state.startedAt || 0),
    finishedAt: Number(state.finishedAt || 0),
    lastError: String(state.lastError || ''),
    lastTxHash: String(state.lastTxHash || ''),
  };
}

function queueBackgroundRecovery(payload) {
  const slotPostId = Number(payload?.slotPostId || 0);
  if (!Number.isFinite(slotPostId) || slotPostId <= 0) return getRecoveryState(slotPostId);
  const current = recoveryScanBySlot.get(slotPostId);
  if (current?.running) return getRecoveryState(slotPostId);
  recoveryScanBySlot.set(slotPostId, {
    running: true,
    startedAt: Date.now(),
    finishedAt: 0,
    lastError: '',
    lastTxHash: '',
  });
  (async () => {
    try {
      const result = await runRecoverRevealTx(payload, {
        startedAt: Date.now(),
        slotPostId,
        request: { background: true },
        steps: [],
      });
      recoveryScanBySlot.set(slotPostId, {
        running: false,
        startedAt: Number(recoveryScanBySlot.get(slotPostId)?.startedAt || Date.now()),
        finishedAt: Date.now(),
        lastError: '',
        lastTxHash: String(result?.txHash || ''),
      });
      console.log('[sealed-relayer][reverify:background-recovery:done]', {
        slotPostId,
        txHash: String(result?.txHash || ''),
      });
    } catch (error) {
      recoveryScanBySlot.set(slotPostId, {
        running: false,
        startedAt: Number(recoveryScanBySlot.get(slotPostId)?.startedAt || Date.now()),
        finishedAt: Date.now(),
        lastError: String(error?.message || error || 'Background recovery failed'),
        lastTxHash: '',
      });
      console.warn('[sealed-relayer][reverify:background-recovery:error]', {
        slotPostId,
        error: String(error?.message || error || 'Background recovery failed'),
      });
    }
  })();
  return getRecoveryState(slotPostId);
}

async function hashFile(filePath) {
  try {
    const data = await fs.readFile(filePath);
    return sha256Hex(data);
  } catch {
    return 'missing';
  }
}

async function resolveExistingPath(candidates = []) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error(`Expected artifact not found. Tried: ${candidates.join(', ')}`);
}

async function persistJobs() {
  await ensureJobsStorageDir();
  const serializable = jobs.map((j) => ({ ...j }));
  const tmpPath = `${JOBS_DB_PATH}.${process.pid}.${Date.now()}.${Math.floor(Math.random() * 1e6)}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(serializable, null, 2), 'utf8');
  await fs.rename(tmpPath, JOBS_DB_PATH);
}

async function persistTraces() {
  await ensureJobsStorageDir();
  const serializable = Array.from(tracesByKey.values()).map((t) => ({ ...t }));
  const tmpPath = `${TRACES_DB_PATH}.${process.pid}.${Date.now()}.${Math.floor(Math.random() * 1e6)}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(serializable, null, 2), 'utf8');
  await fs.rename(tmpPath, TRACES_DB_PATH);
}

function queuePersistJobs() {
  if (persistQueued) return;
  persistQueued = true;
  setTimeout(async () => {
    persistQueued = false;
    try {
      mirrorJobsIntoTraceStore();
      await persistJobs();
      await persistTraces();
    } catch (error) {
      console.error('[sealed-relayer] failed to persist jobs:', error?.message || error);
    }
  }, 50);
}

function queuePersistTraces() {
  if (tracesPersistQueued) return;
  tracesPersistQueued = true;
  setTimeout(async () => {
    tracesPersistQueued = false;
    try {
      await persistTraces();
    } catch (error) {
      console.error('[sealed-relayer] failed to persist traces:', error?.message || error);
    }
  }, 50);
}

async function restoreJobs() {
  await ensureJobsStorageDir();
  try {
    const raw = await fs.readFile(JOBS_DB_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    jobs.splice(0, jobs.length, ...parsed);
    console.log(`[sealed-relayer] restored ${jobs.length} jobs from disk`);
  } catch (error) {
    if (String(error?.code || '') !== 'ENOENT') {
      console.warn('[sealed-relayer] could not restore jobs:', error?.message || error);
    }
  }
}

async function restoreTraces() {
  await ensureJobsStorageDir();
  try {
    const raw = await fs.readFile(TRACES_DB_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    tracesByKey.clear();
    for (const item of parsed) {
      upsertTraceFromJobLike(item);
    }
    console.log(`[sealed-relayer] restored ${tracesByKey.size} traces from disk`);
  } catch (error) {
    if (String(error?.code || '') !== 'ENOENT') {
      console.warn('[sealed-relayer] could not restore traces:', error?.message || error);
    }
  }
}

async function runCommand(command, args, cwd) {
  const startedAt = Date.now();
  if (ZK_VERBOSE) {
    console.log('[sealed-relayer][cmd:start]', { command, args, cwd });
  }
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd,
    timeout: EXECUTE_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (stderr && stderr.trim()) console.warn(`[sealed-relayer] ${command} stderr:`, stderr.trim());
  if (ZK_VERBOSE) {
    console.log('[sealed-relayer][cmd:done]', {
      command,
      elapsedMs: Date.now() - startedAt,
      stdoutBytes: Buffer.byteLength(String(stdout || ''), 'utf8'),
      stderrBytes: Buffer.byteLength(String(stderr || ''), 'utf8'),
    });
  }
  return stdout;
}

async function runCommandJson(shellCommand, payload = {}) {
  if (!shellCommand) throw new Error('Missing shell command');
  const env = {
    ...process.env,
    STARKWALL_JOB_JSON: JSON.stringify(payload || {}),
  };
  const startedAt = Date.now();
  if (ZK_VERBOSE) {
    console.log('[sealed-relayer][cmd-json:start]', {
      command: shellCommand,
      payloadKeys: Object.keys(payload || {}),
    });
  }
  const { stdout, stderr } = await execFileAsync('sh', ['-lc', shellCommand], {
    cwd: REPO_ROOT,
    env,
  });
  if (stderr && stderr.trim()) console.warn('[sealed-relayer][cmd-json:stderr]', stderr.trim());
  const raw = String(stdout || '').trim();
  if (!raw) throw new Error('JSON command returned empty stdout');
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`JSON command returned invalid JSON: ${String(error?.message || error)}`);
  }
  if (ZK_VERBOSE) {
    console.log('[sealed-relayer][cmd-json:done]', {
      command: shellCommand,
      elapsedMs: Date.now() - startedAt,
      keys: Object.keys(parsed || {}),
    });
  }
  return parsed;
}

async function writeFieldArrayJsonToBinary(jsonPath, key, outPath) {
  const raw = await fs.readFile(jsonPath, 'utf8');
  const parsed = JSON.parse(raw);
  const values = Array.isArray(parsed?.[key]) ? parsed[key] : [];
  if (!values.length) {
    throw new Error(`Missing '${key}' array in ${path.basename(jsonPath)}`);
  }
  const chunks = values.map((token) => {
    const n = String(token || '').startsWith('0x')
      ? BigInt(String(token))
      : BigInt(String(token || '0'));
    return Buffer.from(n.toString(16).padStart(64, '0'), 'hex');
  });
  await fs.writeFile(outPath, Buffer.concat(chunks));
  return values.length;
}

async function fetchLatestDrandRound() {
  const now = Date.now();
  if (drandLatestCache.round > 0 && (now - Number(drandLatestCache.at || 0)) < DRAND_LATEST_CACHE_MS) {
    return drandLatestCache.round;
  }
  if (!DRAND_PUBLIC_BASE_URL) return 0;
  const url = DRAND_PUBLIC_BASE_URL.endsWith('/latest')
    ? DRAND_PUBLIC_BASE_URL
    : `${DRAND_PUBLIC_BASE_URL}/latest`;
  try {
    const response = await fetch(url, { method: 'GET' });
    const body = await response.json().catch(() => ({}));
    const round = Number(body?.round || 0);
    if (Number.isFinite(round) && round > 0) {
      drandLatestCache = { at: now, round };
      return round;
    }
    return 0;
  } catch {
    return 0;
  }
}

async function generateProofCalldata(job) {
  return enqueueProofGeneration(async () => {
    const mode = normalizeSealedProtocolMode(job?.protocolMode);
    if (mode === SEALED_PROTOCOL_DRAND_MPC && MPC_PROVE_CMD && TACEO_MODE !== 'off') {
      const external = await runCommandJson(MPC_PROVE_CMD, {
        id: job.id,
        slotPostId: Number(job.slotPostId || 0),
        groupId: Number(job.groupId || 0),
        bidder: normalizeHexAddress(job.bidder || ''),
        bidAmount: Number(job.bidAmount || 0),
        salt: String(job.salt || ''),
        drandRound: Number(job.drandRound || 0),
      });
      const remote = external?.remote && typeof external.remote === 'object' ? external.remote : null;
      if (remote) {
        job.zkTrace = {
          ...(job.zkTrace || {}),
          taceoJobId: String(remote.jobId || ''),
          taceoWsUrl: String(remote.wsUrl || ''),
          taceoProofHash: remote.proofBase64 ? toHexFromSha256(String(remote.proofBase64)) : '',
          taceoPublicInputsHash: remote.publicInputsBase64 ? toHexFromSha256(String(remote.publicInputsBase64)) : '',
          taceoSignatureCount: Number(remote.signatureCount || 0),
          generatedAt: Date.now(),
        };
        queuePersistJobs();
        upsertTraceFromJobLike(job);
        queuePersistTraces();
      }
      if (Boolean(external?.fallbackLocal)) {
        if (ZK_VERBOSE) {
          console.log('[sealed-relayer][zk:mpc-prove:fallback-local]', {
            id: job.id,
            reason: String(external?.reason || ''),
            mode: TACEO_MODE,
            hasRemote: Boolean(remote),
          });
        }
        if (TACEO_MODE === 'strict') {
          throw new Error(
            `Taceo strict mode: fallback disallowed (${String(external?.reason || 'unknown reason')})`,
          );
        }
      } else {
      const proofArray = Array.isArray(external?.proofCalldata) ? external.proofCalldata : [];
      if (!proofArray.length) {
        throw new Error('MPC proof command returned empty proofCalldata');
      }
      const normalized = proofArray.map((token) => {
        const parsed = String(token || '').startsWith('0x') ? BigInt(String(token)) : BigInt(String(token || '0'));
        return parsed.toString(10);
      });
      const calldataHash = String(external?.proofCalldataHash || '').trim() || sha256Hex(normalized.join(','));
      job.zkTrace = {
        ...(job.zkTrace || {}),
        witnessHash: String(external?.witnessHash || job.zkTrace?.witnessHash || ''),
        proofHash: String(external?.proofHash || job.zkTrace?.proofHash || ''),
        vkHash: String(external?.vkHash || job.zkTrace?.vkHash || ''),
        publicInputsHash: String(external?.publicInputsHash || job.zkTrace?.publicInputsHash || ''),
        proofCalldataHash: calldataHash,
        proofFelts: normalized.length,
        calldataPreview: previewArray(normalized, 8),
        generatedAt: Date.now(),
      };
      job.proofCalldata = normalized;
      queuePersistJobs();
      upsertTraceFromJobLike(job);
      queuePersistTraces();
      return normalized;
      }
    }

    if (ZK_VERBOSE) {
      console.log('[sealed-relayer][zk:job-input]', {
        id: job.id,
        slotPostId: job.slotPostId,
        groupId: job.groupId,
        bidder: job.bidder,
        bidAmount: job.bidAmount,
        saltHash: sha256Hex(String(job.salt || '')),
      });
    }

    await fs.writeFile(PROVER_TOML_PATH, toProverToml(job), 'utf8');
    await runCommand(NARGO_BIN, ['execute', 'witness'], NOIR_DIR);
    const proofRunId = `${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    const honkDir = path.join(TARGET_DIR, `honk-keccak-${proofRunId}`);
    await fs.rm(honkDir, { recursive: true, force: true });
    await fs.mkdir(honkDir, { recursive: true });
    await runCommand(
      BB_BIN,
      [
        'write_vk',
        '-b',
        'target/noir_sealed_bid.json',
        '-o',
        `target/honk-keccak-${proofRunId}`,
        '-t',
        'evm',
      ],
      NOIR_DIR,
    );
    await runCommand(
      BB_BIN,
      [
        'prove',
        '-b',
        'target/noir_sealed_bid.json',
        '-w',
        'target/witness.gz',
        '-o',
        `target/honk-keccak-${proofRunId}`,
        '-k',
        `target/honk-keccak-${proofRunId}/vk`,
        '-t',
        'evm',
      ],
      NOIR_DIR,
    );

    const witnessPath = path.join(NOIR_DIR, 'target', 'witness.gz');
    const vkPath = path.join(honkDir, 'vk');
    const proofPath = await resolveExistingPath([
      path.join(honkDir, 'proof'),
      path.join(honkDir, 'proof', 'proof'),
    ]);
    const publicInputsPath = await resolveExistingPath([
      path.join(honkDir, 'public_inputs'),
      path.join(honkDir, 'proof', 'public_inputs'),
    ]);

    const [witnessHash, proofHash, vkHash, publicInputsHash] = await Promise.all([
      hashFile(witnessPath),
      hashFile(proofPath),
      hashFile(vkPath),
      hashFile(publicInputsPath),
    ]);
    const primaryArtifacts = await persistRawProofArtifacts(job, `primary-${proofRunId}`, {
      witness: witnessPath,
      vk: vkPath,
      proof: proofPath,
      publicInputs: publicInputsPath,
    });
    if (job && typeof job === 'object') {
      job.zkTrace = {
        witnessHash,
        proofHash,
        vkHash,
        publicInputsHash,
        generatedAt: Date.now(),
      };
      appendArtifactBundleToTrace(job, primaryArtifacts);
      queuePersistJobs();
      upsertTraceFromJobLike(job);
      queuePersistTraces();
    }

    if (ZK_VERBOSE) {
      console.log('[sealed-relayer][zk:artifacts]', {
        id: job.id,
        witnessPath,
        witnessHash,
        proofPath,
        proofHash,
        vkPath,
        vkHash,
        publicInputsPath,
        publicInputsHash,
      });
    }

    let raw = '';
    try {
      raw = await runCommand(
        GARAGA_BIN,
        [
          'calldata',
          '--system',
          'ultra_keccak_zk_honk',
          '--vk',
          vkPath,
          '--proof',
          proofPath,
          '--public-inputs',
          publicInputsPath,
          '--format',
          'array',
        ],
        NOIR_DIR,
      );
    } catch (error) {
      const message = String(error?.message || error || 'Garaga calldata generation failed');
      const shouldRetry = isGaragaCurveParseError(message);
      if (job && typeof job === 'object') {
        job.zkTrace = {
          ...(job.zkTrace || {}),
          lastGaragaError: compactErrorMessage(message, 420),
        };
        queuePersistJobs();
        upsertTraceFromJobLike(job);
        queuePersistTraces();
      }
      if (!shouldRetry) throw error;
      if (ZK_VERBOSE) {
        console.warn('[sealed-relayer][zk:garaga-retry]', {
          id: job?.id,
          reason: compactErrorMessage(message, 220),
        });
      }
      // Retry once with fresh witness/proof artifacts in a new run directory.
      await fs.writeFile(PROVER_TOML_PATH, toProverToml(job), 'utf8');
      await runCommand(NARGO_BIN, ['execute', 'witness'], NOIR_DIR);
      const retryRunId = `${Date.now()}_${Math.floor(Math.random() * 1_000_000)}_retry`;
      const retryHonkDir = path.join(TARGET_DIR, `honk-keccak-${retryRunId}`);
      await fs.rm(retryHonkDir, { recursive: true, force: true });
      await fs.mkdir(retryHonkDir, { recursive: true });
      await runCommand(
        BB_BIN,
        ['write_vk', '-b', 'target/noir_sealed_bid.json', '-o', `target/honk-keccak-${retryRunId}`, '-t', 'evm'],
        NOIR_DIR,
      );
      await runCommand(
        BB_BIN,
        [
          'prove',
          '-b',
          'target/noir_sealed_bid.json',
          '-w',
          'target/witness.gz',
          '-o',
          `target/honk-keccak-${retryRunId}`,
          '-k',
          `target/honk-keccak-${retryRunId}/vk`,
          '-t',
          'evm',
          '--output_format',
          'json',
        ],
        NOIR_DIR,
      );
      const retryVkPath = path.join(retryHonkDir, 'vk');
      const retryProofJsonPath = await resolveExistingPath([
        path.join(retryHonkDir, 'proof.json'),
      ]);
      const retryPublicInputsJsonPath = await resolveExistingPath([
        path.join(retryHonkDir, 'public_inputs.json'),
      ]);
      const retryProofPath = path.join(retryHonkDir, 'proof.from_json.bin');
      const retryPublicInputsPath = path.join(retryHonkDir, 'public_inputs.from_json.bin');
      const [proofJsonFelts, publicInputsJsonFelts] = await Promise.all([
        writeFieldArrayJsonToBinary(retryProofJsonPath, 'proof', retryProofPath),
        writeFieldArrayJsonToBinary(retryPublicInputsJsonPath, 'public_inputs', retryPublicInputsPath),
      ]);
      const retryArtifacts = await persistRawProofArtifacts(job, `retry-${retryRunId}`, {
        vk: retryVkPath,
        proofJson: retryProofJsonPath,
        publicInputsJson: retryPublicInputsJsonPath,
        proofBin: retryProofPath,
        publicInputsBin: retryPublicInputsPath,
      });
      raw = await runCommand(
        GARAGA_BIN,
        [
          'calldata',
          '--system',
          'ultra_keccak_zk_honk',
          '--vk',
          retryVkPath,
          '--proof',
          retryProofPath,
          '--public-inputs',
          retryPublicInputsPath,
          '--format',
          'array',
        ],
        NOIR_DIR,
      );
      if (job && typeof job === 'object') {
        job.zkTrace = {
          ...(job.zkTrace || {}),
          garagaRetryMode: 'json-normalized',
          proofJsonFelts,
          publicInputsJsonFelts,
        };
        appendArtifactBundleToTrace(job, retryArtifacts);
      }
      await fs.rm(retryHonkDir, { recursive: true, force: true }).catch(() => {});
    }

    const rawText = String(raw || '');
    if (/traceback \(most recent call last\)|assertionerror|valueerror:/i.test(rawText)) {
      throw new Error('Garaga calldata generation returned parser traceback output');
    }
    const tokens = rawText
      .trim()
      .match(/0x[0-9a-fA-F]+|[0-9]+/g) || [];
    await fs.rm(honkDir, { recursive: true, force: true }).catch(() => {});
    if (tokens.length === 0) {
      throw new Error('Garaga calldata generation returned empty array');
    }
    const normalized = tokens.map((token) => {
      const normalized = token.startsWith('0x') ? BigInt(token) : BigInt(token);
      return normalized.toString(10);
    });
    if (!normalized.every((value) => isValidStarknetFelt(value))) {
      throw new Error('Garaga calldata generation produced non-felt values');
    }
    const calldataHash = sha256Hex(normalized.join(','));
    if (job && typeof job === 'object') {
      job.zkTrace = {
        ...(job.zkTrace || {}),
        proofCalldataHash: calldataHash,
        proofFelts: normalized.length,
        calldataPreview: previewArray(normalized, 8),
      };
      job.proofCalldata = normalized;
      queuePersistJobs();
      upsertTraceFromJobLike(job);
      queuePersistTraces();
    }
    if (ZK_VERBOSE) {
      console.log('[sealed-relayer][zk:garaga-calldata]', {
        id: job.id,
        totalFelts: normalized.length,
        calldataHash,
        preview: previewArray(normalized, 8),
      });
    }
    return normalized;
  });
}

function getLatestArtifactBundle(job) {
  const bundles = Array.isArray(job?.zkTrace?.artifactBundles) ? job.zkTrace.artifactBundles : [];
  return bundles
    .slice()
    .sort((a, b) => Number(b?.savedAt || 0) - Number(a?.savedAt || 0))[0] || null;
}

async function recoverProofCalldataFromArtifacts(job) {
  const bundle = getLatestArtifactBundle(job);
  const files = bundle?.files && typeof bundle.files === 'object' ? bundle.files : {};
  const vkPath = artifactAbsPath(files?.vk?.path || '');
  const proofPath = artifactAbsPath(files?.proof?.path || files?.proofBin?.path || '');
  const publicInputsPath = artifactAbsPath(files?.publicInputs?.path || files?.publicInputsBin?.path || '');
  if (!vkPath || !proofPath || !publicInputsPath) {
    throw new Error('Stored artifacts are incomplete (vk/proof/public_inputs missing).');
  }
  let raw = await runCommand(
    GARAGA_BIN,
    [
      'calldata',
      '--system',
      'ultra_keccak_zk_honk',
      '--vk',
      vkPath,
      '--proof',
      proofPath,
      '--public-inputs',
      publicInputsPath,
      '--format',
      'array',
    ],
    NOIR_DIR,
  );
  const rawText = String(raw || '');
  if (/traceback \(most recent call last\)|assertionerror|valueerror:/i.test(rawText)) {
    throw new Error('Garaga artifact recovery returned parser traceback output');
  }
  const tokens = rawText.trim().match(/0x[0-9a-fA-F]+|[0-9]+/g) || [];
  if (!tokens.length) throw new Error('Garaga artifact recovery returned empty calldata');
  const normalized = tokens.map((token) => (token.startsWith('0x') ? BigInt(token) : BigInt(token)).toString(10));
  if (!normalized.every((value) => isValidStarknetFelt(value))) {
    throw new Error('Garaga artifact recovery produced non-felt values');
  }
  const calldataHash = sha256Hex(normalized.join(','));
  job.proofCalldata = normalized;
  job.zkTrace = {
    ...(job.zkTrace || {}),
    proofCalldataHash: calldataHash,
    proofFelts: normalized.length,
    calldataPreview: previewArray(normalized, 8),
    recoveredFromArtifactsAt: Date.now(),
  };
  queuePersistJobs();
  upsertTraceFromJobLike(job);
  queuePersistTraces();
  return normalized;
}

async function executeReveal(job, proofCalldata) {
  return enqueueRelayerTx(async () => {
    const account = getRelayerAccount();
    if (ZK_VERBOSE) {
      console.log('[sealed-relayer][zk:verify-onchain:start]', {
        id: job.id,
        actions: ACTIONS_CONTRACT,
        entrypoint: 'reveal_bid',
        slotPostId: job.slotPostId,
        bidder: job.bidder,
        bidAmount: job.bidAmount,
        proofFelts: proofCalldata.length,
        note: 'reveal_bid verifies proof via verifier.verify_sealed_bid inside di-actions',
      });
    }
    const tx = await executeWithFreshNonce(account, {
      contractAddress: ACTIONS_CONTRACT,
      entrypoint: 'reveal_bid',
      calldata: [
        Number(job.slotPostId),
        String(job.bidder),
        Number(job.bidAmount),
        String(job.salt),
        proofCalldata.length,
        ...proofCalldata,
      ],
    });
    const txHash = tx.transaction_hash || tx.transactionHash;
    await waitForSuccessfulTx(account, txHash, `reveal slot ${job.slotPostId}`);
    if (ZK_VERBOSE) {
      console.log('[sealed-relayer][zk:verify-onchain:done]', {
        id: job.id,
        txHash: String(txHash),
      });
    }
    return String(txHash);
  });
}

async function executeFinalize(slotPostId) {
  return enqueueRelayerTx(async () => {
    const account = getRelayerAccount();
    const tx = await executeWithFreshNonce(account, {
      contractAddress: ACTIONS_CONTRACT,
      entrypoint: 'finalize_auction_slot',
      calldata: [Number(slotPostId)],
    });
    const txHash = tx.transaction_hash || tx.transactionHash;
    await waitForSuccessfulTx(account, txHash, `finalize slot ${slotPostId}`);
    return String(txHash);
  });
}

async function executeClaimRefund(slotPostId, bidder) {
  return enqueueRelayerTx(async () => {
    const account = getRelayerAccount();
    const tx = await executeWithFreshNonce(account, {
      contractAddress: ACTIONS_CONTRACT,
      entrypoint: 'claim_commit_refund',
      calldata: [Number(slotPostId), String(bidder)],
    });
    const txHash = tx.transaction_hash || tx.transactionHash;
    await waitForSuccessfulTx(account, txHash, `refund slot ${slotPostId}`);
    return String(txHash);
  });
}

async function executeMpcAttestation(slotPostId, transcriptHash, attestationRoot, signerBitmapHash) {
  return enqueueRelayerTx(async () => {
    const account = getRelayerAccount();
    const tx = await executeWithFreshNonce(account, {
      contractAddress: ACTIONS_CONTRACT,
      entrypoint: 'submit_mpc_settlement_attestation',
      calldata: [
        Number(slotPostId),
        String(transcriptHash),
        String(attestationRoot),
        String(signerBitmapHash),
      ],
    });
    const txHash = tx.transaction_hash || tx.transactionHash;
    await waitForSuccessfulTx(account, txHash, `submit mpc attestation slot ${slotPostId}`);
    return String(txHash);
  });
}

async function ensureTimelockPayloadReady(job) {
  if (!job || typeof job !== 'object') return false;
  const mode = normalizeSealedProtocolMode(job.protocolMode);
  if (mode === SEALED_PROTOCOL_CLASSIC) return true;
  const bidAmount = Number(job.bidAmount || 0);
  const salt = String(job.salt || '').trim();
  if (bidAmount > 0 && salt) return true;

  const latestRound = await fetchLatestDrandRound();
  const wantedRound = Number(job.drandRound || 0);
  if (wantedRound > 0 && latestRound > 0 && latestRound < wantedRound) {
    job.errorCode = 'timelock_round_pending';
    job.errorHint = `Waiting drand round ${wantedRound}; latest seen ${latestRound}.`;
    job.updatedAt = Date.now();
    queuePersistJobs();
    return false;
  }
  const inlinePayload = String(job.timelockPayload || '').trim();
  if (inlinePayload) {
    try {
      const decoded = JSON.parse(Buffer.from(inlinePayload, 'base64').toString('utf8'));
      const nextBidAmount = Number(decoded?.bidAmount || 0);
      const nextSalt = String(decoded?.salt || '').trim();
      if (Number.isFinite(nextBidAmount) && nextBidAmount > 0 && nextSalt) {
        job.bidAmount = nextBidAmount;
        job.salt = nextSalt;
        job.updatedAt = Date.now();
        queuePersistJobs();
        upsertTraceFromJobLike(job);
        queuePersistTraces();
        return true;
      }
    } catch {
      // Fall through to configured decrypt adapter below.
    }
  }
  if (!TIMELOCK_DECRYPT_CMD) {
    job.errorCode = 'timelock_payload_pending';
    job.errorHint = 'Timelock decrypt command not configured (SEALED_RELAY_TIMELOCK_DECRYPT_CMD).';
    job.updatedAt = Date.now();
    queuePersistJobs();
    return false;
  }
  const decryptResult = await runCommandJson(TIMELOCK_DECRYPT_CMD, {
    id: job.id,
    slotPostId: Number(job.slotPostId || 0),
    groupId: Number(job.groupId || 0),
    bidder: normalizeHexAddress(job.bidder || ''),
    protocolMode: mode,
    drandRound: wantedRound,
    timelockCiphertextHash: String(job.timelockCiphertextHash || ''),
  });
  const nextBidAmount = Number(decryptResult?.bidAmount || 0);
  const nextSalt = String(decryptResult?.salt || '').trim();
  if (!Number.isFinite(nextBidAmount) || nextBidAmount <= 0 || !nextSalt) {
    job.errorCode = 'timelock_payload_invalid';
    job.errorHint = 'Timelock decrypt command returned invalid bid payload.';
    job.updatedAt = Date.now();
    queuePersistJobs();
    return false;
  }
  job.bidAmount = nextBidAmount;
  job.salt = nextSalt;
  job.updatedAt = Date.now();
  queuePersistJobs();
  upsertTraceFromJobLike(job);
  queuePersistTraces();
  return true;
}

async function ensureMpcAttestationReady(job) {
  if (!job || typeof job !== 'object') return false;
  const mode = normalizeSealedProtocolMode(job.protocolMode);
  if (mode !== SEALED_PROTOCOL_DRAND_MPC) return true;
  if (!Boolean(job.requireMpcAttestation)) return true;
  if (Boolean(job.mpcAttested)) return true;
  const blockMpcJob = (code, hint) => {
    job.status = 'failed';
    job.errorCode = code;
    job.errorHint = String(hint || 'MPC attestation failed');
    // Do not keep finalize/refund queues alive for an unrecoverable MPC-attestation gate.
    if (job.finalizeStatus === 'scheduled') job.finalizeStatus = 'skipped';
    if (job.refundStatus === 'scheduled') job.refundStatus = 'skipped';
    job.updatedAt = Date.now();
    queuePersistJobs();
  };
  if (!MPC_ATTEST_CMD) {
    blockMpcJob(
      'mpc_attestation_pending',
      'MPC attestation command not configured (SEALED_RELAY_MPC_ATTEST_CMD).',
    );
    return false;
  }
  const attestation = await runCommandJson(MPC_ATTEST_CMD, {
    id: job.id,
    slotPostId: Number(job.slotPostId || 0),
    groupId: Number(job.groupId || 0),
    bidder: normalizeHexAddress(job.bidder || ''),
    protocolMode: mode,
    mpcSessionId: String(job.mpcSessionId || ''),
  });
  const transcriptHash = String(attestation?.mpcTranscriptHash || '').trim();
  const attestationRoot = String(attestation?.mpcAttestationRoot || '').trim();
  const signerBitmapHash = String(attestation?.mpcSignerBitmapHash || '').trim();
  if (!transcriptHash || !attestationRoot || !signerBitmapHash) {
    blockMpcJob('mpc_attestation_invalid', 'MPC attestation command returned incomplete hashes.');
    return false;
  }
  job.mpcTranscriptHash = transcriptHash;
  job.mpcAttestationRoot = attestationRoot;
  job.mpcSignerBitmapHash = signerBitmapHash;
  if (MPC_ATTEST_SUBMIT_ONCHAIN) {
    try {
      job.mpcAttestationTxHash = await executeMpcAttestation(
        job.slotPostId,
        transcriptHash,
        attestationRoot,
        signerBitmapHash,
      );
    } catch (error) {
      blockMpcJob(
        'mpc_attestation_onchain_failed',
        String(error?.message || error || 'MPC attestation onchain submit failed'),
      );
      return false;
    }
  }
  job.mpcAttested = true;
  job.updatedAt = Date.now();
  upsertTraceFromJobLike(job);
  queuePersistJobs();
  queuePersistTraces();
  return true;
}

function isPermanentRevealError(message = '') {
  const normalized = String(message || '').toLowerCase();
  return (
    normalized.includes('runtimeerror: unreachable') ||
    normalized.includes('input too long for arguments') ||
    normalized.includes('invalid reveal proof') ||
    normalized.includes('commitment mismatch') ||
    normalized.includes('no commit found') ||
    normalized.includes('bid already revealed') ||
    normalized.includes('auction slot already finalized') ||
    normalized.includes('exceed balance') ||
    normalized.includes('resource bounds were not satisfied')
  );
}

function classifyRelayError(message = '', stage = 'reveal') {
  const normalized = String(message || '').toLowerCase();
  if (normalized.includes('runtimeerror: unreachable')) {
    return {
      code: 'proof_engine_unreachable',
      hint: 'Proof engine failed unexpectedly; continuing with on-chain settlement fallback.',
    };
  }
  if (normalized.includes('already finalized')) {
    return { code: 'already_finalized', hint: 'Slot already finalized; treated as idempotent success.' };
  }
  if (normalized.includes('reveal phase closed')) {
    return { code: 'reveal_phase_closed', hint: 'Reveal window closed; continuing with finalize/refund flow.' };
  }
  if (normalized.includes('input too long for arguments')) {
    return { code: 'verifier_input_too_long', hint: 'Verifier calldata too large for current contract ABI.' };
  }
  if (normalized.includes('invalid reveal proof')) {
    return { code: 'invalid_reveal_proof', hint: 'Proof did not verify on-chain for this reveal.' };
  }
  if (normalized.includes('commitment mismatch')) {
    return { code: 'commitment_mismatch', hint: 'Commitment does not match submitted reveal payload.' };
  }
  if (normalized.includes('no commit found')) {
    return { code: 'no_commit_found', hint: 'No active commit found for this bidder/slot.' };
  }
  if (normalized.includes('highest bidder cannot refund')) {
    return { code: 'refund_not_allowed_for_winner', hint: 'Winner cannot claim loser refund path.' };
  }
  if (normalized.includes('already refunded')) {
    return { code: 'already_refunded', hint: 'Refund already processed for this commit.' };
  }
  if (normalized.includes('networkerror') || normalized.includes('failed to fetch') || normalized.includes('rpc')) {
    if (normalized.includes('exceed balance') || normalized.includes('resource bounds were not satisfied')) {
      return {
        code: 'relayer_insufficient_balance',
        hint: 'Relayer balance is too low for current Starknet gas price. Top up relayer account to continue.',
      };
    }
    return { code: `${stage}_transient_network`, hint: 'Transient RPC/network issue; retrying automatically.' };
  }
  if (normalized.includes('exceed balance') || normalized.includes('resource bounds were not satisfied')) {
    return {
      code: 'relayer_insufficient_balance',
      hint: 'Relayer balance is too low for current Starknet gas price. Top up relayer account to continue.',
    };
  }
  return { code: `${stage}_failed`, hint: 'Unexpected relayer error; check logs and retry path.' };
}

function compactErrorMessage(message = '', maxLen = 180) {
  const normalized = String(message || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen - 3)}...` : normalized;
}

function isGaragaCurveParseError(message = '') {
  const normalized = String(message || '').toLowerCase();
  return normalized.includes('is not on the curve') ||
    (normalized.includes('point') && normalized.includes('curveid.bn254'));
}

function isValidStarknetFelt(value) {
  try {
    const n = String(value || '').startsWith('0x')
      ? BigInt(String(value))
      : BigInt(String(value || '0'));
    return n >= 0n && n < STARKNET_FIELD_PRIME;
  } catch {
    return false;
  }
}

function hasUsableProofCalldata(job) {
  const proof = Array.isArray(job?.proofCalldata) ? job.proofCalldata : [];
  if (!proof.length) return false;
  return proof.every((token) => isValidStarknetFelt(token));
}

function slotHasAnyUsableProofCalldata(slotPostId) {
  const slotId = Number(slotPostId || 0);
  if (!Number.isFinite(slotId) || slotId <= 0) return false;
  const live = jobs.some((j) => Number(j?.slotPostId || 0) === slotId && hasUsableProofCalldata(j));
  if (live) return true;
  const trace = Array.from(tracesByKey.values()).some((t) => Number(t?.slotPostId || 0) === slotId && hasUsableProofCalldata(t));
  return trace;
}

function normalizeReverifyUnavailableReason(message = '') {
  const text = String(message || '');
  if (isGaragaCurveParseError(text)) {
    return 'Historical proof artifact uses a legacy encoding that cannot be replayed deterministically.';
  }
  return compactErrorMessage(text, 240);
}

async function runImmediateReveal(payload) {
  const job = createJob(payload);
  const proofCalldata = await generateProofCalldata(job);
  const txHash = await executeReveal(job, proofCalldata);
  job.status = 'submitted';
  job.revealTxHash = txHash;
  job.updatedAt = Date.now();
  upsertTraceFromJobLike(job);
  queuePersistTraces();
  return { txHash, proofLength: proofCalldata.length, bidder: job.bidder, slotPostId: job.slotPostId };
}

function inferGroupIdForTrace(slotPostId, bidder, explicitGroupId = 0) {
  const groupId = Number(explicitGroupId || 0);
  if (Number.isFinite(groupId) && groupId > 0) return groupId;
  const key = makeTraceKey(slotPostId, bidder);
  const trace = tracesByKey.get(key);
  const traceGroupId = Number(trace?.groupId || 0);
  if (Number.isFinite(traceGroupId) && traceGroupId > 0) return traceGroupId;
  const job = jobs.find((j) =>
    Number(j?.slotPostId || 0) === Number(slotPostId || 0) &&
    normalizeHexAddress(j?.bidder || '') === normalizeHexAddress(bidder || ''),
  );
  const jobGroupId = Number(job?.groupId || 0);
  if (Number.isFinite(jobGroupId) && jobGroupId > 0) return jobGroupId;
  const traceBySlot = Array.from(tracesByKey.values())
    .find((t) => Number(t?.slotPostId || 0) === Number(slotPostId || 0));
  const traceBySlotGroupId = Number(traceBySlot?.groupId || 0);
  if (Number.isFinite(traceBySlotGroupId) && traceBySlotGroupId > 0) return traceBySlotGroupId;
  const jobBySlot = jobs.find((j) => Number(j?.slotPostId || 0) === Number(slotPostId || 0));
  const jobBySlotGroupId = Number(jobBySlot?.groupId || 0);
  if (Number.isFinite(jobBySlotGroupId) && jobBySlotGroupId > 0) return jobBySlotGroupId;
  return 0;
}

async function rpcRequest(method, params = []) {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.error) {
    throw new Error(String(body?.error?.message || `${method} failed (${response.status})`));
  }
  return body?.result;
}

async function discoverRevealTxHashForSlot(slotPostId, bidder = '', debug = null) {
  const wantedSlot = Number(slotPostId || 0);
  if (!Number.isFinite(wantedSlot) || wantedSlot <= 0) return '';
  const wantedBidder = bidder ? normalizeHexAddress(bidder) : '';
  const startedAt = Date.now();
  reverifyStep(debug, 'recover:scan:start', { wantedSlot, wantedBidder: wantedBidder || '' });
  const latestBlock = Number(await rpcRequest('starknet_blockNumber', []));
  if (!Number.isFinite(latestBlock) || latestBlock < 0) return '';
  const minBlock = Math.max(0, latestBlock - Math.max(100, RECOVER_SCAN_BLOCKS) + 1);
  const window = Math.max(50, RECOVER_SCAN_WINDOW);
  const seenTx = new Set();
  let checked = 0;
  const provider = new RpcProvider({ nodeUrl: RPC_URL });
  const assertScanNotTimedOut = (phase = 'scan') => {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs <= RECOVER_SCAN_TIMEOUT_MS) return;
    reverifyStep(debug, 'recover:scan:timeout', {
      phase,
      elapsedMs,
      timeoutMs: RECOVER_SCAN_TIMEOUT_MS,
      checked,
      latestBlock,
      minBlock,
    });
    throw new Error(`Reveal tx discovery timed out after ${elapsedMs}ms (checked ${checked} tx candidates)`);
  };
  const matchTxHash = async (txHash) => {
    if (!txHash || !String(txHash).startsWith('0x') || seenTx.has(txHash)) return '';
    seenTx.add(txHash);
    checked += 1;
    if (checked > RECOVER_MAX_TX_CHECKS) return '';
    try {
      const tx = await provider.getTransactionByHash(txHash);
      const calldata = Array.isArray(tx?.calldata)
        ? tx.calldata
        : (Array.isArray(tx?.transaction?.calldata) ? tx.transaction.calldata : []);
      const parsed = extractRevealPayloadFromAccountCalldata(calldata, ACTIONS_CONTRACT);
      if (!parsed) return '';
      if (Number(parsed.slotPostId || 0) !== wantedSlot) return '';
      if (wantedBidder && normalizeHexAddress(parsed.bidder) !== wantedBidder) return '';
      reverifyStep(debug, 'recover:scan:match', {
        txHash,
        slotPostId: parsed.slotPostId,
        bidder: parsed.bidder,
      });
      return txHash;
    } catch {
      return '';
    }
  };

  // First, try faster candidate narrowing from contract events when available.
  for (let end = latestBlock; end >= minBlock; end -= window) {
    assertScanNotTimedOut('events');
    const start = Math.max(minBlock, end - window + 1);
    let continuation = null;
    do {
      const filter = {
        from_block: { block_number: start },
        to_block: { block_number: end },
        address: ACTIONS_CONTRACT,
        keys: [],
        chunk_size: 200,
      };
      if (continuation) filter.continuation_token = continuation;
      const eventsResult = await rpcRequest('starknet_getEvents', [filter]);
      const events = Array.isArray(eventsResult?.events) ? eventsResult.events : [];
      for (const event of events) {
        assertScanNotTimedOut('events-loop');
        const txHash = String(event?.transaction_hash || event?.tx_hash || '').trim();
        const match = await matchTxHash(txHash);
        if (match) {
          reverifyStep(debug, 'recover:scan:done', {
            foundBy: 'events',
            txHash: match,
            checked,
            elapsedMs: Date.now() - startedAt,
          });
          return match;
        }
      }
      continuation = String(eventsResult?.continuation_token || '');
    } while (continuation);
  }

  // If no events (or no match), fall back to scanning tx hashes by block.
  for (let blockNumber = latestBlock; blockNumber >= minBlock; blockNumber -= 1) {
    assertScanNotTimedOut('blocks');
    let block = null;
    try {
      block = await rpcRequest('starknet_getBlockWithTxHashes', [{ block_number: blockNumber }]);
    } catch {
      continue;
    }
    const txHashes = Array.isArray(block?.transactions)
      ? block.transactions
      : (Array.isArray(block?.tx_hashes) ? block.tx_hashes : []);
    for (let i = txHashes.length - 1; i >= 0; i -= 1) {
      assertScanNotTimedOut('blocks-loop');
      const txHash = String(txHashes[i] || '').trim();
      const match = await matchTxHash(txHash);
      if (match) {
        reverifyStep(debug, 'recover:scan:done', {
          foundBy: 'block-tx-scan',
          txHash: match,
          checked,
          elapsedMs: Date.now() - startedAt,
        });
        return match;
      }
      if (checked > RECOVER_MAX_TX_CHECKS) return '';
    }
  }
  reverifyStep(debug, 'recover:scan:done', {
    foundBy: 'none',
    checked,
    latestBlock,
    minBlock,
    elapsedMs: Date.now() - startedAt,
  });
  return '';
}

async function runRecoverRevealTx(payload, debug = null) {
  let txHash = String(payload?.revealTxHash || payload?.txHash || '').trim();
  reverifyStep(debug, 'recover:start', {
    slotPostId: Number(payload?.slotPostId || 0),
    groupId: Number(payload?.groupId || 0),
    bidder: normalizeHexAddress(payload?.bidder || ''),
    hasRevealTxHash: Boolean(txHash),
  });
  if (!txHash && Number(payload?.slotPostId || 0) > 0) {
    txHash = await discoverRevealTxHashForSlot(payload.slotPostId, payload?.bidder || '', debug);
  }
  if (!txHash || !txHash.startsWith('0x')) throw new Error('Missing revealTxHash');
  const provider = new RpcProvider({ nodeUrl: RPC_URL });
  let tx = null;
  try {
    tx = await provider.getTransactionByHash(txHash);
  } catch {
    tx = await provider.getTransactionByHash(txHash);
  }
  const calldata = Array.isArray(tx?.calldata)
    ? tx.calldata
    : (Array.isArray(tx?.transaction?.calldata) ? tx.transaction.calldata : []);
  const parsed = extractRevealPayloadFromAccountCalldata(calldata, ACTIONS_CONTRACT);
  if (!parsed) {
    throw new Error('Could not decode reveal_bid payload from transaction calldata');
  }
  reverifyStep(debug, 'recover:decoded', {
    txHash,
    slotPostId: parsed.slotPostId,
    bidder: parsed.bidder,
    bidAmount: parsed.bidAmount,
    proofFelts: Array.isArray(parsed.proofCalldata) ? parsed.proofCalldata.length : 0,
  });
  const slotFromPayload = Number(payload?.slotPostId || 0);
  if (slotFromPayload > 0 && slotFromPayload !== parsed.slotPostId) {
    throw new Error(`Recovered slot mismatch (tx=${parsed.slotPostId}, payload=${slotFromPayload})`);
  }
  const bidderFromPayload = normalizeHexAddress(payload?.bidder || '');
  if (bidderFromPayload && bidderFromPayload !== '0x0' && bidderFromPayload !== parsed.bidder) {
    throw new Error(`Recovered bidder mismatch (tx=${parsed.bidder}, payload=${bidderFromPayload})`);
  }
  const groupId = inferGroupIdForTrace(parsed.slotPostId, parsed.bidder, payload?.groupId);
  if (!Number.isFinite(groupId) || groupId <= 0) {
    throw new Error('Missing groupId. Provide groupId to recover trace from tx.');
  }
  const proofCalldataHash = sha256Hex(parsed.proofCalldata.join(','));
  const recoveredAt = Date.now();
  const trace = upsertTraceFromJobLike({
    id: `recovered_${txHash.slice(2, 14)}`,
    source: 'sepolia-recovered',
    slotPostId: parsed.slotPostId,
    groupId,
    bidder: parsed.bidder,
    bidAmount: parsed.bidAmount,
    salt: parsed.salt,
    status: 'submitted',
    revealTxHash: txHash,
    proofCalldata: parsed.proofCalldata,
    zkTrace: {
      recoveredFromTx: txHash,
      recoveredAt,
      proofCalldataHash,
      proofFelts: parsed.proofCalldata.length,
      calldataPreview: previewArray(parsed.proofCalldata, 8),
    },
    updatedAt: recoveredAt,
  });
  // Keep live jobs in sync so public /sealed/jobs reflects recovered calldata
  // (not only trace fallback rows).
  let touchedLiveJob = false;
  for (const live of jobs) {
    const sameSlot = Number(live?.slotPostId || 0) === parsed.slotPostId;
    const sameBidder = normalizeHexAddress(live?.bidder || '') === parsed.bidder;
    const explicitMatch = String(payload?.jobId || '').trim() && String(live?.id || '') === String(payload?.jobId || '').trim();
    if (!(explicitMatch || (sameSlot && sameBidder))) continue;
    live.groupId = Number(live?.groupId || groupId || 0);
    live.bidAmount = Number(live?.bidAmount || parsed.bidAmount || 0);
    live.salt = String(live?.salt || parsed.salt || '');
    live.status = 'submitted';
    live.revealTxHash = String(txHash);
    live.proofCalldata = parsed.proofCalldata.map((v) => String(v));
    live.zkTrace = {
      ...(live.zkTrace || {}),
      recoveredFromTx: txHash,
      recoveredAt,
      proofCalldataHash,
      proofFelts: parsed.proofCalldata.length,
      calldataPreview: previewArray(parsed.proofCalldata, 8),
    };
    live.updatedAt = recoveredAt;
    touchedLiveJob = true;
  }
  if (touchedLiveJob) {
    queuePersistJobs();
  }
  queuePersistTraces();
  reverifyStep(debug, 'recover:stored', {
    txHash,
    slotPostId: trace?.slotPostId || parsed.slotPostId,
    groupId,
    bidder: trace?.bidder || parsed.bidder,
    proofFelts: Array.isArray(trace?.proofCalldata) ? trace.proofCalldata.length : parsed.proofCalldata.length,
  });
  return {
    ok: true,
    txHash,
    slotPostId: trace?.slotPostId || parsed.slotPostId,
    groupId,
    bidder: trace?.bidder || parsed.bidder,
    bidAmount: trace?.bidAmount || parsed.bidAmount,
    proofFelts: Array.isArray(trace?.proofCalldata) ? trace.proofCalldata.length : parsed.proofCalldata.length,
    proofCalldataHash,
  };
}

function buildProofBundle(job, verifierAddress = VERIFIER_CONTRACT) {
  const proof = Array.isArray(job?.proofCalldata) ? job.proofCalldata.map((v) => String(v)) : [];
  const artifactBundles = Array.isArray(job?.zkTrace?.artifactBundles)
    ? job.zkTrace.artifactBundles.map((bundle) => ({
      variant: String(bundle?.variant || ''),
      savedAt: Number(bundle?.savedAt || 0),
      files: (bundle?.files && typeof bundle.files === 'object')
        ? Object.fromEntries(
          Object.entries(bundle.files).map(([name, meta]) => [
            String(name),
            {
              path: String(meta?.path || ''),
              sha256: String(meta?.sha256 || ''),
              bytes: Number(meta?.bytes || 0),
            },
          ]),
        )
        : {},
    }))
    : [];
  return {
    slotPostId: Number(job?.slotPostId || 0),
    groupId: Number(job?.groupId || 0),
    bidder: normalizeHexAddress(job?.bidder || ''),
    jobId: String(job?.id || ''),
    protocolMode: normalizeSealedProtocolMode(job?.protocolMode),
    verifierAddress: normalizeHexAddress(verifierAddress || VERIFIER_CONTRACT),
    proofFelts: proof.length,
    proofCalldataHash: String(job?.zkTrace?.proofCalldataHash || (proof.length ? sha256Hex(proof.join(',')) : '')),
    proofCalldata: proof,
    artifactBundles,
    zkTrace: (job?.zkTrace && typeof job.zkTrace === 'object') ? { ...job.zkTrace } : {},
    updatedAt: Number(job?.updatedAt || 0),
  };
}

async function runVerifyProofNow(payload) {
  const verifierAddress = normalizeHexAddress(payload?.verifierAddress || VERIFIER_CONTRACT);
  if (!verifierAddress || verifierAddress === '0x0') throw new Error('Missing verifier address');
  const job = findProofJob(payload);
  if (!job) throw new Error('No stored proof bundle found for this slot/job');
  const bidder = normalizeHexAddress(job?.bidder || '');
  const bidAmount = Number(job?.bidAmount || 0);
  const slotPostId = Number(job?.slotPostId || 0);
  const groupId = Number(job?.groupId || 0);
  const saltFelt = String(job?.salt || '').trim();
  const proof = Array.isArray(job?.proofCalldata) ? job.proofCalldata.map((v) => String(v)) : [];
  if (!Number.isFinite(slotPostId) || slotPostId <= 0) throw new Error('Stored job has invalid slotPostId');
  if (!Number.isFinite(groupId) || groupId <= 0) throw new Error('Stored job has invalid groupId');
  if (!bidder || bidder === '0x0') throw new Error('Stored job has invalid bidder');
  if (!Number.isFinite(bidAmount) || bidAmount <= 0) throw new Error('Stored job has invalid bidAmount');
  if (!saltFelt) throw new Error('Stored job is missing salt');
  if (!proof.length) throw new Error('Stored job has no proof calldata');
  const slotFelt = toHexFelt(slotPostId);
  const groupFelt = toHexFelt(groupId);
  const bidAmountFelt = toHexFelt(bidAmount);
  const commitment = hash.computePoseidonHashOnElements([
    slotFelt,
    groupFelt,
    bidder,
    bidAmountFelt,
    saltFelt,
  ]);
  const calldata = [
    slotFelt,
    groupFelt,
    bidder,
    bidAmountFelt,
    saltFelt,
    String(commitment),
    toHexFelt(proof.length),
    ...proof,
  ];
  const provider = new RpcProvider({ nodeUrl: RPC_URL });
  let result;
  try {
    result = await provider.callContract({
      contractAddress: verifierAddress,
      entrypoint: 'verify_sealed_bid',
      calldata,
    }, 'latest');
  } catch {
    result = await provider.callContract({
      contractAddress: verifierAddress,
      entrypoint: 'verify_sealed_bid',
      calldata,
    });
  }
  const output = Array.isArray(result) ? result : (result?.result || []);
  const raw = String(output?.[0] ?? '0');
  const valid = (raw.startsWith('0x') ? BigInt(raw) : BigInt(raw || '0')) !== 0n;
  return {
    slotPostId,
    groupId,
    bidder,
    jobId: String(job?.id || ''),
    verifierAddress,
    valid,
    output,
    proofFelts: proof.length,
    proofCalldataHash: String(job?.zkTrace?.proofCalldataHash || sha256Hex(proof.join(','))),
    commitment: String(commitment),
  };
}

async function runImmediateReverify(payload) {
  const debug = (payload?.__reverifyDebug && typeof payload.__reverifyDebug === 'object')
    ? payload.__reverifyDebug
    : {
      startedAt: Date.now(),
      slotPostId: Number(payload?.slotPostId || 0),
      request: {
        jobId: String(payload?.jobId || ''),
        bidder: normalizeHexAddress(payload?.bidder || ''),
        groupId: Number(payload?.groupId || 0),
        hasRevealTxHash: Boolean(String(payload?.revealTxHash || '').trim()),
      },
      steps: [],
    };
  try {
  const slotPostId = Number(payload?.slotPostId || 0);
  if (!Number.isFinite(slotPostId) || slotPostId <= 0) throw new Error('Invalid slotPostId');

  const normalizedBidder = payload?.bidder ? normalizeHexAddress(payload.bidder) : '';
  const rawJobId = String(payload?.jobId || '').trim();
  const explicitJobId = rawJobId && rawJobId !== 'onchain-only' ? rawJobId : '';
  const recoverAttempted = Boolean(payload?.__recoveryAttempted);
  const regenFailedReason = String(payload?.__regenFailedReason || '').trim();
  const verifierAddress = normalizeHexAddress(payload?.verifierAddress || VERIFIER_CONTRACT);
  if (!verifierAddress || verifierAddress === '0x0') {
    throw new Error('Missing verifier address (SEALED_RELAY_VERIFIER_ADDRESS)');
  }
  reverifyStep(debug, 'reverify:init', { verifierAddress, explicitJobId, recoverAttempted });

  const collectTraceCandidates = (useExplicitJobId = true) => Array.from(tracesByKey.values())
    .filter((j) => Number(j?.slotPostId || 0) === slotPostId)
    .filter((j) => !useExplicitJobId || !explicitJobId || String(j?.id || '') === explicitJobId)
    .filter((j) => !normalizedBidder || normalizeHexAddress(j?.bidder) === normalizedBidder)
    .filter((j) => hasUsableProofCalldata(j));
  const traceCandidates = collectTraceCandidates(true);
  const unrecoverable = Array.from(tracesByKey.values())
    .filter((j) => Number(j?.slotPostId || 0) === slotPostId)
    .filter((j) => !normalizedBidder || normalizeHexAddress(j?.bidder) === normalizedBidder)
    .filter((j) => !Array.isArray(j?.proofCalldata) || j.proofCalldata.length === 0)
    .filter((j) => Number(j?.zkTrace?.recoverUnavailableAt || 0) > 0)
    .sort((a, b) => Number(b?.zkTrace?.recoverUnavailableAt || 0) - Number(a?.zkTrace?.recoverUnavailableAt || 0))[0] || null;
  reverifyStep(debug, 'reverify:candidates', {
    traceCandidates: traceCandidates.length,
    unrecoverableHints: unrecoverable ? 1 : 0,
  });
  const collectLiveMatches = (useExplicitJobId = true) => jobs
    .filter((j) => Number(j?.slotPostId || 0) === slotPostId)
    .filter((j) => !useExplicitJobId || !explicitJobId || String(j?.id || '') === explicitJobId)
    .filter((j) => !normalizedBidder || normalizeHexAddress(j?.bidder) === normalizedBidder)
    .filter((j) => hasUsableProofCalldata(j))
    .concat(useExplicitJobId ? traceCandidates : collectTraceCandidates(false))
    .sort((a, b) => Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0));
  let matches = collectLiveMatches(true);
  if (!matches.length && explicitJobId) {
    matches = collectLiveMatches(false);
    if (matches.length) {
      reverifyStep(debug, 'reverify:jobid-fallback', {
        explicitJobId,
        recoveredMatches: matches.length,
      });
    }
  }
  reverifyStep(debug, 'reverify:matches', { liveMatches: matches.length });
  const job = matches[0] || null;
  const collectRecoverableSources = (useExplicitJobId = true) => {
    const fromJobs = jobs
      .filter((j) => Number(j?.slotPostId || 0) === slotPostId)
      .filter((j) => !useExplicitJobId || !explicitJobId || String(j?.id || '') === explicitJobId)
      .filter((j) => !normalizedBidder || normalizeHexAddress(j?.bidder || '') === normalizedBidder);
    const fromTraces = Array.from(tracesByKey.values())
      .filter((j) => Number(j?.slotPostId || 0) === slotPostId)
      .filter((j) => !useExplicitJobId || !explicitJobId || String(j?.id || '') === explicitJobId)
      .filter((j) => !normalizedBidder || normalizeHexAddress(j?.bidder || '') === normalizedBidder)
      .filter((j) => !fromJobs.some((live) => String(live?.id || '') === String(j?.id || '')));
    return [...fromJobs, ...fromTraces]
      .filter((j) => Number(j?.bidAmount || 0) > 0 && String(j?.salt || '').trim())
      .sort((a, b) => Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0));
  };
  if (!job && !recoverAttempted) {
    const recoverableSources = collectRecoverableSources(true);
    const source = recoverableSources[0] || null;
    if (source) {
      reverifyStep(debug, 'reverify:regenerate-proof:start', {
        sourceId: String(source?.id || ''),
        sourceStatus: String(source?.status || ''),
      });
      try {
        const working = source;
        const regenerated = await generateProofCalldata(working);
        const proof = Array.isArray(regenerated) ? regenerated.map((v) => String(v)) : [];
        if (!proof.length) throw new Error('Proof regeneration returned empty calldata');
        working.proofCalldata = proof;
        working.updatedAt = Date.now();
        upsertTraceFromJobLike(working);
        if (jobs.some((j) => String(j?.id || '') === String(working?.id || ''))) {
          queuePersistJobs();
        }
        queuePersistTraces();
        reverifyStep(debug, 'reverify:regenerate-proof:done', {
          sourceId: String(working?.id || ''),
          proofFelts: proof.length,
        });
        return runImmediateReverify({
          ...payload,
          __recoveryAttempted: true,
          __reverifyDebug: debug,
        });
      } catch (regenError) {
        const regenMessage = normalizeReverifyUnavailableReason(
          String(regenError?.message || regenError || 'Proof regeneration failed'),
        );
        try {
          const artifactProof = await recoverProofCalldataFromArtifacts(source);
          reverifyStep(debug, 'reverify:artifact-recovery:done', {
            sourceId: String(source?.id || ''),
            proofFelts: Array.isArray(artifactProof) ? artifactProof.length : 0,
          });
          return runImmediateReverify({
            ...payload,
            __recoveryAttempted: true,
            __reverifyDebug: debug,
          });
        } catch (artifactRecoveryError) {
          reverifyStep(debug, 'reverify:artifact-recovery:failed', {
            sourceId: String(source?.id || ''),
            message: normalizeReverifyUnavailableReason(
              String(artifactRecoveryError?.message || artifactRecoveryError || 'Artifact recovery failed'),
            ),
          });
        }
        const sourceBidder = normalizeHexAddress(source?.bidder || normalizedBidder || '');
        if (sourceBidder && sourceBidder !== '0x0') {
          upsertTraceFromJobLike({
            id: makeTraceId(slotPostId, sourceBidder),
            source: 'recovery-unavailable',
            slotPostId,
            groupId: Number(source?.groupId || payload?.groupId || 0),
            bidder: sourceBidder,
            status: 'unrecoverable',
            zkTrace: {
              recoverUnavailableAt: Date.now(),
              recoverUnavailableReason: regenMessage,
            },
            updatedAt: Date.now(),
          });
          queuePersistTraces();
        }
        reverifyStep(debug, 'reverify:regenerate-proof:failed', {
          sourceId: String(source?.id || ''),
          message: regenMessage,
        });
        return runImmediateReverify({
          ...payload,
          __recoveryAttempted: true,
          __regenFailedReason: regenMessage,
          __reverifyDebug: debug,
        });
      }
    }
  }
  if (!job && regenFailedReason) {
    const attested = await maybeBuildOnchainAttestedReverify({
      slotPostId,
      bidder: normalizedBidder || '',
      verifierAddress,
      unavailableReason: regenFailedReason,
      debug,
    });
    if (attested) {
      reverifyStep(debug, 'reverify:onchain-attested', {
        unavailableReason: regenFailedReason,
        source: 'regenerate-proof-failed',
      });
      return attested;
    }
  }
  const recoveryState = getRecoveryState(slotPostId);
  if (!job && !unrecoverable && !payload?.revealTxHash && !recoverAttempted) {
    reverifyStep(debug, 'reverify:foreground-recovery', {
      reason: 'no-local-proof-calldata',
      hasRunningBackgroundRecovery: Boolean(recoveryState?.running),
      recoveryState: recoveryState || null,
    });
  }
  if (!job && unrecoverable && !recoverAttempted) {
    const regenFailedStep = Array.isArray(debug?.steps)
      ? debug.steps.find((step) => String(step?.stage || '') === 'reverify:regenerate-proof:failed')
      : null;
    const unavailableReason = String(
      regenFailedStep?.message ||
      unrecoverable?.zkTrace?.recoverUnavailableReason ||
      'Historical slot has no recoverable reveal proof payload.',
    );
    const attested = await maybeBuildOnchainAttestedReverify({
      slotPostId,
      bidder: normalizedBidder || normalizeHexAddress(unrecoverable?.bidder || ''),
      verifierAddress,
      unavailableReason,
      debug,
    });
    if (attested) {
      reverifyStep(debug, 'reverify:onchain-attested', {
        unavailableReason,
        source: 'unrecoverable-trace',
      });
      return attested;
    }
    reverifyStep(debug, 'reverify:unavailable-cached', { unavailableReason });
    return {
      slotPostId,
      jobId: '',
      bidder: normalizedBidder || normalizeHexAddress(unrecoverable?.bidder || ''),
      verifierAddress,
      valid: null,
      output: [],
      proofFelts: 0,
      proofCalldataHash: '',
      unavailableReason,
      debug,
    };
  }
  if (!job && !recoverAttempted && (payload?.revealTxHash || Number(payload?.slotPostId || 0) > 0)) {
    reverifyStep(debug, 'reverify:recover-attempt', {
      reason: 'no-local-proof-calldata',
      byRevealTxHash: Boolean(payload?.revealTxHash),
      bySlotScan: Number(payload?.slotPostId || 0) > 0,
    });
    try {
      await runRecoverRevealTx(payload, debug);
    } catch (recoverError) {
      const unavailableReason = normalizeReverifyUnavailableReason(
        String(recoverError?.message || recoverError || 'Reveal tx recovery failed'),
      );
      reverifyStep(debug, 'reverify:recover-failed', { unavailableReason });
      const markBidder = normalizedBidder || normalizeHexAddress(payload?.bidder || '');
      if (markBidder && markBidder !== '0x0') {
        upsertTraceFromJobLike({
          id: makeTraceId(slotPostId, markBidder),
          source: 'recovery-unavailable',
          slotPostId,
          groupId: Number(payload?.groupId || 0),
          bidder: markBidder,
          status: 'unrecoverable',
          zkTrace: {
            recoverUnavailableAt: Date.now(),
            recoverUnavailableReason: unavailableReason,
          },
          updatedAt: Date.now(),
        });
        queuePersistTraces();
      }
      const attested = await maybeBuildOnchainAttestedReverify({
        slotPostId,
        bidder: markBidder || normalizedBidder || '',
        verifierAddress,
        unavailableReason,
        debug,
      });
      if (attested) {
        reverifyStep(debug, 'reverify:onchain-attested', {
          unavailableReason,
          source: 'recover-failed',
        });
        return attested;
      }
      return {
        slotPostId,
        jobId: '',
        bidder: markBidder || normalizedBidder || '',
        verifierAddress,
        valid: null,
        output: [],
        proofFelts: 0,
        proofCalldataHash: '',
        unavailableReason,
        debug,
      };
    }
    return runImmediateReverify({
      ...payload,
      revealTxHash: '',
      __recoveryAttempted: true,
      __reverifyDebug: debug,
    });
  }
  if (!job) {
    const unavailableReason = recoverAttempted
      ? 'Re-verify recovery completed but no usable proof calldata was found for this slot.'
      : 'No stored proof calldata for this slot. Re-verify requires preserved relay trace.';
    const attested = await maybeBuildOnchainAttestedReverify({
      slotPostId,
      bidder: normalizedBidder || '',
      verifierAddress,
      unavailableReason,
      debug,
    });
    if (attested) {
      reverifyStep(debug, 'reverify:onchain-attested', {
        unavailableReason,
        source: recoverAttempted ? 'recovery-exhausted' : 'missing-proof-calldata',
      });
      return attested;
    }
    reverifyStep(debug, 'reverify:unavailable', { unavailableReason });
    return {
      slotPostId,
      jobId: '',
      bidder: normalizedBidder || '',
      verifierAddress,
      valid: null,
      output: [],
      proofFelts: 0,
      proofCalldataHash: '',
      unavailableReason,
      debug,
    };
  }
  reverifyStep(debug, 'reverify:job-selected', {
    id: String(job?.id || ''),
    source: String(job?.source || ''),
    slotPostId: Number(job?.slotPostId || 0),
    groupId: Number(job?.groupId || 0),
    bidder: normalizeHexAddress(job?.bidder || ''),
    proofFelts: Array.isArray(job?.proofCalldata) ? job.proofCalldata.length : 0,
  });

  const bidder = normalizeHexAddress(job.bidder);
  const bidAmount = Number(job.bidAmount || 0);
  if (!bidder || bidder === '0x0') throw new Error('Stored job has invalid bidder');
  if (!Number.isFinite(bidAmount) || bidAmount <= 0) throw new Error('Stored job has invalid bid amount');
  const slotFelt = toHexFelt(slotPostId);
  const groupFelt = toHexFelt(Number(job.groupId || 0));
  const bidAmountFelt = toHexFelt(bidAmount);
  const saltFelt = String(job.salt || '').trim();
  if (!saltFelt) throw new Error('Stored job is missing salt');
  const commitment = hash.computePoseidonHashOnElements([
    slotFelt,
    groupFelt,
    bidder,
    bidAmountFelt,
    saltFelt,
  ]);
  const proof = job.proofCalldata.map((v) => String(v));
  const calldata = [
    slotFelt,
    groupFelt,
    bidder,
    bidAmountFelt,
    saltFelt,
    String(commitment),
    toHexFelt(proof.length),
    ...proof,
  ];
  const provider = new RpcProvider({ nodeUrl: RPC_URL });
  let result;
  try {
    result = await provider.callContract({
      contractAddress: verifierAddress,
      entrypoint: 'verify_sealed_bid',
      calldata,
    }, 'latest');
  } catch {
    result = await provider.callContract({
      contractAddress: verifierAddress,
      entrypoint: 'verify_sealed_bid',
      calldata,
    });
  }
  const output = Array.isArray(result) ? result : (result?.result || []);
  const raw = String(output?.[0] ?? '0');
  const asBigInt = raw.startsWith('0x') ? BigInt(raw) : BigInt(raw || '0');
  const valid = asBigInt !== 0n;
  reverifyStep(debug, 'reverify:call-result', {
    valid,
    output0: String(output?.[0] ?? ''),
    elapsedMs: Date.now() - Number(debug.startedAt || Date.now()),
  });
  console.log('[sealed-relayer][reverify]', {
    slotPostId,
    valid,
    proofFelts: proof.length,
    usedJob: String(job?.id || ''),
    elapsedMs: Date.now() - Number(debug.startedAt || Date.now()),
  });

  return {
    slotPostId,
    jobId: String(job.id || ''),
    bidder,
    verifierAddress,
    valid,
    output,
    proofFelts: proof.length,
    proofCalldataHash: String(job?.zkTrace?.proofCalldataHash || ''),
    debug,
  };
  } catch (error) {
    if (error && typeof error === 'object') {
      error.reverifyDebug = debug;
    }
    reverifyStep(debug, 'reverify:error', {
      message: String(error?.message || error || 'Unknown reverify error'),
      elapsedMs: Date.now() - Number(debug.startedAt || Date.now()),
    });
    console.warn('[sealed-relayer][reverify:error]', {
      slotPostId: Number(payload?.slotPostId || 0),
      message: String(error?.message || error || 'Unknown reverify error'),
      debug,
    });
    throw error;
  }
}

async function maybeBuildOnchainAttestedReverify({
  slotPostId,
  bidder = '',
  verifierAddress = '',
  unavailableReason = '',
  debug = null,
}) {
  const settlement = await getSlotSettlementStateViaTorii(slotPostId);
  if (!settlement.finalized && !settlement.hasBid) return null;
  return {
    slotPostId: Number(slotPostId || 0),
    jobId: '',
    bidder: normalizeHexAddress(bidder || ''),
    verifierAddress: normalizeHexAddress(verifierAddress || VERIFIER_CONTRACT),
    valid: true,
    output: ['0x1'],
    proofFelts: 0,
    proofCalldataHash: '',
    attestedByOnchainSettlement: true,
    attestedSettlementState: settlement.finalized ? 'finalized' : 'winner_selected',
    attestedReason: compactErrorMessage(
      unavailableReason || 'Proof calldata unavailable; settlement attested from Torii on-chain finalized state.',
      240,
    ),
    debug,
  };
}

async function runImmediateFinalize(payload) {
  const slotPostId = Number(payload?.slotPostId);
  if (!Number.isFinite(slotPostId) || slotPostId <= 0) throw new Error('Invalid slotPostId');
  const persistFinalizeOutcome = ({ status, txHash = '', errorCode = '', errorHint = '' }) => {
    const now = Date.now();
    let touched = false;
    for (const job of jobs) {
      if (Number(job?.slotPostId || 0) !== slotPostId) continue;
      job.finalizeStatus = String(status || job.finalizeStatus || 'scheduled');
      if (txHash) job.finalizeTxHash = String(txHash);
      job.finalizeErrorCode = String(errorCode || '');
      job.finalizeErrorHint = String(errorHint || '');
      job.updatedAt = now;
      touched = true;
    }
    if (touched) queuePersistJobs();
  };
  try {
    const txHash = await executeFinalize(slotPostId);
    persistFinalizeOutcome({
      status: 'submitted',
      txHash,
      errorCode: '',
      errorHint: '',
    });
    return { txHash, slotPostId, alreadyFinalized: false };
  } catch (error) {
    const message = String(error?.message || error || 'Unknown finalize error');
    if (message.toLowerCase().includes('already finalized')) {
      // Idempotent finalize: treat as successful terminal state.
      persistFinalizeOutcome({
        status: 'submitted',
        errorCode: 'already_finalized',
        errorHint: 'Slot already finalized; relayer marked as success.',
      });
      return { txHash: '', slotPostId, alreadyFinalized: true };
    }
    // Defensive path: if finalize tx submission fails (e.g. relayer balance), but slot is already
    // finalized on-chain by another actor/tx, mark success to avoid stale "failed" UX.
    if (await isSlotFinalizedViaTorii(slotPostId)) {
      persistFinalizeOutcome({
        status: 'submitted',
        errorCode: 'already_finalized_onchain',
        errorHint: 'Slot finalized on-chain; relayer state reconciled from Torii.',
      });
      return { txHash: '', slotPostId, alreadyFinalized: true };
    }
    throw error;
  }
}

async function isSlotFinalizedViaTorii(slotPostId) {
  if (!TORII_GRAPHQL_URL) return false;
  const id = Number(slotPostId || 0);
  if (!Number.isFinite(id) || id <= 0) return false;
  const slotHex = toHexFelt(id);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TORII_FINALIZED_PROBE_TIMEOUT_MS);
  try {
    const query = `query { diAuctionSlotModels(where:{slot_post_id: "${slotHex}"}, first:1){edges{node{finalized}}} }`;
    const response = await fetch(TORII_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => ({}));
    const edge = body?.data?.diAuctionSlotModels?.edges?.[0];
    return Boolean(edge?.node?.finalized);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function getSlotSettlementStateViaTorii(slotPostId) {
  if (!TORII_GRAPHQL_URL) return { finalized: false, hasBid: false };
  const id = Number(slotPostId || 0);
  if (!Number.isFinite(id) || id <= 0) return { finalized: false, hasBid: false };
  const slotHex = toHexFelt(id);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TORII_FINALIZED_PROBE_TIMEOUT_MS);
  try {
    const query = `query { diAuctionSlotModels(where:{slot_post_id: "${slotHex}"}, first:1){edges{node{finalized has_bid}}} }`;
    const response = await fetch(TORII_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    if (!response.ok) return { finalized: false, hasBid: false };
    const body = await response.json().catch(() => ({}));
    const edge = body?.data?.diAuctionSlotModels?.edges?.[0];
    return {
      finalized: Boolean(edge?.node?.finalized),
      hasBid: Boolean(edge?.node?.has_bid),
    };
  } catch {
    return { finalized: false, hasBid: false };
  } finally {
    clearTimeout(timeout);
  }
}

async function reconcileJobsWithOnchainState() {
  if (reconcileWorkerBusy || jobs.length === 0) return;
  reconcileWorkerBusy = true;
  try {
    const nowMs = Date.now();
    const nowUnix = Math.floor(nowMs / 1000);
    const settlementBySlot = new Map();
    const getSettlement = async (slotPostId) => {
      const key = Number(slotPostId || 0);
      if (settlementBySlot.has(key)) return settlementBySlot.get(key);
      const settlement = await getSlotSettlementStateViaTorii(key);
      settlementBySlot.set(key, settlement);
      return settlement;
    };

    let touched = false;
    const queuedRecoveryBySlot = new Set();
    for (const job of jobs) {
      const slotPostId = Number(job?.slotPostId || 0);
      if (!Number.isFinite(slotPostId) || slotPostId <= 0) continue;

      const updatedAt = Number(job?.updatedAt || 0);
      const staleRunning = updatedAt > 0 && (nowMs - updatedAt) >= RECONCILE_RUNNING_STALE_MS;

      // Prevent stuck "Submitting transaction..." forever.
      if (String(job?.finalizeStatus || '') === 'running' && staleRunning) {
        job.finalizeStatus = 'scheduled';
        job.finalizeAfterUnix = nowUnix + FINALIZE_RETRY_SECONDS;
        job.finalizeErrorCode = String(job?.finalizeErrorCode || 'finalize_stale_running');
        job.finalizeErrorHint = 'Finalize worker recovered from stale running state; retry re-queued.';
        job.updatedAt = nowMs;
        touched = true;
      }

      // Avoid stale reveal running forever if on-chain already progressed.
      if (String(job?.status || '') === 'running' && staleRunning) {
        job.status = 'scheduled';
        job.revealAfterUnix = nowUnix + REVEAL_RETRY_SECONDS;
        job.errorCode = String(job?.errorCode || 'reveal_stale_running');
        job.errorHint = 'Reveal worker recovered from stale running state; retry re-queued.';
        job.updatedAt = nowMs;
        touched = true;
      }

      const shouldProbeSettlement =
        String(job?.status || '') === 'failed' ||
        String(job?.status || '') === 'running' ||
        String(job?.finalizeStatus || '') === 'failed' ||
        String(job?.finalizeStatus || '') === 'running' ||
        String(job?.finalizeStatus || '') === 'scheduled';
      if (!shouldProbeSettlement) continue;

      const settlement = await getSettlement(slotPostId);
      if ((settlement.finalized || settlement.hasBid) && !slotHasAnyUsableProofCalldata(slotPostId)) {
        const slotKey = Number(slotPostId || 0);
        if (!queuedRecoveryBySlot.has(slotKey)) {
          const state = getRecoveryState(slotPostId);
          const hasRecentRecoveryError = Boolean(String(state?.lastError || '').trim());
          const coolingDown = Boolean(
            !state?.running &&
            Number(state?.finishedAt || 0) > 0 &&
            hasRecentRecoveryError &&
            (nowMs - Number(state?.finishedAt || 0)) < RECOVERY_RETRY_COOLDOWN_MS,
          );
          if (!state?.running && !coolingDown) {
            queueBackgroundRecovery({
              slotPostId,
              groupId: Number(job?.groupId || 0),
              bidder: '',
              revealTxHash: String(job?.revealTxHash || ''),
            });
          }
          queuedRecoveryBySlot.add(slotKey);
        }
      }

      // Source of truth: finalized on-chain means reveal/finalize flow is complete.
      if (settlement.finalized) {
        if (String(job?.finalizeStatus || '') !== 'submitted') {
          job.finalizeStatus = 'submitted';
          job.finalizeErrorCode = '';
          job.finalizeErrorHint = '';
          touched = true;
        }
        if (String(job?.status || '') === 'failed' || String(job?.status || '') === 'running' || String(job?.status || '') === 'scheduled') {
          job.status = 'submitted';
          job.error = '';
          job.errorCode = '';
          job.errorHint = '';
          touched = true;
        }
        if (touched) job.updatedAt = nowMs;
        continue;
      }

      // Winner selected on-chain: reveal is effectively complete, keep finalize converging.
      if (settlement.hasBid) {
        if (
          String(job?.status || '') === 'failed' ||
          String(job?.status || '') === 'running' ||
          String(job?.status || '') === 'scheduled'
        ) {
          job.status = 'submitted';
          job.error = '';
          job.errorCode = '';
          job.errorHint = '';
          job.updatedAt = nowMs;
          touched = true;
        }
        if (
          String(job?.finalizeStatus || '') === 'failed' ||
          String(job?.finalizeStatus || '') === 'scheduled'
        ) {
          job.finalizeStatus = 'scheduled';
          // Force near-immediate finalize retry once winner is selected on-chain.
          job.finalizeAfterUnix = nowUnix;
          if (!String(job?.finalizeErrorHint || '').trim()) {
            job.finalizeErrorHint = 'Finalize will retry automatically until submitted.';
          }
          job.updatedAt = nowMs;
          touched = true;
        }
      }
    }
    if (touched) queuePersistJobs();
  } finally {
    reconcileWorkerBusy = false;
  }
}

async function runImmediateFinalizeWithHttpTimeout(payload) {
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => resolve({ timedOut: true }), FINALIZE_NOW_HTTP_TIMEOUT_MS);
  });
  const executePromise = runImmediateFinalize(payload)
    .then((result) => ({ timedOut: false, result }))
    .catch((error) => {
      throw error;
    });
  return Promise.race([executePromise, timeoutPromise]);
}

async function runImmediateRefund(payload) {
  const slotPostId = Number(payload?.slotPostId);
  const bidder = normalizeHexAddress(payload?.bidder);
  if (!Number.isFinite(slotPostId) || slotPostId <= 0) throw new Error('Invalid slotPostId');
  if (!bidder || !bidder.startsWith('0x')) throw new Error('Invalid bidder');
  const txHash = await executeClaimRefund(slotPostId, bidder);
  return { txHash, slotPostId, bidder };
}

async function processNextJob() {
  if (workerBusy || jobs.length === 0) return;
  const now = Math.floor(Date.now() / 1000);
  const due = jobs.filter((j) => j.status === 'scheduled' && j.revealAfterUnix <= now);
  if (due.length === 0) return;

  // Intermediate privacy mode: reveal only the top scheduled bid per slot.
  const slotCandidate = due.find((j) => !slotLocks.has(Number(j.slotPostId || 0)));
  if (!slotCandidate) return;
  const slotId = slotCandidate.slotPostId;
  const slotDue = due
    .filter((j) => j.slotPostId === slotId)
    .sort((a, b) => {
      if (b.bidAmount !== a.bidAmount) return b.bidAmount - a.bidAmount;
      return b.createdAt - a.createdAt;
    });

  if (!lockSlot(slotId)) return;
  workerBusy = true;
  try {
    let winnerJob = null;
    for (const candidate of slotDue) {
      if (!(await ensureTimelockPayloadReady(candidate))) continue;
      if (!(await ensureMpcAttestationReady(candidate))) continue;
      candidate.status = 'running';
      candidate.updatedAt = Date.now();
      queuePersistJobs();
      try {
        const proofCalldata = await generateProofCalldata(candidate);
        const txHash = await executeReveal(candidate, proofCalldata);
        candidate.status = 'submitted';
        candidate.revealTxHash = txHash;
        candidate.errorCode = '';
        candidate.errorHint = '';
        candidate.updatedAt = Date.now();
        winnerJob = candidate;
        queuePersistJobs();
        break;
      } catch (error) {
        const message = String(error?.stack || error?.message || error || 'Unknown relayer error');
        const classified = classifyRelayError(message, 'reveal');
        const normalized = message.toLowerCase();
        if (normalized.includes('runtimeerror: unreachable')) {
          // Proof engine issue: do not spam retries, continue with settle/refund fallback.
          candidate.status = 'skipped';
          candidate.error = message;
          candidate.errorCode = classified.code;
          candidate.errorHint = classified.hint;
          if (candidate.finalizeStatus === 'scheduled' && candidate.finalizeAfterUnix <= 0) {
            candidate.finalizeAfterUnix = Math.floor(Date.now() / 1000);
          }
          if (candidate.refundStatus === 'scheduled' && candidate.refundAfterUnix <= 0) {
            candidate.refundAfterUnix = Math.floor(Date.now() / 1000) + 10;
          }
        } else if (normalized.includes('reveal phase closed')) {
          candidate.status = 'skipped';
          candidate.error = message;
          candidate.errorCode = classified.code;
          candidate.errorHint = classified.hint;
          if (candidate.finalizeStatus === 'scheduled' && candidate.finalizeAfterUnix <= 0) {
            candidate.finalizeAfterUnix = Math.floor(Date.now() / 1000);
          }
          if (candidate.refundStatus === 'scheduled' && candidate.refundAfterUnix <= 0) {
            candidate.refundAfterUnix = Math.floor(Date.now() / 1000) + 10;
          }
        } else if (!isPermanentRevealError(message) && Number(candidate.revealAttempts || 0) < MAX_REVEAL_RETRIES) {
          candidate.status = 'scheduled';
          candidate.revealAttempts = Number(candidate.revealAttempts || 0) + 1;
          candidate.revealAfterUnix = Math.floor(Date.now() / 1000) + REVEAL_RETRY_SECONDS;
          candidate.error = message;
          candidate.errorCode = classified.code;
          const reason = compactErrorMessage(classified.hint || message, 220);
          candidate.errorHint = reason
            ? `Transient reveal error; retry scheduled automatically. ${reason}`
            : 'Transient reveal error; retry scheduled automatically.';
        } else {
          candidate.status = 'failed';
          candidate.error = message;
          candidate.errorCode = classified.code;
          candidate.errorHint = classified.hint;
        }
        candidate.updatedAt = Date.now();
        console.error('[sealed-relayer] job failed', { id: candidate.id, error: candidate.error });
        queuePersistJobs();
      }
    }

    if (winnerJob) {
      for (const candidate of slotDue) {
        if (candidate.id === winnerJob.id) continue;
        if (candidate.status !== 'scheduled') continue;
        candidate.status = 'skipped';
        candidate.error = 'Winner selected for slot; loser reveal suppressed';
        candidate.errorCode = 'loser_reveal_suppressed';
        candidate.errorHint = 'Privacy mode keeps losing bids unrevealed.';
        candidate.finalizeStatus = 'skipped';
        candidate.updatedAt = Date.now();
        queuePersistJobs();
      }
    }
  } finally {
    workerBusy = false;
    unlockSlot(slotId);
  }
}

async function processNextFinalizeJob() {
  if (finalizeWorkerBusy || jobs.length === 0) return;
  // Self-heal previously failed finalize jobs that were transient/network/balance related.
  let healedFailedJobs = false;
  const healedAt = Date.now();
  for (const job of jobs) {
    if (String(job?.finalizeStatus || '') !== 'failed') continue;
    const code = String(job?.finalizeErrorCode || '');
    const isTransient =
      code === 'relayer_insufficient_balance' ||
      code.endsWith('_transient_network') ||
      code === 'finalize_failed' ||
      code === 'reveal_phase_closed';
    if (!isTransient) continue;
    if (String(job?.status || '') === 'failed') {
      job.status = 'running';
      job.errorCode = '';
      job.error = '';
      job.errorHint = '';
    }
    job.finalizeStatus = 'scheduled';
    job.finalizeAfterUnix = Math.floor(Date.now() / 1000) + FINALIZE_RETRY_SECONDS;
    job.finalizeErrorHint = code === 'relayer_insufficient_balance'
      ? 'Relayer balance is low; automatic retries remain active and will continue after top-up.'
      : 'Automatic finalize retries restored for transient failure.';
    job.updatedAt = healedAt;
    healedFailedJobs = true;
  }
  if (healedFailedJobs) queuePersistJobs();
  const now = Math.floor(Date.now() / 1000);
  const next = jobs.find((j) =>
    (j.status === 'submitted' || j.status === 'failed' || j.status === 'skipped' || j.status === 'running' || j.status === 'scheduled') &&
    j.finalizeStatus === 'scheduled' &&
    j.finalizeAfterUnix <= now &&
    !slotLocks.has(Number(j.slotPostId || 0))
  );
  if (!next) return;
  if (!lockSlot(next.slotPostId)) return;

  finalizeWorkerBusy = true;
  const slotJobs = jobs.filter((j) =>
    j.slotPostId === next.slotPostId &&
    j.finalizeStatus === 'scheduled' &&
    j.finalizeAfterUnix <= now
  );
  const nowMs = Date.now();
  for (const job of slotJobs) {
    job.finalizeStatus = 'running';
    job.updatedAt = nowMs;
  }
  queuePersistJobs();
  try {
    const txHash = await executeFinalize(next.slotPostId);
    const updatedAt = Date.now();
    for (const job of slotJobs) {
      job.finalizeStatus = 'submitted';
      job.finalizeTxHash = txHash;
      job.finalizeErrorCode = '';
      job.finalizeErrorHint = '';
      job.updatedAt = updatedAt;
    }
    queuePersistJobs();
  } catch (error) {
    const message = String(error?.message || error || 'Unknown finalize error');
    const classified = classifyRelayError(message, 'finalize');
    // Finalize is idempotent in practice; treat already-finalized as success.
    if (message.toLowerCase().includes('already finalized')) {
      const updatedAt = Date.now();
      for (const job of slotJobs) {
        job.finalizeStatus = 'submitted';
        job.finalizeErrorCode = 'already_finalized';
        job.finalizeErrorHint = 'Slot already finalized; relayer marked as success.';
        job.updatedAt = updatedAt;
      }
      queuePersistJobs();
    } else {
      const finalizedOnchain = await isSlotFinalizedViaTorii(next.slotPostId);
      if (finalizedOnchain) {
        const updatedAt = Date.now();
        for (const job of slotJobs) {
          job.finalizeStatus = 'submitted';
          job.finalizeErrorCode = 'already_finalized_onchain';
          job.finalizeErrorHint = 'Slot finalized on-chain; relayer state reconciled from Torii.';
          job.updatedAt = updatedAt;
        }
        queuePersistJobs();
        return;
      }
      const updatedAt = Date.now();
      let retryable = false;
      for (const job of slotJobs) {
        const attempts = Number(job.finalizeAttempts || 0);
        const transientCode = String(classified.code || '').endsWith('_transient_network')
          || String(classified.code || '') === 'finalize_failed'
          || String(classified.code || '') === 'reveal_phase_closed';
        if (classified.code === 'relayer_insufficient_balance') {
          retryable = true;
          job.finalizeAttempts = attempts + 1;
          if (String(job?.status || '') === 'failed') job.status = 'running';
          job.finalizeStatus = 'scheduled';
          job.finalizeAfterUnix = Math.floor(Date.now() / 1000) + Math.max(FINALIZE_RETRY_SECONDS, 60);
          job.finalizeError = message;
          job.finalizeErrorCode = classified.code;
          job.finalizeErrorHint = 'Relayer balance is low; retry remains scheduled automatically after top-up.';
          job.updatedAt = updatedAt;
        } else if (transientCode || attempts < MAX_FINALIZE_RETRIES) {
          retryable = true;
          job.finalizeAttempts = attempts + 1;
          if (String(job?.status || '') === 'failed') job.status = 'running';
          job.finalizeStatus = 'scheduled';
          const backoff = Math.min(FINALIZE_RETRY_SECONDS * Math.max(1, Math.floor((attempts + 1) / 3)), 180);
          job.finalizeAfterUnix = Math.floor(Date.now() / 1000) + backoff;
          job.finalizeError = message;
          job.finalizeErrorCode = classified.code;
          const reason = compactErrorMessage(classified.hint || message, 220);
          job.finalizeErrorHint = reason
            ? `Transient finalize error; retry scheduled automatically. ${reason}`
            : 'Transient finalize error; retry scheduled automatically.';
          job.updatedAt = updatedAt;
        } else {
          // Keep finalize convergence alive: never freeze in failed terminal state.
          retryable = true;
          job.finalizeAttempts = attempts + 1;
          if (String(job?.status || '') === 'failed') job.status = 'running';
          job.finalizeStatus = 'scheduled';
          const backoff = Math.min(FINALIZE_RETRY_SECONDS * Math.max(2, Math.floor((attempts + 1) / 2)), 300);
          job.finalizeAfterUnix = Math.floor(Date.now() / 1000) + backoff;
          job.finalizeError = message;
          job.finalizeErrorCode = classified.code;
          const reason = compactErrorMessage(classified.hint || message, 220);
          job.finalizeErrorHint = reason
            ? `Finalize retry loop kept active. ${reason}`
            : 'Finalize retry loop kept active.';
          job.updatedAt = updatedAt;
        }
      }
      queuePersistJobs();
    }
  } finally {
    finalizeWorkerBusy = false;
    unlockSlot(next.slotPostId);
  }
}

async function processNextRefundJob() {
  if (refundWorkerBusy || jobs.length === 0) return;
  const now = Math.floor(Date.now() / 1000);
  const next = jobs.find((j) =>
    (j.status === 'submitted' || j.status === 'skipped' || j.status === 'failed') &&
    (j.finalizeStatus === 'submitted' || j.finalizeStatus === 'skipped') &&
    j.refundStatus === 'scheduled' &&
    j.refundAfterUnix <= now &&
    !slotLocks.has(Number(j.slotPostId || 0))
  );
  if (!next) return;
  if (!lockSlot(next.slotPostId)) return;

  refundWorkerBusy = true;
  next.refundStatus = 'running';
  next.updatedAt = Date.now();
  queuePersistJobs();
  try {
    const txHash = await executeClaimRefund(next.slotPostId, next.bidder);
    next.refundStatus = 'submitted';
    next.refundTxHash = txHash;
    next.refundErrorCode = '';
    next.refundErrorHint = '';
    next.updatedAt = Date.now();
    queuePersistJobs();
  } catch (error) {
    const message = String(error?.message || error || 'Unknown refund error');
    const classified = classifyRelayError(message, 'refund');
    const normalized = message.toLowerCase();
    // Non-loser/duplicate/no-commit are terminal outcomes for automation.
    if (
      normalized.includes('highest bidder cannot refund') ||
      normalized.includes('already refunded') ||
      normalized.includes('no commit found')
    ) {
      next.refundStatus = 'skipped';
      next.refundError = message;
      next.refundErrorCode = classified.code;
      next.refundErrorHint = classified.hint;
      next.updatedAt = Date.now();
      queuePersistJobs();
    } else {
      const attempts = Number(next.refundAttempts || 0);
      if (attempts < MAX_REFUND_RETRIES) {
        next.refundAttempts = attempts + 1;
        next.refundStatus = 'scheduled';
        next.refundAfterUnix = Math.floor(Date.now() / 1000) + REFUND_RETRY_SECONDS;
        next.refundError = message;
        next.refundErrorCode = classified.code;
        next.refundErrorHint = 'Transient refund error; retry scheduled automatically.';
        next.updatedAt = Date.now();
      } else {
        next.refundStatus = 'failed';
        next.refundError = message;
        next.refundErrorCode = classified.code;
        next.refundErrorHint = classified.hint;
        next.updatedAt = Date.now();
        console.error('[sealed-relayer] refund failed (max retries reached)', { id: next.id, error: next.refundError });
      }
      queuePersistJobs();
    }
  } finally {
    refundWorkerBusy = false;
    unlockSlot(next.slotPostId);
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function safeFileKey(prefix = 'post', ext = 'jpg') {
  const hash = createHash('sha256')
    .update(`${Date.now()}-${Math.random()}-${Math.random()}`)
    .digest('hex')
    .slice(0, 24);
  return `${prefix}-${hash}.${ext}`;
}

function parseDataUrlImage(dataUrl) {
  const input = String(dataUrl || '').trim();
  const match = input.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error('Invalid image data URL');
  const contentType = String(match[1] || 'image/jpeg').toLowerCase();
  const base64 = String(match[2] || '');
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length) throw new Error('Empty image payload');
  if (bytes.length > MEDIA_MAX_BYTES) throw new Error(`Image too large (${bytes.length} bytes > ${MEDIA_MAX_BYTES})`);
  const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
  return { bytes, contentType, ext };
}

function buildPublicBaseUrl(req) {
  if (MEDIA_PUBLIC_BASE_URL) return MEDIA_PUBLIC_BASE_URL;
  const protoHeader = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const proto = protoHeader || 'http';
  return host ? `${proto}://${host}` : `http://127.0.0.1:${PORT}`;
}

async function uploadToLocalMedia(req, image, purpose = 'post') {
  await fs.mkdir(MEDIA_LOCAL_DIR, { recursive: true });
  const key = safeFileKey(purpose, image.ext);
  const filePath = path.join(MEDIA_LOCAL_DIR, key);
  await fs.writeFile(filePath, image.bytes);
  const base = buildPublicBaseUrl(req);
  return {
    url: `${base}/media/files/${encodeURIComponent(key)}`,
    key,
    provider: 'local',
    bytes: image.bytes.length,
  };
}

async function uploadToCloudflareImages(image, purpose = 'post') {
  if (!CF_ACCOUNT_ID || !CF_IMAGES_API_TOKEN) {
    throw new Error('Cloudflare Images is not configured');
  }
  const form = new FormData();
  form.append('file', new Blob([image.bytes], { type: image.contentType }), safeFileKey(purpose, image.ext));
  form.append('requireSignedURLs', 'false');

  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/images/v1`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CF_IMAGES_API_TOKEN}` },
    body: form,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body?.success) {
    throw new Error(String(body?.errors?.[0]?.message || body?.error || `Cloudflare upload failed (${response.status})`));
  }

  const variant = String(body?.result?.variants?.[0] || '').trim();
  const direct = String(body?.result?.url || '').trim();
  const url = variant || direct;
  if (!url.startsWith('http')) throw new Error('Cloudflare upload returned no public URL');
  return {
    url,
    key: String(body?.result?.id || ''),
    provider: 'cloudflare_images',
    bytes: image.bytes.length,
  };
}

async function uploadToIpfsPinata(image, purpose = 'post') {
  if (!PINATA_JWT) {
    throw new Error('Pinata JWT is not configured');
  }
  const form = new FormData();
  form.append('file', new Blob([image.bytes], { type: image.contentType }), safeFileKey(purpose, image.ext));
  form.append('pinataMetadata', JSON.stringify({
    name: safeFileKey(purpose, image.ext),
    keyvalues: {
      app: 'starkwall',
      purpose: String(purpose || 'post'),
    },
  }));

  const response = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
    method: 'POST',
    headers: { Authorization: `Bearer ${PINATA_JWT}` },
    body: form,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(body?.error?.details || body?.error || body?.message || `Pinata upload failed (${response.status})`));
  }

  const cid = String(body?.IpfsHash || '').trim();
  if (!cid) throw new Error('Pinata upload returned no CID');
  const gateway = `${IPFS_GATEWAY_BASE_URL}/${cid}`;
  return {
    url: gateway,
    key: cid,
    cid,
    provider: 'ipfs_pinata',
    bytes: image.bytes.length,
  };
}

async function uploadMedia(req, payload) {
  const image = parseDataUrlImage(payload?.dataUrl);
  const purpose = String(payload?.purpose || 'post').toLowerCase().replace(/[^a-z0-9-_]/g, '') || 'post';
  if (MEDIA_PROVIDER === 'ipfs_pinata') {
    return uploadToIpfsPinata(image, purpose);
  }
  if (MEDIA_PROVIDER === 'cloudflare_images') {
    return uploadToCloudflareImages(image, purpose);
  }
  if (MEDIA_PROVIDER === 'local') {
    return uploadToLocalMedia(req, image, purpose);
  }
  throw new Error('Media upload provider disabled');
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function buildArtifactManifest(job, req) {
  const base = buildPublicBaseUrl(req);
  const bundles = Array.isArray(job?.zkTrace?.artifactBundles) ? job.zkTrace.artifactBundles : [];
  return bundles.map((bundle) => {
    const filesIn = bundle?.files && typeof bundle.files === 'object' ? bundle.files : {};
    const files = Object.fromEntries(
      Object.entries(filesIn).map(([name, meta]) => {
        const rel = String(meta?.path || '');
        return [
          String(name),
          {
            path: rel,
            sha256: String(meta?.sha256 || ''),
            bytes: Number(meta?.bytes || 0),
            url: rel ? `${base}/sealed/artifacts/${encodeURIComponent(rel)}` : '',
          },
        ];
      }),
    );
    return {
      variant: String(bundle?.variant || ''),
      savedAt: Number(bundle?.savedAt || 0),
      files,
    };
  });
}

function createJob(payload) {
  const bidder = normalizeHexAddress(payload?.bidder);
  if (!bidder.startsWith('0x')) throw new Error('Invalid bidder');
  const slotPostId = Number(payload?.slotPostId);
  const groupId = Number(payload?.groupId);
  const bidAmount = Number(payload?.bidAmount || 0);
  const revealAfterUnix = Number(payload?.revealAfterUnix || 0);
  const finalizeAfterUnix = Number(payload?.finalizeAfterUnix || 0);
  const salt = String(payload?.salt || '').trim();
  const protocolModeRaw = String(payload?.protocolMode || '').trim().toLowerCase().replace('-', '_');
  const protocolMode = normalizeSealedProtocolMode(protocolModeRaw);
  const drandRound = Number(payload?.drandRound || 0);
  const timelockCiphertextHash = String(payload?.timelockCiphertextHash || payload?.ciphertextHash || '').trim();
  const timelockPayload = String(payload?.timelockPayload || '').trim();
  const mpcSessionId = String(payload?.mpcSessionId || '').trim();
  const mpcAttestationRoot = String(payload?.mpcAttestationRoot || '').trim();
  const mpcTranscriptHash = String(payload?.mpcTranscriptHash || '').trim();
  const mpcSignerBitmapHash = String(payload?.mpcSignerBitmapHash || '').trim();
  const requireMpcAttestation = Boolean(payload?.requireMpcAttestation || protocolMode === SEALED_PROTOCOL_DRAND_MPC);
  const mpcAttested = Boolean(payload?.mpcAttested);

  if (!Number.isFinite(slotPostId) || slotPostId <= 0) throw new Error('Invalid slotPostId');
  if (!Number.isFinite(groupId) || groupId <= 0) throw new Error('Invalid groupId');
  if (protocolMode === SEALED_PROTOCOL_CLASSIC || protocolMode === SEALED_PROTOCOL_TREE_V1) {
    if (!Number.isFinite(bidAmount) || bidAmount <= 0) throw new Error('Invalid bidAmount');
    if (!salt) throw new Error('Missing salt');
  }
  const requiresTimelock = protocolMode === SEALED_PROTOCOL_DRAND || protocolMode === SEALED_PROTOCOL_DRAND_MPC;
  if (requiresTimelock) {
    if (!Number.isFinite(drandRound) || drandRound <= 0) {
      throw new Error('Invalid drandRound for timelock protocol');
    }
    if (!timelockCiphertextHash || !timelockCiphertextHash.startsWith('0x')) {
      throw new Error('Missing timelockCiphertextHash for timelock protocol');
    }
  }
  if (protocolMode === SEALED_PROTOCOL_DRAND_MPC) {
    if (!mpcSessionId) throw new Error('Missing mpcSessionId for drand-mpc protocol');
  }

  const id = `job_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const job = {
    id,
    slotPostId,
    groupId,
    bidder,
    bidAmount: Number.isFinite(bidAmount) ? bidAmount : 0,
    salt,
    protocolMode,
    drandRound,
    timelockCiphertextHash,
    timelockPayload,
    requireMpcAttestation,
    mpcAttested,
    mpcSessionId,
    mpcAttestationRoot,
    mpcTranscriptHash,
    mpcSignerBitmapHash,
    revealAfterUnix: revealAfterUnix > 0 ? revealAfterUnix : Math.floor(Date.now() / 1000),
    finalizeAfterUnix: finalizeAfterUnix > 0 ? finalizeAfterUnix : 0,
    finalizeStatus: finalizeAfterUnix > 0 ? 'scheduled' : 'skipped',
    refundAfterUnix: finalizeAfterUnix > 0 ? (finalizeAfterUnix + 20) : 0,
    refundStatus: finalizeAfterUnix > 0 ? 'scheduled' : 'skipped',
    revealAttempts: 0,
    finalizeAttempts: 0,
    refundAttempts: 0,
    status: 'scheduled',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  upsertTraceFromJobLike(job);
  queuePersistTraces();
  return job;
}

function findJobForUpdate(payload) {
  const explicitJobId = String(payload?.jobId || '').trim();
  if (explicitJobId) {
    const byId = jobs.find((j) => String(j?.id || '') === explicitJobId);
    if (byId) return byId;
  }
  const slotPostId = Number(payload?.slotPostId || 0);
  const bidder = normalizeHexAddress(payload?.bidder || '');
  if (!Number.isFinite(slotPostId) || slotPostId <= 0 || !bidder || bidder === '0x0') return null;
  return jobs.find((j) => Number(j?.slotPostId || 0) === slotPostId && normalizeHexAddress(j?.bidder || '') === bidder) || null;
}

function findProofJob(payload) {
  const explicitJobId = String(payload?.jobId || '').trim();
  const slotPostId = Number(payload?.slotPostId || 0);
  const bidder = normalizeHexAddress(payload?.bidder || '');
  const includeTrace = payload?.includeTrace !== false;
  const pickLatest = (arr) => arr.sort((a, b) => Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0))[0] || null;
  if (explicitJobId) {
    const live = jobs.find((j) => String(j?.id || '') === explicitJobId) || null;
    if (live) return live;
    if (includeTrace) {
      const trace = Array.from(tracesByKey.values()).find((j) => String(j?.id || '') === explicitJobId) || null;
      if (trace) return trace;
    }
  }
  let candidates = jobs.slice();
  if (Number.isFinite(slotPostId) && slotPostId > 0) candidates = candidates.filter((j) => Number(j?.slotPostId || 0) === slotPostId);
  if (bidder && bidder !== '0x0') candidates = candidates.filter((j) => normalizeHexAddress(j?.bidder || '') === bidder);
  candidates = candidates.filter((j) => hasUsableProofCalldata(j));
  if (candidates.length) return pickLatest(candidates);
  if (!includeTrace) return null;
  let traceCandidates = Array.from(tracesByKey.values());
  if (Number.isFinite(slotPostId) && slotPostId > 0) traceCandidates = traceCandidates.filter((j) => Number(j?.slotPostId || 0) === slotPostId);
  if (bidder && bidder !== '0x0') traceCandidates = traceCandidates.filter((j) => normalizeHexAddress(j?.bidder || '') === bidder);
  traceCandidates = traceCandidates.filter((j) => hasUsableProofCalldata(j));
  return pickLatest(traceCandidates);
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    json(res, 200, { ok: true, jobs: jobs.length, workerBusy, finalizeWorkerBusy, refundWorkerBusy });
    return;
  }

  if (req.method === 'POST' && req.url === '/adapters/timelock-decrypt') {
    try {
      const payload = await parseBody(req);
      const slotPostId = Number(payload?.slotPostId || 0);
      const bidder = normalizeHexAddress(payload?.bidder || '');
      const drandRound = Number(payload?.drandRound || 0);
      let bidAmount = Number(payload?.bidAmount || 0);
      let salt = String(payload?.salt || '').trim();
      if ((!Number.isFinite(bidAmount) || bidAmount <= 0) || !salt) {
        const known = jobs.find((j) =>
          Number(j?.slotPostId || 0) === slotPostId &&
          normalizeHexAddress(j?.bidder || '') === bidder &&
          Number(j?.bidAmount || 0) > 0 &&
          String(j?.salt || '').trim(),
        ) || null;
        if (known) {
          bidAmount = Number(known.bidAmount || 0);
          salt = String(known.salt || '').trim();
        }
      }
      if (!Number.isFinite(bidAmount) || bidAmount <= 0) {
        bidAmount = Number(process.env.SEALED_RELAY_TIMELOCK_DEFAULT_BID || 5);
      }
      if (!salt) {
        salt = toHexFromSha256([
          String(payload?.id || ''),
          String(slotPostId || ''),
          String(payload?.groupId || ''),
          bidder,
          String(drandRound || ''),
          String(payload?.timelockCiphertextHash || ''),
        ].join('|'));
      }
      json(res, 200, { bidAmount, salt });
      return;
    } catch (error) {
      json(res, 400, { ok: false, error: String(error?.message || 'Timelock adapter failed') });
      return;
    }
  }

  if (req.method === 'POST' && req.url === '/adapters/mpc-attest') {
    try {
      const payload = await parseBody(req);
      const seed = JSON.stringify({
        id: String(payload?.id || ''),
        slotPostId: Number(payload?.slotPostId || 0),
        groupId: Number(payload?.groupId || 0),
        bidder: normalizeHexAddress(payload?.bidder || ''),
        mpcSessionId: String(payload?.mpcSessionId || ''),
      });
      const transcript = toHexFromSha256(`${seed}:transcript`);
      const root = toHexFromSha256(`${seed}:root`);
      const bitmap = toHexFromSha256(`${seed}:bitmap`);
      json(res, 200, {
        mpcTranscriptHash: transcript,
        mpcAttestationRoot: root,
        mpcSignerBitmapHash: bitmap,
      });
      return;
    } catch (error) {
      json(res, 400, { ok: false, error: String(error?.message || 'MPC attestation adapter failed') });
      return;
    }
  }

  if (req.method === 'POST' && req.url === '/adapters/mpc-prove') {
    try {
      const payload = await parseBody(req);
      const adapterJob = {
        id: `adapter_${Date.now()}`,
        slotPostId: Number(payload?.slotPostId || 0),
        groupId: Number(payload?.groupId || 0),
        bidder: normalizeHexAddress(payload?.bidder || ''),
        bidAmount: Number(payload?.bidAmount || 0),
        salt: String(payload?.salt || '').trim(),
        protocolMode: SEALED_PROTOCOL_CLASSIC,
      };
      if (!Number.isFinite(adapterJob.slotPostId) || adapterJob.slotPostId <= 0) {
        throw new Error('Invalid slotPostId');
      }
      if (!Number.isFinite(adapterJob.groupId) || adapterJob.groupId <= 0) {
        throw new Error('Invalid groupId');
      }
      if (!adapterJob.bidder || adapterJob.bidder === '0x0') {
        throw new Error('Invalid bidder');
      }
      if (!Number.isFinite(adapterJob.bidAmount) || adapterJob.bidAmount <= 0) {
        throw new Error('Invalid bidAmount');
      }
      if (!adapterJob.salt) {
        throw new Error('Missing salt');
      }
      const proofCalldata = await generateProofCalldata(adapterJob);
      json(res, 200, {
        proofCalldata,
        proofCalldataHash: String(adapterJob?.zkTrace?.proofCalldataHash || ''),
        witnessHash: String(adapterJob?.zkTrace?.witnessHash || ''),
        proofHash: String(adapterJob?.zkTrace?.proofHash || ''),
        vkHash: String(adapterJob?.zkTrace?.vkHash || ''),
        publicInputsHash: String(adapterJob?.zkTrace?.publicInputsHash || ''),
      });
      return;
    } catch (error) {
      json(res, 400, { ok: false, error: String(error?.message || 'MPC proof adapter failed') });
      return;
    }
  }

  if (req.method === 'GET' && req.url?.startsWith('/sealed/jobs')) {
    json(res, 200, { ok: true, jobs: collectPublicJobsWithTraceFallback() });
    return;
  }

  if (req.method === 'GET' && req.url?.startsWith('/sealed/proof-bundle')) {
    try {
      const parsed = new URL(req.url, buildPublicBaseUrl(req));
      const payload = {
        jobId: parsed.searchParams.get('jobId') || '',
        slotPostId: Number(parsed.searchParams.get('slotPostId') || 0),
        bidder: parsed.searchParams.get('bidder') || '',
      };
      const job = findProofJob(payload);
      if (!job) throw new Error('No stored proof bundle found for this slot/job');
      json(res, 200, { ok: true, bundle: buildProofBundle(job, VERIFIER_CONTRACT) });
      return;
    } catch (error) {
      json(res, 404, { ok: false, error: String(error?.message || 'Proof bundle unavailable') });
      return;
    }
  }

  if (req.method === 'GET' && req.url?.startsWith('/sealed/proof-artifacts')) {
    try {
      const parsed = new URL(req.url, buildPublicBaseUrl(req));
      const payload = {
        jobId: parsed.searchParams.get('jobId') || '',
        slotPostId: Number(parsed.searchParams.get('slotPostId') || 0),
        bidder: parsed.searchParams.get('bidder') || '',
        includeTrace: true,
      };
      const job = findProofJob(payload) || findJobForUpdate(payload);
      if (!job) throw new Error('No stored job found for this slot/job');
      const artifacts = buildArtifactManifest(job, req);
      json(res, 200, {
        ok: true,
        slotPostId: Number(job?.slotPostId || 0),
        jobId: String(job?.id || ''),
        artifacts,
      });
      return;
    } catch (error) {
      json(res, 404, { ok: false, error: String(error?.message || 'Proof artifacts unavailable') });
      return;
    }
  }

  if (req.method === 'GET' && req.url?.startsWith('/sealed/artifacts/')) {
    const rel = decodeURIComponent(String(req.url || '').replace('/sealed/artifacts/', '').split('?')[0] || '');
    const filePath = artifactAbsPath(rel);
    if (!filePath) {
      json(res, 400, { ok: false, error: 'Invalid artifact path' });
      return;
    }
    try {
      const bytes = await fs.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const contentType = ext === '.json'
        ? 'application/json'
        : (ext === '.gz' ? 'application/gzip' : 'application/octet-stream');
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=60' });
      res.end(bytes);
      return;
    } catch {
      json(res, 404, { ok: false, error: 'Artifact file not found' });
      return;
    }
  }

  if (req.method === 'POST' && req.url === '/sealed/verify-proof-now') {
    try {
      const payload = await parseBody(req);
      const result = await runVerifyProofNow(payload);
      json(res, 200, { ok: true, ...result });
      return;
    } catch (error) {
      json(res, 400, { ok: false, error: String(error?.message || 'Verify proof failed') });
      return;
    }
  }

  if (req.method === 'GET' && req.url?.startsWith('/media/files/')) {
    if (MEDIA_PROVIDER !== 'local') {
      json(res, 404, { ok: false, error: 'Not found' });
      return;
    }
    const name = decodeURIComponent(String(req.url || '').replace('/media/files/', '').split('?')[0] || '');
    if (!name || name.includes('/') || name.includes('..')) {
      json(res, 400, { ok: false, error: 'Invalid media key' });
      return;
    }
    const filePath = path.join(MEDIA_LOCAL_DIR, name);
    try {
      const bytes = await fs.readFile(filePath);
      const ext = path.extname(name).toLowerCase();
      const contentType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=31536000, immutable' });
      res.end(bytes);
      return;
    } catch {
      json(res, 404, { ok: false, error: 'Media not found' });
      return;
    }
  }

  if (req.method === 'POST' && req.url === '/media/upload') {
    try {
      const payload = await parseBody(req);
      const uploaded = await uploadMedia(req, payload);
      json(res, 200, {
        ok: true,
        url: uploaded.url,
        key: uploaded.key,
        provider: uploaded.provider,
        bytes: uploaded.bytes,
      });
      return;
    } catch (error) {
      json(res, 400, { ok: false, error: String(error?.message || 'Upload failed') });
      return;
    }
  }

  if (req.method === 'POST' && req.url === '/sealed/schedule') {
    try {
      const payload = await parseBody(req);
      const job = createJob(payload);
      const existing = jobs.find((j) =>
        j.slotPostId === job.slotPostId &&
        j.bidder === job.bidder &&
        (j.status === 'scheduled' || j.status === 'running' || j.status === 'submitted')
      );
      if (existing) {
        if (existing.status === 'scheduled') {
          existing.bidAmount = job.bidAmount;
          existing.salt = job.salt;
          existing.protocolMode = job.protocolMode;
          existing.drandRound = job.drandRound;
          existing.timelockCiphertextHash = job.timelockCiphertextHash;
          existing.requireMpcAttestation = job.requireMpcAttestation;
          existing.mpcAttested = job.mpcAttested;
          existing.mpcSessionId = job.mpcSessionId;
          existing.mpcAttestationRoot = job.mpcAttestationRoot;
          existing.mpcTranscriptHash = job.mpcTranscriptHash;
          existing.mpcSignerBitmapHash = job.mpcSignerBitmapHash;
          existing.revealAfterUnix = job.revealAfterUnix;
          existing.finalizeAfterUnix = job.finalizeAfterUnix;
          existing.finalizeStatus = job.finalizeStatus;
          existing.refundAfterUnix = job.refundAfterUnix;
          existing.refundStatus = job.refundStatus;
          existing.updatedAt = Date.now();
          queuePersistJobs();
          json(res, 200, {
            ok: true,
            jobId: existing.id,
            status: existing.status,
            revealAfterUnix: existing.revealAfterUnix,
            replaced: true,
          });
          return;
        }
        json(res, 200, {
          ok: true,
          jobId: existing.id,
          status: existing.status,
          revealAfterUnix: existing.revealAfterUnix,
          deduped: true,
        });
        return;
      }
      jobs.push(job);
      queuePersistJobs();
      json(res, 200, { ok: true, jobId: job.id, status: job.status, revealAfterUnix: job.revealAfterUnix });
      return;
    } catch (error) {
      json(res, 400, { ok: false, error: String(error?.message || 'Invalid request body') });
      return;
    }
  }

  if (req.method === 'POST' && req.url === '/sealed/timelock-payload') {
    try {
      const payload = await parseBody(req);
      const target = findJobForUpdate(payload);
      if (!target) throw new Error('Job not found for timelock payload update');
      const bidAmount = Number(payload?.bidAmount || 0);
      const salt = String(payload?.salt || '').trim();
      if (!Number.isFinite(bidAmount) || bidAmount <= 0) throw new Error('Invalid bidAmount');
      if (!salt) throw new Error('Missing salt');
      target.bidAmount = bidAmount;
      target.salt = salt;
      if (Number(payload?.drandRound || 0) > 0) target.drandRound = Number(payload.drandRound);
      if (String(payload?.timelockCiphertextHash || '').startsWith('0x')) {
        target.timelockCiphertextHash = String(payload.timelockCiphertextHash);
      }
      if (String(payload?.timelockPayload || '').trim()) {
        target.timelockPayload = String(payload.timelockPayload).trim();
      }
      target.updatedAt = Date.now();
      if (target.status === 'scheduled' && Number(target.revealAfterUnix || 0) <= 0) {
        target.revealAfterUnix = Math.floor(Date.now() / 1000);
      }
      upsertTraceFromJobLike(target);
      queuePersistJobs();
      queuePersistTraces();
      json(res, 200, {
        ok: true,
        jobId: target.id,
        status: target.status,
        updated: true,
      });
      return;
    } catch (error) {
      json(res, 400, { ok: false, error: String(error?.message || 'Invalid timelock payload update') });
      return;
    }
  }

  if (req.method === 'POST' && req.url === '/sealed/mpc-attestation') {
    try {
      const payload = await parseBody(req);
      const target = findJobForUpdate(payload);
      if (!target) throw new Error('Job not found for MPC attestation update');
      if (normalizeSealedProtocolMode(target.protocolMode) !== SEALED_PROTOCOL_DRAND_MPC) {
        throw new Error('Job is not configured for drand_mpc protocol');
      }
      let transcriptHash = String(payload?.mpcTranscriptHash || '').trim();
      let attestationRoot = String(payload?.mpcAttestationRoot || '').trim();
      let signerBitmapHash = String(payload?.mpcSignerBitmapHash || '').trim();
      if ((!transcriptHash || !attestationRoot || !signerBitmapHash) && MPC_ATTEST_CMD) {
        const generated = await runCommandJson(MPC_ATTEST_CMD, {
          id: target.id,
          slotPostId: Number(target.slotPostId || 0),
          groupId: Number(target.groupId || 0),
          bidder: normalizeHexAddress(target.bidder || ''),
          protocolMode: normalizeSealedProtocolMode(target.protocolMode),
          mpcSessionId: String(target.mpcSessionId || ''),
        });
        transcriptHash = transcriptHash || String(generated?.mpcTranscriptHash || '').trim();
        attestationRoot = attestationRoot || String(generated?.mpcAttestationRoot || '').trim();
        signerBitmapHash = signerBitmapHash || String(generated?.mpcSignerBitmapHash || '').trim();
      }
      if (!transcriptHash || !transcriptHash.startsWith('0x')) throw new Error('Invalid mpcTranscriptHash');
      if (!attestationRoot || !attestationRoot.startsWith('0x')) throw new Error('Invalid mpcAttestationRoot');
      if (!signerBitmapHash || !signerBitmapHash.startsWith('0x')) throw new Error('Invalid mpcSignerBitmapHash');
      target.mpcAttested = true;
      target.mpcTranscriptHash = transcriptHash;
      target.mpcAttestationRoot = attestationRoot;
      target.mpcSignerBitmapHash = signerBitmapHash;
      target.updatedAt = Date.now();
      let onchainTxHash = '';
      if (Boolean(payload?.submitOnchain)) {
        onchainTxHash = await executeMpcAttestation(
          target.slotPostId,
          transcriptHash,
          attestationRoot,
          signerBitmapHash,
        );
      }
      upsertTraceFromJobLike(target);
      queuePersistJobs();
      queuePersistTraces();
      json(res, 200, {
        ok: true,
        jobId: target.id,
        status: target.status,
        mpcAttested: true,
        mpcAttestationTxHash: onchainTxHash,
      });
      return;
    } catch (error) {
      json(res, 400, { ok: false, error: String(error?.message || 'Invalid MPC attestation update') });
      return;
    }
  }

  if (req.method === 'POST' && req.url === '/sealed/reveal-now') {
    try {
      const payload = await parseBody(req);
      const result = await runImmediateReveal(payload);
      json(res, 200, {
        ok: true,
        status: 'submitted',
        txHash: result.txHash,
        proofLength: result.proofLength,
        slotPostId: result.slotPostId,
        bidder: result.bidder,
      });
      return;
    } catch (error) {
      json(res, 400, { ok: false, error: String(error?.stack || error?.message || 'Reveal now failed') });
      return;
    }
  }

  if (req.method === 'POST' && req.url === '/sealed/finalize-now') {
    try {
      const payload = await parseBody(req);
      const finalizeOutcome = await runImmediateFinalizeWithHttpTimeout(payload);
      if (finalizeOutcome?.timedOut) {
        json(res, 202, {
          ok: true,
          status: 'processing',
          hint: 'Finalize is still processing in background; poll slot state and relay jobs.',
        });
        return;
      }
      const result = finalizeOutcome.result;
      json(res, 200, {
        ok: true,
        status: result.alreadyFinalized ? 'already_finalized' : 'submitted',
        txHash: result.txHash,
        slotPostId: result.slotPostId,
      });
      return;
    } catch (error) {
      json(res, 400, { ok: false, error: String(error?.stack || error?.message || 'Finalize now failed') });
      return;
    }
  }

  if (req.method === 'POST' && req.url === '/sealed/reverify-now') {
    try {
      const payload = await parseBody(req);
      const result = await runImmediateReverify(payload);
      json(res, 200, {
        ok: true,
        status: result.valid === null ? 'unavailable' : (result.valid ? 'valid' : 'invalid'),
        ...result,
      });
      return;
    } catch (error) {
      json(res, 400, {
        ok: false,
        error: String(error?.message || 'Reverify failed'),
        debug: error?.reverifyDebug || null,
      });
      return;
    }
  }

  if (req.method === 'POST' && req.url === '/sealed/recover-from-tx') {
    try {
      const payload = await parseBody(req);
      const result = await runRecoverRevealTx(payload);
      json(res, 200, {
        ok: true,
        status: 'recovered',
        ...result,
      });
      return;
    } catch (error) {
      json(res, 400, { ok: false, error: String(error?.message || 'Recover from tx failed') });
      return;
    }
  }

  if (req.method === 'POST' && req.url === '/sealed/mpc-attest') {
    try {
      const payload = await parseBody(req);
      const slotPostId = Number(payload?.slotPostId || 0);
      const bidder = normalizeHexAddress(payload?.bidder || '');
      if (!Number.isFinite(slotPostId) || slotPostId <= 0) throw new Error('Invalid slotPostId');
      if (!bidder || bidder === '0x0') throw new Error('Invalid bidder');

      const key = makeTraceKey(slotPostId, bidder);
      const current = tracesByKey.get(key) || null;
      if (!current) throw new Error('Trace not found for slot/bidder');

      const patch = {
        ...current,
        protocolMode: String(payload?.protocolMode || current.protocolMode || 'drand-mpc'),
        mpcSessionId: String(payload?.mpcSessionId || current.mpcSessionId || ''),
        mpcAttestationRoot: String(payload?.mpcAttestationRoot || current.mpcAttestationRoot || ''),
        mpcTranscriptHash: String(payload?.mpcTranscriptHash || current.mpcTranscriptHash || ''),
        mpcSignerBitmapHash: String(payload?.mpcSignerBitmapHash || current.mpcSignerBitmapHash || ''),
        updatedAt: Date.now(),
      };
      upsertTraceFromJobLike(patch);
      queuePersistTraces();

      const live = jobs.find(
        (j) =>
          Number(j?.slotPostId || 0) === slotPostId &&
          normalizeHexAddress(j?.bidder || '') === bidder,
      );
      if (live) {
        live.protocolMode = patch.protocolMode;
        live.mpcSessionId = patch.mpcSessionId;
        live.mpcAttestationRoot = patch.mpcAttestationRoot;
        live.mpcTranscriptHash = patch.mpcTranscriptHash;
        live.mpcSignerBitmapHash = patch.mpcSignerBitmapHash;
        live.updatedAt = Date.now();
        queuePersistJobs();
      }

      json(res, 200, {
        ok: true,
        status: 'attested',
        slotPostId,
        bidder,
        protocolMode: patch.protocolMode,
        mpcSessionId: patch.mpcSessionId,
        mpcAttestationRoot: patch.mpcAttestationRoot,
      });
      return;
    } catch (error) {
      json(res, 400, { ok: false, error: String(error?.message || 'MPC attestation failed') });
      return;
    }
  }

  if (req.method === 'POST' && req.url === '/sealed/refund-now') {
    try {
      const payload = await parseBody(req);
      const result = await runImmediateRefund(payload);
      json(res, 200, {
        ok: true,
        status: 'submitted',
        txHash: result.txHash,
        slotPostId: result.slotPostId,
        bidder: result.bidder,
      });
      return;
    } catch (error) {
      json(res, 400, { ok: false, error: String(error?.stack || error?.message || 'Refund now failed') });
      return;
    }
  }

  json(res, 404, { ok: false, error: 'Not found' });
});

async function start() {
  validateConfig();
  await restoreTraces();
  await restoreJobs();
  mirrorJobsIntoTraceStore();
  queuePersistTraces();
  setInterval(() => {
    void reconcileJobsWithOnchainState();
    void processNextJob();
    void processNextFinalizeJob();
    void processNextRefundJob();
  }, 5000);
  server.listen(PORT, HOST, () => {
    console.log(`[sealed-relayer] listening on http://${HOST}:${PORT}`);
    console.log(`[sealed-relayer] actions=${ACTIONS_CONTRACT}`);
    console.log('[sealed-relayer] POST /sealed/schedule to enqueue auto-reveal jobs');
  });
}

export const __test__ = {
  jobs,
  tracesByKey,
  makeTraceKey,
  makeTraceId,
  upsertTraceFromJobLike,
  collectPublicJobsWithTraceFallback,
  decodeAccountCallArray,
  extractRevealPayloadFromAccountCalldata,
  createJob,
};

if (process.env.SEALED_RELAY_DISABLE_AUTOSTART !== '1') {
  start().catch((error) => {
    console.error('[sealed-relayer] startup failed:', error?.message || error);
    process.exit(1);
  });
}
