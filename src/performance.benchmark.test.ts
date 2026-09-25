import { describe, expect, it } from 'vitest'
import { createDefaultScenarioForm, distributeEmployees, resizeElevators } from './scenarioForm'
import { runScenarioFromForm } from './scenarioRunner'
import { prepareBrowserResult } from './browserResult'

const enabled = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.RUN_PERFORMANCE_BENCHMARK === '1'
const selectedCount = Number((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.BENCHMARK_EMPLOYEES)
const selectedMeetings = Number((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.BENCHMARK_MEETINGS)
const selectedElevators = Number((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.BENCHMARK_ELEVATORS)
const wholeHourBiasEnabled = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.BENCHMARK_HOUR_BIAS === '1'

describe.skipIf(!enabled)('full-day performance benchmark', () => {
  it('measures representative default scenarios', () => {
    const employeeCounts = Number.isSafeInteger(selectedCount) && selectedCount > 0 ? [selectedCount] : [100, 1_000, 5_000, 10_000]
    const measurements: { employees: number; elevators: number; milliseconds: number; serializeMilliseconds: number; payloadMegabytes: number; uiPayloadMegabytes: number; routes: number; events: number; dispatches: number }[] = []
    for (const totalEmployees of employeeCounts) {
      const base = Number.isSafeInteger(selectedElevators) && selectedElevators > 0
        ? resizeElevators(createDefaultScenarioForm(), selectedElevators)
        : createDefaultScenarioForm()
      const form = distributeEmployees({
        ...base,
        totalEmployees,
        distributionMode: 'equal',
        wholeHourBiasEnabled,
        ...(Number.isFinite(selectedMeetings) && selectedMeetings >= 0
          ? { meanMeetingsPerEmployee: selectedMeetings }
          : {}),
      })
      const startedAt = performance.now()
      const result = runScenarioFromForm(form)
      const milliseconds = Math.round(performance.now() - startedAt)
      const serializeStartedAt = performance.now()
      const serialized = JSON.stringify(result)
      const serializeMilliseconds = Math.round(performance.now() - serializeStartedAt)
      measurements.push({
        employees: totalEmployees,
        elevators: form.elevatorCount,
        milliseconds,
        serializeMilliseconds,
        payloadMegabytes: Math.round(new TextEncoder().encode(serialized).length / 10_000) / 100,
        uiPayloadMegabytes: Math.round(new TextEncoder().encode(JSON.stringify(prepareBrowserResult(result))).length / 10_000) / 100,
        routes: result.metrics.counters.completedRoutes,
        events: result.processedEvents.length,
        dispatches: result.processedEvents.filter((event) => event.kind === 'dispatch-requested').length,
      })
      expect(result.metrics.counters.arrivedEmployees).toBe(totalEmployees)
      expect(result.metrics.counters.departedEmployees).toBe(totalEmployees)
    }
    console.table(measurements)
  }, 600_000)
})
