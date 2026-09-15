import { describe, expect, it } from 'vitest'
import { applyTransportChoiceToPath, chooseDayTransport, DEFAULT_LUNCH_OVERLOAD_STAIR_SETTINGS, DEFAULT_STAIR_CHOICE_SETTINGS, lunchOverloadStairProbability, stairProbability, type RouteChoiceRequest, type StairChoiceSettings } from './routeChoice'

function request(overrides: Partial<RouteChoiceRequest> = {}): RouteChoiceRequest {
  return {
    seed: 42,
    employeeId: 1,
    journeyId: 'meeting-10',
    legId: 'outbound',
    floorCount: 10,
    fromFloor: 2,
    toFloor: 3,
    ...overrides,
  }
}

function settings(overrides: Partial<StairChoiceSettings> = {}): StairChoiceSettings {
  return { ...DEFAULT_STAIR_CHOICE_SETTINGS, ...overrides }
}

describe('routeChoice', () => {
  it('uses the lunch-overload scale and halves it for an inconvenient staircase', () => {
    expect(lunchOverloadStairProbability(3, true, DEFAULT_LUNCH_OVERLOAD_STAIR_SETTINGS)).toBe(0.6)
    expect(lunchOverloadStairProbability(3, false, DEFAULT_LUNCH_OVERLOAD_STAIR_SETTINGS)).toBe(0.3)
    expect(lunchOverloadStairProbability(20, true, DEFAULT_LUNCH_OVERLOAD_STAIR_SETTINGS)).toBe(0.05)
    expect(lunchOverloadStairProbability(20, false, DEFAULT_LUNCH_OVERLOAD_STAIR_SETTINGS)).toBe(0.025)
  })
  it('uses the documented default probabilities for all distances', () => {
    const convenient = [0.9, 0.7, 0.575, 0.45, 0.325, 0.2]
    const inconvenient = [0.3, 0.1, 0.08, 0.06, 0.04, 0.02]
    for (let distance = 1; distance <= 6; distance += 1) {
      expect(stairProbability(distance, settings({ maxVoluntaryFloors: 6 }))).toBeCloseTo(convenient[distance - 1])
      expect(stairProbability(distance, settings({ convenient: false, maxVoluntaryFloors: 6 }))).toBeCloseTo(inconvenient[distance - 1])
    }
  })

  it('returns no route and consumes no random draw on the same floor', () => {
    expect(chooseDayTransport(request({ toFloor: 2 }), settings())).toMatchObject({
      mode: 'none', distanceFloors: 0, stairDurationSeconds: 0, randomDraw: null, reason: 'same-floor',
    })
  })

  it('uses the elevator beyond the voluntary limit', () => {
    expect(chooseDayTransport(request({ toFloor: 5 }), settings())).toMatchObject({
      mode: 'elevator', distanceFloors: 3, stairProbability: 0, randomDraw: null, reason: 'outside-voluntary-limit',
    })
  })

  it('forces an unavailable-lift segment onto stairs regardless of the limit', () => {
    expect(chooseDayTransport(request({ toFloor: 9, mandatoryStairs: true }), settings({ maxVoluntaryFloors: 1 }))).toMatchObject({
      mode: 'stairs', distanceFloors: 7, stairProbability: 1, stairDurationSeconds: 105, randomDraw: null, reason: 'mandatory',
    })
  })

  it('calculates the same fractional stair duration upward and downward', () => {
    const custom = settings({ secondsPerFloor: 12.5, maxVoluntaryFloors: 6, convenientProbabilities: [1, 1, 1, 1, 1, 1] })
    expect(chooseDayTransport(request({ fromFloor: 2, toFloor: 6 }), custom).stairDurationSeconds).toBe(50)
    expect(chooseDayTransport(request({ fromFloor: 6, toFloor: 2 }), custom).stairDurationSeconds).toBe(50)
  })

  it('is reproducible per employee and leg and independent of processing order', () => {
    const requests = [1, 2, 3, 4, 5].map((employeeId) => request({ employeeId }))
    const forward = new Map(requests.map((item) => [item.employeeId, chooseDayTransport(item, settings()).randomDraw]))
    const reversed = new Map([...requests].reverse().map((item) => [item.employeeId, chooseDayTransport(item, settings()).randomDraw]))
    expect(reversed).toEqual(forward)
    expect(new Set(forward.values()).size).toBeGreaterThan(1)
  })

  it('uses independent stable draws for outbound and return legs', () => {
    const outbound = chooseDayTransport(request({ legId: 'outbound' }), settings())
    const returning = chooseDayTransport(request({ legId: 'return', fromFloor: 3, toFloor: 2 }), settings())
    expect(chooseDayTransport(request({ legId: 'outbound' }), settings())).toEqual(outbound)
    expect(returning.randomDraw).not.toBe(outbound.randomDraw)
  })

  it('changes the keyed streams when the scenario seed changes', () => {
    const first = [1, 2, 3, 4, 5].map((employeeId) => chooseDayTransport(request({ employeeId }), settings()).randomDraw)
    const second = [1, 2, 3, 4, 5].map((employeeId) => chooseDayTransport(request({ employeeId, seed: 43 }), settings()).randomDraw)
    expect(second).not.toEqual(first)
  })

  it('applies editable probabilities', () => {
    const alwaysStairs = settings({ convenientProbabilities: [1, 1, 1, 1, 1, 1] })
    const neverStairs = settings({ convenientProbabilities: [0, 0, 0, 0, 0, 0] })
    expect(chooseDayTransport(request(), alwaysStairs).mode).toBe('stairs')
    expect(chooseDayTransport(request(), neverStairs)).toMatchObject({
      mode: 'elevator', reason: 'probability', stairProbability: 0,
    })
  })

  it('keeps one two-floor choice across every search hop without a second draw', () => {
    const choice = chooseDayTransport(request({ fromFloor: 2, toFloor: 4 }), settings())
    const segments = applyTransportChoiceToPath(choice, [2, 3, 4], 10, settings())
    expect(segments).toHaveLength(2)
    expect(segments.every((segment) => segment.mode === choice.mode)).toBe(true)
    expect(segments.every((segment) => segment.randomDraw === choice.randomDraw)).toBe(true)
    expect(segments.map(({ fromFloor, toFloor }) => [fromFloor, toFloor])).toEqual([[2, 3], [3, 4]])
  })

  it('encodes string boundaries without keyed random collisions', () => {
    const first = chooseDayTransport(request({ journeyId: 'a|b', legId: 'c' }), settings())
    const second = chooseDayTransport(request({ journeyId: 'a', legId: 'b|c' }), settings())
    expect(first.randomDraw).not.toBe(second.randomDraw)
  })

  it('changes the keyed draw when actual route floors change', () => {
    const first = chooseDayTransport(request({ fromFloor: 2, toFloor: 3 }), settings())
    const second = chooseDayTransport(request({ fromFloor: 3, toFloor: 4 }), settings())
    expect(first.randomDraw).not.toBe(second.randomDraw)
  })

  it('validates route identity, floors and stair settings', () => {
    expect(() => chooseDayTransport(request({ seed: -1 }), settings())).toThrow('Seed')
    expect(() => chooseDayTransport(request({ journeyId: '' }), settings())).toThrow('непустые')
    expect(() => chooseDayTransport(request({ toFloor: 11 }), settings())).toThrow('внутри здания')
    expect(() => chooseDayTransport(request(), settings({ secondsPerFloor: 0 }))).toThrow('от 1 до 120')
    expect(() => chooseDayTransport(request(), settings({ maxVoluntaryFloors: 7 }))).toThrow('от 1 до 6')
    expect(() => chooseDayTransport(request(), settings({ convenientProbabilities: [0.5] }))).toThrow('от 1 до 6 этажей')
    expect(() => chooseDayTransport(request(), settings({ inconvenientProbabilities: [0, 0, 0, 0, 0, 2] }))).toThrow('от 0 до 1')
    expect(() => chooseDayTransport(request(), settings({ convenientProbabilities: Array(6) }))).toThrow('от 0 до 1')
    expect(() => chooseDayTransport(request(), settings({ convenient: 'yes' as unknown as boolean }))).toThrow('логическим')
    expect(() => chooseDayTransport(request({ mandatoryStairs: 'yes' as unknown as boolean }), settings())).toThrow('логическим')
    expect(() => chooseDayTransport(request({ journeyId: 1 as unknown as string }), settings())).toThrow('непустые')
    const choice = chooseDayTransport(request(), settings())
    expect(() => applyTransportChoiceToPath(choice, [2, 4], 1, settings())).toThrow('от 2 до 100')
  })
})
