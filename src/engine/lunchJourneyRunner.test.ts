import { describe, expect, it } from 'vitest'
import type { Elevator, Employee } from './domain'
import type { EmployeeLunch, LunchSchedule } from './lunchSchedule'
import { runLunchJourneyScenario } from './lunchJourneyRunner'
import { DEFAULT_STAIR_CHOICE_SETTINGS } from './routeChoice'
import { createSimulationState } from './state'
import { DEFAULT_ELEVATOR_TIMING } from './timing'
import { minuteToSimulationTick } from './journeyRunner'
import { ticksToSeconds } from './time'

function elevator(): Elevator {
  return {
    id: 1, capacity: 6, currentFloor: 1, direction: 'idle', state: 'idle-closed', passengerIds: [],
    assignedCallIds: [], scheduledStops: [], mandatoryCallId: null, movement: null,
    pendingBoardingEmployeeIds: [], doorServiceEndsAt: null, parkingFloor: null, parkingTimeoutAt: null,
  }
}

function employee(id = 1, floor = 3): Employee {
  return { id, homeFloor: floor, currentFloor: floor, targetFloor: floor, state: 'arrived', activeCallId: null, elevatorId: null }
}

function lunch(overrides: Partial<EmployeeLunch> = {}): EmployeeLunch {
  return {
    employeeId: 1, cafeteriaFloor: 1, desiredStartMinute: 60, startMinute: 60,
    returnStartMinute: 90, shiftedFromDesired: false, ...overrides,
  }
}

function schedule(lunches: EmployeeLunch[], skippedEmployeeIds: number[] = []): LunchSchedule {
  return { lunches, skippedEmployeeIds }
}

const stairsOnly = {
  ...DEFAULT_STAIR_CHOICE_SETTINGS, maxVoluntaryFloors: 6,
  convenientProbabilities: [1, 1, 1, 1, 1, 1],
}
const elevatorOnly = { ...stairsOnly, convenientProbabilities: [0, 0, 0, 0, 0, 0] }

function settings(stairSettings = stairsOnly) {
  return { seed: 42, floorCount: 7, elevatorTiming: DEFAULT_ELEVATOR_TIMING, stairSettings }
}

describe('runLunchJourneyScenario', () => {
  it('executes stairs to the cafeteria and an independent return home', () => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee()] })
    const result = runLunchJourneyScenario(state, schedule([lunch()]), settings())
    expect(result.traces.map((trace) => [trace.purpose, trace.fromFloor, trace.targetFloor])).toEqual([
      ['lunch', 3, 1], ['lunch-return', 1, 3],
    ])
    expect(result.traces.every((trace) => trace.choice.mode === 'stairs')).toBe(true)
    expect(result.traces.every((trace) => ticksToSeconds(trace.stairsTicks) === 30)).toBe(true)
    expect(state.employees.get(1)?.currentFloor).toBe(3)
  })

  it('uses the elevator dispatcher in both directions', () => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee()] })
    const result = runLunchJourneyScenario(state, schedule([lunch()]), settings(elevatorOnly))
    expect(result.traces.map((trace) => trace.choice.mode)).toEqual(['elevator', 'elevator'])
    expect(result.traces.every((trace) => trace.waitingTicks > 0 && trace.ridingTicks > 0)).toBe(true)
    expect(state.hallCalls.size).toBe(2)
  })

  it('waits until the configured interval ends when the cafeteria is on the same floor', () => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee()] })
    const result = runLunchJourneyScenario(state, schedule([lunch({ cafeteriaFloor: 3 })]), settings())
    expect(result.traces.map((trace) => trace.choice.mode)).toEqual(['none', 'none'])
    expect(result.lunches[0].actualReturnStartAt).toBe(minuteToSimulationTick(90))
    expect(state.hallCalls.size).toBe(0)
  })

  it('keeps results stable when lunch input order changes', () => {
    const entries = [lunch(), lunch({ employeeId: 2, startMinute: 61, desiredStartMinute: 61, returnStartMinute: 91 })]
    const execute = (values: EmployeeLunch[]) => runLunchJourneyScenario(
      createSimulationState({ elevators: [elevator()], employees: [employee(1), employee(2, 4)] }),
      schedule(values), settings(),
    ).lunches
    expect(execute(entries)).toEqual(execute([...entries].reverse()))
  })

  it('creates no routes for skipped employees', () => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee()] })
    const result = runLunchJourneyScenario(state, schedule([], [1]), settings())
    expect(result.traces).toEqual([])
    expect(result.lunches).toEqual([])
  })

  it('rejects invalid schedules before changing simulation state', () => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee()] })
    expect(() => runLunchJourneyScenario(state, schedule([lunch(), lunch()]), settings())).toThrow('повторно')
    expect(state.currentTime).toBe(0)
    expect(() => runLunchJourneyScenario(state, schedule([lunch({ cafeteriaFloor: 8 })]), settings())).toThrow('внутри здания')
    expect(() => runLunchJourneyScenario(state, schedule([lunch({ shiftedFromDesired: true })]), settings())).toThrow('не соответствует')
    expect(() => runLunchJourneyScenario(state, schedule([], [99]), settings())).toThrow('не найден')
  })

  it('starts returning immediately after arrival when the outbound trip exceeds duration', () => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee()] })
    const slowTiming = { ...DEFAULT_ELEVATOR_TIMING, secondsPerFloor: 600 }
    const result = runLunchJourneyScenario(state, schedule([lunch({ returnStartMinute: 75 })]), {
      ...settings(elevatorOnly), elevatorTiming: slowTiming,
    })
    expect(result.lunches[0].actualReturnStartAt).toBe(result.lunches[0].outbound.completedAt)
  })

  it.each([15, 37, 60])('preserves a %i minute interval between movement starts', (duration) => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee()] })
    const result = runLunchJourneyScenario(state, schedule([lunch({ returnStartMinute: 60 + duration })]), settings())
    expect(result.lunches[0].actualReturnStartAt - result.lunches[0].actualStartAt).toBe(minuteToSimulationTick(duration))
  })

  it('reports the actual return start when another same-time route delays it', () => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee()] })
    const result = runLunchJourneyScenario(state, schedule([lunch({ cafeteriaFloor: 3 })]), {
      ...settings(),
      onJourneyCompleted: (trace) => trace.id === 'lunch-outbound-1' ? [{
        id: 'a-block-return', employeeId: 1, plannedStartAt: minuteToSimulationTick(90),
        targetFloor: 4, purpose: 'meeting', mandatoryStairs: true,
      }] : [],
    })
    expect(result.lunches[0].actualReturnStartAt).toBeGreaterThan(minuteToSimulationTick(90))
    expect(result.lunches[0].returnJourney.fromFloor).toBe(4)
  })
})
