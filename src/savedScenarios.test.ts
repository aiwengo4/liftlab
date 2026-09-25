import { describe, expect, it } from 'vitest'
import { createDefaultScenarioForm } from './scenarioForm'
import { loadSavedScenarios, makeSavedScenario, MAX_SAVED_SCENARIOS, metricDelta, persistSavedScenarios, SAVED_SCENARIOS_KEY } from './savedScenarios'
import { uniqueCopyName } from './SavedScenariosView'
import { reportFingerprint, SIMULATION_MODEL_VERSION, trafficFingerprint } from './scenarioComparison'

function memory(initial: string | null = null) {
  let value = initial
  return { getItem: () => value, setItem: (_key: string, next: string) => { value = next }, value: () => value }
}

describe('saved scenarios', () => {
  it('persists and loads a versioned collection', () => {
    const storage = memory()
    const item = makeSavedScenario(createDefaultScenarioForm(), null, ' База ', ' заметка ', 'id-1', '2026-01-01T00:00:00.000Z')
    persistSavedScenarios(storage, [item])
    expect(JSON.parse(storage.value()!).version).toBe(1)
    expect(loadSavedScenarios(storage)).toEqual([{ ...item, name: 'База', comment: 'заметка' }])
  })
  it('recovers from corrupt storage and filters corrupt records', () => {
    expect(loadSavedScenarios(memory('{bad'))).toEqual([])
    expect(loadSavedScenarios(memory(JSON.stringify({ version: 1, items: [{ id: 1 }] })))).toEqual([])
  })
  it('marks a migrated meeting model and clears only its stale result', () => {
    const current = makeSavedScenario(createDefaultScenarioForm(), null, 'Current', '', 'current', 'now')
    const { meetingRoomFoundSharesByHour: _hourly, ...legacyForm } = current.form
    const legacy = { ...current, id: 'legacy', form: legacyForm, snapshot: { waitingMeanSeconds: 1, waitingP90Seconds: 2, totalMeanSeconds: 3, maximumQueue: 4, emptyFloorsTravelled: 5 } }
    const [loadedLegacy, loadedCurrent] = loadSavedScenarios(memory(JSON.stringify({ version: 1, items: [legacy, current] })))
    expect(loadedLegacy).toMatchObject({ snapshot: null, migratedFromLegacy: true })
    expect(loadedLegacy.form.meetingRoomFoundSharesByHour).toEqual(Array(24).fill(0.8))
    expect(loadedCurrent.snapshot).toBeNull()
    expect(loadedCurrent.migratedFromLegacy).toBeUndefined()
  })
  it('sanitizes migration markers and never keeps a legacy snapshot', () => {
    const current = makeSavedScenario(createDefaultScenarioForm(), null, 'Current', '', 'current', 'now')
    const snapshot = { waitingMeanSeconds: 1, waitingP90Seconds: 2, totalMeanSeconds: 3, maximumQueue: 4, emptyFloorsTravelled: 5 }
    const [malformed, persisted] = loadSavedScenarios(memory(JSON.stringify({ version: 1, items: [
      { ...current, id: 'bad', migratedFromLegacy: 'yes' },
      { ...current, id: 'old', migratedFromLegacy: true, snapshot },
    ] })))
    expect(malformed.migratedFromLegacy).toBeUndefined()
    expect(persisted).toMatchObject({ migratedFromLegacy: true, snapshot: null })
  })
  it('invalidates a snapshot attached to different traffic settings', () => {
    const form = createDefaultScenarioForm()
    const changed = { ...form, arrivalPrimaryShare: 0.7 }
    const item = makeSavedScenario(changed, null, 'Stale', '', 'stale', 'now')
    const staleSnapshot = { snapshotVersion: 2, simulationModelVersion: SIMULATION_MODEL_VERSION, trafficFingerprint: trafficFingerprint(form), reportFingerprint: reportFingerprint(changed), waitingMeanSeconds: 1, waitingP90Seconds: 2, totalMeanSeconds: 3, maximumQueue: 4, emptyFloorsTravelled: 5 }
    const [loaded] = loadSavedScenarios(memory(JSON.stringify({ version: 1, items: [{ ...item, snapshot: staleSnapshot }] })))
    expect(loaded).toMatchObject({ snapshot: null, snapshotNeedsUpgrade: true })
  })
  it('keeps version 2 results and marks unavailable medians as empty', () => {
    const form = createDefaultScenarioForm()
    const item = makeSavedScenario(form, null, 'Old result', '', 'old-result', 'now')
    const snapshot = { snapshotVersion: 2, simulationModelVersion: SIMULATION_MODEL_VERSION, trafficFingerprint: trafficFingerprint(form), reportFingerprint: reportFingerprint(form), waitingMeanSeconds: 10, waitingP90Seconds: 30, totalMeanSeconds: 40, maximumQueue: 5, emptyFloorsTravelled: 6 }
    const [loaded] = loadSavedScenarios(memory(JSON.stringify({ version: 1, items: [{ ...item, snapshot }] })))

    expect(loaded.snapshot).toMatchObject({ snapshotVersion: 3, waitingMedianSeconds: null, totalMedianSeconds: null })
    expect(loaded.snapshotNeedsUpgrade).toBeUndefined()
  })
  it('enforces names, comments and the maximum collection size', () => {
    expect(() => makeSavedScenario(createDefaultScenarioForm(), null, ' ', '', 'x', 'now')).toThrow('Название')
    const item = makeSavedScenario(createDefaultScenarioForm(), null, 'A', '', 'x', 'now')
    expect(() => persistSavedScenarios(memory(), Array.from({ length: MAX_SAVED_SCENARIOS + 1 }, () => item))).toThrow('20')
  })
  it('calculates signed relative changes and handles zero/null baselines', () => {
    expect(metricDelta(80, 100)).toBe(-0.2)
    expect(metricDelta(120, 100)).toBe(0.2)
    expect(metricDelta(1, 0)).toBeNull()
    expect(metricDelta(0, 0)).toBe(0)
    expect(metricDelta(null, 10)).toBeNull()
  })
  it('uses the documented storage key', () => { expect(SAVED_SCENARIOS_KEY).toContain('v1') })
  it('creates finite unique copy names for an 80-character source', () => {
    const name = 'A'.repeat(80)
    const first = uniqueCopyName(name, [])
    const second = uniqueCopyName(name, [{ name: first } as never])
    expect(first).toHaveLength(80)
    expect(second).toHaveLength(80)
    expect(second).not.toBe(first)
  })
})
