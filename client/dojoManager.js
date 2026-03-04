import { stringToByteArray } from './utils.js';
import { ToriiQueryBuilder, KeysClause } from "@dojoengine/sdk";
import { IS_SEPOLIA, PAYMENT_TOKEN_ADDRESS, RPC_URL, SEPOLIA_SWAP_WBTC_TOKEN, SEPOLIA_WBTC_TOKEN, TORII_URL } from './config.js';
import { RpcProvider, hash } from 'starknet';
import {
  getQuotes,
  executeSwap,
  executeStake,
  executeInitiateUnstake,
  executeUnstake,
  getAvnuStakingInfo,
  getUserStakingInfo,
  SEPOLIA_BASE_URL,
} from '@avnu/avnu-sdk';

const ONE_STRK = 10n ** 18n;
const DEFAULT_TOKEN_DECIMALS = 18;
const WBTC_TOKEN_DECIMALS = 8;
const AVNU_DEFAULT_SLIPPAGE_PERCENT = 1;
const AVNU_OPTIONS = IS_SEPOLIA ? { baseUrl: SEPOLIA_BASE_URL } : undefined;
const PAID_POST_MULTIPLIER = 4;
const AUCTION_POST_CREATION_FEE_STRK = 10;
const POST_KIND_NORMAL = 0;
const POST_KIND_AUCTION_CENTER = 1;
const POST_KIND_AUCTION_SLOT = 2;

function getPaidPostPrice(size) {
  if (size < 2) return 0;
  return Math.max(1, Math.floor(PAID_POST_MULTIPLIER ** (size - 2)));
}


function isTxReceiptSuccessful(receipt) {
  const execution = receipt?.execution_status || receipt?.executionStatus || '';
  const finality = receipt?.finality_status || receipt?.finalityStatus || '';

  if (String(execution).toUpperCase() === 'REVERTED') return false;
  if (String(finality).toUpperCase() === 'REJECTED') return false;

  // Some providers only return tx hash/finality; treat non-reverted receipts as success.
  return true;
}

function isInsufficientMaxL2GasError(error) {
  const message = String(error?.message || error || '').toLowerCase()
  return message.includes('insufficient max l2gas')
}

async function waitOrThrow(account, tx, fallbackReason) {
  const receipt = await account.waitForTransaction(tx.transaction_hash)
  if (!isTxReceiptSuccessful(receipt)) {
    const reason = receipt?.revert_reason || receipt?.revertReason || fallbackReason
    throw new Error(reason)
  }
  return receipt
}

const HIGH_L2_GAS_TX_DETAILS = {
  // tx v3 style (common in Controller/starknet.js)
  resourceBounds: {
    L1_GAS: {
      max_amount: '0x186a0',
      max_price_per_unit: '0x174876e800', // 100 gwei
    },
    L2_GAS: {
      max_amount: '0x77359400', // 2,000,000,000
      max_price_per_unit: '0x2540be400', // 10 gwei
    },
  },
}

const HIGH_L2_GAS_TX_DETAILS_LEGACY_KEYS = {
  // Compatibility fallback for wrappers expecting lowercase keys.
  resourceBounds: {
    l1_gas: {
      max_amount: '0x186a0',
      max_price_per_unit: '0x174876e800',
    },
    l2_gas: {
      max_amount: '0x77359400',
      max_price_per_unit: '0x2540be400',
    },
  },
}

async function executeWithDetailsCompat(account, calls, details) {
  // Some account wrappers expect `execute(calls, details)`, others `execute(calls, undefined, details)`.
  try {
    return await account.execute(calls, undefined, details)
  } catch (firstError) {
    try {
      return await account.execute(calls, details)
    } catch {
      throw firstError
    }
  }
}

async function executeWithL2GasFallback(account, calls) {
  try {
    return await account.execute(calls)
  } catch (error) {
    if (!isInsufficientMaxL2GasError(error)) throw error
  }

  // First fallback: same call set with larger L2 gas bounds (v3 keys).
  try {
    return await executeWithDetailsCompat(account, calls, HIGH_L2_GAS_TX_DETAILS)
  } catch (error) {
    if (!isInsufficientMaxL2GasError(error)) throw error
  }

  // Second fallback: lowercase resource keys for compatibility wrappers.
  try {
    return await executeWithDetailsCompat(account, calls, HIGH_L2_GAS_TX_DETAILS_LEGACY_KEYS)
  } catch (error) {
    if (!isInsufficientMaxL2GasError(error)) throw error
  }

  // Final fallback: high bounds + explicit maxFee.
  return executeWithDetailsCompat(account, calls, {
    ...HIGH_L2_GAS_TX_DETAILS_LEGACY_KEYS,
    maxFee: '0xee6b2800', // 4e9
  })
}

function feltToU256(val) {
  const n = BigInt(val);
  const low = n & ((1n << 128n) - 1n);
  const high = n >> 128n;
  return { low: low.toString(), high: high.toString() };
}

function unitsToTokenNumber(units, tokenDecimals = DEFAULT_TOKEN_DECIMALS, displayDecimals = 6) {
  const amount = BigInt(units || 0);
  const decimals = Math.max(0, Number(tokenDecimals) || 0);
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const frac = amount % base;
  const scale = 10n ** BigInt(Math.max(0, Number(displayDecimals) || 0));
  const fracScaled = (frac * scale) / base;
  return Number(whole) + Number(fracScaled) / Number(scale);
}

function parseAmountToUnits(amountValue, tokenDecimals = DEFAULT_TOKEN_DECIMALS) {
  const raw = String(amountValue ?? '').trim();
  if (!raw) throw new Error('Invalid amount');
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error('Invalid amount');

  const decimals = Math.max(0, Number(tokenDecimals) || 0);
  const [wholePart, fractionalPart = ''] = raw.split('.');
  const normalizedFraction = fractionalPart.slice(0, decimals).padEnd(decimals, '0');
  const whole = BigInt(wholePart || '0');
  const frac = normalizedFraction ? BigInt(normalizedFraction) : 0n;
  return (whole * (10n ** BigInt(decimals))) + frac;
}

function isNoSwapRouteError(error) {
  const message = String(error?.message || error || '').toLowerCase()
  return message.includes('no swap route')
    || message.includes('no route available')
    || message.includes('insufficient liquidity')
}

function isRetryableSwapExecutionError(error) {
  const message = String(error?.message || error || '').toLowerCase()
  return message.includes('insufficient tokens received')
    || message.includes('argent/multicall-failed')
    || message.includes('entrypoint_failed')
    || message.includes('slippage')
    || message.includes('minimum received')
}

function poolIdFromMode(useBtcMode) {
  return useBtcMode ? 1 : 0
}

function normalizeHexAddress(address) {
  const raw = String(address || '').trim().toLowerCase()
  if (!raw) return '0x0'
  const hex = raw.startsWith('0x') ? raw.slice(2) : raw
  const normalized = hex.replace(/^0+/, '')
  return `0x${normalized || '0'}`
}

function simpleCommitment(slotPostId, groupId, bidder, bidAmount, salt) {
  const slot = BigInt(slotPostId || 0).toString()
  const group = BigInt(groupId || 0).toString()
  const bid = BigInt(bidAmount || 0).toString()
  const saltVal = BigInt(salt || 0).toString()
  const addr = BigInt(normalizeHexAddress(bidder)).toString()
  const commitment = hash.computePoseidonHashOnElements([slot, group, addr, bid, saltVal])
  return normalizeHexAddress(commitment)
}

export class DojoManager {
  constructor(account, manifest, toriiClient) {
    this.account = account;
    this.manifest = manifest;
    this.toriiClient = toriiClient;
    this.actionsContract = manifest.contracts.find((c) => c.tag === 'di-actions');
    this.balanceProvider = new RpcProvider({ nodeUrl: RPC_URL });
    this.tokenDecimalsCache = new Map();
    this.avnuStakingInfoCache = null;
    this.avnuStakingInfoCacheAt = 0;
    this.avnuUserStakingCache = new Map();
    this.lastAvnuRouteProbeErrors = [];
    this.sealedConfigureSupport = null;
  }

  async supportsConfigureSealedEntrypoint() {
    if (typeof this.sealedConfigureSupport === 'boolean') return this.sealedConfigureSupport
    const verifierProbe = this.actionsContract?.address || '0x1'
    try {
      await this.balanceProvider.callContract({
        contractAddress: this.actionsContract.address,
        entrypoint: 'configure_auction_sealed',
        calldata: ['0', '0', '1', verifierProbe],
      }, 'latest')
      this.sealedConfigureSupport = true
      return true
    } catch (error) {
      const msg = String(error?.message || error || '').toLowerCase()
      this.sealedConfigureSupport = !(
        msg.includes('entrypoint_not_found') ||
        msg.includes('entry point') && msg.includes('not found')
      )
      return this.sealedConfigureSupport
    }
  }

  async getAvnuStakingInfoCached(forceRefresh = false) {
    const now = Date.now()
    const cacheTtlMs = 45_000
    if (!forceRefresh && this.avnuStakingInfoCache && (now - this.avnuStakingInfoCacheAt) < cacheTtlMs) {
      return this.avnuStakingInfoCache
    }
    const info = await getAvnuStakingInfo(AVNU_OPTIONS)
    this.avnuStakingInfoCache = info
    this.avnuStakingInfoCacheAt = now
    return info
  }

  async getAvnuUserStakingByToken(tokenAddress, userAddress, forceRefresh = false) {
    const token = this.normalizeAddress(tokenAddress)
    const user = this.normalizeAddress(userAddress || this.account?.address)
    if (!token || !user || token === '0x0' || user === '0x0') return null

    const cacheKey = `${token}:${user}`
    const now = Date.now()
    const cacheTtlMs = 30_000
    const cached = this.avnuUserStakingCache.get(cacheKey)
    if (!forceRefresh && cached && (now - cached.at) < cacheTtlMs) {
      return cached.value
    }

    try {
      const info = await getUserStakingInfo(token, user, AVNU_OPTIONS)
      const amountRaw = BigInt(info?.amount || 0n)
      const rewardsRaw = BigInt(info?.unclaimedRewards || 0n)
      const unpoolRaw = BigInt(info?.unpoolAmount || 0n)
      const decimals = await this.getTokenDecimals(token).catch(() => DEFAULT_TOKEN_DECIMALS)
      const value = {
        tokenAddress: token,
        poolAddress: this.normalizeAddress(info?.poolAddress),
        amountRaw,
        rewardsRaw,
        unpoolRaw,
        unpoolTime: info?.unpoolTime ? new Date(info.unpoolTime) : null,
        amountFormatted: unitsToTokenNumber(amountRaw, decimals, 6),
        rewardsFormatted: unitsToTokenNumber(rewardsRaw, decimals, 6),
        unpoolFormatted: unitsToTokenNumber(unpoolRaw, decimals, 6),
      }
      this.avnuUserStakingCache.set(cacheKey, { at: now, value })
      return value
    } catch {
      this.avnuUserStakingCache.set(cacheKey, { at: now, value: null })
      return null
    }
  }

