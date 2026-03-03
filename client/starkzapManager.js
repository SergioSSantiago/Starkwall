import { Amount, StarkZap, sepoliaValidators } from 'starkzap'
import { CartridgeWallet } from 'starkzap/cartridge'
import { getAvnuStakingInfo, SEPOLIA_BASE_URL } from '@avnu/avnu-sdk'
import { IS_SEPOLIA, RPC_URL, SEPOLIA_BTC_SWAP_TOKEN, SEPOLIA_BTC_STAKING_TOKEN } from './config.js'

const AVNU_OPTIONS = IS_SEPOLIA ? { baseUrl: SEPOLIA_BASE_URL } : undefined

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase()
}

function tokenMatches(symbol, tokenSymbol) {
  const desired = normalizeSymbol(symbol)
  const got = normalizeSymbol(tokenSymbol)
  if (desired === got) return true
  if (desired === 'WBTC') {
    // Sepolia staking presets often expose BTC wrappers under TBTCx.
    return got === 'WBTC' || got.startsWith('TBTC') || got === 'BTC'
  }
  return false
}

function isControllerInitError(error) {
  const message = String(error?.message || error || '').toLowerCase()
  return message.includes('cartridge controller failed to initialize')
    || message.includes('failed to initialize')
}

function normalizeAddress(value) {
  const v = String(value || '').trim().toLowerCase()
  return v.startsWith('0x') ? v : (v ? `0x${v}` : '')
}

