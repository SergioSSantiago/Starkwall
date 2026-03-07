import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetQuotes = vi.fn()
const mockExecuteSwap = vi.fn()
const mockGetAvnuStakingInfo = vi.fn()
const mockGetUserStakingInfo = vi.fn()

vi.mock('@avnu/avnu-sdk', () => ({
  getQuotes: (...args) => mockGetQuotes(...args),
  executeSwap: (...args) => mockExecuteSwap(...args),
  executeStake: vi.fn(),
  executeInitiateUnstake: vi.fn(),
  executeUnstake: vi.fn(),
  getAvnuStakingInfo: (...args) => mockGetAvnuStakingInfo(...args),
  getUserStakingInfo: (...args) => mockGetUserStakingInfo(...args),
  SEPOLIA_BASE_URL: 'https://sepolia.api.avnu.fi',
}))

vi.mock('@dojoengine/sdk', () => ({
  ToriiQueryBuilder: class {
    withClause() { return this }
    withLimit() { return this }
    withCursor() { return this }
  },
  KeysClause: () => ({ build: () => ({}) }),
}))

describe('DojoManager AVNU swap integrations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  async function createManager() {
    const { DojoManager } = await import('../dojoManager.js')
    const manager = new DojoManager(
      {
        address: '0xabc',
        waitForTransaction: vi.fn().mockResolvedValue({
          execution_status: 'SUCCEEDED',
          finality_status: 'ACCEPTED_ON_L2',
        }),
      },
      { contracts: [{ tag: 'di-actions', address: '0xactions' }] },
      { getEntities: vi.fn().mockResolvedValue({ items: [] }) },
    )
    vi.spyOn(manager, 'getTokenDecimals').mockResolvedValue(18)
    return manager
  }

  it('requests AVNU quotes from official Sepolia endpoint', async () => {
    const manager = await createManager()
    mockGetQuotes.mockResolvedValueOnce([{
      buyAmount: 123n,
      gasFees: 1n,
      priceImpact: 10,
      estimatedSlippage: 1,
    }])

    const quote = await manager.getTokenSwapQuote(
      '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
      '0x020d208b9e57a7f92bfa9f61135446e0961afc340378be97dbd317453c0950ae',
      1,
    )

    expect(quote.estimatedBuyRaw).toBe(123n)
    const [, options] = mockGetQuotes.mock.calls[0]
    expect(options).toEqual({ baseUrl: 'https://sepolia.api.avnu.fi' })
  })

  it('retries swap execution with wider slippage for retryable failures', async () => {
    const manager = await createManager()
    vi.spyOn(manager, 'getTokenSwapQuote').mockResolvedValue({
      quote: { id: 'q1' },
      estimatedBuyRaw: 1n,
      estimatedBuyAmount: 1,
      estimatedGasFee: 0,
      estimatedGasFeeStrk: 0,
      priceImpactBps: 0,
      estimatedSlippage: 0,
    })
    mockExecuteSwap
      .mockRejectedValueOnce(new Error('argent/multicall-failed'))
      .mockResolvedValueOnce({ transactionHash: '0xtx' })

    const result = await manager.swapTokens('0x1', '0x2', 1, 1, { slippageCandidates: [2] })
    expect(result.transaction_hash).toBe('0xtx')
    expect(mockExecuteSwap).toHaveBeenCalledTimes(2)
  })

  it('maps STRK/WBTC swap helper methods to configured token addresses', async () => {
    const manager = await createManager()
    const spy = vi.spyOn(manager, 'swapTokens').mockResolvedValue({ transaction_hash: '0xtx' })

    await manager.swapStrkToWbtc(2)
    await manager.swapWbtcToStrk(3)

    expect(spy).toHaveBeenNthCalledWith(
      1,
      '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
      '0x020d208b9e57a7f92bfa9f61135446e0961afc340378be97dbd317453c0950ae',
      2,
      1,
    )
    expect(spy).toHaveBeenNthCalledWith(
      2,
      '0x020d208b9e57a7f92bfa9f61135446e0961afc340378be97dbd317453c0950ae',
      '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
      3,
      1,
    )
  })
})