  async getTokenDecimals(tokenAddress = PAYMENT_TOKEN_ADDRESS) {
    const tokenAddr = String(tokenAddress || '').toLowerCase();
    if (!tokenAddr) return DEFAULT_TOKEN_DECIMALS;
    if (this.tokenDecimalsCache.has(tokenAddr)) return this.tokenDecimalsCache.get(tokenAddr);

    // Known production config: Sepolia WBTC uses 8 decimals.
    if (tokenAddr === String(SEPOLIA_WBTC_TOKEN || '').toLowerCase()) {
      this.tokenDecimalsCache.set(tokenAddr, WBTC_TOKEN_DECIMALS);
      return WBTC_TOKEN_DECIMALS;
    }

    const entrypoints = ['decimals', 'get_decimals'];
    for (const entrypoint of entrypoints) {
      const call = {
        contractAddress: tokenAddr,
        entrypoint,
        calldata: [],
      };

      try {
        let result;
        try {
          result = await this.balanceProvider.callContract(call, 'latest');
        } catch {
          result = await this.balanceProvider.callContract(call);
        }
        const parts = Array.isArray(result) ? result : (result?.result || []);
        const raw = Number(parts[0] ?? DEFAULT_TOKEN_DECIMALS);
        const decimals = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TOKEN_DECIMALS;
        this.tokenDecimalsCache.set(tokenAddr, decimals);
        return decimals;
      } catch {
        continue;
      }
    }

    this.tokenDecimalsCache.set(tokenAddr, DEFAULT_TOKEN_DECIMALS);
    return DEFAULT_TOKEN_DECIMALS;
  }

  async getTokenBalanceRaw(address, tokenAddress = PAYMENT_TOKEN_ADDRESS) {
    const tokenAddr = String(tokenAddress || '')
    if (!tokenAddr) return 0n

    // Starknet ERC20s usually expose `balanceOf`, but our local minimal token uses `balance_of`.
    const entrypoints = ['balanceOf', 'balance_of']

    for (const entrypoint of entrypoints) {
      const call = {
        contractAddress: tokenAddr,
        entrypoint,
        calldata: [address],
      }

      try {
        // Some nodes reject `pending`; prefer `latest`.
        let result
        try {
          result = await this.balanceProvider.callContract(call, 'latest')
        } catch {
          result = await this.balanceProvider.callContract(call)
        }

        // Some providers return { result: [low, high] }, others return [low, high].
        const parts = Array.isArray(result) ? result : (result?.result || [])
        const low = BigInt(parts[0] || 0)
        const high = BigInt(parts[1] || 0)
        const units = low + (high << 128n)
        return units
      } catch (e) {
        // Try next entrypoint.
        continue
      }
    }

    return 0n
  }

  async getTokenBalance(address, tokenAddress = PAYMENT_TOKEN_ADDRESS, displayDecimals = 6) {
    const tokenAddr = String(tokenAddress || '')
    if (!tokenAddr) return 0
    const [units, tokenDecimals] = await Promise.all([
      this.getTokenBalanceRaw(address, tokenAddr),
      this.getTokenDecimals(tokenAddr),
    ])
    return unitsToTokenNumber(units, tokenDecimals, displayDecimals)
  }

  async getActivePoolTokenDecimals() {
    const state = await this.queryYieldState(this.account?.address || '').catch(() => null)
    const poolId = Number(state?.pool_id ?? 0)
    const tokenAddress = poolId === 1 ? SEPOLIA_WBTC_TOKEN : PAYMENT_TOKEN_ADDRESS
    return this.getTokenDecimals(tokenAddress)
  }

  async getPoolTokenDecimals(poolId = 0) {
    const tokenAddress = Number(poolId) === 1 ? SEPOLIA_WBTC_TOKEN : PAYMENT_TOKEN_ADDRESS
    return this.getTokenDecimals(tokenAddress)
  }

  normalizeAddress(address) {
    const raw = String(address || '').trim().toLowerCase()
    if (!raw) return ''
    const hex = raw.startsWith('0x') ? raw.slice(2) : raw
    const normalized = hex.replace(/^0+/, '')
    return `0x${normalized || '0'}`
  }

  normalizeUsername(username) {
    return String(username || '').trim().toLowerCase()
  }

  async computeUsernameHash(username) {
    const normalized = this.normalizeUsername(username)
    if (!normalized) return '0x0'

    const bytes = new TextEncoder().encode(normalized)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
    // felt252 fits up to 251 bits, keep first 62 hex chars (248 bits)
    return `0x${hex.slice(0, 62) || '0'}`
  }

  async setProfile(username) {
    const clean = String(username || '').trim()
    if (!clean) throw new Error('Username is required')
    const hash = await this.computeUsernameHash(clean)
    const usernameBytes = stringToByteArray(clean)

    const tx = await this.account.execute({
      contractAddress: this.actionsContract.address,
      entrypoint: 'set_profile',
      calldata: [...usernameBytes, hash],
    })

    const receipt = await this.account.waitForTransaction(tx.transaction_hash)
    if (!isTxReceiptSuccessful(receipt)) {
      const reason = receipt?.revert_reason || receipt?.revertReason || 'Set profile transaction reverted'
      throw new Error(reason)
    }

    return tx
  }

  async followUser(followingAddress) {
    const target = this.normalizeAddress(followingAddress)
    if (!target) throw new Error('Invalid target address')

    const tx = await this.account.execute({
      contractAddress: this.actionsContract.address,
      entrypoint: 'follow',
      calldata: [target],
    })

    const receipt = await this.account.waitForTransaction(tx.transaction_hash)
    if (!isTxReceiptSuccessful(receipt)) {
      const reason = receipt?.revert_reason || receipt?.revertReason || 'Follow transaction reverted'
      throw new Error(reason)
    }

    return tx
  }

  async unfollowUser(followingAddress) {
    const target = this.normalizeAddress(followingAddress)
    if (!target) throw new Error('Invalid target address')

    const tx = await this.account.execute({
      contractAddress: this.actionsContract.address,
      entrypoint: 'unfollow',
      calldata: [target],
    })

    const receipt = await this.account.waitForTransaction(tx.transaction_hash)
    if (!isTxReceiptSuccessful(receipt)) {
      const reason = receipt?.revert_reason || receipt?.revertReason || 'Unfollow transaction reverted'
      throw new Error(reason)
    }

    return tx
  }

  async querySocialData() {
    const [profilesResp, relationsResp, statsResp] = await Promise.all([
      this.toriiClient.getEntities({
        query: new ToriiQueryBuilder().withClause(KeysClause(['di-UserProfile'], [], 'VariableLen').build()),
      }).catch(() => ({ items: [] })),
      this.toriiClient.getEntities({
        query: new ToriiQueryBuilder().withClause(KeysClause(['di-FollowRelation'], [], 'VariableLen').build()),
      }).catch(() => ({ items: [] })),
      this.toriiClient.getEntities({
        query: new ToriiQueryBuilder().withClause(KeysClause(['di-FollowStats'], [], 'VariableLen').build()),
      }).catch(() => ({ items: [] })),
    ])

    const profiles = []
    for (const item of (profilesResp?.items || [])) {
      const model = item?.models?.di?.UserProfile
      if (!model?.user) continue
      profiles.push({
        user: this.normalizeAddress(model.user),
        username: this.byteArrayToString(model.username),
        username_norm_hash: model.username_norm_hash,
      })
    }

    const relations = []
    for (const item of (relationsResp?.items || [])) {
      const model = item?.models?.di?.FollowRelation
      if (!model?.follower || !model?.following) continue
      const createdAt = Number(model.created_at ?? model.createdAt ?? 0)
      if (createdAt <= 0) continue
      relations.push({
        follower: this.normalizeAddress(model.follower),
        following: this.normalizeAddress(model.following),
        created_at: createdAt,
      })
    }

    const stats = []
    for (const item of (statsResp?.items || [])) {
      const model = item?.models?.di?.FollowStats
      if (!model?.user) continue
      stats.push({
        user: this.normalizeAddress(model.user),
        followers_count: Number(model.followers_count ?? model.followersCount ?? 0),
        following_count: Number(model.following_count ?? model.followingCount ?? 0),
      })
    }

    return { profiles, relations, stats }
  }

  async getFollowCounts(address) {
    const target = this.normalizeAddress(address)
    if (!target) return { following: 0, followers: 0 }

    try {
      const social = await this.querySocialData()
      const stat = social.stats.find((s) => s.user === target)
      if (stat) {
        return { following: Number(stat.following_count || 0), followers: Number(stat.followers_count || 0) }
      }

      let following = 0
      let followers = 0
      for (const rel of social.relations) {
        if (rel.follower === target) following += 1
        if (rel.following === target) followers += 1
      }
      return { following, followers }
    } catch {
      return { following: 0, followers: 0 }
    }
  }

  async yieldDeposit(amountStrk, useBtcMode = false) {
    const poolId = poolIdFromMode(useBtcMode)
    const tokenAddress = poolId === 1 ? SEPOLIA_WBTC_TOKEN : PAYMENT_TOKEN_ADDRESS
    const tokenDecimals = await this.getTokenDecimals(tokenAddress)
    const amountUnits = parseAmountToUnits(amountStrk, tokenDecimals)
    if (amountUnits <= 0n) throw new Error('Invalid deposit amount')

    const currentBalance = await this.getTokenBalanceRaw(this.account.address, tokenAddress).catch(() => null)
    if (typeof currentBalance === 'bigint' && amountUnits > currentBalance) {
      const symbol = poolId === 1 ? 'WBTC' : 'STRK'
      throw new Error(`Insufficient ${symbol} balance`)
    }

    // Deposit pulls the selected pool token via transfer_from, so approval is required first.
    const { low, high } = feltToU256(amountUnits)
    const tx = await this.account.execute([
      {
        contractAddress: tokenAddress,
        entrypoint: 'approve',
        calldata: [this.actionsContract.address, low, high],
      },
      {
        contractAddress: this.actionsContract.address,
        entrypoint: 'yield_deposit',
        calldata: [amountUnits.toString(), useBtcMode ? 1 : 0],
      },
    ])

    const receipt = await this.account.waitForTransaction(tx.transaction_hash)
    if (!isTxReceiptSuccessful(receipt)) {
      const reason = receipt?.revert_reason || receipt?.revertReason || 'Yield deposit reverted'
      throw new Error(reason)
    }
    return tx
  }

  // Starkzap-style smart stake behavior:
  // one entrypoint that automatically handles first stake and add-to-existing.
  async stake(amount, useBtcMode = false) {
    return this.yieldDeposit(amount, useBtcMode)
  }

  // Alias for "add to an existing stake". Contract-side logic is the same deposit flow.
  async addToPool(amount, useBtcMode = false) {
    return this.yieldDeposit(amount, useBtcMode)
  }

  async yieldWithdraw(amountStrk) {
    const tokenDecimals = await this.getActivePoolTokenDecimals()
    const amountUnits = parseAmountToUnits(amountStrk, tokenDecimals)
    if (amountUnits <= 0n) throw new Error('Invalid withdraw amount')

    const tx = await this.account.execute({
      contractAddress: this.actionsContract.address,
      entrypoint: 'yield_withdraw',
      calldata: [amountUnits.toString()],
    })

    const receipt = await this.account.waitForTransaction(tx.transaction_hash)
    if (!isTxReceiptSuccessful(receipt)) {
      const reason = receipt?.revert_reason || receipt?.revertReason || 'Yield withdraw reverted'
      throw new Error(reason)
    }
    return tx
  }

