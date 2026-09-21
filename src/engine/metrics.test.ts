import { describe, expect, it } from 'vitest'
import type { JourneyTrace } from './journeyRunner'
import { calculateSimulationMetrics } from './metrics'
import { secondsToTicks } from './time'

function trace(
  id: string,
  startSeconds: number,
  values: { waiting?: number; riding?: number; stairs?: number; total: number; boarded?: boolean; employeeId?: number; purpose?: JourneyTrace['purpose']; reason?: JourneyTrace['choice']['reason'] },
): JourneyTrace {
  const actualStartAt = secondsToTicks(startSeconds)
  const mode = values.stairs && values.boarded === false ? 'stairs' : 'elevator'
  const reason = values.reason ?? (mode === 'stairs' ? 'probability' : 'outside-voluntary-limit')
  return {
    id,
    employeeId: values.employeeId ?? (Number(id.replace(/\D/g, '')) || 1),
    purpose: values.purpose ?? 'meeting',
    plannedStartAt: actualStartAt,
    actualStartAt,
    fromFloor: 1,
    targetFloor: 2,
    choice: { mode, stairProbability: mode === 'stairs' ? 1 : 0, randomDraw: mode === 'stairs' ? 0 : null, reason, fromFloor: 1, toFloor: 2, distanceFloors: 1, stairDurationSeconds: values.stairs ?? 0 },
    selectedChoice: { mode, stairProbability: mode === 'stairs' ? 1 : 0, randomDraw: mode === 'stairs' ? 0 : null, reason, fromFloor: 1, toFloor: 2, distanceFloors: 1, stairDurationSeconds: values.stairs ?? 0 },
    boardedAt: values.boarded === false ? null : actualStartAt,
    completedAt: secondsToTicks(startSeconds + values.total),
    waitingTicks: secondsToTicks(values.waiting ?? 0),
    ridingTicks: secondsToTicks(values.riding ?? 0),
    stairsTicks: secondsToTicks(values.stairs ?? 0),
    totalTicks: secondsToTicks(values.total),
  }
}

