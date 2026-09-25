import { describe, expect, it } from 'vitest'
import { createDefaultScenarioForm, distributeEmployees } from './scenarioForm'
import { runScenarioFromForm } from './scenarioRunner'

describe('runScenarioFromForm', () => {
  it('matches compact golden results for several deterministic seeds', () => {
    const cases = [
      { seed: 7, employees: 8 },
      { seed: 42, employees: 12 },
      { seed: 2026, employees: 16 },
    ]

    const actual = cases.map(({ seed, employees }) => {
      const form = distributeEmployees({
        ...createDefaultScenarioForm(),
        seed,
        totalEmployees: employees,
        distributionMode: 'equal' as const,
      })
      const result = runScenarioFromForm(form)
      const outcome = {
        traces: result.traces,
        metrics: result.metrics,
        operations: result.operationalMetrics,
        meetings: result.meetings,
        bookings: result.bookings,
        lunches: result.lunches,
        runtimeSkippedLunches: result.runtimeSkippedLunches,
        allSkippedLunchEmployeeIds: result.allSkippedLunchEmployeeIds,
      }
      return {
        seed,
        employees,
        routes: result.metrics.counters.completedRoutes,
        events: result.processedEvents.length,
        outcomeDigest: goldenDigest(outcome),
        digest: goldenDigest({
          ...outcome,
          events: result.processedEvents,
        }),
      }
    })

    expect(actual).toEqual([
      { seed: 7, employees: 8, routes: 60, events: 400, outcomeDigest: '0367bf6fce5a582c', digest: 'b748a547147e1416' },
      { seed: 42, employees: 12, routes: 82, events: 656, outcomeDigest: '1fb5886c365b8b50', digest: '83df9201d9929c5e' },
      { seed: 2026, employees: 16, routes: 94, events: 793, outcomeDigest: '8b7d1f2cd8fc6564', digest: '4ea6d1c45f396b62' },
    ])
  })

  it('preserves a dispatch-sensitive medium scenario', () => {
    const form = distributeEmployees({
      ...createDefaultScenarioForm(),
      totalEmployees: 250,
      distributionMode: 'equal',
    })
    const result = runScenarioFromForm(form)
    const outcome = {
      traces: result.traces,
      metrics: result.metrics,
      operations: result.operationalMetrics,
      meetings: result.meetings,
      bookings: result.bookings,
      lunches: result.lunches,
      runtimeSkippedLunches: result.runtimeSkippedLunches,
      allSkippedLunchEmployeeIds: result.allSkippedLunchEmployeeIds,
    }

    expect({
      routes: result.metrics.counters.completedRoutes,
      events: result.processedEvents.length,
      outcomeDigest: goldenDigest(outcome),
    }).toEqual({
      routes: 1542,
      events: 12178,
      outcomeDigest: '3ba7e3fb18b4c4d2',
    })
  })

  it('runs a reproducible full day from validated UI settings', () => {
    const form = distributeEmployees({ ...createDefaultScenarioForm(), totalEmployees: 2, distributionMode: 'equal' })
    const first = runScenarioFromForm(form)
    const second = runScenarioFromForm(form)
    expect(first.traces).toEqual(second.traces)
    expect(first.metrics.counters.arrivedEmployees).toBe(2)
    expect(first.metrics.counters.departedEmployees).toBe(2)
  })

  it('runs a populated full day with whole-hour peaks enabled', () => {
    const form = distributeEmployees({
      ...createDefaultScenarioForm(),
      seed: 20260925,
      totalEmployees: 100,
      distributionMode: 'equal',
      wholeHourBiasEnabled: true,
      wholeHourBiasShare: 0.5,
    })
    const result = runScenarioFromForm(form)

    expect(result.metrics.counters.arrivedEmployees).toBe(100)
    expect(result.metrics.counters.departedEmployees).toBe(100)
    expect(result.metrics.counters.unfinishedRoutes).toBe(0)
    expect(result.metrics.wholeDay.routeCount).toBeGreaterThan(0)
  })

  it('rejects an invalid form before starting the engine', () => {
    expect(() => runScenarioFromForm(createDefaultScenarioForm())).toThrow('содержат ошибки')
  })

  it('keeps the passenger schedule when only elevator timing changes', () => {
    const form = distributeEmployees({ ...createDefaultScenarioForm(), totalEmployees: 3, distributionMode: 'equal' })
    const baseline = runScenarioFromForm(form)
    const changed = runScenarioFromForm({ ...form, secondsPerFloor: 9, elevatorCapacity: 3 })
    const flow = (result: typeof baseline) => result.traces.filter((trace) => trace.purpose === 'arrival' || trace.purpose === 'departure').map((trace) => [trace.employeeId, trace.purpose, trace.plannedStartAt, trace.fromFloor, trace.targetFloor])
    expect(flow(changed)).toEqual(flow(baseline))
  })

  it('supports an employee whose workplace is on the first floor', () => {
    const initial = createDefaultScenarioForm()
    const form = { ...initial, totalEmployees: 1, floors: initial.floors.map((floor) => floor.floor === 1 ? { ...floor, employees: 1 } : floor) }
    const result = runScenarioFromForm(form)
    expect(result.arrivals[0].fromFloor).toBe(1)
    expect(result.arrivals[0].targetFloor).toBe(1)
    expect(result.departures).toHaveLength(1)
  })

  it('passes advanced meeting, lunch and reporting settings to the engine', () => {
    const form = distributeEmployees({ ...createDefaultScenarioForm(), totalEmployees: 2, distributionMode: 'equal', meanMeetingsPerEmployee: 1, maxMeetingConcurrentShare: 1, lunchShare: 0, longWaitThresholds: [1, 2, 3] })
    const result = runScenarioFromForm(form)
    expect(result.meetings.reduce((sum, meeting) => sum + meeting.participants.length, 0)).toBe(2)
    expect(result.lunches).toHaveLength(0)
    expect(result.metrics.wholeDay.longWaits.map((item) => item.thresholdSeconds)).toEqual([1, 2, 3, 60, 90])
  })

  it('passes per-elevator parking settings to the full-day engine', () => {
    const initial = createDefaultScenarioForm()
    const form = distributeEmployees({ ...initial, totalEmployees: 1, distributionMode: 'equal', parkingByElevator: initial.parkingByElevator.map((parking,index) => index === 0 ? { enabled: true, timeoutSeconds: 0, intervals: [{ startMinute: 0, endMinute: 1, floor: 3 }] } : parking) })
    const result = runScenarioFromForm(form)
    expect(result.processedEvents.some((event) => event.kind === 'parking-step-arrived')).toBe(true)
    expect(result.operationalMetrics.group.resource.emptyFloorsTravelled).toBeGreaterThanOrEqual(2)
  })
})

function goldenDigest(value: unknown): string {
  const json = JSON.stringify(value)
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < json.length; index += 1) {
    hash ^= BigInt(json.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, '0')
}
