import { Amount, StarkZap, sepoliaValidators } from 'starkzap'
import { IS_SEPOLIA, RPC_URL } from './config.js'

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

export class StarkzapManager {
  constructor() {
    this.enabled = IS_SEPOLIA
    this.sdk = this.enabled
      ? new StarkZap({ network: 'sepolia', rpcUrl: RPC_URL })
      : null
    this.wallet = null
    this.walletPromise = null
    this.poolBySymbol = new Map()
  }

  async getWallet(opts = {}) {
    const { interactive = true } = opts
    if (!this.enabled || !this.sdk) throw new Error('Starkzap staking is enabled on Sepolia only.')
    if (this.wallet) return this.wallet
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

  async resolvePool(symbol) {
    const key = normalizeSymbol(symbol)
    if (this.poolBySymbol.has(key)) return this.poolBySymbol.get(key)

    const validators = Object.values(sepoliaValidators || {})
    console.info('[Starkzap] resolvePool start', { symbol: key, validatorCount: validators.length })
    for (const validator of validators) {
      const pools = await this.sdk.getStakerPools(validator.stakerAddress).catch((error) => {
        console.warn('[Starkzap] getStakerPools failed', {
          symbol: key,
          validator: validator?.name || validator?.stakerAddress,
          error: error?.message || String(error),
        })
        return []
      })
      const pool = (pools || []).find((p) => tokenMatches(key, p?.token?.symbol))
      if (pool) {
        this.poolBySymbol.set(key, pool)
        console.info('[Starkzap] resolvePool success', {
          symbol: key,
          validator: validator?.name || validator?.stakerAddress,
          poolContract: String(pool.poolContract),
          token: pool?.token?.symbol,
        })
        return pool
      }
    }

    throw new Error(`No Starkzap staking pool found for ${key} on Sepolia.`)
  }

  async stake(symbol, amount) {
    const wallet = await this.getWallet({ interactive: true })
    const pool = await this.resolvePool(symbol)
    const parsed = Amount.parse(String(amount), pool.token)
    console.info('[Starkzap] stake submit', {
      symbol: normalizeSymbol(symbol),
      amount: String(amount),
      poolContract: String(pool.poolContract),
      token: pool?.token?.symbol,
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
    const pool = await this.resolvePool(symbol)
    const isMember = await wallet.isPoolMember(pool.poolContract).catch(() => false)
    const position = isMember
      ? await wallet.getPoolPosition(pool.poolContract).catch(() => null)
      : null
    const commissionPercent = await wallet.getPoolCommission(pool.poolContract).catch(() => 0)
    return { wallet, pool, isMember, position, commissionPercent }
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