  async yieldClaim() {
    const tx = await this.account.execute({
      contractAddress: this.actionsContract.address,
      entrypoint: 'yield_claim',
      calldata: [],
    })

    const receipt = await this.account.waitForTransaction(tx.transaction_hash)
    if (!isTxReceiptSuccessful(receipt)) {
      const reason = receipt?.revert_reason || receipt?.revertReason || 'Yield claim reverted'
      throw new Error(reason)
    }
    return tx
  }

  // Starkzap-style naming alias.
  async claimPoolRewards() {
    return this.yieldClaim()
  }

  async yieldSetBtcMode(useBtcMode) {
    const tx = await this.account.execute({
      contractAddress: this.actionsContract.address,
      entrypoint: 'yield_set_btc_mode',
      calldata: [useBtcMode ? 1 : 0],
    })

    const receipt = await this.account.waitForTransaction(tx.transaction_hash)
    if (!isTxReceiptSuccessful(receipt)) {
      const reason = receipt?.revert_reason || receipt?.revertReason || 'Set BTC mode reverted'
      throw new Error(reason)
    }
    return tx
  }

  async yieldRebalance() {
    const tx = await this.account.execute({
      contractAddress: this.actionsContract.address,
      entrypoint: 'yield_rebalance',
      calldata: [],
    })
    const receipt = await this.account.waitForTransaction(tx.transaction_hash)
    if (!isTxReceiptSuccessful(receipt)) {
      const reason = receipt?.revert_reason || receipt?.revertReason || 'Yield rebalance reverted'
      throw new Error(reason)
    }
    return tx
  }

  async yieldHarvest() {
    const tx = await this.account.execute({
      contractAddress: this.actionsContract.address,
      entrypoint: 'yield_harvest',
      calldata: [],
    })
    const receipt = await this.account.waitForTransaction(tx.transaction_hash)
    if (!isTxReceiptSuccessful(receipt)) {
      const reason = receipt?.revert_reason || receipt?.revertReason || 'Yield harvest reverted'
      throw new Error(reason)
    }
    return tx
  }

  async yieldProcessExitQueue(userAddress) {
    const user = this.normalizeAddress(userAddress)
    if (!user) throw new Error('Invalid user address')
    const tx = await this.account.execute({
      contractAddress: this.actionsContract.address,
      entrypoint: 'yield_process_exit_queue',
      calldata: [user],
    })
    const receipt = await this.account.waitForTransaction(tx.transaction_hash)
    if (!isTxReceiptSuccessful(receipt)) {
      const reason = receipt?.revert_reason || receipt?.revertReason || 'Yield queue processing reverted'
      throw new Error(reason)
    }
    return tx
  }

  async queryYieldState(address) {
    const target = this.normalizeAddress(address)
    if (!target) {
      return {
        principal_strk: 0,
        pending_strk: 0,
        pool_id: 0,
        pool_token_symbol: 'STRK',
        last_accrual_ts: 0,
        use_btc_mode: false,
        apr_bps: 0,
        earnings_pool_strk: 0,
        liquid_buffer_strk: 0,
        staked_principal_strk: 0,
        queued_exit_strk: 0,
      }
    }

    // Source of truth: read directly from on-chain actions contract.
    try {
      const call = {
        contractAddress: this.actionsContract.address,
        entrypoint: 'yield_get_user_state',
        calldata: [target],
      }
      let raw
      try {
        raw = await this.balanceProvider.callContract(call, 'latest')
      } catch {
        raw = await this.balanceProvider.callContract(call)
      }
      const result = Array.isArray(raw) ? raw : (Array.isArray(raw?.result) ? raw.result : [])
      if (result.length >= 8) {
        const toBigInt = (v) => {
          try { return BigInt(String(v ?? 0)) } catch { return 0n }
        }
        const principalWei = toBigInt(result[0])
        const pendingWei = toBigInt(result[1])
        const queuedWei = toBigInt(result[2])
        const useBtc = String(result[3] ?? '0') !== '0'
        const poolId = Number(result[4] ?? (useBtc ? 1 : 0))
        const tokenDecimals = await this.getPoolTokenDecimals(poolId)
        const earningsPoolWei = toBigInt(result[5])
        const liquidBufferWei = toBigInt(result[6])
        const aprBps = Number(result[7] ?? 0)
        return {
          principal_strk: unitsToTokenNumber(principalWei, tokenDecimals, 6),
          pending_strk: unitsToTokenNumber(pendingWei, tokenDecimals, 8),
          pool_id: poolId,
          pool_token_symbol: poolId === 1 ? 'WBTC' : 'STRK',
          last_accrual_ts: 0,
          use_btc_mode: useBtc,
          apr_bps: Number.isFinite(aprBps) && aprBps > 0 ? aprBps : 0,
          earnings_pool_strk: unitsToTokenNumber(earningsPoolWei, tokenDecimals, 6),
          liquid_buffer_strk: unitsToTokenNumber(liquidBufferWei, tokenDecimals, 6),
          staked_principal_strk: 0,
          queued_exit_strk: unitsToTokenNumber(queuedWei, tokenDecimals, 6),
        }
      }
    } catch {
      // Fallback to Torii below.
    }

    const [posResp, queueResp, pool0Resp, pool1Resp, risk0Resp, risk1Resp] = await Promise.all([
      this.toriiClient.getEntities({
        query: new ToriiQueryBuilder().withClause(KeysClause(['di-YieldPosition'], [target], 'FixedLen').build()),
      }).catch(() => ({ items: [] })),
      this.toriiClient.getEntities({
        query: new ToriiQueryBuilder().withClause(KeysClause(['di-YieldExitQueue'], [target], 'FixedLen').build()),
      }).catch(() => ({ items: [] })),
      this.toriiClient.getEntities({
        query: new ToriiQueryBuilder().withClause(KeysClause(['di-YieldPoolState'], [0], 'FixedLen').build()),
      }).catch(() => ({ items: [] })),
      this.toriiClient.getEntities({
        query: new ToriiQueryBuilder().withClause(KeysClause(['di-YieldPoolState'], [1], 'FixedLen').build()),
      }).catch(() => ({ items: [] })),
      this.toriiClient.getEntities({
        query: new ToriiQueryBuilder().withClause(KeysClause(['di-YieldRiskState'], [0], 'FixedLen').build()),
      }).catch(() => ({ items: [] })),
      this.toriiClient.getEntities({
        query: new ToriiQueryBuilder().withClause(KeysClause(['di-YieldRiskState'], [1], 'FixedLen').build()),
      }).catch(() => ({ items: [] })),
    ])

    const toBigInt = (v) => {
      try { return BigInt(String(v ?? 0)) } catch { return 0n }
    }

    let posItems = posResp?.items || []
    let queueItems = queueResp?.items || []

    // Torii can occasionally miss fresh FixedLen entities right after writes.
    // Fall back to VariableLen scan only when targeted lookups return empty.
    if (posItems.length === 0) {
      const [posFallbackResp, queueFallbackResp] = await Promise.all([
        this.toriiClient.getEntities({
          query: new ToriiQueryBuilder().withClause(KeysClause(['di-YieldPosition'], [], 'VariableLen').build()),
        }).catch(() => ({ items: [] })),
        this.toriiClient.getEntities({
          query: new ToriiQueryBuilder().withClause(KeysClause(['di-YieldExitQueue'], [], 'VariableLen').build()),
        }).catch(() => ({ items: [] })),
      ])
      posItems = posFallbackResp?.items || []
      queueItems = queueFallbackResp?.items || []
    }

    const posCandidates = posItems
      .map((x) => x?.models?.di?.YieldPosition)
      .filter((m) => this.normalizeAddress(m?.user) === target)
    const posModel = posCandidates.sort((a, b) => {
      const ta = Number(a?.last_accrual_ts ?? a?.lastAccrualTs ?? 0)
      const tb = Number(b?.last_accrual_ts ?? b?.lastAccrualTs ?? 0)
      return tb - ta
    })[0] || null
    const poolId = Number(posModel?.pool_id ?? posModel?.poolId ?? (posModel?.use_btc_mode ? 1 : 0) ?? 0)

    const pool0Model = (pool0Resp?.items || []).map((x) => x?.models?.di?.YieldPoolState)[0] || null
    const pool1Model = (pool1Resp?.items || []).map((x) => x?.models?.di?.YieldPoolState)[0] || null
    const poolModel = poolId === 1 ? pool1Model : pool0Model

    const principalWei = toBigInt(posModel?.principal)
    const pendingWei = toBigInt(posModel?.pending_rewards ?? posModel?.pendingRewards)
    const earningsPoolWei = toBigInt(poolModel?.earnings_pool ?? poolModel?.earningsPool)
    const risk0Model = (risk0Resp?.items || []).map((x) => x?.models?.di?.YieldRiskState)[0] || null
    const risk1Model = (risk1Resp?.items || []).map((x) => x?.models?.di?.YieldRiskState)[0] || null
    const riskModel = poolId === 1 ? risk1Model : risk0Model
    const liquidBufferWei = toBigInt(riskModel?.liquid_buffer ?? riskModel?.liquidBuffer)
    const stakedPrincipalWei = toBigInt(riskModel?.staked_principal ?? riskModel?.stakedPrincipal)
    const aprBps = Number(poolModel?.apr_bps ?? poolModel?.aprBps ?? 0)
    const tokenDecimals = await this.getPoolTokenDecimals(poolId)
    const queueCandidates = queueItems
      .map((x) => x?.models?.di?.YieldExitQueue)
      .filter((m) => this.normalizeAddress(m?.user) === target)
    const queueModel = queueCandidates.sort((a, b) => {
      const ta = Number(a?.requested_at ?? a?.requestedAt ?? 0)
      const tb = Number(b?.requested_at ?? b?.requestedAt ?? 0)
      return tb - ta
    })[0] || null
    const queuedWei = toBigInt(queueModel?.queued_principal ?? queueModel?.queuedPrincipal)

    return {
      principal_strk: unitsToTokenNumber(principalWei, tokenDecimals, 6),
      pending_strk: unitsToTokenNumber(pendingWei, tokenDecimals, 8),
      pool_id: poolId,
      pool_token_symbol: poolId === 1 ? 'WBTC' : 'STRK',
      last_accrual_ts: Number(posModel?.last_accrual_ts ?? posModel?.lastAccrualTs ?? 0),
      use_btc_mode: Boolean(posModel?.use_btc_mode ?? posModel?.useBtcMode ?? false),
      apr_bps: Number.isFinite(aprBps) && aprBps > 0 ? aprBps : 0,
      earnings_pool_strk: unitsToTokenNumber(earningsPoolWei, tokenDecimals, 6),
      liquid_buffer_strk: unitsToTokenNumber(liquidBufferWei, tokenDecimals, 6),
      staked_principal_strk: unitsToTokenNumber(stakedPrincipalWei, tokenDecimals, 6),
      queued_exit_strk: unitsToTokenNumber(queuedWei, tokenDecimals, 6),
    }
  }

