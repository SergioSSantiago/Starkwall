import { describe, expect, it, vi } from 'vitest'
import { SpiralLayout } from '../spiralLayout.js'

describe('SpiralLayout', () => {
  it('starts at origin when empty', () => {
    const layout = new SpiralLayout(10, 20)
    const pos = layout.getNextPosition()
    expect(pos).toEqual({ x: 0, y: 0 })
    expect(layout.isOccupied(0, 0)).toBe(true)
  })

  it('marks all cells for multi-size existing post', () => {
    const layout = new SpiralLayout(10, 10)
    layout.addExistingPost(0, 0, 2)
    expect(layout.isOccupied(0, 0)).toBe(true)
    expect(layout.isOccupied(10, 0)).toBe(true)
    expect(layout.isOccupied(0, 10)).toBe(true)
    expect(layout.isOccupied(10, 10)).toBe(true)
    expect(layout.isOccupied(20, 20)).toBe(false)
  })

  it('finds a non-occupied spiral position when already populated', () => {
    const layout = new SpiralLayout(100, 100)
    layout.addExistingPost(0, 0, 1)
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    const pos = layout.getNextPosition(1)
    randomSpy.mockRestore()
    expect(layout.isOccupied(pos.x, pos.y)).toBe(true)
    expect(pos).not.toEqual({ x: 0, y: 0 })
  })

  it('falls back to random adjacent placement when all adjacency checks are occupied', () => {
    const layout = new SpiralLayout(50, 50)
    layout.addExistingPost(0, 0, 1)

    const isOccupiedMock = vi.spyOn(layout, 'isOccupied').mockReturnValue(true)
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.75)
    const pos = layout.findAdjacentPosition(1)
    randomSpy.mockRestore()
    isOccupiedMock.mockRestore()

    expect(pos).toEqual({ x: 250, y: 250 })
    expect(layout.occupiedPositions.has('250,250')).toBe(true)
  })

  it('returns first valid adjacent position when available', () => {
    const layout = new SpiralLayout(10, 10)
    layout.addExistingPost(0, 0, 1)
    layout.addExistingPost(10, 10, 1)

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    const pos = layout.findAdjacentPosition(1)
    randomSpy.mockRestore()

    expect(
      [
        { x: 10, y: 0 },
        { x: -10, y: 0 },
        { x: 0, y: 10 },
        { x: 0, y: -10 },
        { x: 10, y: 10 },
        { x: -10, y: 10 },
        { x: 10, y: -10 },
        { x: -10, y: -10 },
      ],
    ).toContainEqual(pos)
    expect(layout.occupiedPositions.has(`${pos.x},${pos.y}`)).toBe(true)
  })

  it('uses adjacent fallback from getNextPosition when spiral cannot place', () => {
    const layout = new SpiralLayout(10, 10)
    layout.addExistingPost(0, 0, 1)

    const occupiedSpy = vi.spyOn(layout, 'isOccupied').mockReturnValue(true)
    const adjacentSpy = vi.spyOn(layout, 'findAdjacentPosition').mockReturnValue({ x: 99, y: 88 })
    const pos = layout.getNextPosition(1)
    occupiedSpy.mockRestore()
    adjacentSpy.mockRestore()

    expect(pos).toEqual({ x: 99, y: 88 })
  })

  it('loads existing posts list into occupied map', () => {
    const layout = new SpiralLayout(10, 10)
    layout.loadExistingPosts([
      { x_position: 30, y_position: 40, size: 1 },
      { x_position: 50, y_position: 60, size: 2 },
    ])
    expect(layout.isOccupied(30, 40)).toBe(true)
    expect(layout.isOccupied(50, 60)).toBe(true)
    expect(layout.isOccupied(60, 70)).toBe(true)
  })
})
