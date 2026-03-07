import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetAvnuStakingInfo = vi.fn()
const mockStake = vi.fn()
const mockClaimPoolRewards = vi.fn()
const mockExitPoolIntent = vi.fn()
const mockExitPool = vi.fn()
const mockGetPoolPosition = vi.fn()
const mockIsPoolMember = vi.fn()
const mockGetPoolCommission = vi.fn()
const mockCallContract = vi.fn()
const mockGetStakerPools = vi.fn()

vi.mock('@avnu/avnu-sdk', () => ({
  getAvnuStakingInfo: (...args) => mockGetAvnuStakingInfo(...args),
  SEPOLIA_BASE_URL: 'https://sepolia.api.avnu.fi',
}))

vi.mock('starkzap', () => {
  class MockStarkZap {
    constructor() {
      this.provider = { callContract: (...args) => mockCallContract(...args) }
      this.config = { chainId: 'SN_SEPOLIA', staking: {} }
    }
    getStakingConfig() {
      return {}
    }
    getProvider() {
      return this.provider
    }
    getStakerPools(...args) {
      return mockGetStakerPools(...args)
    }
  }
  const amountParse = vi.fn((value) => ({
    toBase: () => BigInt(value).toString(),
    toFormatted: () => String(value),
  }))
  return {
    Amount: { parse: amountParse },
    StarkZap: MockStarkZap,
    sepoliaValidators: {
      v0: { name: 'Validator 0', stakerAddress: '0xabc' },
    },
  }
})

vi.mock('starkzap/cartridge', () => {
  class MockWallet {
    constructor() {
      this.address = '0x123'
      this.provider = { callContract: (...args) => mockCallContract(...args) }
    }
    stake(...args) {
      return mockStake(...args)
    }
    claimPoolRewards(...args) {
      return mockClaimPoolRewards(...args)
    }
    exitPoolIntent(...args) {
      return mockExitPoolIntent(...args)
    }
    exitPool(...args) {
      return mockExitPool(...args)
    }
    getPoolPosition(...args) {
      return mockGetPoolPosition(...args)
    }
    isPoolMember(...args) {
      return mockIsPoolMember(...args)
    }
    getPoolCommission(...args) {
      return mockGetPoolCommission(...args)
    }
  }
  return { CartridgeWallet: MockWallet }
})

describe('StarkzapManager staking integrations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('queries AVNU staking pools through Sepolia endpoint', async () => {
    const { StarkzapManager } = await import('../starkzapManager.js')
    mockGetAvnuStakingInfo.mockResolvedValueOnce({
      delegationPools: [{ poolAddress: '0x1', tokenAddress: '0x2' }],
    })

    const manager = new StarkzapManager({
      account: {
        address: '0x123',
        execute: vi.fn(),
      },
    })

    const pools = await manager.getAvnuStakingPools()
    expect(pools).toHaveLength(1)
    expect(mockGetAvnuStakingInfo).toHaveBeenCalledWith({ baseUrl: 'https://sepolia.api.avnu.fi' })
  })

  it('uses wallet.stake(pool, amount) for staking', async () => {
    const { StarkzapManager } = await import('../starkzapManager.js')
    const manager = new StarkzapManager({
      account: {
        address: '0x123',
        execute: vi.fn(),
      },
    })
    const pool = { poolContract: '0xpool', token: { symbol: 'STRK', address: '0xtoken', decimals: 18 } }
    vi.spyOn(manager, 'resolvePool').mockResolvedValue(pool)
    vi.spyOn(manager, 'getWallet').mockResolvedValue({
      address: '0x123',
      provider: { callContract: mockCallContract },
      stake: mockStake,
    })
    mockCallContract.mockResolvedValue(['100000000000000000000', '0']) // large enough balance
    mockStake.mockResolvedValue({ wait: vi.fn().mockResolvedValue(undefined), hash: '0xtx' })

    const result = await manager.stake('STRK', 1)
    expect(mockStake).toHaveBeenCalledTimes(1)
    expect(mockStake).toHaveBeenCalledWith('0xpool', expect.any(Object))
    expect(result.pool.poolContract).toBe('0xpool')
  })

  it('uses wallet.claimPoolRewards(pool) for claim', async () => {
    const { StarkzapManager } = await import('../starkzapManager.js')
    const manager = new StarkzapManager({ account: { address: '0x123', execute: vi.fn() } })
    vi.spyOn(manager, 'resolvePool').mockResolvedValue({ poolContract: '0xpool' })
    vi.spyOn(manager, 'getWallet').mockResolvedValue({
      getPoolPosition: vi.fn().mockResolvedValue({
        rewards: { isZero: () => false, toFormatted: () => '1' },
      }),
      claimPoolRewards: mockClaimPoolRewards,
    })
    mockClaimPoolRewards.mockResolvedValue({ wait: vi.fn().mockResolvedValue(undefined), hash: '0xclaim' })

    await manager.claimRewards('STRK')
    expect(mockClaimPoolRewards).toHaveBeenCalledWith('0xpool')
  })

  it('uses exitPoolIntent first and exitPool after cooldown', async () => {
    const { StarkzapManager } = await import('../starkzapManager.js')
    const manager = new StarkzapManager({ account: { address: '0x123', execute: vi.fn() } })
    const pool = { poolContract: '0xpool', token: { decimals: 18 } }
    const nowPast = new Date(Date.now() - 5_000).toISOString()

    vi.spyOn(manager, 'getPoolPosition')
      .mockResolvedValueOnce({
        wallet: { exitPoolIntent: mockExitPoolIntent },
        pool,
        position: {
          unpooling: { isZero: () => true },
          staked: { toFormatted: () => '1' },
        },
      })
      .mockResolvedValueOnce({
        wallet: { exitPool: mockExitPool },
        pool,
        position: {
          unpooling: { isZero: () => false },
          unpoolTime: nowPast,
          staked: { toFormatted: () => '1' },
        },
      })

    mockExitPoolIntent.mockResolvedValue({ wait: vi.fn().mockResolvedValue(undefined), hash: '0xintent' })
    mockExitPool.mockResolvedValue({ wait: vi.fn().mockResolvedValue(undefined), hash: '0xexit' })

    await manager.unstake('STRK', 1)
    await manager.unstake('STRK')

    expect(mockExitPoolIntent).toHaveBeenCalledTimes(1)
    expect(mockExitPoolIntent).toHaveBeenCalledWith('0xpool', expect.any(Object))
    expect(mockExitPool).toHaveBeenCalledTimes(1)
    expect(mockExitPool).toHaveBeenCalledWith('0xpool')
  })
})