  async buyPostWithPayment(postId, sellerAddress, price) {
    const tokenAddr = PAYMENT_TOKEN_ADDRESS;
    if (!tokenAddr) throw new Error('No token configured. Set VITE_STRK_TOKEN or deploy STRK (see contracts/DEPLOY_STRK.md).');
    const amountWei = BigInt(price) * ONE_STRK;
    const { low, high } = feltToU256(amountWei);
    const calls = [
      // Contract enforces payment via transfer_from inside buy_post.
      { contractAddress: tokenAddr, entrypoint: 'approve', calldata: [this.actionsContract.address, low, high] },
      { contractAddress: this.actionsContract.address, entrypoint: 'buy_post', calldata: [postId] },
    ];

    const tx = await this.account.execute(calls);
    const receipt = await this.account.waitForTransaction(tx.transaction_hash);

    if (!isTxReceiptSuccessful(receipt)) {
      const reason = receipt?.revert_reason || receipt?.revertReason || 'Buy transaction reverted';
      throw new Error(reason);
    }

    return tx;
  }

  async sendStrk(recipientAddress, amountStrk) {
    const tokenAddr = PAYMENT_TOKEN_ADDRESS;
    if (!tokenAddr) throw new Error('No token configured.');

    const recipient = String(recipientAddress || '').trim();
    if (!recipient.startsWith('0x')) throw new Error('Invalid recipient address.');

    const amountNum = Number(amountStrk);
    if (!Number.isFinite(amountNum) || amountNum <= 0) throw new Error('Invalid amount.');

    const amountWei = BigInt(Math.floor(amountNum * 1_000_000)) * (ONE_STRK / 1_000_000n);
    if (amountWei <= 0n) throw new Error('Amount too small.');

    const { low, high } = feltToU256(amountWei);
    const tx = await this.account.execute({
      contractAddress: tokenAddr,
      entrypoint: 'transfer',
      calldata: [recipient, low, high],
    });

    const receipt = await this.account.waitForTransaction(tx.transaction_hash);
    if (!isTxReceiptSuccessful(receipt)) {
      const reason = receipt?.revert_reason || receipt?.revertReason || 'Token transfer reverted';
      throw new Error(reason);
    }

    return tx;
  }

  async getWbtcToStrkQuote(amountWbtc) {
    const q = await this.getTokenSwapQuote(SEPOLIA_SWAP_WBTC_TOKEN, PAYMENT_TOKEN_ADDRESS, amountWbtc);
    return {
      ...q,
      estimatedStrkRaw: q.estimatedBuyRaw,
      estimatedStrk: q.estimatedBuyAmount,
      estimatedGasFeeStrk: q.estimatedGasFee,
    };
  }

  async swapWbtcToStrk(amountWbtc, slippagePercent = AVNU_DEFAULT_SLIPPAGE_PERCENT) {
    return this.swapTokens(SEPOLIA_SWAP_WBTC_TOKEN, PAYMENT_TOKEN_ADDRESS, amountWbtc, slippagePercent);
  }

  async getStrkToWbtcQuote(amountStrk) {
    const q = await this.getTokenSwapQuote(PAYMENT_TOKEN_ADDRESS, SEPOLIA_SWAP_WBTC_TOKEN, amountStrk);
    return {
      ...q,
      estimatedWbtcRaw: q.estimatedBuyRaw,
      estimatedWbtc: q.estimatedBuyAmount,
      estimatedGasFeeStrk: q.estimatedGasFee,
    };
  }

  async swapStrkToWbtc(amountStrk, slippagePercent = AVNU_DEFAULT_SLIPPAGE_PERCENT) {
    return this.swapTokens(PAYMENT_TOKEN_ADDRESS, SEPOLIA_SWAP_WBTC_TOKEN, amountStrk, slippagePercent);
  }

  async swapTokens(sellTokenAddress, buyTokenAddress, amountSell, slippagePercent = AVNU_DEFAULT_SLIPPAGE_PERCENT, retryOptions = {}) {
    const base = Number(slippagePercent || AVNU_DEFAULT_SLIPPAGE_PERCENT)
    const extraCandidates = Array.isArray(retryOptions?.slippageCandidates)
      ? retryOptions.slippageCandidates
      : [2, 3, 5, 8, 12, 15, 20, 30]
    const slippageCandidates = Array.from(
      new Set([base, ...extraCandidates].filter((v) => Number.isFinite(Number(v)) && Number(v) > 0)),
    )
    let lastError = null

    for (let i = 0; i < slippageCandidates.length; i += 1) {
      const candidate = Number(slippageCandidates[i])
      try {
        const { quote } = await this.getTokenSwapQuote(sellTokenAddress, buyTokenAddress, amountSell);
        const slippage = Math.max(0.001, candidate / 100);
        const swapResult = await executeSwap({
          provider: this.account,
          quote,
          slippage,
          executeApprove: true,
        }, AVNU_OPTIONS);

        const txHash = String(swapResult?.transactionHash || swapResult?.transaction_hash || '').trim();
        if (!txHash) throw new Error('Swap submitted but transaction hash was not returned');

        const receipt = await this.account.waitForTransaction(txHash);
        if (!isTxReceiptSuccessful(receipt)) {
          const reason = receipt?.revert_reason || receipt?.revertReason || 'Token swap reverted';
          throw new Error(reason);
        }
        return { transaction_hash: txHash, quote };
      } catch (error) {
        lastError = error
        const retryable = isRetryableSwapExecutionError(error)
        const hasMore = i < slippageCandidates.length - 1
        if (!(retryable && hasMore)) {
          if (retryable) {
            throw new Error('Swap execution failed due to slippage/liquidity at confirmation time. Try a smaller amount or retry shortly.')
          }
          throw error
        }
      }
    }
    if (isRetryableSwapExecutionError(lastError)) {
      throw new Error('Swap execution failed due to slippage/liquidity at confirmation time. Try a smaller amount or retry shortly.')
    }
    throw lastError || new Error('Token swap failed')
  }

  async getTokenSwapQuote(sellTokenAddress, buyTokenAddress, amountSell) {
    const sellToken = String(sellTokenAddress || '').trim();
    const buyToken = String(buyTokenAddress || '').trim();
    if (!sellToken || !buyToken) throw new Error('Invalid swap token addresses');

    const sellTokenDecimals = await this.getTokenDecimals(sellToken);
    const buyTokenDecimals = await this.getTokenDecimals(buyToken);
    const amountUnits = parseAmountToUnits(amountSell, sellTokenDecimals);
    if (amountUnits <= 0n) throw new Error('Invalid swap amount');

    let quotes = [];
    try {
      quotes = await getQuotes({
        sellTokenAddress: sellToken,
        buyTokenAddress: buyToken,
        sellAmount: amountUnits,
        takerAddress: String(this.account.address),
        size: 1,
      }, AVNU_OPTIONS);
    } catch (error) {
      const rawMessage = String(
        error?.response?.data?.message ||
        error?.response?.data?.error ||
        error?.message ||
        error ||
        ''
      ).trim();
      const message = rawMessage || 'Unknown AVNU quote error';
      if (/cors|network|failed to fetch|cross-origin/i.test(message)) {
        throw new Error(`AVNU raw: ${message}`);
      }
      throw new Error(`AVNU raw: ${message}`);
    }

    const quote = Array.isArray(quotes) && quotes.length > 0 ? quotes[0] : null;
    if (!quote) {
      throw new Error('AVNU raw: empty quotes response');
    }

    const buyAmountRaw = BigInt(quote.buyAmount || 0);
    const gasFeeRaw = BigInt(quote.gasFees || 0);
    return {
      quote,
      sellToken,
      buyToken,
      estimatedBuyRaw: buyAmountRaw,
      estimatedBuyAmount: unitsToTokenNumber(buyAmountRaw, buyTokenDecimals, 6),
      estimatedGasFee: unitsToTokenNumber(gasFeeRaw, DEFAULT_TOKEN_DECIMALS, 6),
      estimatedGasFeeStrk: unitsToTokenNumber(gasFeeRaw, DEFAULT_TOKEN_DECIMALS, 6),
      priceImpactBps: Number(quote.priceImpact || 0),
      estimatedSlippage: Number(quote.estimatedSlippage || 0),
    };
  }

  async planWbtcStakeRoute(amountWbtc, candidatePools = [], opts = {}) {
    const amount = Number(amountWbtc || 0)
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invalid WBTC stake amount')
    const maxSellAmount = Number(opts?.maxSellAmount || 0)
    const capSell = Number.isFinite(maxSellAmount) && maxSellAmount > 0 ? maxSellAmount : amount

    const candidates = (Array.isArray(candidatePools) ? candidatePools : [])
      .map((p) => ({
        poolAddress: this.normalizeAddress(p?.poolAddress),
        tokenAddress: this.normalizeAddress(p?.tokenAddress),
      }))
      .filter((p) => p.poolAddress && p.tokenAddress)
    if (candidates.length === 0) throw new Error('No AVNU staking pools available')

    const fromToken = this.normalizeAddress(SEPOLIA_SWAP_WBTC_TOKEN)
    const strkToken = this.normalizeAddress(PAYMENT_TOKEN_ADDRESS)
    // WBTC flow must never target STRK staking pools.
    const filteredCandidates = candidates.filter((c) => c.tokenAddress !== strkToken)
    if (filteredCandidates.length === 0) {
      this.lastAvnuRouteProbeErrors = ['AVNU staking info exposes STRK pool only on current network']
      return null
    }
    const multipliers = [1, 1.25, 1.5, 2, 3, 5, 8, 10]
    const plans = []
    const rawErrors = []
    const targetTolerance = amount * 0.995

    for (const candidate of filteredCandidates) {
      for (const mult of multipliers) {
        const sellAmount = Number(Math.min(capSell, amount * mult).toFixed(8))
        if (!Number.isFinite(sellAmount) || sellAmount <= 0) continue
        if (candidate.tokenAddress === fromToken) {
          plans.push({ kind: 'none', ...candidate, sellAmount, estimatedTargetAmount: sellAmount })
          continue
        }
        try {
          const direct = await this.getTokenSwapQuote(fromToken, candidate.tokenAddress, sellAmount)
          const out = Number(direct?.estimatedBuyAmount || 0)
          if (Number.isFinite(out) && out >= targetTolerance) {
            plans.push({ kind: 'direct', ...candidate, sellAmount, estimatedTargetAmount: out })
          }
        } catch (error) {
          rawErrors.push(String(error?.message || error || 'Unknown AVNU error'))
          if (!isNoSwapRouteError(error)) continue
        }
        try {
          const hop1 = await this.getTokenSwapQuote(fromToken, strkToken, sellAmount)
          const estimatedStrkAmount = Number(hop1?.estimatedBuyAmount || 0)
          if (!Number.isFinite(estimatedStrkAmount) || estimatedStrkAmount <= 0) continue
          const hop2 = await this.getTokenSwapQuote(strkToken, candidate.tokenAddress, estimatedStrkAmount)
          const estimatedTargetAmount = Number(hop2?.estimatedBuyAmount || 0)
          if (Number.isFinite(estimatedTargetAmount) && estimatedTargetAmount >= targetTolerance) {
            plans.push({
              kind: 'via-strk',
              ...candidate,
              sellAmount,
              estimatedStrkAmount,
              estimatedTargetAmount,
            })
          }
        } catch (error) {
          rawErrors.push(String(error?.message || error || 'Unknown AVNU error'))
          continue
        }
      }
    }

    this.lastAvnuRouteProbeErrors = rawErrors.slice(0, 10)
    if (plans.length === 0) return null
    plans.sort((a, b) => b.estimatedTargetAmount - a.estimatedTargetAmount)
    return plans[0]
  }

