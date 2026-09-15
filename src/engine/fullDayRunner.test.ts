import { describe, expect, it } from 'vitest'
import type { Elevator, Employee } from './domain'
import type { DaySchedule } from './daySchedule'
import type { LunchSchedule } from './lunchSchedule'
import type { MeetingSchedule, PlannedMeeting } from './meetingSchedule'
import { runFullDayScenario } from './fullDayRunner'
import { createSimulationState } from './state'
import { DEFAULT_ELEVATOR_TIMING } from './timing'
import { DEFAULT_STAIR_CHOICE_SETTINGS } from './routeChoice'

function elevator(capacity = 6): Elevator {
  return { id: 1, capacity, currentFloor: 1, direction: 'idle', state: 'idle-closed', passengerIds: [], assignedCallIds: [], scheduledStops: [], mandatoryCallId: null, movement: null, pendingBoardingEmployeeIds: [], doorServiceEndsAt: null, parkingFloor: null, parkingTimeoutAt: null }
}
function employee(id: number, homeFloor: number): Employee {
  return { id, homeFloor, currentFloor: 1, targetFloor: 1, state: 'arrived', activeCallId: null, elevatorId: null }
}
function day(values: DaySchedule['employees']): DaySchedule {
  return { seed: 42, floorCount: 7, employees: values }
}
function meeting(id: number, employeeId: number, overrides: Partial<PlannedMeeting> = {}): PlannedMeeting {
  return { id, startMinute: 20, endMinute: 30, departureLeadMinutes: 2, participantIds: [employeeId], participantDepartures: [{ employeeId, departureMinute: 18 }], homeFloor: 3, searchRadius: 1, searchDirection: 'up', searchFloors: [4], roomFound: true, returnAfterFailedSearch: false, ...overrides }
}
function meetings(values: PlannedMeeting[] = []): MeetingSchedule {
  return { meetings: values, targetVisits: values.length, assignedVisits: values.length, unassignedVisits: 0 }
}
const noLunch: LunchSchedule = { lunches: [], skippedEmployeeIds: [] }
const stairsPreferred = { ...DEFAULT_STAIR_CHOICE_SETTINGS, convenientProbabilities: [1, 1, 1, 1, 1, 1], maxVoluntaryFloors: 6 }
const settings = { seed: 42, floorCount: 7, elevatorTiming: DEFAULT_ELEVATOR_TIMING, stairSettings: stairsPreferred }

