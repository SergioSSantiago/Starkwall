import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initGame, updateFromEntitiesData } from '../game.js'

function setupDom() {
  document.body.innerHTML = `
    <div id="position-display"></div>
    <div id="moves-display"></div>
    <button id="up-button"></button>
    <button id="right-button"></button>
    <button id="down-button"></button>
    <button id="left-button"></button>
    <button id="move-random-button"></button>
    <button id="spawn-button"></button>
  `
}

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('game UI and tx mapping', () => {
  const account = {
    address: '0xabc',
    execute: vi.fn().mockResolvedValue({ transaction_hash: '0x1' }),
  }
  const manifest = { contracts: [{ tag: 'di-actions', address: '0xaction' }] }

  beforeEach(() => {
    setupDom()
    account.execute.mockClear()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('updates position and moves from entities payload', () => {
    updateFromEntitiesData([
      {
        models: {
          di: {
            Position: { x: 5, y: 9 },
            Moves: { remaining: 11 },
          },
        },
      },
    ])

    expect(document.getElementById('position-display')?.textContent).toBe('Position: (5, 9)')
    expect(document.getElementById('moves-display')?.textContent).toBe('Moves remaining: 11')
  })

  it('handles partial/missing entity models without crashing', () => {
    expect(() => updateFromEntitiesData([{ foo: 'bar' }, { models: { di: {} } }])).not.toThrow()
  })

  it('skips DOM updates when display nodes are absent', () => {
    document.getElementById('position-display')?.remove()
    document.getElementById('moves-display')?.remove()
    expect(() =>
      updateFromEntitiesData([
        {
          models: {
            di: {
              Position: { x: 1, y: 2 },
              Moves: { remaining: 3 },
            },
          },
        },
      ]),
    ).not.toThrow()
  })

  it('binds spawn and enables movement buttons', async () => {
    document.getElementById('up-button').disabled = true
    document.getElementById('right-button').disabled = true
    document.getElementById('down-button').disabled = true
    document.getElementById('left-button').disabled = true
    document.getElementById('move-random-button').disabled = true

    initGame(account, manifest)
    document.getElementById('spawn-button').click()
    await flushPromises()

    expect(account.execute).toHaveBeenCalledWith({
      contractAddress: '0xaction',
      entrypoint: 'spawn',
      calldata: [],
    })
    expect(document.getElementById('up-button').disabled).toBe(false)
    expect(document.getElementById('right-button').disabled).toBe(false)
    expect(document.getElementById('down-button').disabled).toBe(false)
    expect(document.getElementById('left-button').disabled).toBe(false)
    expect(document.getElementById('move-random-button').disabled).toBe(false)
  })

  it('maps directional buttons to expected move calldata', async () => {
    initGame(account, manifest)

    document.getElementById('left-button').click()
    await flushPromises()
    document.getElementById('right-button').click()
    await flushPromises()
    document.getElementById('up-button').click()
    await flushPromises()
    document.getElementById('down-button').click()
    await flushPromises()

    expect(account.execute).toHaveBeenNthCalledWith(1, {
      contractAddress: '0xaction',
      entrypoint: 'move',
      calldata: ['0'],
    })
    expect(account.execute).toHaveBeenNthCalledWith(2, {
      contractAddress: '0xaction',
      entrypoint: 'move',
      calldata: ['1'],
    })
    expect(account.execute).toHaveBeenNthCalledWith(3, {
      contractAddress: '0xaction',
      entrypoint: 'move',
      calldata: ['2'],
    })
    expect(account.execute).toHaveBeenNthCalledWith(4, {
      contractAddress: '0xaction',
      entrypoint: 'move',
      calldata: ['3'],
    })
  })

  it('builds VRF sandwich calls for random movement', async () => {
    initGame(account, manifest)

    document.getElementById('move-random-button').click()
    await flushPromises()

    expect(account.execute).toHaveBeenCalledWith([
      {
        contractAddress: '0x15f542e25a4ce31481f986888c179b6e57412be340b8095f72f75a328fbb27b',
        entrypoint: 'request_random',
        calldata: ['0xaction', '0', '0xabc'],
      },
      {
        contractAddress: '0xaction',
        entrypoint: 'move_random',
        calldata: [],
      },
    ])
  })
})
