import { describe, expect, it } from 'vitest'
import { createDefaultScenarioForm } from './scenarioForm'
import { reportFingerprint, trafficFingerprint } from './scenarioComparison'
import { compareMetric, comparisonCompatibility, type SavedScenario, type ScenarioSnapshot } from './savedScenarios'

function snapshot(form = createDefaultScenarioForm()): ScenarioSnapshot {
  return { snapshotVersion: 2, simulationModelVersion: 'personal-calendars-v1', trafficFingerprint: trafficFingerprint(form), reportFingerprint: reportFingerprint(form), waitingMeanSeconds: 10, waitingP90Seconds: 20, totalMeanSeconds: 30, maximumQueue: 4, emptyFloorsTravelled: 5 }
}
function saved(id: string, form = createDefaultScenarioForm()): SavedScenario { return { id, name: id, comment: '', savedAt: 'now', form, snapshot: snapshot(form) } }

describe('scenario comparison', () => {
  it('keeps elevator hypotheses out of the traffic fingerprint', () => {
    const base = createDefaultScenarioForm()
    expect(trafficFingerprint({ ...base, elevatorCount: 9, elevatorCapacity: 20, secondsPerFloor: 8, initialElevatorFloors: Array(9).fill(1), parkingByElevator: Array(9).fill(base.parkingByElevator[0]) })).toBe(trafficFingerprint(base))
    expect(trafficFingerprint({ ...base, floors: base.floors.map((floor) => floor.floor === 2 ? { ...floor, served: false } : floor) })).toBe(trafficFingerprint(base))
  })

  it('detects changed demand and separates report settings', () => {
    const base = createDefaultScenarioForm()
    expect(trafficFingerprint({ ...base, arrivalPrimaryShare: 0.7 })).not.toBe(trafficFingerprint(base))
    expect(trafficFingerprint({ ...base, reportDayStart: 13 * 60 })).toBe(trafficFingerprint(base))
    expect(reportFingerprint({ ...base, reportDayStart: 13 * 60 })).not.toBe(reportFingerprint(base))
  })

  it('compares absolute and relative changes including a zero baseline', () => {
    expect(compareMetric(80, 100)).toEqual({ absoluteDelta: -20, relativeDelta: -0.2, verdict: 'better' })
    expect(compareMetric(1, 0)).toEqual({ absoluteDelta: 1, relativeDelta: null, verdict: 'worse' })
    expect(compareMetric(0, 0)).toEqual({ absoluteDelta: 0, relativeDelta: 0, verdict: 'same' })
    expect(compareMetric(80, 100, false).verdict).toBe('not-comparable')
  })

  it('allows a verdict only for the same model and traffic', () => {
    const base = saved('base')
    expect(comparisonCompatibility(base, saved('same')).paired).toBe(true)
    const changed = createDefaultScenarioForm()
    const different = saved('different', { ...changed, arrivalPrimaryShare: 0.7 })
    expect(comparisonCompatibility(base, different)).toMatchObject({ paired: false, reasons: ['Различаются сотрудники или расписание дня'] })
  })
})