describe('runFullDayScenario', () => {
  it('runs arrival and departure through one persistent elevator state', () => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee(1, 4)] })
    const result = runFullDayScenario(state, day([{ id: 1, homeFloor: 4, arrivalMinute: 0, departureMinute: 60 }]), meetings(), noLunch, settings)
    expect(result.arrivals.map((trace) => [trace.fromFloor, trace.targetFloor, trace.choice.mode])).toEqual([[1, 4, 'elevator']])
    expect(result.departures.map((trace) => [trace.fromFloor, trace.targetFloor, trace.choice.mode])).toEqual([[4, 1, 'elevator']])
    expect(state.employees.get(1)?.currentFloor).toBe(1)
    expect(state.hallCalls.size).toBe(2)
    expect(result.metrics.wholeDay.routeCount).toBe(2)
    expect(result.metrics.counters).toMatchObject({ arrivedEmployees: 1, departedEmployees: 1, completedRoutes: 2 })
    expect(result.operationalMetrics.elevators[0].resource.floorsTravelled).toBeGreaterThan(0)
    expect(result.operationalMetrics.group.resource.transportedPassengers).toBe(2)
    expect(result.operationalMetrics.queue.maximumWaitingInBuilding).toBeGreaterThan(0)
  })

  it('runs morning from and evening back to the same underground floor', () => {
    const undergroundEmployee = { ...employee(1, 2), currentFloor: -1, targetFloor: -1 }
    const schedule = day([{ id: 1, homeFloor: 2, arrivalMinute: 0, departureMinute: 60, arrivalFloor: -1, departureFloor: -1 }])
    const result = runFullDayScenario(
      createSimulationState({ elevators: [elevator()], employees: [undergroundEmployee] }),
      schedule,
      meetings(),
      noLunch,
      { ...settings, minFloor: -1, servedFloors: [-1, 1, 2, 3, 4, 5, 6, 7] },
    )

    expect(result.arrivals.map(({ fromFloor, targetFloor }) => [fromFloor, targetFloor])).toEqual([[-1, 2]])
    expect(result.departures.map(({ fromFloor, targetFloor }) => [fromFloor, targetFloor])).toEqual([[2, -1]])
    expect(result.state.employees.get(1)?.currentFloor).toBe(-1)
    expect(result.operationalMetrics.group.resource.floorsTravelled).toBeGreaterThanOrEqual(4)
  })

  it('uses one compatible cabin plus stairs for a zoned parking route', () => {
    const undergroundEmployee = { ...employee(1, 5), currentFloor: -1, targetFloor: -1 }
    const secondElevator = { ...elevator(), id: 2 }
    const result = runFullDayScenario(
      createSimulationState({ elevators: [elevator(), secondElevator], employees: [undergroundEmployee] }),
      day([{ id: 1, homeFloor: 5, arrivalMinute: 0, departureMinute: 60, arrivalFloor: -1, departureFloor: -1 }]),
      meetings(), noLunch,
      {
        ...settings,
        minFloor: -1,
        servedFloors: [-1, 1, 5],
        servedFloorsByElevator: [
          { elevatorId: 1, floors: [-1, 1] },
          { elevatorId: 2, floors: [1, 5] },
        ],
      },
    )

    expect(result.arrivals[0]).toMatchObject({ fromFloor: -1, targetFloor: 5 })
    expect(result.arrivals[0].stairsTicks).toBeGreaterThan(0)
    expect(result.departures[0].stairsTicks).toBeGreaterThan(0)
    expect([...result.state.hallCalls.values()].map(({ floor, assignedElevatorId }) => [floor, assignedElevatorId])).toEqual([[1, null], [5, null]])
    const boardedElevators = result.processedEvents.filter((event) => event.kind === 'passenger-entered').map((event) => (event.payload as { elevatorId: number }).elevatorId)
    expect(boardedElevators).toEqual([2, 2])
    expect(result.state.employees.get(1)?.currentFloor).toBe(-1)
  })

  it('uses arrival as a gate for a meeting due in the same minute', () => {
    const slow = { ...settings, elevatorTiming: { ...DEFAULT_ELEVATOR_TIMING, secondsPerFloor: 90 } }
    const value = meeting(1, 1, { startMinute: 2, endMinute: 10, participantDepartures: [{ employeeId: 1, departureMinute: 0 }] })
    const state = createSimulationState({ elevators: [elevator()], employees: [employee(1, 3)] })
    const result = runFullDayScenario(state, day([{ id: 1, homeFloor: 3, arrivalMinute: 0, departureMinute: 20 }]), meetings([value]), noLunch, slow)
    const arrival = result.arrivals[0]
    const search = result.traces.find((trace) => trace.id === 'meeting-1-search-0-1')!
    expect(search.actualStartAt).toBeGreaterThanOrEqual(arrival.completedAt)
    expect(search.fromFloor).toBe(3)
  })

  it('forces elevator morning and evening while daytime movement may use stairs', () => {
    const value = meeting(1, 1)
    const state = createSimulationState({ elevators: [elevator()], employees: [employee(1, 3)] })
    const result = runFullDayScenario(state, day([{ id: 1, homeFloor: 3, arrivalMinute: 0, departureMinute: 40 }]), meetings([value]), noLunch, settings)
    expect(result.arrivals[0].choice.mode).toBe('elevator')
    expect(result.traces.find((trace) => trace.id === 'meeting-1-search-0-1')?.choice.mode).toBe('stairs')
    expect(result.departures[0].choice.mode).toBe('elevator')
  })

  it('makes departure terminal after a delayed current meeting', () => {
    const slow = { ...settings, elevatorTiming: { ...DEFAULT_ELEVATOR_TIMING, secondsPerFloor: 180 }, stairSettings: { ...stairsPreferred, convenientProbabilities: [0, 0, 0, 0, 0, 0] } }
    const value = meeting(1, 1, { startMinute: 2, endMinute: 5, participantDepartures: [{ employeeId: 1, departureMinute: 1 }], searchRadius: 2, searchDirection: 'up', searchFloors: [4, 5] })
    const state = createSimulationState({ elevators: [elevator()], employees: [employee(1, 3)] })
    const result = runFullDayScenario(state, day([{ id: 1, homeFloor: 3, arrivalMinute: 0, departureMinute: 5 }]), meetings([value]), noLunch, slow)
    expect(result.departures).toHaveLength(1)
    expect(result.departures[0].actualStartAt).toBeGreaterThanOrEqual(result.arrivals[0].completedAt)
    expect(result.traces.filter((trace) => trace.purpose === 'departure')).toHaveLength(1)
    const departure = result.departures[0]
    expect(result.traces
      .filter((trace) => trace.employeeId === 1 && trace.purpose !== 'departure')
      .every((trace) => trace.completedAt <= departure.completedAt)).toBe(true)
    expect(state.employees.get(1)?.currentFloor).toBe(1)
  })

  it('shares lift capacity between simultaneous arrivals', () => {
    const state = createSimulationState({ elevators: [elevator(1)], employees: [employee(1, 3), employee(2, 4)] })
    const result = runFullDayScenario(state, day([
      { id: 1, homeFloor: 3, arrivalMinute: 0, departureMinute: 60 },
      { id: 2, homeFloor: 4, arrivalMinute: 0, departureMinute: 60 },
    ]), meetings(), noLunch, settings)
    expect(result.arrivals).toHaveLength(2)
    expect(result.arrivals[1].actualStartAt).toBe(0)
    expect(result.arrivals.some((trace) => trace.waitingTicks > result.arrivals[0].waitingTicks)).toBe(true)
    expect(new Set(state.hallCalls.keys()).size).toBe(3)
    expect(result.processedEvents.filter((event) => event.kind === 'hall-call-created')).toHaveLength(3)
    expect(result.processedEvents.filter((event) => event.kind === 'hall-call-joined')).toHaveLength(1)
  })

  it('validates the full schedule before mutating state', () => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee(1, 3)] })
    expect(() => runFullDayScenario(state, day([{ id: 1, homeFloor: 3, arrivalMinute: 10, departureMinute: 60 }]), meetings([
      meeting(1, 1, { participantDepartures: [{ employeeId: 1, departureMinute: 9 }] }),
    ]), noLunch, settings)).toThrow('вне времени')
    expect(state.currentTime).toBe(0)
    expect(state.processedEvents).toEqual([])
  })

  it('validates reporting settings before mutating state', () => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee(1, 3)] })
    expect(() => runFullDayScenario(
      state, day([{ id: 1, homeFloor: 3, arrivalMinute: 0, departureMinute: 60 }]),
      meetings(), noLunch, { ...settings, metrics: { longWaitThresholdSeconds: [240, 120] } },
    )).toThrow('возрастающими')
    expect(state.currentTime).toBe(0)
    expect(state.processedEvents).toEqual([])
  })

  it('does not allow a callback to create activity after departure', () => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee(1, 3)] })
    expect(() => runFullDayScenario(
      state, day([{ id: 1, homeFloor: 3, arrivalMinute: 0, departureMinute: 10 }]),
      meetings(), noLunch, {
        ...settings,
        onJourneyCompleted: (trace) => trace.purpose === 'departure' ? [{
          id: 'after-departure', employeeId: 1, plannedStartAt: trace.completedAt,
          targetFloor: 2, purpose: 'meeting',
        }] : [],
      },
    )).toThrow('уже завершил уход')
  })

  it('keeps departure as the last route when a slow lunch outbound crosses departure time', () => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee(1, 3)] })
    const lunch: LunchSchedule = {
      lunches: [{ employeeId: 1, cafeteriaFloor: 1, desiredStartMinute: 0, startMinute: 0, returnStartMinute: 15, shiftedFromDesired: false }],
      skippedEmployeeIds: [],
    }
    const result = runFullDayScenario(
      state, day([{ id: 1, homeFloor: 3, arrivalMinute: 0, departureMinute: 15 }]),
      meetings(), lunch, {
        ...settings,
        stairSettings: { ...stairsPreferred, convenientProbabilities: [0, 0, 0, 0, 0, 0] },
        elevatorTiming: { ...DEFAULT_ELEVATOR_TIMING, secondsPerFloor: 230 },
      },
    )
    const employeeTraces = result.traces.filter((trace) => trace.employeeId === 1)
    expect(employeeTraces.at(-1)?.purpose).toBe('departure')
    expect(result.lunches[0].returnJourney).toBeNull()
    expect(result.lunches[0].endedByDeparture).toBe(true)
    expect(state.employees.get(1)?.currentFloor).toBe(1)
  })

  it('aggregates elevator and mandatory stairs into one arrival and one departure', () => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee(1, 5)] })
    const result = runFullDayScenario(
      state, day([{ id: 1, homeFloor: 5, arrivalMinute: 0, departureMinute: 60 }]),
      meetings(), noLunch, { ...settings, servedFloors: [1, 4] },
    )
    expect(result.arrivals).toHaveLength(1)
    expect(result.departures).toHaveLength(1)
    expect(result.arrivals[0].stairsTicks).toBeGreaterThan(0)
    expect(result.departures[0].stairsTicks).toBeGreaterThan(0)
    expect(result.arrivals[0].targetFloor).toBe(5)
    expect(result.departures[0].fromFloor).toBe(5)
    expect([...state.hallCalls.values()].map((call) => call.floor)).toEqual([1, 4])
    expect(state.employees.get(1)?.currentFloor).toBe(1)
  })

  it('supports a building where the elevator stops only at the lobby', () => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee(1, 5)] })
    const result = runFullDayScenario(
      state, day([{ id: 1, homeFloor: 5, arrivalMinute: 0, departureMinute: 60 }]),
      meetings(), noLunch, { ...settings, servedFloors: [1] },
    )
    expect(result.arrivals[0].waitingTicks).toBe(0)
    expect(result.arrivals[0].ridingTicks).toBe(0)
    expect(result.arrivals[0].stairsTicks).toBeGreaterThan(0)
    expect(result.departures[0].stairsTicks).toBe(result.arrivals[0].stairsTicks)
    expect(state.hallCalls.size).toBe(0)
  })

  it('resolves equally near stops reproducibly', () => {
    const execute = () => runFullDayScenario(
      createSimulationState({ elevators: [elevator()], employees: [employee(1, 5)] }),
      day([{ id: 1, homeFloor: 5, arrivalMinute: 0, departureMinute: 60 }]),
      meetings(), noLunch, { ...settings, servedFloors: [6, 1, 4] },
    )
    const first = execute()
    const second = execute()
    expect(first.traces).toEqual(second.traces)
    expect(first.state.hallCalls.get(2)?.floor).toBe(4)
    expect(first.state.hallCalls.get(2)?.floor).toBe(second.state.hallCalls.get(2)?.floor)
  })

  it('rejects invalid served floors before changing state', () => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee(1, 3)] })
    const run = (servedFloors: number[]) => runFullDayScenario(
      state, day([{ id: 1, homeFloor: 3, arrivalMinute: 0, departureMinute: 10 }]),
      meetings(), noLunch, { ...settings, servedFloors },
    )
    expect(() => run([])).toThrow('остановки')
    expect(() => run([2])).toThrow('первом этаже')
    expect(() => run([1, 1])).toThrow('повторов')
    expect(() => run([1, 8])).toThrow('внутри здания')
    expect(state.processedEvents).toEqual([])
  })

  it('keeps every daytime elevator event on a served floor', () => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee(1, 3)] })
    const lunch: LunchSchedule = {
      lunches: [{ employeeId: 1, cafeteriaFloor: 5, desiredStartMinute: 10, startMinute: 10, returnStartMinute: 25, shiftedFromDesired: false }],
      skippedEmployeeIds: [],
    }
    const result = runFullDayScenario(
      state, day([{ id: 1, homeFloor: 3, arrivalMinute: 0, departureMinute: 60 }]),
      meetings(), lunch, {
        ...settings, servedFloors: [1, 2, 4, 6],
        stairSettings: { ...stairsPreferred, convenientProbabilities: [0, 0, 0, 0, 0, 0] },
      },
    )
    const served = new Set([1, 2, 4, 6])
    expect([...state.hallCalls.values()].every((call) => served.has(call.floor))).toBe(true)
    expect(result.processedEvents.filter((event) => event.kind === 'elevator-doors-opened').every((event) => served.has((event.payload as { floor: number }).floor))).toBe(true)
    expect(result.lunches[0].outbound.stairsTicks).toBeGreaterThan(0)
  })
})
