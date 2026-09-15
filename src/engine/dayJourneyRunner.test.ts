import { describe, expect, it } from 'vitest'
import type { Elevator, Employee } from './domain'
import type { LunchSchedule } from './lunchSchedule'
import type { MeetingSchedule, PlannedMeeting } from './meetingSchedule'
import { runDayJourneyScenario } from './dayJourneyRunner'
import { createSimulationState } from './state'
import { DEFAULT_ELEVATOR_TIMING } from './timing'
import { DEFAULT_STAIR_CHOICE_SETTINGS } from './routeChoice'
import { minuteToSimulationTick } from './journeyRunner'

function elevator(): Elevator {
  return { id: 1, capacity: 6, currentFloor: 1, direction: 'idle', state: 'idle-closed', passengerIds: [], assignedCallIds: [], scheduledStops: [], mandatoryCallId: null, movement: null, pendingBoardingEmployeeIds: [], doorServiceEndsAt: null, parkingFloor: null, parkingTimeoutAt: null }
}
function employee(id: number, floor: number): Employee {
  return { id, homeFloor: floor, currentFloor: floor, targetFloor: floor, state: 'arrived', activeCallId: null, elevatorId: null }
}
function meeting(id: number, employeeId: number, overrides: Partial<PlannedMeeting> = {}): PlannedMeeting {
  return { id, startMinute: 2, endMinute: 4, departureLeadMinutes: 2, participantIds: [employeeId], participantDepartures: [{ employeeId, departureMinute: 0 }], homeFloor: 3, searchRadius: 0, searchDirection: null, searchFloors: [3], roomFound: true, returnAfterFailedSearch: false, ...overrides }
}
function meetings(values: PlannedMeeting[]): MeetingSchedule {
  const visits = values.reduce((sum, item) => sum + item.participantIds.length, 0)
  return { meetings: values, targetVisits: visits, assignedVisits: visits, unassignedVisits: 0 }
}
function lunches(employeeId: number, start = 0, duration = 30): LunchSchedule {
  return { lunches: [{ employeeId, cafeteriaFloor: 1, desiredStartMinute: start, startMinute: start, returnStartMinute: start + duration, shiftedFromDesired: false }], skippedEmployeeIds: [] }
}
const elevatorOnly = { ...DEFAULT_STAIR_CHOICE_SETTINGS, convenientProbabilities: [0, 0, 0, 0, 0, 0] }
const settings = { seed: 42, floorCount: 7, elevatorTiming: DEFAULT_ELEVATOR_TIMING, stairSettings: elevatorOnly }

