import { describe, expect, it } from 'vitest'
import { SeededRandom } from './random'

describe('SeededRandom', () => {
  it('repeats the same sequence for the same seed', () => {
    const first = new SeededRandom(42)
    const second = new SeededRandom(42)

    expect([first.next(), first.next(), first.next()]).toEqual([
      second.next(),
      second.next(),
      second.next(),
    ])
  })

  it('rejects a seed outside the uint32 range', () => {
    expect(() => new SeededRandom(-1)).toThrow(RangeError)
    expect(() => new SeededRandom(0x1_0000_0000)).toThrow(RangeError)
  })
})