  async stakeWbtcViaAvnu(amountWbtc) {
    if (!IS_SEPOLIA) throw new Error('WBTC staking via AVNU is enabled on Sepolia only.')
    const amount = Number(amountWbtc || 0)
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invalid WBTC stake amount')

    const info = await this.getAvnuStakingInfoCached()
    const pools = Array.isArray(info?.delegationPools) ? info.delegationPools : []
    const availableSwapBalance = Number(
      await this.getTokenBalance(this.account.address, SEPOLIA_SWAP_WBTC_TOKEN).catch(() => 0),
    )
    if (!Number.isFinite(availableSwapBalance) || availableSwapBalance <= 0) {
      throw new Error('No WBTC swap balance available for staking bridge.')
    }
    if (amount > availableSwapBalance + 1e-12) {
      throw new Error(
        `Insufficient WBTC balance for stake amount. Requested ${amount.toFixed(8)} WBTC, ` +
        `available ${availableSwapBalance.toFixed(8)} WBTC.`,
      )
    }
    const route = await this.planWbtcStakeRoute(amount, pools, { maxSellAmount: availableSwapBalance })
    if (!route) {
      const raw = Array.isArray(this.lastAvnuRouteProbeErrors) && this.lastAvnuRouteProbeErrors.length > 0
        ? this.lastAvnuRouteProbeErrors.slice(0, 3).join(' | ')
        : 'AVNU returned no executable quote'
      throw new Error(
        `AVNU raw: ${raw}. Diagnostics: no viable WBTC staking route for ${amount.toFixed(8)} WBTC on current network.`,
      )
    }

    const fromToken = this.normalizeAddress(SEPOLIA_SWAP_WBTC_TOKEN)
    const strkToken = this.normalizeAddress(PAYMENT_TOKEN_ADDRESS)
    const targetToken = this.normalizeAddress(route.tokenAddress)
    if (targetToken === strkToken) {
      throw new Error('Invalid WBTC staking target: resolved STRK pool. Please retry later.')
    }
    const targetBeforeRaw = await this.getTokenBalanceRaw(this.account.address, targetToken).catch(() => 0n)
    let swappedTxHash = ''

    if (route.kind === 'none') {
      // Pool token already matches the wallet WBTC swap token.
    } else if (route.kind === 'direct') {
      const swapTx = await this.swapTokens(fromToken, targetToken, route.sellAmount, 1)
      swappedTxHash = String(swapTx?.transaction_hash || '')
    } else {
      const strkBeforeRaw = await this.getTokenBalanceRaw(this.account.address, strkToken).catch(() => 0n)
      const hop1 = await this.swapTokens(fromToken, strkToken, route.sellAmount, 1)
      swappedTxHash = String(hop1?.transaction_hash || '')
      const strkAfterRaw = await this.getTokenBalanceRaw(this.account.address, strkToken).catch(() => 0n)
      const bridgedStrkRaw = BigInt(strkAfterRaw || 0n) - BigInt(strkBeforeRaw || 0n)
      if (bridgedStrkRaw <= 0n) throw new Error('WBTC -> STRK bridge produced no spendable STRK.')
      const strkDecimals = await this.getTokenDecimals(strkToken).catch(() => 18)
      const bridgedStrkAmount = unitsToTokenNumber(bridgedStrkRaw, strkDecimals, 10)
      await this.swapTokens(strkToken, targetToken, bridgedStrkAmount, 1)
    }

    const targetAfterRaw = await this.getTokenBalanceRaw(this.account.address, targetToken).catch(() => 0n)
    let stakeRaw = 0n
    if (route.kind === 'none') {
      const targetDecimals = await this.getTokenDecimals(targetToken).catch(() => WBTC_TOKEN_DECIMALS)
      stakeRaw = parseAmountToUnits(amount, targetDecimals)
      if (stakeRaw <= 0n) throw new Error('Invalid stake amount after token conversion.')
      if (targetAfterRaw < stakeRaw) throw new Error('Insufficient staking token balance for requested WBTC amount.')
    } else {
      stakeRaw = BigInt(targetAfterRaw || 0n) - BigInt(targetBeforeRaw || 0n)
      if (stakeRaw <= 0n) throw new Error('No staking pool token received after AVNU conversion.')
    }

    const stakeResult = await executeStake({
      provider: this.account,
      poolAddress: route.poolAddress,
      amount: stakeRaw,
    }, AVNU_OPTIONS)
    const stakingTxHash = String(stakeResult?.transactionHash || stakeResult?.transaction_hash || '').trim()
    if (!stakingTxHash) throw new Error('AVNU stake submitted but transaction hash was not returned')
    const receipt = await this.account.waitForTransaction(stakingTxHash)
    if (!isTxReceiptSuccessful(receipt)) {
      const reason = receipt?.revert_reason || receipt?.revertReason || 'AVNU stake reverted'
      throw new Error(reason)
    }

    return {
      transaction_hash: stakingTxHash,
      poolAddress: route.poolAddress,
      tokenAddress: route.tokenAddress,
      routeKind: route.kind,
      bridgeSellAmount: route.sellAmount,
      bridgeTxHash: swappedTxHash,
    }
  }

  async unstakeStrkViaAvnu() {
    if (!IS_SEPOLIA) throw new Error('AVNU STRK unstake is enabled on Sepolia only.')
    const strkToken = this.normalizeAddress(PAYMENT_TOKEN_ADDRESS)
    const userAddr = this.normalizeAddress(this.account?.address)
    if (!strkToken || !userAddr || strkToken === '0x0' || userAddr === '0x0') {
      throw new Error('Invalid wallet/token context for AVNU unstake.')
    }

    const info = await this.getAvnuUserStakingByToken(strkToken, userAddr, true)
    const poolAddress = this.normalizeAddress(info?.poolAddress)
    if (!poolAddress || poolAddress === '0x0') throw new Error('No active STRK staking pool found for this wallet.')

    const amountRaw = BigInt(info?.amountRaw || 0n)
    const unpoolRaw = BigInt(info?.unpoolRaw || 0n)
    const baseInfo = await getUserStakingInfo(strkToken, userAddr, AVNU_OPTIONS).catch(() => null)
    const unpoolTimeMs = baseInfo?.unpoolTime ? new Date(baseInfo.unpoolTime).getTime() : 0
    const nowMs = Date.now()

    if (amountRaw > 0n) {
      const tx = await executeInitiateUnstake({
        provider: this.account,
        poolAddress,
        amount: amountRaw,
      }, AVNU_OPTIONS)
      const txHash = String(tx?.transactionHash || tx?.transaction_hash || '').trim()
      if (!txHash) throw new Error('AVNU unstake intent submitted but tx hash was not returned')
      const receipt = await this.account.waitForTransaction(txHash)
      if (!isTxReceiptSuccessful(receipt)) {
        const reason = receipt?.revert_reason || receipt?.revertReason || 'AVNU unstake intent reverted'
        throw new Error(reason)
      }
      return { action: 'intent', txHash, poolAddress, amountRaw, unpoolTimeMs }
    }

    if (unpoolRaw > 0n) {
      if (unpoolTimeMs > nowMs) {
        return { action: 'pending', txHash: '', poolAddress, amountRaw: unpoolRaw, unpoolTimeMs }
      }
      const tx = await executeUnstake({
        provider: this.account,
        poolAddress,
      }, AVNU_OPTIONS)
      const txHash = String(tx?.transactionHash || tx?.transaction_hash || '').trim()
      if (!txHash) throw new Error('AVNU unstake exit submitted but tx hash was not returned')
      const receipt = await this.account.waitForTransaction(txHash)
      if (!isTxReceiptSuccessful(receipt)) {
        const reason = receipt?.revert_reason || receipt?.revertReason || 'AVNU unstake exit reverted'
        throw new Error(reason)
      }
      return { action: 'exit', txHash, poolAddress, amountRaw: unpoolRaw, unpoolTimeMs }
    }

    throw new Error('No staked or unpooling STRK position found in AVNU.')
  }

  /**
   * Create a post on-chain
   * @param {string} imageUrl - URL of the image
   * @param {string} caption - Post caption
   * @param {string} creatorUsername - Username of the creator
   * @param {number} xPosition - X coordinate
   * @param {number} yPosition - Y coordinate
   * @param {number} size - Post size (1 = free, 2+ = paid)
   * @param {boolean} isPaid - Whether it's a paid post
   * @returns {Promise<number>} - The ID of the created post
   */
  async createPost(imageUrl, caption, creatorUsername, xPosition, yPosition, size, isPaid) {
    console.log('📝 Creating post with params:', {
      imageUrl,
      caption,
      creatorUsername,
      xPosition,
      yPosition,
      size,
      isPaid
    });

    // Convert strings to ByteArray format for Cairo
    const imageUrlBytes = stringToByteArray(imageUrl);
    const captionBytes = stringToByteArray(caption);
    const usernameBytes = stringToByteArray(creatorUsername);

    console.log('📦 Converted calldata:', {
      imageUrlBytes,
      captionBytes,
      usernameBytes,
      contractAddress: this.actionsContract.address
    });

    const calldata = [
      ...imageUrlBytes,
      ...captionBytes,
      ...usernameBytes,
      xPosition,
      yPosition,
      size, // Tamaño del post (1, 2, 3, 4...)
      isPaid ? 1 : 0,
    ];

    console.log('🚀 Executing transaction with calldata length:', calldata.length);

    try {
      const tokenAddr = PAYMENT_TOKEN_ADDRESS;
      const shouldChargePaidPost = Boolean(isPaid) && Number(size) >= 2;

      if (shouldChargePaidPost) {
        console.log('💸 Paid post price (STRK):', getPaidPostPrice(Number(size)));
      }

      // Paid post: atomic multicall (charge -> create post)
      const tx = shouldChargePaidPost
        ? await (() => {
            const priceInStrk = getPaidPostPrice(Number(size));
            const amountWei = BigInt(priceInStrk) * ONE_STRK;
            const { low, high } = feltToU256(amountWei);
            return this.account.execute([
              {
                contractAddress: tokenAddr,
                entrypoint: 'approve',
                // Contract enforces payment via transfer_from inside create_post.
                calldata: [this.actionsContract.address, low, high],
              },
              {
                contractAddress: this.actionsContract.address,
                entrypoint: 'create_post',
                calldata,
              },
            ]);
          })()
        : await this.account.execute({
            contractAddress: this.actionsContract.address,
            entrypoint: 'create_post',
            calldata,
          });

      console.log('✅ Transaction sent:', tx.transaction_hash);

      // Wait for transaction to be accepted
      console.log('⏳ Waiting for transaction confirmation...');
      const receipt = await this.account.waitForTransaction(tx.transaction_hash);
      console.log('✅ Transaction receipt:', receipt);

      if (!isTxReceiptSuccessful(receipt)) {
        const reason = receipt?.revert_reason || receipt?.revertReason || 'Transaction reverted';
        throw new Error(reason);
      }

      console.log('✅ Transaction confirmed!');
      return tx;
    } catch (error) {
      console.error('❌ Transaction failed:', error);
      throw error;
    }
  }

