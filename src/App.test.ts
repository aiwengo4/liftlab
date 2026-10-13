import { describe, expect, it } from 'vitest'
import { replicateParkingSettings } from './App'
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
