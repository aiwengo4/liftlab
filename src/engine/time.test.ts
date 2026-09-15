import { describe, expect, it } from 'vitest'
import { addTicks, secondsToTicks, ticksToSeconds } from './time'

describe('simulation time', () => {
  it('represents tenths of a second without floating-point accumulation', () => {
    const oneTenth = secondsToTicks(0.1)
    const twoTenths = secondsToTicks(0.2)

    expect(ticksToSeconds(addTicks(oneTenth, twoTenths))).toBe(0.3)
  })

  it('rejects a value more precise than one tenth of a second', () => {
    expect(() => secondsToTicks(0.15)).toThrow(RangeError)
  })

  it('rejects negative and non-finite time', () => {
    expect(() => secondsToTicks(-0.1)).toThrow(RangeError)
    expect(() => secondsToTicks(Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })

  it('rejects time outside the safe integer range', () => {
    expect(() => secondsToTicks(Number.MAX_SAFE_INTEGER)).toThrow(RangeError)
  })
})
