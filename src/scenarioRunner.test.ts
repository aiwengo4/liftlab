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
      { seed: 7, employees: 8, routes: 74, events: 400, outcomeDigest: '35ff758abbc5bd58', digest: '305a75a68aa977ba' },
      { seed: 42, employees: 12, routes: 114, events: 656, outcomeDigest: '3b40be026120790a', digest: '1ec43e04c471d200' },
      { seed: 2026, employees: 16, routes: 148, events: 793, outcomeDigest: '81c86f21d304495e', digest: 'ba575894b83e1f1c' },
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
      routes: 2360,
      events: 12178,
      outcomeDigest: '768a7cef64baf54f',
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
    expect(result.metrics.wholeDay.longWaits.map((item) => item.thresholdSeconds)).toEqual([1, 2, 3])
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
