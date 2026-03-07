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
const BB_BIN = process.env.SEALED_RELAY_BB_BIN || 'bb';
const NARGO_BIN = process.env.SEALED_RELAY_NARGO_BIN || 'nargo';
const TX_VERSION = String(process.env.SEALED_RELAY_TX_VERSION || '').trim();
const VERIFIER_CONTRACT = String(process.env.SEALED_RELAY_VERIFIER_ADDRESS || '').trim();
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
let workerBusy = false;
let finalizeWorkerBusy = false;
let refundWorkerBusy = false;
let persistQueued = false;
let tracesPersistQueued = false;
let relayerTxQueue = Promise.resolve();
let proofGenQueue = Promise.resolve();
const slotLocks = new Set();

async function ensureJobsStorageDir() {
  const dirPath = path.dirname(JOBS_DB_PATH);
  await fs.mkdir(dirPath, { recursive: true });
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
  publicJob.hasProofCalldata = Array.isArray(job.proofCalldata) && job.proofCalldata.length > 0;
  // Never expose secret salt or full proof calldata via public API.
  delete publicJob.salt;
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
  const tmpPath = `${JOBS_DB_PATH}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(serializable, null, 2), 'utf8');
  await fs.rename(tmpPath, JOBS_DB_PATH);
}

async function persistTraces() {
  await ensureJobsStorageDir();
  const serializable = Array.from(tracesByKey.values()).map((t) => ({ ...t }));
  const tmpPath = `${TRACES_DB_PATH}.tmp`;
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
  const { stdout, stderr } = await execFileAsync(command, args, { cwd });
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

async function generateProofCalldata(job) {
  return enqueueProofGeneration(async () => {
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
    const honkDir = path.join(TARGET_DIR, 'honk-keccak');
    // bb native writes nested proof outputs; clear stale file-vs-dir conflicts from previous toolchains.
    await fs.rm(honkDir, { recursive: true, force: true });
    await fs.mkdir(honkDir, { recursive: true });
    await runCommand(
      BB_BIN,
      [
        'write_vk',
        '-b',
        'target/noir_sealed_bid.json',
        '-o',
        'target/honk-keccak',
        '--oracle_hash',
        'keccak',
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
        'target/honk-keccak/proof',
        '-k',
        'target/honk-keccak/vk',
        '--oracle_hash',
        'keccak',
      ],
      NOIR_DIR,
    );

    const witnessPath = path.join(NOIR_DIR, 'target', 'witness.gz');
    const vkPath = path.join(TARGET_DIR, 'honk-keccak', 'vk');
    const proofPath = await resolveExistingPath([
      path.join(TARGET_DIR, 'honk-keccak', 'proof', 'proof'),
      path.join(TARGET_DIR, 'honk-keccak', 'proof'),
    ]);
    const publicInputsPath = await resolveExistingPath([
      path.join(TARGET_DIR, 'honk-keccak', 'proof', 'public_inputs'),
      path.join(TARGET_DIR, 'honk-keccak', 'public_inputs'),
    ]);

    const [witnessHash, proofHash, vkHash, publicInputsHash] = await Promise.all([
      hashFile(witnessPath),
      hashFile(proofPath),
      hashFile(vkPath),
      hashFile(publicInputsPath),
    ]);
    if (job && typeof job === 'object') {
      job.zkTrace = {
        witnessHash,
        proofHash,
        vkHash,
        publicInputsHash,
        generatedAt: Date.now(),
      };
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

    const raw = await runCommand(
      GARAGA_BIN,
      [
        'calldata',
        '--system',
        'ultra_keccak_zk_honk',
        '--vk',
        path.join(TARGET_DIR, 'honk-keccak', 'vk'),
        '--proof',
        path.join(TARGET_DIR, 'honk-keccak', 'proof'),
        '--public-inputs',
        path.join(TARGET_DIR, 'honk-keccak', 'public_inputs'),
        '--format',
        'array',
      ],
      NOIR_DIR,
    );

    const tokens = String(raw || '')
      .trim()
      .match(/0x[0-9a-fA-F]+|[0-9]+/g) || [];
    if (tokens.length === 0) {
      throw new Error('Garaga calldata generation returned empty array');
    }
    const normalized = tokens.map((token) => {
      const normalized = token.startsWith('0x') ? BigInt(token) : BigInt(token);
      return normalized.toString(10);
    });
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

function isPermanentRevealError(message = '') {
  const normalized = String(message || '').toLowerCase();
  return (
    normalized.includes('runtimeerror: unreachable') ||
    normalized.includes('input too long for arguments') ||
    normalized.includes('invalid reveal proof') ||
    normalized.includes('commitment mismatch') ||
    normalized.includes('no commit found') ||
    normalized.includes('bid already revealed') ||
    normalized.includes('auction slot already finalized')
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
    return { code: `${stage}_transient_network`, hint: 'Transient RPC/network issue; retrying automatically.' };
  }
  return { code: `${stage}_failed`, hint: 'Unexpected relayer error; check logs and retry path.' };
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
  return 0;
}

async function runRecoverRevealTx(payload) {
  const txHash = String(payload?.revealTxHash || payload?.txHash || '').trim();
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
      recoveredAt: Date.now(),
      proofCalldataHash,
      proofFelts: parsed.proofCalldata.length,
      calldataPreview: previewArray(parsed.proofCalldata, 8),
    },
    updatedAt: Date.now(),
  });
  queuePersistTraces();
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

async function runImmediateReverify(payload) {
  const slotPostId = Number(payload?.slotPostId || 0);
  if (!Number.isFinite(slotPostId) || slotPostId <= 0) throw new Error('Invalid slotPostId');

  const normalizedBidder = payload?.bidder ? normalizeHexAddress(payload.bidder) : '';
  const explicitJobId = String(payload?.jobId || '').trim();
  const verifierAddress = normalizeHexAddress(payload?.verifierAddress || VERIFIER_CONTRACT);
  if (!verifierAddress || verifierAddress === '0x0') {
    throw new Error('Missing verifier address (SEALED_RELAY_VERIFIER_ADDRESS)');
  }

  const traceCandidates = Array.from(tracesByKey.values())
    .filter((j) => Number(j?.slotPostId || 0) === slotPostId)
    .filter((j) => !explicitJobId || String(j?.id || '') === explicitJobId)
    .filter((j) => !normalizedBidder || normalizeHexAddress(j?.bidder) === normalizedBidder)
    .filter((j) => Array.isArray(j?.proofCalldata) && j.proofCalldata.length > 0);
  const matches = jobs
    .filter((j) => Number(j?.slotPostId || 0) === slotPostId)
    .filter((j) => !explicitJobId || String(j?.id || '') === explicitJobId)
    .filter((j) => !normalizedBidder || normalizeHexAddress(j?.bidder) === normalizedBidder)
    .filter((j) => Array.isArray(j?.proofCalldata) && j.proofCalldata.length > 0)
    .concat(traceCandidates)
    .sort((a, b) => Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0));
  const job = matches[0] || null;
  if (!job && payload?.revealTxHash) {
    await runRecoverRevealTx(payload);
    return runImmediateReverify({ ...payload, revealTxHash: '' });
  }
  if (!job) {
    throw new Error('No stored proof calldata for this slot. Re-verify requires preserved relay trace.');
  }

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

  return {
    slotPostId,
    jobId: String(job.id || ''),
    bidder,
    verifierAddress,
    valid,
    output,
    proofFelts: proof.length,
    proofCalldataHash: String(job?.zkTrace?.proofCalldataHash || ''),
  };
}

async function runImmediateFinalize(payload) {
  const slotPostId = Number(payload?.slotPostId);
  if (!Number.isFinite(slotPostId) || slotPostId <= 0) throw new Error('Invalid slotPostId');
  try {
    const txHash = await executeFinalize(slotPostId);
    return { txHash, slotPostId, alreadyFinalized: false };
  } catch (error) {
    const message = String(error?.message || error || 'Unknown finalize error');
    if (message.toLowerCase().includes('already finalized')) {
      // Idempotent finalize: treat as successful terminal state.
      return { txHash: '', slotPostId, alreadyFinalized: true };
    }
    throw error;
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
          candidate.errorHint = 'Transient reveal error; retry scheduled automatically.';
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
  const now = Math.floor(Date.now() / 1000);
  const next = jobs.find((j) =>
    (j.status === 'submitted' || j.status === 'failed' || j.status === 'skipped') &&
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
      const updatedAt = Date.now();
      let retryable = false;
      for (const job of slotJobs) {
        const attempts = Number(job.finalizeAttempts || 0);
        if (attempts < MAX_FINALIZE_RETRIES) {
          retryable = true;
          job.finalizeAttempts = attempts + 1;
          job.finalizeStatus = 'scheduled';
          job.finalizeAfterUnix = Math.floor(Date.now() / 1000) + FINALIZE_RETRY_SECONDS;
          job.finalizeError = message;
          job.finalizeErrorCode = classified.code;
          job.finalizeErrorHint = 'Transient finalize error; retry scheduled automatically.';
          job.updatedAt = updatedAt;
        } else {
          job.finalizeStatus = 'failed';
          job.finalizeError = message;
          job.finalizeErrorCode = classified.code;
          job.finalizeErrorHint = classified.hint;
          job.updatedAt = updatedAt;
        }
      }
      if (!retryable) {
        console.error('[sealed-relayer] finalize failed (max retries reached)', {
          slotPostId: next.slotPostId,
          jobs: slotJobs.map((j) => j.id),
          error: message,
        });
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

function createJob(payload) {
  const bidder = normalizeHexAddress(payload?.bidder);
  if (!bidder.startsWith('0x')) throw new Error('Invalid bidder');
  const slotPostId = Number(payload?.slotPostId);
  const groupId = Number(payload?.groupId);
  const bidAmount = Number(payload?.bidAmount);
  const revealAfterUnix = Number(payload?.revealAfterUnix || 0);
  const finalizeAfterUnix = Number(payload?.finalizeAfterUnix || 0);
  const salt = String(payload?.salt || '').trim();

  if (!Number.isFinite(slotPostId) || slotPostId <= 0) throw new Error('Invalid slotPostId');
  if (!Number.isFinite(groupId) || groupId <= 0) throw new Error('Invalid groupId');
  if (!Number.isFinite(bidAmount) || bidAmount <= 0) throw new Error('Invalid bidAmount');
  if (!salt) throw new Error('Missing salt');

  const id = `job_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const job = {
    id,
    slotPostId,
    groupId,
    bidder,
    bidAmount,
    salt,
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

  if (req.method === 'GET' && req.url?.startsWith('/sealed/jobs')) {
    json(res, 200, { ok: true, jobs: collectPublicJobsWithTraceFallback() });
    return;
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
        status: result.valid ? 'valid' : 'invalid',
        ...result,
      });
      return;
    } catch (error) {
      json(res, 400, { ok: false, error: String(error?.message || 'Reverify failed') });
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
