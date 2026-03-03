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
const { Account, RpcProvider } = require('/Users/sss/Webs/Starkwall/client/node_modules/starknet');

const PORT = Number(process.env.SEALED_RELAY_PORT || 3002);
const RPC_URL = String(process.env.SEALED_RELAY_RPC_URL || 'https://starknet-sepolia.public.blastapi.io/rpc/v0_8');
const ACTIONS_CONTRACT = String(process.env.SEALED_RELAY_ACTIONS_ADDRESS || '').trim();
const RELAYER_ACCOUNT_ADDRESS = String(process.env.SEALED_RELAY_ACCOUNT_ADDRESS || '').trim();
const RELAYER_PRIVATE_KEY = String(process.env.SEALED_RELAY_PRIVATE_KEY || '').trim();

const REPO_ROOT = '/Users/sss/Webs/Starkwall';
const NOIR_DIR = path.join(REPO_ROOT, 'zk/noir-sealed-bid');
const TARGET_DIR = path.join(NOIR_DIR, 'target');
const PROVER_TOML_PATH = path.join(NOIR_DIR, 'Prover.toml');
const GARAGA_BIN = process.env.SEALED_RELAY_GARAGA_BIN || path.join(REPO_ROOT, '.venv-garaga/bin/garaga');
const BB_BIN = process.env.SEALED_RELAY_BB_BIN || path.join(process.env.HOME || '', '.bb/bb');
const NARGO_BIN = process.env.SEALED_RELAY_NARGO_BIN || 'nargo';
const JOBS_DB_PATH = process.env.SEALED_RELAY_JOBS_FILE || path.join(REPO_ROOT, '.sealed-relayer-jobs.json');
const ZK_VERBOSE = String(process.env.SEALED_RELAY_ZK_VERBOSE || 'true').toLowerCase() !== 'false';
const MAX_REVEAL_RETRIES = Number(process.env.SEALED_RELAY_MAX_REVEAL_RETRIES || 4);
const MAX_FINALIZE_RETRIES = Number(process.env.SEALED_RELAY_MAX_FINALIZE_RETRIES || 8);
const MAX_REFUND_RETRIES = Number(process.env.SEALED_RELAY_MAX_REFUND_RETRIES || 8);
const REVEAL_RETRY_SECONDS = Number(process.env.SEALED_RELAY_REVEAL_RETRY_SECONDS || 15);
const FINALIZE_RETRY_SECONDS = Number(process.env.SEALED_RELAY_FINALIZE_RETRY_SECONDS || 15);
const REFUND_RETRY_SECONDS = Number(process.env.SEALED_RELAY_REFUND_RETRY_SECONDS || 15);

const jobs = [];
let workerBusy = false;
let finalizeWorkerBusy = false;
let refundWorkerBusy = false;
let persistQueued = false;
let relayerTxQueue = Promise.resolve();
const slotLocks = new Set();

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
  // starknet.js v8 expects an options object constructor.
  return new Account({
    provider,
    address: RELAYER_ACCOUNT_ADDRESS,
    signer: RELAYER_PRIVATE_KEY,
    cairoVersion: '1',
  });
}

function enqueueRelayerTx(task) {
  const run = relayerTxQueue.then(task, task);
  relayerTxQueue = run.catch(() => {});
  return run;
}

async function executeWithFreshNonce(account, call) {
  let nonce = undefined;
  try {
    nonce = await account.getNonce('pending');
  } catch {
    try {
      nonce = await account.getNonce();
    } catch {}
  }
  const details = nonce !== undefined ? { nonce } : undefined;
  return account.execute(call, undefined, details);
}

function isExecutionReverted(receipt) {
  const execution = String(receipt?.execution_status || receipt?.executionStatus || '').toUpperCase();
  return execution === 'REVERTED';
}

function readRevertReason(receipt) {
  return String(receipt?.revert_reason || receipt?.revertReason || 'Transaction reverted');
}

async function waitForSuccessfulTx(account, txHash, label = 'transaction') {
  await account.waitForTransaction(txHash);
  const receipt = await account.provider.getTransactionReceipt(txHash);
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

async function persistJobs() {
  const serializable = jobs.map((j) => ({ ...j }));
  await fs.writeFile(JOBS_DB_PATH, JSON.stringify(serializable, null, 2), 'utf8');
}

function queuePersistJobs() {
  if (persistQueued) return;
  persistQueued = true;
  setTimeout(async () => {
    persistQueued = false;
    try {
      await persistJobs();
    } catch (error) {
      console.error('[sealed-relayer] failed to persist jobs:', error?.message || error);
    }
  }, 50);
}

async function restoreJobs() {
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
  await runCommand(
    BB_BIN,
    ['prove', '-s', 'ultra_honk', '--oracle_hash', 'keccak', '-b', 'target/noir_sealed_bid.json', '-w', 'target/witness.gz', '-o', 'target/honk-keccak', '--write_vk'],
    NOIR_DIR,
  );

  const witnessPath = path.join(NOIR_DIR, 'target', 'witness.gz');
  const proofPath = path.join(TARGET_DIR, 'honk-keccak', 'proof');
  const vkPath = path.join(TARGET_DIR, 'honk-keccak', 'vk');
  const publicInputsPath = path.join(TARGET_DIR, 'honk-keccak', 'public_inputs');

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
    queuePersistJobs();
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
  return { txHash, proofLength: proofCalldata.length, bidder: job.bidder, slotPostId: job.slotPostId };
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
        if (normalized.includes('reveal phase closed')) {
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
  return {
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
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
    json(res, 200, { ok: true, jobs });
    return;
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
      const result = await runImmediateFinalize(payload);
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
  await restoreJobs();
  setInterval(() => {
    void processNextJob();
    void processNextFinalizeJob();
    void processNextRefundJob();
  }, 5000);
  server.listen(PORT, () => {
    console.log(`[sealed-relayer] listening on http://localhost:${PORT}`);
    console.log(`[sealed-relayer] actions=${ACTIONS_CONTRACT}`);
    console.log('[sealed-relayer] POST /sealed/schedule to enqueue auto-reveal jobs');
  });
}

start().catch((error) => {
  console.error('[sealed-relayer] startup failed:', error?.message || error);
  process.exit(1);
});