  async getPostCounter() {
    // Fast path via Torii GraphQL (works even when SDK entity envelopes lag).
    try {
      const endpoint = String(TORII_URL || '').replace(/\/+$/, '') + '/graphql'
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: 'query { diPostCounterModels(limit: 1) { edges { node { count } } } }',
        }),
      })
      if (res.ok) {
        const data = await res.json()
        const countRaw = data?.data?.diPostCounterModels?.edges?.[0]?.node?.count
        if (countRaw !== undefined && countRaw !== null) {
          return Number(BigInt(String(countRaw)))
        }
      }
    } catch {}

    // Fallback path via SDK entities.
    try {
      const resp = await this.toriiClient.getEntities({
        query: new ToriiQueryBuilder()
          .withClause(KeysClause(['di-PostCounter'], [], 'VariableLen').build()),
      })
      const item = (resp?.items || [])[0]
      const model = item?.models?.di?.PostCounter
      const countRaw = model?.count ?? 0
      return Number(BigInt(String(countRaw)))
    } catch {
      return 0
    }
  }

  async createAuctionPost3x3(imageUrl, caption, creatorUsername, centerX, centerY, endTimeUnix) {
    const imageUrlBytes = stringToByteArray(imageUrl || '');
    const captionBytes = stringToByteArray(caption || '');
    const usernameBytes = stringToByteArray(creatorUsername || '');

    const calldata = [
      ...imageUrlBytes,
      ...captionBytes,
      ...usernameBytes,
      centerX,
      centerY,
      Number(endTimeUnix),
    ];

    const amountWei = BigInt(AUCTION_POST_CREATION_FEE_STRK) * ONE_STRK;
    const { low, high } = feltToU256(amountWei);

    const calls = [
      {
        contractAddress: PAYMENT_TOKEN_ADDRESS,
        entrypoint: 'approve',
        calldata: [this.actionsContract.address, low, high],
      },
      {
        contractAddress: this.actionsContract.address,
        entrypoint: 'create_auction_post_3x3',
        calldata,
      },
    ]
    let tx
    try {
      tx = await executeWithL2GasFallback(this.account, calls)
    } catch (error) {
      if (!isInsufficientMaxL2GasError(error)) throw error
      // Last resort: split approval and creation to reduce peak tx complexity.
      const approveTx = await executeWithL2GasFallback(this.account, {
        contractAddress: PAYMENT_TOKEN_ADDRESS,
        entrypoint: 'approve',
        calldata: [this.actionsContract.address, low, high],
      })
      await waitOrThrow(this.account, approveTx, 'Approve transaction reverted')
      tx = await executeWithL2GasFallback(this.account, {
        contractAddress: this.actionsContract.address,
        entrypoint: 'create_auction_post_3x3',
        calldata,
      })
    }
    await waitOrThrow(this.account, tx, 'Create auction transaction reverted')

    return tx;
  }

  async createAuctionPost3x3Sealed(
    imageUrl,
    caption,
    creatorUsername,
    centerX,
    centerY,
    commitEndTimeUnix,
    revealEndTimeUnix,
    verifierAddress,
  ) {
    const supportsSplitConfig = await this.supportsConfigureSealedEntrypoint().catch(() => false)
    if (supportsSplitConfig) {
      const expectedGroupId = Number(await this.getPostCounter().catch(() => 0)) + 1
      const createTx = await this.createAuctionPost3x3(
        imageUrl,
        caption,
        creatorUsername,
        centerX,
        centerY,
        Number(revealEndTimeUnix),
      )
      await this.configureAuctionSealed(
        expectedGroupId,
        Number(commitEndTimeUnix),
        Number(revealEndTimeUnix),
        verifierAddress,
      )
      return createTx
    }

    const imageUrlBytes = stringToByteArray(imageUrl || '')
    const captionBytes = stringToByteArray(caption || '')
    const usernameBytes = stringToByteArray(creatorUsername || '')
    const verifier = String(verifierAddress || '').trim()
    if (!verifier || !verifier.startsWith('0x')) throw new Error('Invalid verifier address')

    const calldata = [
      ...imageUrlBytes,
      ...captionBytes,
      ...usernameBytes,
      centerX,
      centerY,
      Number(commitEndTimeUnix),
      Number(revealEndTimeUnix),
      verifier,
    ]

    const amountWei = BigInt(AUCTION_POST_CREATION_FEE_STRK) * ONE_STRK
    const { low, high } = feltToU256(amountWei)
    const calls = [
      {
        contractAddress: PAYMENT_TOKEN_ADDRESS,
        entrypoint: 'approve',
        calldata: [this.actionsContract.address, low, high],
      },
      {
        contractAddress: this.actionsContract.address,
        entrypoint: 'create_auction_post_3x3_sealed',
        calldata,
      },
    ]
    let tx
    try {
      tx = await executeWithL2GasFallback(this.account, calls)
    } catch (error) {
      if (!isInsufficientMaxL2GasError(error)) throw error
      // Last resort: split approval and creation to reduce peak tx complexity.
      const approveTx = await executeWithL2GasFallback(this.account, {
        contractAddress: PAYMENT_TOKEN_ADDRESS,
        entrypoint: 'approve',
        calldata: [this.actionsContract.address, low, high],
      })
      await waitOrThrow(this.account, approveTx, 'Approve transaction reverted')
      tx = await executeWithL2GasFallback(this.account, {
        contractAddress: this.actionsContract.address,
        entrypoint: 'create_auction_post_3x3_sealed',
        calldata,
      })
    }
    await waitOrThrow(this.account, tx, 'Create sealed auction transaction reverted')

    return tx
  }

  async configureAuctionSealed(groupId, commitEndTimeUnix, revealEndTimeUnix, verifierAddress) {
    const verifier = String(verifierAddress || '').trim()
    if (!verifier || !verifier.startsWith('0x')) throw new Error('Invalid verifier address')
    const tx = await this.account.execute({
      contractAddress: this.actionsContract.address,
      entrypoint: 'configure_auction_sealed',
      calldata: [
        Number(groupId),
        Number(commitEndTimeUnix),
        Number(revealEndTimeUnix),
        verifier,
      ],
    })
    await waitOrThrow(this.account, tx, 'Configure sealed auction transaction reverted')
    return tx
  }

  async placeAuctionBid(slotPostId, bidAmountStrk) {
    const tokenAddr = PAYMENT_TOKEN_ADDRESS;
    if (!tokenAddr) throw new Error('No token configured.');

    const amountStrk = Number(bidAmountStrk);
    if (!Number.isFinite(amountStrk) || amountStrk <= 0) throw new Error('Invalid bid amount');
    const slotId = Number(slotPostId);
    if (!Number.isFinite(slotId) || slotId <= 0) throw new Error('Invalid slot');

    // Client-side guard so creators cannot bid even before contract upgrades are deployed.
    const posts = await this.queryAllPosts().catch(() => []);
    const safePosts = Array.isArray(posts) ? posts.filter(Boolean) : [];
    const slotPost = safePosts.find((p) => Number(p?.id ?? 0) === slotId);
    const caller = this.normalizeAddress(this.account?.address || '');
    const creator = this.normalizeAddress(slotPost?.auction_group?.creator || '');
    const owner = this.normalizeAddress(slotPost?.current_owner || '');
    if ((creator && caller === creator) || (owner && caller === owner)) {
      throw new Error('Creator cannot bid in own auction');
    }

    const amountWei = BigInt(Math.floor(amountStrk)) * ONE_STRK;
    const { low, high } = feltToU256(amountWei);

    const calls = [
      {
        contractAddress: tokenAddr,
        entrypoint: 'approve',
        calldata: [this.actionsContract.address, low, high],
      },
      {
        contractAddress: this.actionsContract.address,
        entrypoint: 'place_bid',
        calldata: [slotId, Math.floor(amountStrk)],
      },
    ];

    const tx = await this.account.execute(calls);
    const receipt = await this.account.waitForTransaction(tx.transaction_hash);

    if (!isTxReceiptSuccessful(receipt)) {
      const reason = receipt?.revert_reason || receipt?.revertReason || 'Bid transaction reverted';
      throw new Error(reason);
    }

    return tx;
  }

  async commitAuctionBid(slotPostId, bidAmountStrk, saltFelt, escrowAmountStrk = bidAmountStrk) {
    const amount = Number(bidAmountStrk)
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invalid bid amount')
    const escrowAmount = Number(escrowAmountStrk)
    if (!Number.isFinite(escrowAmount) || escrowAmount <= 0) throw new Error('Invalid escrow amount')
    if (escrowAmount < amount) throw new Error('Escrow must cover sealed bid amount')
    const slotId = Number(slotPostId)
    if (!Number.isFinite(slotId) || slotId <= 0) throw new Error('Invalid slot')
    const posts = await this.queryAllPosts().catch(() => [])
    const safePosts = Array.isArray(posts) ? posts.filter(Boolean) : []
    const slotPost = safePosts.find((p) => Number(p?.id ?? 0) === slotId)
    const caller = this.normalizeAddress(this.account?.address || '')
    const creator = this.normalizeAddress(slotPost?.auction_group?.creator || '')
    const owner = this.normalizeAddress(slotPost?.current_owner || '')
    if ((creator && caller === creator) || (owner && caller === owner)) {
      throw new Error('Creator cannot bid in own auction')
    }
    const groupId = Number(slotPost?.auction_group_id || slotPost?.auction_slot?.group_id || 0)
    if (!groupId) {
      throw new Error('Cannot resolve auction group for slot (indexer not ready yet). Reopen slot and retry in a few seconds.')
    }
    const commitment = simpleCommitment(slotId, groupId, this.account.address, Math.floor(amount), saltFelt)

    const amountWei = BigInt(Math.floor(escrowAmount)) * ONE_STRK
    const { low, high } = feltToU256(amountWei)
    const tx = await this.account.execute([
      {
        contractAddress: PAYMENT_TOKEN_ADDRESS,
        entrypoint: 'approve',
        calldata: [this.actionsContract.address, low, high],
      },
      {
        contractAddress: this.actionsContract.address,
        entrypoint: 'commit_bid',
        calldata: [slotId, commitment, Math.floor(escrowAmount)],
      },
    ])
    const receipt = await this.account.waitForTransaction(tx.transaction_hash)
    if (!isTxReceiptSuccessful(receipt)) {
      const reason = receipt?.revert_reason || receipt?.revertReason || 'Commit bid transaction reverted'
      throw new Error(reason)
    }
    return {
      tx,
      commitment,
      slotId,
      groupId,
      bidAmount: Math.floor(amount),
      escrowAmount: Math.floor(escrowAmount),
    }
  }

  async revealAuctionBidWithProof(slotPostId, bidderAddress, bidAmountStrk, saltFelt, fullProofWithHints = ['0x1']) {
    const amount = Number(bidAmountStrk)
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('Invalid bid amount')
    const slotId = Number(slotPostId)
    if (!Number.isFinite(slotId) || slotId <= 0) throw new Error('Invalid slot')
    const bidder = String(bidderAddress || '').trim()
    if (!bidder || !bidder.startsWith('0x')) throw new Error('Invalid bidder address')
    const proof = Array.isArray(fullProofWithHints)
      ? fullProofWithHints.map((v) => String(v))
      : [String(fullProofWithHints || '0x1')]
    if (!proof.length) throw new Error('Missing proof calldata')
    const tx = await this.account.execute({
      contractAddress: this.actionsContract.address,
      entrypoint: 'reveal_bid',
      calldata: [slotId, bidder, Math.floor(amount), String(saltFelt), proof.length, ...proof],
    })
    const receipt = await this.account.waitForTransaction(tx.transaction_hash)
    if (!isTxReceiptSuccessful(receipt)) {
      const reason = receipt?.revert_reason || receipt?.revertReason || 'Reveal bid transaction reverted'
      throw new Error(reason)
    }
    return tx
  }

  async claimAuctionCommitRefund(slotPostId) {
    const slotId = Number(slotPostId)
    if (!Number.isFinite(slotId) || slotId <= 0) throw new Error('Invalid slot')
    const bidder = String(this.account?.address || '').trim()
    if (!bidder || !bidder.startsWith('0x')) throw new Error('Invalid bidder account')
    try {
      // Preferred ABI (new): explicit bidder allows third-party automation.
      const tx = await this.account.execute({
        contractAddress: this.actionsContract.address,
        entrypoint: 'claim_commit_refund',
        calldata: [slotId, bidder],
      })
      const receipt = await this.account.waitForTransaction(tx.transaction_hash)
      if (!isTxReceiptSuccessful(receipt)) {
        const reason = receipt?.revert_reason || receipt?.revertReason || 'Claim refund transaction reverted'
        throw new Error(reason)
      }
      return tx
    } catch (error) {
      const message = String(error?.message || '')
      // Backward compatibility with already-deployed ABI using single slot_post_id param.
      const maybeArgMismatch = message.toLowerCase().includes('input') || message.toLowerCase().includes('calldata')
      if (!maybeArgMismatch) throw error
      const tx = await this.account.execute({
        contractAddress: this.actionsContract.address,
        entrypoint: 'claim_commit_refund',
        calldata: [slotId],
      })
      const receipt = await this.account.waitForTransaction(tx.transaction_hash)
      if (!isTxReceiptSuccessful(receipt)) {
        const reason = receipt?.revert_reason || receipt?.revertReason || 'Claim refund transaction reverted'
        throw new Error(reason)
      }
      return tx
    }
  }

  async checkSealedVerifierCompatibility(verifierAddress) {
    const contractAddress = this.normalizeAddress(verifierAddress)
    if (!contractAddress) {
      return { ok: false, reason: 'Missing verifier address' }
    }

    // Probe #1: basic ABI shape check.
    // verify_sealed_bid(slot_post_id, group_id, bidder, bid_amount, salt, commitment, full_proof_with_hints)
    // We intentionally send a wrong commitment so compatible contracts can return false early.
    const bidder = this.normalizeAddress(this.account?.address || '0x1')
    const basicCalldata = [1, 1, bidder, 1, '0x1', '0x0', 0]

    try {
      let result
      try {
        result = await this.balanceProvider.callContract({
          contractAddress,
          entrypoint: 'verify_sealed_bid',
          calldata: basicCalldata,
        }, 'latest')
      } catch {
        result = await this.balanceProvider.callContract({
          contractAddress,
          entrypoint: 'verify_sealed_bid',
          calldata: basicCalldata,
        })
      }
      const parts = Array.isArray(result) ? result : (result?.result || [])
      const normalized = String(parts?.[0] ?? '0')

      // Probe #2: stress proof span length enough to catch known incompatible verifier ABI.
      // Older verifier contracts revert with "Input too long for arguments" here.
      const slotPostId = '0x1'
      const groupId = '0x1'
      const bidAmount = '0x1'
      const salt = '0x1'
      const commitment = hash.computePoseidonHashOnElements([slotPostId, groupId, bidder, bidAmount, salt])
      const proofLen = 64
      const dummyProof = Array(proofLen).fill('0x0')
      const stressCalldata = [
        slotPostId,
        groupId,
        bidder,
        bidAmount,
        salt,
        commitment,
        `0x${proofLen.toString(16)}`,
        ...dummyProof,
      ]
      try {
        await this.balanceProvider.callContract({
          contractAddress,
          entrypoint: 'verify_sealed_bid',
          calldata: stressCalldata,
        }, 'latest')
      } catch (stressError) {
        const stressMessage = String(stressError?.message || stressError || '')
        if (stressMessage.toLowerCase().includes('input too long for arguments')) {
          return {
            ok: false,
            reason: 'Incompatible verifier contract for current sealed proof format.',
            error: stressMessage,
          }
        }
      }

      return { ok: true, result: normalized }
    } catch (error) {
      const message = String(error?.message || error || '')
      const lower = message.toLowerCase()
      if (lower.includes('entrypoint') || lower.includes('input too long for arguments')) {
        return {
          ok: false,
          reason: 'Incompatible verifier contract. This address does not match current sealed proof ABI.',
          error: message,
        }
      }
      return { ok: false, reason: 'Verifier probe failed', error: message }
    }
  }

  async finalizeAuctionSlot(slotPostId) {
    const tx = await this.account.execute({
      contractAddress: this.actionsContract.address,
      entrypoint: 'finalize_auction_slot',
      calldata: [slotPostId],
    });

    const receipt = await this.account.waitForTransaction(tx.transaction_hash);
    if (!isTxReceiptSuccessful(receipt)) {
      const reason = receipt?.revert_reason || receipt?.revertReason || 'Finalize auction transaction reverted';
      throw new Error(reason);
    }

    return tx;
  }

  async setWonSlotContent(slotPostId, imageUrl, caption) {
    const imageUrlBytes = stringToByteArray(imageUrl || '');
    const captionBytes = stringToByteArray(caption || '');

    const tx = await this.account.execute({
      contractAddress: this.actionsContract.address,
      entrypoint: 'set_won_slot_content',
      calldata: [slotPostId, ...imageUrlBytes, ...captionBytes],
    });

    const receipt = await this.account.waitForTransaction(tx.transaction_hash);
    if (!isTxReceiptSuccessful(receipt)) {
      const reason = receipt?.revert_reason || receipt?.revertReason || 'Set slot content transaction reverted';
      throw new Error(reason);
    }

    return tx;
  }

  /**
   * Query all posts from Torii
   * @returns {Promise<Array>} - Array of post objects
   */
  async queryAllPosts() {
    try {
      const getWithTimeout = async (query, label, ms = 18000) => {
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
        });
        return Promise.race([
          this.toriiClient.getEntities({ query }),
          timeoutPromise,
        ]);
      };

      // Torii responses are paginated; without cursor paging, older posts vanish from UI
      // once total entities exceed the default page size.
      const getAllEntities = async (buildQuery, label, pageLimit = 200, maxPages = 100) => {
        const items = [];
        let cursor = null;

        for (let page = 0; page < maxPages; page++) {
          let query = buildQuery().withLimit(pageLimit);
          if (cursor) query = query.withCursor(String(cursor));
          const resp = await getWithTimeout(query, `${label} page ${page + 1}`);
          const pageItems = Array.isArray(resp?.items) ? resp.items : [];
          items.push(...pageItems);

          const nextCursor = resp?.nextCursor ?? resp?.next_cursor ?? null;
          if (!nextCursor || nextCursor === cursor || pageItems.length === 0) break;
          cursor = nextCursor;
        }

        return { items };
      };

      const entities = await getAllEntities(
        () => new ToriiQueryBuilder().withClause(KeysClause(['di-Post'], [], 'VariableLen').build()),
        'Post query',
      );
      
      if (!entities || !entities.items || entities.items.length === 0) {
        console.log('⚠️ No Post entities found');
        return [];
      }

      // Query auction models too; they are not guaranteed to be included in Post envelopes.
      const [slotEntities, groupEntities, sealedCfgEntities, commitEntities] = await Promise.all([
        getAllEntities(
          () => new ToriiQueryBuilder().withClause(KeysClause(['di-AuctionSlot'], [], 'VariableLen').build()),
          'AuctionSlot query',
        ).catch((e) => {
          console.warn('⚠️ AuctionSlot query failed:', e?.message || e);
          return { items: [] };
        }),
        getAllEntities(
          () => new ToriiQueryBuilder().withClause(KeysClause(['di-AuctionGroup'], [], 'VariableLen').build()),
          'AuctionGroup query',
        ).catch((e) => {
          console.warn('⚠️ AuctionGroup query failed:', e?.message || e);
          return { items: [] };
        }),
        getAllEntities(
          () => new ToriiQueryBuilder().withClause(KeysClause(['di-AuctionSealedConfig'], [], 'VariableLen').build()),
          'AuctionSealedConfig query',
        ).catch(() => ({ items: [] })),
        getAllEntities(
          () => new ToriiQueryBuilder().withClause(KeysClause(['di-AuctionCommit'], [], 'VariableLen').build()),
          'AuctionCommit query',
        ).catch(() => ({ items: [] })),
      ]);

      const slotItems = slotEntities?.items || [];
      const groupItems = groupEntities?.items || [];
      const sealedCfgItems = sealedCfgEntities?.items || [];
      const commitItems = commitEntities?.items || [];

      const mergedItems = [...entities.items, ...slotItems, ...groupItems, ...sealedCfgItems, ...commitItems];
      const sdkPosts = this.parseSDKEntities(mergedItems);
      let posts = sdkPosts;

      // Browser-dependent SDK pagination/indexer lag can hide older posts.
      // Merge with direct GraphQL snapshot for stable cross-browser visibility.
      const gqlPosts = await this.fetchPostModelsViaGraphQL().catch(() => []);
      if (Array.isArray(gqlPosts) && gqlPosts.length > 0) {
        posts = this.mergePostSnapshots(sdkPosts, gqlPosts);
      }

      const expectedCount = await this.getPostCounter().catch(() => 0);
      if (expectedCount > 0 && posts.length < expectedCount && Array.isArray(gqlPosts) && gqlPosts.length >= posts.length) {
        posts = this.mergePostSnapshots(posts, gqlPosts);
      }

      console.log(`✅ Parsed ${posts.length} posts`);
      return posts;
    } catch (error) {
      console.error('❌ Error querying posts:', error?.message || error);
      return [];
    }
  }

  async fetchPostModelsViaGraphQL(limit = 2000) {
    const endpoint = String(TORII_URL || '').replace(/\/+$/, '') + '/graphql';
    const query = `
      query GetPosts($limit: Int!) {
        diPostModels(first: $limit, order: { field: ID, direction: ASC }) {
          edges {
            node {
              id
              image_url
              caption
              x_position
              y_position
              size
              is_paid
              created_at
              created_by
              creator_username
              current_owner
              sale_price
              post_kind
              auction_group_id
              auction_slot_index
            }
          }
        }
      }
    `;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { limit } }),
    });
    if (!res.ok) throw new Error(`GraphQL posts fetch failed (${res.status})`);
    const body = await res.json();
    const edges = body?.data?.diPostModels?.edges || [];
    return edges
      .map((e) => e?.node || null)
      .filter(Boolean)
      .map((node) => {
        let salePrice = 0;
        const rawPrice = node.sale_price;
        if (typeof rawPrice === 'object' && rawPrice !== null) {
          if ('low' in rawPrice) salePrice = Number(rawPrice.low || 0);
          else if ('0' in rawPrice) salePrice = Number(rawPrice['0'] || 0);
        } else {
          salePrice = Number(rawPrice || 0);
        }

        const createdAtUnix = Number(node.created_at || 0);
        return {
          id: Number(node.id || 0),
          image_url: typeof node.image_url === 'string' ? node.image_url : this.byteArrayToString(node.image_url),
          caption: typeof node.caption === 'string' ? node.caption : this.byteArrayToString(node.caption),
          x_position: Number(node.x_position || 0),
          y_position: Number(node.y_position || 0),
          size: Number(node.size || 1),
          is_paid: Boolean(node.is_paid),
          created_at: createdAtUnix > 0 ? new Date(createdAtUnix * 1000).toISOString() : new Date(0).toISOString(),
          created_by: node.created_by || null,
          creator_username: typeof node.creator_username === 'string'
            ? node.creator_username
            : this.byteArrayToString(node.creator_username),
          current_owner: node.current_owner || null,
          sale_price: Number.isFinite(salePrice) ? salePrice : 0,
          post_kind: Number(node.post_kind ?? 0),
          auction_group_id: Number(node.auction_group_id ?? 0),
          auction_slot_index: Number(node.auction_slot_index ?? 0),
        };
      })
      .filter((p) => Number(p.id || 0) > 0);
  }

  mergePostSnapshots(primaryPosts = [], fallbackPosts = []) {
    const map = new Map();
    for (const post of (Array.isArray(primaryPosts) ? primaryPosts : [])) {
      const id = Number(post?.id || 0);
      if (!id) continue;
      map.set(id, post);
    }

    for (const post of (Array.isArray(fallbackPosts) ? fallbackPosts : [])) {
      const id = Number(post?.id || 0);
      if (!id) continue;
      const prev = map.get(id) || {};
      map.set(id, { ...prev, ...post });
    }

    return [...map.values()].sort((a, b) => Number(a.id || 0) - Number(b.id || 0));
  }

  /**
   * Parse post entities from SDK response (entities.items)
   * @param {Array} items - Array of entity items from SDK
   * @returns {Array} - Parsed post objects
   */
  parseSDKEntities(items) {
    const posts = [];
    const slotByPostId = new Map();
    const groupById = new Map();
    const sealedConfigByGroupId = new Map();
    const commitsBySlotPostId = new Map();

    // First pass: collect AuctionSlot and AuctionGroup models from entity envelopes.
    items.forEach((entity) => {
      const slot = entity.models?.di?.AuctionSlot;
      if (slot) {
        const slotPostId = Number(slot.slot_post_id ?? slot.slotPostId ?? slot.slot_post ?? 0);
        if (slotPostId > 0) {
          slotByPostId.set(slotPostId, {
            slot_post_id: slotPostId,
            group_id: Number(slot.group_id ?? 0),
            highest_bid: Number(slot.highest_bid ?? 0),
            highest_bidder: slot.highest_bidder || null,
            has_bid: Boolean(slot.has_bid),
            finalized: Boolean(slot.finalized),
            content_initialized: Boolean(slot.content_initialized),
          });
        }
      }

      const group = entity.models?.di?.AuctionGroup;
      if (group) {
        const groupId = Number(group.group_id ?? 0);
        if (groupId > 0) {
          groupById.set(groupId, {
            group_id: groupId,
            center_post_id: Number(group.center_post_id ?? 0),
            creator: group.creator || null,
            end_time: Number(group.end_time ?? 0),
            active: Boolean(group.active),
          });
        }
      }

      const sealedCfg = entity.models?.di?.AuctionSealedConfig;
      if (sealedCfg) {
        const groupId = Number(sealedCfg.group_id ?? 0)
        if (groupId > 0) {
          sealedConfigByGroupId.set(groupId, {
            group_id: groupId,
            sealed_mode: Boolean(sealedCfg.sealed_mode),
            commit_end_time: Number(sealedCfg.commit_end_time ?? 0),
            reveal_end_time: Number(sealedCfg.reveal_end_time ?? 0),
            verifier: sealedCfg.verifier || null,
          })
        }
      }

      const commit = entity.models?.di?.AuctionCommit;
      if (commit) {
        const slotPostId = Number(commit.slot_post_id ?? commit.slotPostId ?? 0);
        if (slotPostId > 0) {
          if (!commitsBySlotPostId.has(slotPostId)) commitsBySlotPostId.set(slotPostId, []);
          commitsBySlotPostId.get(slotPostId).push({
            slot_post_id: slotPostId,
            bidder: normalizeHexAddress(commit.bidder),
            commitment: String(commit.commitment || '0x0'),
            escrow_amount: Number(commit.escrow_amount ?? 0),
            committed_at: Number(commit.committed_at ?? 0),
            revealed: Boolean(commit.revealed),
            revealed_bid: Number(commit.revealed_bid ?? 0),
            refunded: Boolean(commit.refunded),
          });
        }
      }
    });

    // Second pass: parse Post models and attach auction metadata.
    items.forEach((entity) => {
      const postData = entity.models?.di?.Post;
      if (!postData) return;

      let salePrice = 0;
      if (postData.sale_price !== undefined && postData.sale_price !== null) {
        const rawPrice = postData.sale_price;
        if (typeof rawPrice === 'object' && rawPrice !== null) {
          if ('low' in rawPrice) salePrice = Number(rawPrice.low);
          else if ('0' in rawPrice) salePrice = Number(rawPrice['0']);
        } else {
          salePrice = Number(rawPrice);
        }
      }

      const postId = Number(postData.id);
      const postKind = Number(postData.post_kind ?? POST_KIND_NORMAL);
      const auctionGroupId = Number(postData.auction_group_id ?? 0);
      const auctionSlotIndex = Number(postData.auction_slot_index ?? 0);

      const slot = slotByPostId.get(postId) || null;
      const group = auctionGroupId > 0 ? (groupById.get(auctionGroupId) || null) : null;
      const sealedConfig = auctionGroupId > 0 ? (sealedConfigByGroupId.get(auctionGroupId) || null) : null;
      const slotCommits = commitsBySlotPostId.get(postId) || [];

      posts.push({
        id: postId,
        image_url: this.byteArrayToString(postData.image_url),
        caption: this.byteArrayToString(postData.caption),
        x_position: Number(postData.x_position),
        y_position: Number(postData.y_position),
        size: Number(postData.size || 1),
        is_paid: Boolean(postData.is_paid),
        created_at: new Date(Number(postData.created_at) * 1000).toISOString(),
        created_by: postData.created_by,
        creator_username: this.byteArrayToString(postData.creator_username),
        current_owner: postData.current_owner,
        sale_price: salePrice,
        post_kind: postKind,
        auction_group_id: auctionGroupId,
        auction_slot_index: auctionSlotIndex,
        auction_slot: slot,
        auction_group: group,
        auction_sealed_config: sealedConfig,
        auction_commits: slotCommits,
      });
    });

    return posts;
  }

  /**
   * Convert ByteArray from Cairo to JavaScript string
   * @param {Object} byteArray - ByteArray object from Cairo
   * @returns {string} - Converted string
   */
  byteArrayToString(byteArray) {
    if (typeof byteArray === 'string') return byteArray;
    if (!byteArray?.data) return '';
    
    // ByteArray format: { data: [u256, ...], pending_word: u256, pending_word_len: u32 }
    let str = '';
    
    // Process full words (31 bytes each)
    for (const word of byteArray.data) {
      const bytes = this.u256ToBytes(word);
      str += new TextDecoder().decode(bytes);
    }
    
    // Process pending word if exists
    if (byteArray.pending_word_len > 0) {
      const pendingBytes = this.u256ToBytes(byteArray.pending_word).slice(0, byteArray.pending_word_len);
      str += new TextDecoder().decode(pendingBytes);
    }
    
    return str;
  }

  /**
   * Convert u256 to bytes
   * @param {string|number} u256 - u256 value
   * @returns {Uint8Array} - Byte array
   */
  u256ToBytes(u256) {
    const hex = BigInt(u256).toString(16).padStart(62, '0'); // 31 bytes = 62 hex chars
    const bytes = new Uint8Array(31);
    
    for (let i = 0; i < 31; i++) {
      bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    
    return bytes;
  }

  /**
   * Set the sale price for a post
   * @param {number} postId - ID of the post
   * @param {number} price - Price in wei (0 to remove from sale)
   * @returns {Promise} - Transaction result
   */
  async setPostPrice(postId, price) {
    console.log('💰 Setting post price:', { postId, price });
    
    // Try passing u128 as a single value (Cairo might handle it automatically)
    const calldata = [postId, price];
    console.log('📤 Sending calldata (trying single u128 value):', calldata);
    console.log('📤 Contract address:', this.actionsContract.address);
    console.log('📤 Entrypoint:', 'set_post_price');

    try {
      const tx = await this.account.execute({
        contractAddress: this.actionsContract.address,
        entrypoint: 'set_post_price',
        calldata: calldata,
      });

      console.log('✅ Price set! Transaction:', tx.transaction_hash);
      console.log('📊 Full transaction object:', tx);
      
      // Wait for transaction confirmation
      const receipt = await this.account.waitForTransaction(tx.transaction_hash);
      console.log('✅ Transaction confirmed!', receipt);
      
      return tx;
    } catch (error) {
      console.error('❌ Failed to set price:', error);
      throw error;
    }
  }

  /**
   * Buy a post that is for sale
   * @param {number} postId - ID of the post to buy
   * @returns {Promise} - Transaction result
   */
  async buyPost(postId) {
    console.log('🛒 Buying post:', postId);

    try {
      const tx = await this.account.execute({
        contractAddress: this.actionsContract.address,
        entrypoint: 'buy_post',
        calldata: [postId],
      });

      console.log('✅ Post purchased! Transaction:', tx.transaction_hash);
      
      // Wait for transaction confirmation
      const receipt = await this.account.waitForTransaction(tx.transaction_hash);
      console.log('✅ Transaction confirmed!', receipt);
      
      return tx;
    } catch (error) {
      console.error('❌ Failed to buy post:', error);
      throw error;
    }
  }

  /**
   * Query a specific post directly from the blockchain (not Torii)
   * @param {number} postId - ID of the post
   * @returns {Promise} - The post data
   */
  async queryPostDirect(postId) {
    console.log('🔍 Querying post directly from blockchain:', postId);
    
    try {
      const post = await this.toriiClient.getEntities({
        query: new ToriiQueryBuilder()
          .withClause(KeysClause(['di-Post'], [postId], 'FixedLen').build())
      });
      
      console.log('📦 Direct query result:', post);
      
      if (post.items && post.items.length > 0) {
        const postData = post.items[0].models?.di?.Post;
        console.log('📊 Post data:', postData);
        console.log('💰 sale_price from blockchain:', postData?.sale_price);
        return postData;
      } else {
        console.log('❌ Post not found');
        return null;
      }
    } catch (error) {
      console.error('❌ Error querying post:', error);
      throw error;
    }
  }
}