describe('runDayJourneyScenario', () => {
  it('executes meetings and lunches through one elevator queue', () => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee(1, 3), employee(2, 4)] })
    const result = runDayJourneyScenario(state, meetings([meeting(1, 1)]), lunches(2), settings)
    expect(result.meetings[0].booking).not.toBeNull()
    expect(result.lunches).toHaveLength(1)
    expect(result.traces.some((trace) => trace.purpose === 'meeting-return')).toBe(true)
    expect(result.traces.some((trace) => trace.purpose === 'lunch')).toBe(true)
    expect([...state.hallCalls.keys()]).toEqual([...state.hallCalls.keys()].sort((a, b) => a - b))
  })

  it('gives a same-tick meeting priority and skips the conflicting lunch', () => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee(1, 2)] })
    const result = runDayJourneyScenario(state, meetings([meeting(1, 1)]), lunches(1), settings)
    expect(result.lunches).toEqual([])
    expect(result.runtimeSkippedLunches).toEqual([{ employeeId: 1, attemptedAt: result.runtimeSkippedLunches[0].attemptedAt, reason: 'meeting-in-progress' }])
    expect(result.meetings[0].booking).not.toBeNull()
  })

  it('skips a lunch whose full interval no longer fits before the next meeting', () => {
    const future = meeting(1, 1, { startMinute: 22, endMinute: 30, participantDepartures: [{ employeeId: 1, departureMinute: 20 }] })
    const state = createSimulationState({ elevators: [elevator()], employees: [employee(1, 3)] })
    const result = runDayJourneyScenario(state, meetings([future]), lunches(1, 0, 30), settings)
    expect(result.runtimeSkippedLunches[0].reason).toBe('insufficient-time-before-meeting')
    expect(result.allSkippedLunchEmployeeIds).toEqual([1])
  })

  it('goes directly from lunch to a meeting when return and departure share a tick', () => {
    const upcoming = meeting(1, 1, { startMinute: 17, endMinute: 25, participantDepartures: [{ employeeId: 1, departureMinute: 15 }], searchRadius: 1, searchDirection: 'up', searchFloors: [4] })
    const state = createSimulationState({ elevators: [elevator()], employees: [employee(1, 3)] })
    const slow = { ...settings, elevatorTiming: { ...DEFAULT_ELEVATOR_TIMING, secondsPerFloor: 120 } }
    const result = runDayJourneyScenario(state, meetings([upcoming]), lunches(1, 0, 15), slow)
    const meetingSearch = result.traces.find((trace) => trace.id === 'meeting-1-search-0-1')!
    expect(result.lunches[0].returnJourney).toBeNull()
    expect(result.lunches[0].endedByMeeting).toBe(true)
    expect(meetingSearch.actualStartAt).toBe(minuteToSimulationTick(15))
    expect(meetingSearch.fromFloor).toBe(1)
  })

  it('is reproducible and independent of meeting input order', () => {
    const values = [meeting(2, 2, { startMinute: 40, endMinute: 45, participantDepartures: [{ employeeId: 2, departureMinute: 38 }], homeFloor: 4 }), meeting(1, 1)]
    const execute = (input: PlannedMeeting[]) => runDayJourneyScenario(
      createSimulationState({ elevators: [elevator()], employees: [employee(1, 3), employee(2, 4)] }),
      meetings(input), { lunches: [], skippedEmployeeIds: [] }, settings,
    )
    const first = execute(values)
    const second = execute([...values].reverse())
    expect(first.traces).toEqual(second.traces)
    expect(first.bookings).toEqual(second.bookings)
    expect(first.processedEvents).toEqual(second.processedEvents)
  })

  it('supports a day without meetings or lunches', () => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee(1, 3)] })
    const result = runDayJourneyScenario(state, meetings([]), { lunches: [], skippedEmployeeIds: [] }, settings)
    expect(result.traces).toEqual([])
    expect(result.meetings).toEqual([])
    expect(result.lunches).toEqual([])
    expect(state.processedEvents).toEqual([])
  })

  it('rejects an invalid meeting after lunch validation without mutating state', () => {
    const duplicate = meeting(1, 1)
    const state = createSimulationState({ elevators: [elevator()], employees: [employee(1, 3)] })
    expect(() => runDayJourneyScenario(state, meetings([duplicate, { ...duplicate }]), lunches(1, 10), settings)).toThrow('уникальными')
    expect(state.currentTime).toBe(0)
    expect(state.processedEvents).toEqual([])
    expect(state.hallCalls.size).toBe(0)
  })

  it('goes from the cafeteria to an already due meeting after a very slow outbound trip', () => {
    const upcoming = meeting(1, 1, {
      startMinute: 17, endMinute: 25,
      participantDepartures: [{ employeeId: 1, departureMinute: 15 }],
      searchRadius: 1, searchDirection: 'up', searchFloors: [2],
    })
    const state = createSimulationState({ elevators: [elevator()], employees: [employee(1, 3)] })
    const result = runDayJourneyScenario(
      state, meetings([upcoming]), lunches(1, 0, 15),
      { ...settings, elevatorTiming: { ...DEFAULT_ELEVATOR_TIMING, secondsPerFloor: 230 } },
    )
    const meetingSearch = result.traces.find((trace) => trace.id === 'meeting-1-search-0-1')!
    expect(result.lunches[0].returnJourney).toBeNull()
    expect(result.lunches[0].endedByMeeting).toBe(true)
    expect(meetingSearch.fromFloor).toBe(1)
    expect(meetingSearch.actualStartAt).toBeGreaterThan(minuteToSimulationTick(15))
  })

  it('still prioritizes a meeting when lunch travel finishes after the meeting end', () => {
    const overdue = meeting(1, 1, {
      startMinute: 17, endMinute: 25,
      participantDepartures: [{ employeeId: 1, departureMinute: 15 }],
      searchRadius: 1, searchDirection: 'up', searchFloors: [2],
    })
    const state = createSimulationState({ elevators: [elevator()], employees: [employee(1, 3)] })
    const result = runDayJourneyScenario(
      state, meetings([overdue]), lunches(1, 0, 15),
      { ...settings, elevatorTiming: { ...DEFAULT_ELEVATOR_TIMING, secondsPerFloor: 500 } },
    )
    const meetingSearch = result.traces.find((trace) => trace.id === 'meeting-1-search-0-1')!
    expect(result.lunches[0].returnJourney).toBeNull()
    expect(result.lunches[0].endedByMeeting).toBe(true)
    expect(meetingSearch.fromFloor).toBe(1)
    expect(meetingSearch.actualStartAt).toBeGreaterThanOrEqual(minuteToSimulationTick(25))
  })
})
