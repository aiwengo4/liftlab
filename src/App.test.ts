import { describe, expect, it } from 'vitest'
import { replicateMaintenanceSettings, replicateParkingSettings } from './App'
import { createDefaultScenarioForm, type ScenarioFormState } from './scenarioForm'

describe('parking settings actions', () => {
  it('copies one elevator schedule to every elevator with independent intervals', () => {
    const initial = createDefaultScenarioForm()
    const form: ScenarioFormState = {
      ...initial,
      parkingByElevator: [
        { enabled: true, timeoutSeconds: 45, intervals: [{ startMinute: 480, endMinute: 720, floor: 3 }] },
        { enabled: false, timeoutSeconds: 60, intervals: [] },
      ],
    }
    let patch: Partial<ScenarioFormState> = {}

    replicateParkingSettings(0, form, (next) => { patch = next })

    expect(patch.parkingByElevator).toEqual([form.parkingByElevator[0], form.parkingByElevator[0]])
    expect(patch.parkingByElevator?.[0]).not.toBe(patch.parkingByElevator?.[1])
    expect(patch.parkingByElevator?.[0].intervals[0]).not.toBe(patch.parkingByElevator?.[1].intervals[0])
  })
})

describe('repair settings actions', () => {
  it('copies independent repair intervals to every elevator', () => {
    const initial = createDefaultScenarioForm()
    const form = { ...initial, maintenanceByElevator: [{ enabled: true, intervals: [{ startMinute: 0, endMinute: 1440 }] }, { enabled: false, intervals: [] }] }
    let patch: Partial<ScenarioFormState> = {}
    replicateMaintenanceSettings(0, form, (next) => { patch = next })
    expect(patch.maintenanceByElevator?.[1]).toEqual(form.maintenanceByElevator[0])
    expect(patch.maintenanceByElevator?.[0].intervals[0]).not.toBe(patch.maintenanceByElevator?.[1].intervals[0])
  })
})
