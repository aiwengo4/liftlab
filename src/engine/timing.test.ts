import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ELEVATOR_TIMING,
  movementTime,
  stopTime,
} from './timing'

describe('movementTime', () => {
  it('adds acceleration and braking once for one continuous movement', () => {
    expect(movementTime(3, DEFAULT_ELEVATOR_TIMING)).toBe(14)
  })

  it('rejects movement without a positive whole number of floors', () => {
    expect(() => movementTime(0, DEFAULT_ELEVATOR_TIMING)).toThrow(RangeError)
    expect(() => movementTime(1.5, DEFAULT_ELEVATOR_TIMING)).toThrow(RangeError)
  })
})

describe('stopTime', () => {
  it('calculates a stop with five exits and five entries', () => {
    expect(stopTime(5, 5, DEFAULT_ELEVATOR_TIMING)).toBe(6)
  })

  it('calculates an empty door cycle', () => {
    expect(stopTime(0, 0, DEFAULT_ELEVATOR_TIMING)).toBe(4)
  })

  it('rejects a negative passenger count', () => {
    expect(() => stopTime(-1, 0, DEFAULT_ELEVATOR_TIMING)).toThrow(RangeError)
  })
})