describe('calculateSimulationMetrics', () => {
  it('calculates deterministic aggregates without mutating input', () => {
    const traces = [
      trace('route-4', 10 * 3600, { waiting: 40, riding: 80, total: 120 }),
      trace('route-1', 10 * 3600, { waiting: 10, riding: 20, total: 30 }),
      trace('route-3', 10 * 3600, { waiting: 30, riding: 60, total: 90 }),
      trace('route-2', 10 * 3600, { waiting: 20, riding: 40, total: 60 }),
    ]
    const originalOrder = traces.map((item) => item.id)
    const result = calculateSimulationMetrics(traces)
    expect(traces.map((item) => item.id)).toEqual(originalOrder)
    expect(result.wholeDay.waiting).toEqual({ sampleSize: 4, meanSeconds: 25, medianSeconds: 25, p75Seconds: 30, p90Seconds: 40, p95Seconds: 40 })
    expect(result.wholeDay.riding.meanSeconds).toBe(50)
    expect(result.wholeDay.total.medianSeconds).toBe(75)
    expect(result.wholeDay.waitingDistributionSeconds).toEqual([10, 20, 30, 40])
  })

  it('classifies by actual start using half-open period and hour boundaries', () => {
    const traces = [
      trace('at-0800', 8 * 3600, { total: 1 }),
      trace('crossing', 10 * 3600 + 59 * 60 + 59.9, { total: 120.1 }),
      trace('at-1200', 12 * 3600, { total: 1 }),
      trace('at-1800', 18 * 3600, { total: 1 }),
      trace('at-2300', 23 * 3600, { total: 1 }),
    ]
    const result = calculateSimulationMetrics(traces)
    expect(result.morning.routeCount).toBe(2)
    expect(result.day.routeCount).toBe(1)
    expect(result.evening.routeCount).toBe(1)
    expect(result.hours[10].routeCount).toBe(1)
    expect(result.hours[11].routeCount).toBe(0)
    expect(result.hours[23].routeCount).toBe(1)
    expect(result.wholeDay.routeCount).toBe(5)
  })

  it('excludes pure stairs and no-boarding routes from elevator metrics', () => {
    const values = [
      trace('elevator-1', 9 * 3600, { waiting: 10, riding: 20, total: 30 }),
      trace('stairs-2', 9 * 3600, { stairs: 15, total: 15, boarded: false }),
      trace('compound-3', 9 * 3600, { waiting: 20, riding: 25, stairs: 10, total: 55 }),
      trace('lobby-only-4', 9 * 3600, { total: 30, stairs: 30, boarded: false }),
    ]
    const result = calculateSimulationMetrics(values)
    expect(result.wholeDay.waiting.sampleSize).toBe(2)
    expect(result.wholeDay.riding.sampleSize).toBe(2)
    expect(result.wholeDay.total.sampleSize).toBe(4)
    expect(result.wholeDay.routeGroups.elevator).toMatchObject({ routeCount: 2, shareOfAllRoutes: 0.5 })
    expect(result.wholeDay.routeGroups.elevator.total.medianSeconds).toBe(42.5)
    expect(result.wholeDay.routeGroups.stairs).toMatchObject({ routeCount: 2, shareOfAllRoutes: 0.5 })
    expect(result.wholeDay.routeGroups.stairs.total.medianSeconds).toBe(22.5)
    expect(result.wholeDay.routeGroups.all).toMatchObject({ routeCount: 4, shareOfAllRoutes: 1 })
    expect(result.hours[9].routeGroups.elevator.total.medianSeconds).toBe(42.5)
    expect(result.hours[9].routeGroups.stairs.total.medianSeconds).toBe(22.5)
    expect(result.hours[9].total.medianSeconds).toBe(30)
    expect(result.counters.combinedRoutes).toBe(1)
  })

  it('returns null rather than zero or NaN for empty samples', () => {
    const result = calculateSimulationMetrics([])
    expect(result.wholeDay.waiting).toEqual({ sampleSize: 0, meanSeconds: null, medianSeconds: null, p75Seconds: null, p90Seconds: null, p95Seconds: null })
    expect(result.wholeDay.longWaits[0].share).toBeNull()
    expect(result.counters.voluntaryStairsEmployeeShare).toBeNull()
    expect(result.hours).toHaveLength(24)
  })

  it('excludes same-floor calendar events from route metrics', () => {
    const movement = trace('movement-1', 9 * 3600, { waiting: 10, riding: 20, total: 30 })
    const noMovement = {
      ...trace('same-floor-2', 10 * 3600, { total: 0, boarded: false }),
      fromFloor: 2,
      targetFloor: 2,
    }

    const result = calculateSimulationMetrics([movement, noMovement])

    expect(result.wholeDay.routeCount).toBe(1)
    expect(result.wholeDay.routeGroups.elevator.routeCount).toBe(1)
    expect(result.wholeDay.routeGroups.stairs.routeCount).toBe(0)
    expect(result.wholeDay.total.medianSeconds).toBe(30)
    expect(result.counters.completedRoutes).toBe(1)
  })

  it('uses strict long-wait thresholds and allows custom values', () => {
    const result = calculateSimulationMetrics([
      trace('exact-1', 9 * 3600, { waiting: 120, total: 121 }),
      trace('over-2', 9 * 3600, { waiting: 120.1, total: 121 }),
      trace('more-3', 9 * 3600, { waiting: 241, total: 242 }),
    ], { longWaitThresholdSeconds: [120, 240] })
    expect(result.wholeDay.longWaits).toEqual([
      { thresholdSeconds: 120, count: 2, share: 2 / 3 },
      { thresholdSeconds: 240, count: 1, share: 1 / 3 },
    ])
  })

  it('counts unique employees and distinguishes voluntary from mandatory stairs', () => {
    const first = trace('arrival-1', 9 * 3600, { total: 10, employeeId: 1, purpose: 'arrival' })
    const stairsA = trace('stairs-a-1', 13 * 3600, { stairs: 10, total: 10, boarded: false, employeeId: 1 })
    const stairsB = trace('stairs-b-1', 14 * 3600, { stairs: 10, total: 10, boarded: false, employeeId: 1 })
    const combined = trace('departure-2', 19 * 3600, { riding: 10, stairs: 10, total: 20, employeeId: 2, purpose: 'departure' })
    const mandatory = trace('mandatory-3', 15 * 3600, { stairs: 10, total: 10, boarded: false, employeeId: 3, reason: 'mandatory' })
    const result = calculateSimulationMetrics([first, stairsA, stairsB, combined, mandatory])
    expect(result.counters).toMatchObject({ arrivedEmployees: 1, departedEmployees: 1, employeesUsingVoluntaryStairs: 1, voluntaryStairsEmployeeShare: 1 / 3, combinedRoutes: 1, completedRoutes: 5 })
  })

  it('rejects broken periods, thresholds and duplicate traces', () => {
    expect(() => calculateSimulationMetrics([], { periods: { morning: { startMinute: 480, endMinute: 720 }, day: { startMinute: 721, endMinute: 1080 }, evening: { startMinute: 1080, endMinute: 1380 } } })).toThrow('разрывы')
    expect(() => calculateSimulationMetrics([], { longWaitThresholdSeconds: [240, 120] })).toThrow('возрастающими')
    const value = trace('same-1', 9 * 3600, { total: 1 })
    expect(() => calculateSimulationMetrics([value, value])).toThrow('повторно')
  })
})