function formatUnits(raw, decimals = 18) {
  const d = Math.max(0, Number(decimals || 0))
  const base = 10n ** BigInt(d)
  const whole = raw / base
  const frac = (raw % base).toString().padStart(d, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}

function hasNonZeroPosition(position) {
  if (!position) return false
  const stakedZero = Boolean(position?.staked?.isZero?.())
  const rewardsZero = Boolean(position?.rewards?.isZero?.())
  const unpoolZero = Boolean(position?.unpooling?.isZero?.())
  return !(stakedZero && rewardsZero && unpoolZero)
}

export class StarkzapManager {
  constructor(options = {}) {
    this.enabled = IS_SEPOLIA
    this.sdk = this.enabled
      ? new StarkZap({ network: 'sepolia', rpcUrl: RPC_URL })
      : null
    this.wallet = null
    this.walletPromise = null
    this.poolBySymbol = new Map()
    this.externalAccount = options?.account || null
    this.externalWalletBootstrapped = false
    this.avnuPoolsCache = null
    this.avnuPoolsCacheAt = 0
  }

  setExternalAccount(account) {
    this.externalAccount = account || null
    this.externalWalletBootstrapped = false
  }

  tryBootstrapExternalWallet() {
    if (!this.enabled || !this.sdk || !this.externalAccount || this.externalWalletBootstrapped) return null
    const account = this.externalAccount
    if (!account?.address || typeof account?.execute !== 'function') {
      this.externalWalletBootstrapped = true
      return null
    }
    try {
      const provider = this.sdk.getProvider?.() || this.sdk.provider
      const chainId = this.sdk.config?.chainId
      const stakingConfig = this.sdk.getStakingConfig?.() || this.sdk.config?.staking
      if (!provider || !chainId || !stakingConfig) return null
      const controllerShim = {
        disconnect: async () => {},
        username: async () => '',
        keychain: null,
      }
      this.wallet = new CartridgeWallet(
        controllerShim,
        account,
        provider,
        chainId,
        '0x0',
        stakingConfig,
        {},
      )
      this.externalWalletBootstrapped = true
      console.info('[Starkzap] using app-connected account (no extra connectCartridge)')
      return this.wallet
    } catch (error) {
      console.warn('[Starkzap] failed to bootstrap app-connected wallet', error?.message || String(error))
      return null
    }
  }

  async getWallet(opts = {}) {
    const { interactive = true } = opts
    if (!this.enabled || !this.sdk) throw new Error('Starkzap staking is enabled on Sepolia only.')
    if (this.wallet) return this.wallet
    const external = this.tryBootstrapExternalWallet()
    if (external) return external
    if (!interactive) return null
    if (this.walletPromise) return this.walletPromise

    const connect = async () => {
      const maxAttempts = 2
      let lastError = null
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        console.info('[Starkzap] connectCartridge start', { attempt, maxAttempts })
        try {
          const wallet = await this.sdk.connectCartridge()
          this.wallet = wallet
          console.info('[Starkzap] connectCartridge success', { attempt })
          return wallet
        } catch (error) {
          lastError = error
          console.warn('[Starkzap] connectCartridge failed', {
            attempt,
            maxAttempts,
            message: error?.message || String(error),
          })
          if (attempt < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, 500))
          }
        }
      }

      // Last-resort retry: if popup flow fails, re-attempt using currently connected app account.
      const afterFailureExternal = this.tryBootstrapExternalWallet()
      if (afterFailureExternal) return afterFailureExternal

      if (isControllerInitError(lastError)) {
        throw new Error('Cartridge Controller failed to initialize. Use https://localhost:5173, allow popups/cookies for localhost, then retry.')
      }
      throw lastError || new Error('Unable to connect Cartridge Controller.')
    }

    this.walletPromise = connect()
      .catch((error) => {
        this.wallet = null
        throw error
      })
      .finally(() => {
        this.walletPromise = null
      })
    return this.walletPromise
  }

  async readTokenBalanceRaw(tokenAddress, accountAddress) {
    if (!tokenAddress || !accountAddress || !this.sdk?.provider) return 0n
    try {
      const bal = await this.sdk.provider.callContract({
        contractAddress: tokenAddress,
        entrypoint: 'balanceOf',
        calldata: [accountAddress],
      })
      const low = BigInt(bal?.[0] || 0)
      const high = BigInt(bal?.[1] || 0)
      return low + (high << 128n)
    } catch {
      return 0n
    }
  }

  async getAvnuStakingPools() {
    const cacheTtlMs = 60_000
    const now = Date.now()
    if (this.avnuPoolsCache && (now - this.avnuPoolsCacheAt) < cacheTtlMs) return this.avnuPoolsCache
    try {
      const info = await getAvnuStakingInfo(AVNU_OPTIONS)
      const pools = Array.isArray(info?.delegationPools) ? info.delegationPools : []
      this.avnuPoolsCache = pools.map((p) => ({
        poolAddress: normalizeAddress(p?.poolAddress),
        tokenAddress: normalizeAddress(p?.tokenAddress),
      })).filter((p) => p.poolAddress && p.tokenAddress)
      this.avnuPoolsCacheAt = now
      return this.avnuPoolsCache
    } catch (error) {
      console.warn('[Starkzap] AVNU staking info unavailable, using Starkzap-only discovery:', error?.message || String(error))
      this.avnuPoolsCache = []
      this.avnuPoolsCacheAt = now
      return this.avnuPoolsCache
    }
  }

  async resolvePool(symbol, opts = {}) {
    const key = normalizeSymbol(symbol)
    const walletAddress = String(opts?.walletAddress || '')
    const requiredRaw = BigInt(opts?.requiredRaw || 0n)
    if (this.poolBySymbol.has(key) && !walletAddress) return this.poolBySymbol.get(key)

    const validators = Object.values(sepoliaValidators || {})
    console.info('[Starkzap] resolvePool start', { symbol: key, validatorCount: validators.length })
    const candidates = []
    for (const validator of validators) {
      const pools = await this.sdk.getStakerPools(validator.stakerAddress).catch((error) => {
        console.warn('[Starkzap] getStakerPools failed', {
          symbol: key,
          validator: validator?.name || validator?.stakerAddress,
          error: error?.message || String(error),
        })
        return []
      })
      for (const pool of (pools || [])) {
        if (tokenMatches(key, pool?.token?.symbol)) {
          candidates.push({
            pool,
            validator: validator?.name || validator?.stakerAddress,
            tokenAddress: normalizeAddress(pool?.token?.address),
            tokenSymbol: normalizeSymbol(pool?.token?.symbol),
          })
        }
      }
    }

    if (candidates.length === 0) {
      throw new Error(`No Starkzap staking pool found for ${key} on Sepolia.`)
    }

    // For BTC track tokens, pick the pool by concrete token address and usable balance.
    if (key === 'WBTC') {
      const avnuPools = await this.getAvnuStakingPools()
      const avnuPoolKeys = new Set(avnuPools.map((p) => `${p.poolAddress}:${p.tokenAddress}`))
      const preferredSwapToken = normalizeAddress(SEPOLIA_BTC_SWAP_TOKEN)
      const preferredStakingToken = normalizeAddress(SEPOLIA_BTC_STAKING_TOKEN)
      const balanceCache = new Map()
      for (const c of candidates) {
        if (!walletAddress || !c.tokenAddress) continue
        if (!balanceCache.has(c.tokenAddress)) {
          balanceCache.set(c.tokenAddress, await this.readTokenBalanceRaw(c.tokenAddress, walletAddress))
        }
      }
      const scored = candidates.map((c) => {
        const bal = c.tokenAddress ? (balanceCache.get(c.tokenAddress) || 0n) : 0n
        const poolAddress = normalizeAddress(c?.pool?.poolContract)
        const avnuKey = `${poolAddress}:${c.tokenAddress}`
        const isAvnuPool = avnuPoolKeys.has(avnuKey)
        let score = 0
        if (isAvnuPool) score += 2000
        if (c.tokenAddress && c.tokenAddress === preferredSwapToken) score += 1000
        if (c.tokenAddress && c.tokenAddress === preferredStakingToken) score += 900
        if (c.tokenSymbol === 'WBTC') score += 300
        if (c.tokenSymbol.startsWith('TBTC')) score += 200
        if (bal > 0n) score += 250
        if (requiredRaw > 0n && bal >= requiredRaw) score += 500
        return { ...c, score, balanceRaw: bal, isAvnuPool, poolAddress }
      })
      const avnuScoped = scored.filter((c) => c.isAvnuPool)
      const prioritized = avnuScoped.length > 0 ? avnuScoped : scored
      prioritized.sort((a, b) => b.score - a.score)
      const best = prioritized[0]
      this.poolBySymbol.set(key, best.pool)
      console.info('[Starkzap] resolvePool success', {
        symbol: key,
        validator: best.validator,
        poolContract: String(best.pool.poolContract),
        token: best.pool?.token?.symbol,
        tokenAddress: best.tokenAddress,
        walletTokenBalanceRaw: best.balanceRaw?.toString?.() || '0',
        avnuAligned: Boolean(best.isAvnuPool),
      })
      return best.pool
    }

    const chosen = candidates[0]
    this.poolBySymbol.set(key, chosen.pool)
    console.info('[Starkzap] resolvePool success', {
      symbol: key,
      validator: chosen.validator,
      poolContract: String(chosen.pool.poolContract),
      token: chosen.pool?.token?.symbol,
    })
    return chosen.pool
  }

  async stake(symbol, amount) {
    const wallet = await this.getWallet({ interactive: true })
    const firstParsedAmount = Number(amount || 0)
    const fallbackRaw = BigInt(Math.floor(firstParsedAmount * 10 ** 8))
    const pool = await this.resolvePool(symbol, {
      walletAddress: wallet?.address,
      requiredRaw: fallbackRaw,
    })
    const parsed = Amount.parse(String(amount), pool.token)
    const requiredRaw = BigInt(parsed.toBase())
    const poolTokenAddress = normalizeAddress(pool?.token?.address)
    const swapTokenAddress = normalizeAddress(SEPOLIA_BTC_SWAP_TOKEN)

    // Preflight: prevent opaque multicall failures by checking pool-token balance first.
    if (poolTokenAddress && wallet?.provider) {
      try {
        const bal = await wallet.provider.callContract({
          contractAddress: poolTokenAddress,
          entrypoint: 'balanceOf',
          calldata: [wallet.address],
        })
        const low = BigInt(bal?.[0] || 0)
        const high = BigInt(bal?.[1] || 0)
        const walletPoolTokenRaw = low + (high << 128n)
        if (walletPoolTokenRaw < requiredRaw) {
          let swapReadable = ''
          if (swapTokenAddress && swapTokenAddress !== poolTokenAddress) {
            try {
              const swapBal = await wallet.provider.callContract({
                contractAddress: swapTokenAddress,
                entrypoint: 'balanceOf',
                calldata: [wallet.address],
              })
              const sLow = BigInt(swapBal?.[0] || 0)
              const sHigh = BigInt(swapBal?.[1] || 0)
              const swapRaw = sLow + (sHigh << 128n)
              // UI WBTC is shown with 8 decimals.
              swapReadable = ` You currently hold ${formatUnits(swapRaw, 8)} WBTC in swap token ${swapTokenAddress}.`
            } catch {}
          }
          throw new Error(
            `Insufficient ${pool?.token?.symbol || normalizeSymbol(symbol)} balance for selected staking pool. ` +
            `Pool token: ${poolTokenAddress}. Required: ${parsed.toFormatted()}. Available: ${formatUnits(walletPoolTokenRaw, Number(pool?.token?.decimals || 18))}.` +
            swapReadable,
          )
        }
      } catch (balanceError) {
        const message = String(balanceError?.message || balanceError || '')
        if (message.toLowerCase().includes('insufficient')) throw balanceError
        console.warn('[Starkzap] pool-token preflight skipped', message)
      }
    }
    console.info('[Starkzap] stake submit', {
      symbol: normalizeSymbol(symbol),
      amount: String(amount),
      poolContract: String(pool.poolContract),
      token: pool?.token?.symbol,
      tokenAddress: poolTokenAddress,
    })
    const tx = await wallet.stake(pool.poolContract, parsed)
    await tx.wait()
    console.info('[Starkzap] stake confirmed', { txHash: tx?.hash || '' })
    return { tx, pool }
  }

  async claimRewards(symbol) {
    const wallet = await this.getWallet({ interactive: true })
    const pool = await this.resolvePool(symbol)
    const position = await wallet.getPoolPosition(pool.poolContract)
    if (!position || position.rewards.isZero()) {
      throw new Error(`No claimable ${normalizeSymbol(symbol)} rewards right now.`)
    }
    console.info('[Starkzap] claim submit', {
      symbol: normalizeSymbol(symbol),
      poolContract: String(pool.poolContract),
      pending: position.rewards.toFormatted(),
    })
    const tx = await wallet.claimPoolRewards(pool.poolContract)
    await tx.wait()
    console.info('[Starkzap] claim confirmed', { txHash: tx?.hash || '' })
    return { tx, pool, position }
  }

  async getPoolPosition(symbol, opts = {}) {
    const wallet = await this.getWallet({ interactive: Boolean(opts?.interactive) })
    if (!wallet) {
      return { wallet: null, pool: null, isMember: false, position: null, commissionPercent: 0 }
    }
    // For balance/position reads, resolve with wallet context so WBTC picks the
    // pool that actually matches the user's held/staked token.
    let pool = await this.resolvePool(symbol, { walletAddress: wallet.address })
    let isMember = await wallet.isPoolMember(pool.poolContract).catch(() => false)
    let position = isMember
      ? await wallet.getPoolPosition(pool.poolContract).catch(() => null)
      : null
    let commissionPercent = await wallet.getPoolCommission(pool.poolContract).catch(() => 0)

    // WBTC on Sepolia may have multiple wrappers/pools. If the scored pool is
    // not the member pool, probe all BTC-like pools and pick the pool that
    // actually holds the user's position so wallet UI stays chain-accurate.
    if (normalizeSymbol(symbol) === 'WBTC' && !hasNonZeroPosition(position)) {
      const validators = Object.values(sepoliaValidators || {})
      for (const validator of validators) {
        const pools = await this.sdk.getStakerPools(validator.stakerAddress).catch(() => [])
        for (const candidate of (pools || [])) {
          if (!tokenMatches('WBTC', candidate?.token?.symbol)) continue
          const member = await wallet.isPoolMember(candidate.poolContract).catch(() => false)
          if (!member) continue
          const candidatePosition = await wallet.getPoolPosition(candidate.poolContract).catch(() => null)
          if (!hasNonZeroPosition(candidatePosition)) continue
          pool = candidate
          isMember = true
          position = candidatePosition
          commissionPercent = await wallet.getPoolCommission(candidate.poolContract).catch(() => commissionPercent)
          console.info('[Starkzap] getPoolPosition selected member pool', {
            symbol: 'WBTC',
            poolContract: String(candidate.poolContract),
            token: candidate?.token?.symbol,
            tokenAddress: normalizeAddress(candidate?.token?.address),
          })
          return { wallet, pool, isMember, position, commissionPercent }
        }
      }
    }

    return { wallet, pool, isMember, position, commissionPercent }
  }

  async getWbtcMemberInfo(accountAddress) {
    const user = normalizeAddress(accountAddress || '')
    if (!user || user === '0x0' || !this.sdk?.provider) {
      return {
        found: false,
        poolAddress: '',
        tokenAddress: '',
        tokenSymbol: '',
        stakedRaw: 0n,
        unclaimedRewardsRaw: 0n,
        unpoolAmountRaw: 0n,
        unpoolTimeUnix: 0,
        commissionBps: 0n,
        memberFlag: 0n,
      }
    }

    const validators = Object.values(sepoliaValidators || {})
    for (const validator of validators) {
      const pools = await this.sdk.getStakerPools(validator.stakerAddress).catch(() => [])
      for (const pool of (pools || [])) {
        if (!tokenMatches('WBTC', pool?.token?.symbol)) continue
        const poolAddress = String(pool?.poolContract || '')
        if (!poolAddress) continue
        try {
          const res = await this.sdk.provider.callContract({
            contractAddress: poolAddress,
            entrypoint: 'get_pool_member_info_v1',
            calldata: [user],
          })
          const parts = Array.isArray(res) ? res : (res?.result || [])
          // ABI decode (Option<PoolMemberInfoV1>, Some variant index = 0):
          // [0, reward_address, amount, unclaimed_rewards, commission, unpool_amount, unpool_time]
          const stakedRaw = BigInt(parts?.[2] || 0)
          const unclaimedRewardsRaw = BigInt(parts?.[3] || 0)
          const commissionBps = BigInt(parts?.[4] || 0)
          const unpoolAmountRaw = BigInt(parts?.[5] || 0)
          const unpoolTimeOpt = BigInt(parts?.[6] || 1)
          const unpoolTimeUnix = (unpoolTimeOpt === 0n) ? Number(BigInt(parts?.[7] || 0)) : 0
          const memberFlag = (stakedRaw > 0n || unclaimedRewardsRaw > 0n || unpoolAmountRaw > 0n || unpoolTimeOpt === 0n) ? 1n : 0n
          if (stakedRaw > 0n || unclaimedRewardsRaw > 0n || unpoolAmountRaw > 0n || memberFlag > 0n) {
            return {
              found: true,
              poolAddress: normalizeAddress(poolAddress),
              tokenAddress: normalizeAddress(pool?.token?.address),
              tokenSymbol: String(pool?.token?.symbol || ''),
              stakedRaw,
              unclaimedRewardsRaw,
              unpoolAmountRaw,
              unpoolTimeUnix,
              commissionBps,
              memberFlag,
            }
          }
        } catch {
          continue
        }
      }
    }

    return {
      found: false,
      poolAddress: '',
      tokenAddress: '',
      tokenSymbol: '',
      stakedRaw: 0n,
      unclaimedRewardsRaw: 0n,
      unpoolAmountRaw: 0n,
      unpoolTimeUnix: 0,
      commissionBps: 0n,
      memberFlag: 0n,
    }
  }

  async unstake(symbol, requestedAmount = null) {
    const { wallet, pool, position } = await this.getPoolPosition(symbol, { interactive: true })
    if (!position) throw new Error(`No active ${normalizeSymbol(symbol)} staking position.`)

    const nowMs = Date.now()
    const hasUnpooling = !position.unpooling.isZero()
    if (hasUnpooling) {
      const unlockMs = position.unpoolTime ? new Date(position.unpoolTime).getTime() : 0
      if (unlockMs > nowMs) {
        throw new Error(`Unstake already requested. Exit available at ${new Date(unlockMs).toLocaleString()}.`)
      }
      console.info('[Starkzap] exitPool submit', {
        symbol: normalizeSymbol(symbol),
        poolContract: String(pool.poolContract),
      })
      const tx = await wallet.exitPool(pool.poolContract)
      await tx.wait()
      console.info('[Starkzap] exitPool confirmed', { txHash: tx?.hash || '' })
      return { action: 'exit', tx, pool, position }
    }

    const amount = requestedAmount && Number(requestedAmount) > 0
      ? Amount.parse(String(requestedAmount), pool.token)
      : position.staked

    console.info('[Starkzap] exitPoolIntent submit', {
      symbol: normalizeSymbol(symbol),
      poolContract: String(pool.poolContract),
      amount: amount.toFormatted(),
    })
    const tx = await wallet.exitPoolIntent(pool.poolContract, amount)
    await tx.wait()
    console.info('[Starkzap] exitPoolIntent confirmed', { txHash: tx?.hash || '' })
    return { action: 'intent', tx, pool, position }
  }
}
