import { describe, expect, it } from 'vitest'
import { feltToI32, i32ToFelt, shortenAddress, stringToByteArray } from '../utils.js'

function bytesToDecimalString(bytes) {
  let value = 0n
  for (const b of bytes) value = (value << 8n) | BigInt(b)
  return value.toString()
}

describe('utils:stringToByteArray', () => {
  it('encodes empty string as zero-length bytearray', () => {
    expect(stringToByteArray('')).toEqual(['0', '0', '0'])
  })

  it('encodes short strings in pending word only', () => {
    const value = 'abc'
    const encoded = stringToByteArray(value)
    const expectedPending = bytesToDecimalString(new TextEncoder().encode(value))
    expect(encoded).toEqual(['0', expectedPending, '3'])
  })

  it('splits full 31-byte chunk plus pending bytes', () => {
    const value = 'a'.repeat(32)
    const encoded = stringToByteArray(value)
    const fullChunk = bytesToDecimalString(new TextEncoder().encode('a'.repeat(31)))
    const pending = bytesToDecimalString(new TextEncoder().encode('a'))
    expect(encoded).toEqual(['1', fullChunk, pending, '1'])
  })

  it('covers long preview logging branch (>50 chars)', () => {
    const value = 'z'.repeat(51)
    const encoded = stringToByteArray(value)
    expect(encoded[0]).toBe('1')
    expect(encoded.at(-1)).toBe('20')
  })
})

describe('utils:felt/i32 conversion', () => {
  it('keeps positive values unchanged', () => {
    expect(feltToI32('123')).toBe(123)
    expect(i32ToFelt(123)).toBe('123')
  })

  it('round-trips negative i32 values', () => {
    const felt = i32ToFelt(-42)
    expect(feltToI32(felt)).toBe(-42)
  })
})

describe('utils:shortenAddress', () => {
  it('handles empty and short strings', () => {
    expect(shortenAddress('')).toBe('')
    expect(shortenAddress('0x1234')).toBe('0x1234')
  })

  it('shortens with default and custom lengths', () => {
    const addr = '0x1234567890abcdef'
    expect(shortenAddress(addr)).toBe('0x1234...cdef')
    expect(shortenAddress(addr, 4, 2)).toBe('0x12...ef')
  })
})
