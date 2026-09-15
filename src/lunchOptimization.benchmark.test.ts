import { describe, expect, it } from 'vitest'
import { createDefaultScenarioForm, distributeEmployees, resizeElevators } from './scenarioForm'
import { runScenarioFromForm } from './scenarioRunner'
import { ticksToSeconds } from './engine/time'

const enabled = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.RUN_LUNCH_OPTIMIZATION_BENCHMARK === '1'

describe.skipIf(!enabled)('lunch optimization A/B benchmark', () => {
  it('compares duration jitter and overload stairs independently and together', () => {
    const sizes = [{ employees: 4_000, elevators: 4 }, { employees: 5_000, elevators: 6 }, { employees: 10_000, elevators: 10 }]
    const variants = [
      { variant: 'current', jitter: 0, stairs: false },
      { variant: 'duration-jitter', jitter: 15, stairs: false },
      { variant: 'overload-stairs', jitter: 0, stairs: true },
      { variant: 'both', jitter: 15, stairs: true },
    ]
    const rows = []
    for (const size of sizes) for (const variant of variants) {
      const resized = resizeElevators(createDefaultScenarioForm(), size.elevators)
      const form = distributeEmployees({
        ...resized,
        totalEmployees: size.employees,
        distributionMode: 'equal',
        elevatorCapacity: 10,
        lunchDurationJitterMinutes: variant.jitter,
        lunchOverloadStairsEnabled: variant.stairs,
      })
      const started = performance.now()
      const result = runScenarioFromForm(form)
      const elapsed = Math.round(performance.now() - started)
      const lunchElevator = result.traces.filter((trace) => trace.purpose === 'lunch' && trace.boardedAt !== null)
      const waits = lunchElevator.map((trace) => ticksToSeconds(trace.waitingTicks)).sort((a, b) => a - b)
      rows.push({
        employees: size.employees,
        elevators: size.elevators,
        variant: variant.variant,
        milliseconds: elapsed,
        lunchElevatorRoutes: waits.length,
        overloadStairRoutes: result.traces.filter((trace) => trace.purpose === 'lunch' && trace.choice.reason === 'lunch-overload' && trace.choice.mode === 'stairs').length,
        lunchWaitMeanSeconds: Math.round(waits.reduce((sum, value) => sum + value, 0) / Math.max(1, waits.length)),
        lunchWaitP90Seconds: waits[Math.max(0, Math.ceil(waits.length * 0.9) - 1)] ?? 0,
      })
      expect(result.metrics.counters.departedEmployees).toBe(size.employees)
    }
    console.table(rows)
  }, 600_000)
})
