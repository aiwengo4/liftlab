import { describe, expect, it } from 'vitest'
import type { Elevator, Employee } from './domain'
import type { MeetingSchedule, PlannedMeeting } from './meetingSchedule'
import { runMeetingJourneyScenario } from './meetingJourneyRunner'
import { DEFAULT_STAIR_CHOICE_SETTINGS } from './routeChoice'
import { createSimulationState } from './state'
import { DEFAULT_ELEVATOR_TIMING } from './timing'
import { secondsToTicks } from './time'

function elevator(): Elevator {
  return {
    id: 1, capacity: 6, currentFloor: 1, direction: 'idle', state: 'idle-closed',
    passengerIds: [], assignedCallIds: [], scheduledStops: [], mandatoryCallId: null,
    movement: null, pendingBoardingEmployeeIds: [], doorServiceEndsAt: null,
    parkingFloor: null, parkingTimeoutAt: null,
  }
}

function employee(id: number, floor: number, homeFloor = 2): Employee {
  return { id, homeFloor, currentFloor: floor, targetFloor: floor, state: 'arrived', activeCallId: null, elevatorId: null }
}

function meeting(id: number, overrides: Partial<PlannedMeeting> = {}): PlannedMeeting {
  return {
    id, startMinute: 2, endMinute: 4, departureLeadMinutes: 2,
    participantIds: [1], participantDepartures: [{ employeeId: 1, departureMinute: 0 }],
    roomFound: true, returnAfterFailedSearch: false,
    homeFloor: 2, searchRadius: 0, searchDirection: null, searchFloors: [2],
    ...overrides,
  }
}

function schedule(meetings: PlannedMeeting[]): MeetingSchedule {
  const visits = meetings.reduce((sum, item) => sum + item.participantIds.length, 0)
  return { meetings, targetVisits: visits, assignedVisits: visits, unassignedVisits: 0 }
}

const settings = {
  seed: 42, floorCount: 7, elevatorTiming: DEFAULT_ELEVATOR_TIMING,
  stairSettings: {
    ...DEFAULT_STAIR_CHOICE_SETTINGS,
    convenientProbabilities: [1, 1, 1, 1, 1, 1],
    maxVoluntaryFloors: 6,
  },
}

describe('runMeetingJourneyScenario', () => {
  it('acquires one room on the home floor and returns without teleportation', () => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee(1, 2)] })
    const result = runMeetingJourneyScenario(state, schedule([meeting(1)]), [{ floor: 2, rooms: 1 }], settings)
    expect(result.bookings).toHaveLength(1)
    expect(result.meetings[0].decisions[0].kind).toBe('room-acquired')
    expect(result.traces.map((trace) => trace.choice.mode)).toEqual(['none'])
    expect(state.employees.get(1)?.currentFloor).toBe(2)
  })

  it('checks a group room only after its slowest participant arrives', () => {
    const value = meeting(1, {
      participantIds: [1, 2],
      participantDepartures: [{ employeeId: 1, departureMinute: 0 }, { employeeId: 2, departureMinute: 0 }],
      searchRadius: 1, searchDirection: 'up', searchFloors: [3],
    })
    const state = createSimulationState({ elevators: [elevator()], employees: [employee(1, 2), employee(2, 1)] })
    const result = runMeetingJourneyScenario(state, schedule([value]), [{ floor: 3, rooms: 1 }], settings)
    expect(result.bookings[0].actualStartAt).toBe(secondsToTicks(30))
    expect(result.meetings[0].participants.map((item) => item.arrivedAt)).toEqual([secondsToTicks(30), secondsToTicks(30)])
    expect(result.bookings).toHaveLength(1)
  })

  it('keeps the selected stair mode through both floors of a radius-two search', () => {
    const value = meeting(1, { searchRadius: 2, searchDirection: 'up', searchFloors: [3, 4] })
    const state = createSimulationState({ elevators: [elevator()], employees: [employee(1, 2)] })
    const result = runMeetingJourneyScenario(state, schedule([value]), [{ floor: 4, rooms: 1 }], settings)
    const search = result.traces.filter((trace) => trace.id.includes('-search-'))
    expect(search.map((trace) => [trace.fromFloor, trace.targetFloor, trace.choice.mode])).toEqual([
      [2, 3, 'stairs'], [3, 4, 'stairs'],
    ])
    expect(result.meetings[0].decisions.map((item) => item.kind)).toEqual(['move-to-next-floor', 'room-acquired'])
  })

  it('does not return home between meetings that touch at the boundary', () => {
    const first = meeting(1, { startMinute: 1, endMinute: 2, searchRadius: 1, searchDirection: 'up', searchFloors: [3] })
    const second = meeting(2, {
      startMinute: 2, endMinute: 3, participantDepartures: [{ employeeId: 1, departureMinute: 2 }],
      searchRadius: 2, searchDirection: 'up', searchFloors: [3, 4],
    })
    const state = createSimulationState({ elevators: [elevator()], employees: [employee(1, 2)] })
    const result = runMeetingJourneyScenario(state, schedule([first, second]), [{ floor: 3, rooms: 1 }, { floor: 4, rooms: 1 }], settings)
    expect(result.traces.some((trace) => trace.id === 'meeting-1-return-1')).toBe(false)
    const secondStart = result.traces.find((trace) => trace.id === 'meeting-2-search-0-1')!
    expect(secondStart.fromFloor).toBe(3)
    expect(secondStart.actualStartAt).toBe(secondsToTicks(120))
  })

  it('resolves an exact-tick room tie by meeting id rather than employee id', () => {
    const first = meeting(1, { participantIds: [2], participantDepartures: [{ employeeId: 2, departureMinute: 0 }] })
    const second = meeting(2, { participantIds: [1], participantDepartures: [{ employeeId: 1, departureMinute: 0 }] })
    const state = createSimulationState({ elevators: [elevator()], employees: [employee(1, 2), employee(2, 2)] })
    const result = runMeetingJourneyScenario(state, schedule([second, first]), [{ floor: 2, rooms: 1 }], settings)
    expect(result.bookings[0].meetingId).toBe(1)
  })

  it('uses the full radius when choosing transport for a two-floor search', () => {
    const value = meeting(1, { searchRadius: 2, searchDirection: 'up', searchFloors: [3, 4] })
    const state = createSimulationState({ elevators: [elevator()], employees: [employee(1, 2)] })
    const result = runMeetingJourneyScenario(state, schedule([value]), [{ floor: 4, rooms: 1 }], {
      ...settings,
      stairSettings: { ...DEFAULT_STAIR_CHOICE_SETTINGS, convenientProbabilities: [1, 0, 0, 0, 0, 0] },
    })
    expect(result.traces.find((trace) => trace.id === 'meeting-1-search-0-1')?.choice.mode).toBe('elevator')
  })

  it('skips return when the next meeting departure equals the previous end', () => {
    const first = meeting(1, { startMinute: 1, endMinute: 2, searchRadius: 1, searchDirection: 'up', searchFloors: [3] })
    const second = meeting(2, {
      startMinute: 4, endMinute: 5, participantDepartures: [{ employeeId: 1, departureMinute: 2 }],
      searchRadius: 2, searchDirection: 'up', searchFloors: [3, 4],
    })
    const state = createSimulationState({ elevators: [elevator()], employees: [employee(1, 2)] })
    const result = runMeetingJourneyScenario(state, schedule([first, second]), [{ floor: 3, rooms: 1 }, { floor: 4, rooms: 1 }], settings)
    expect(result.traces.some((trace) => trace.id === 'meeting-1-return-1')).toBe(false)
  })

  it('rejects departure rows that belong to non-participants', () => {
    const invalid = meeting(1, { participantDepartures: [{ employeeId: 2, departureMinute: 0 }] })
    const state = createSimulationState({ elevators: [elevator()], employees: [employee(1, 2), employee(2, 2)] })
    expect(() => runMeetingJourneyScenario(state, schedule([invalid]), [], settings)).toThrow('соответствовать')
    expect(state.currentTime).toBe(secondsToTicks(0))
  })

  it('builds the search path from the actual floor at departure time', () => {
    const value = meeting(1, { searchRadius: 1, searchDirection: 'up', searchFloors: [3] })
    const state = createSimulationState({ elevators: [elevator()], employees: [employee(1, 7)] })
    const result = runMeetingJourneyScenario(state, schedule([value]), [{ floor: 6, rooms: 1 }], settings)
    const firstSearch = result.traces.find((trace) => trace.id === 'meeting-1-search-0-1')!
    expect([firstSearch.fromFloor, firstSearch.targetFloor]).toEqual([7, 6])
  })

  it('keeps one full choice including probability and draw for every search hop', () => {
    const value = meeting(1, { searchRadius: 2, searchDirection: 'up', searchFloors: [3, 4] })
    const state = createSimulationState({ elevators: [elevator()], employees: [employee(1, 2)] })
    const result = runMeetingJourneyScenario(state, schedule([value]), [{ floor: 4, rooms: 1 }], {
      ...settings, stairSettings: DEFAULT_STAIR_CHOICE_SETTINGS,
    })
    const [first, second] = result.traces.filter((trace) => trace.id.includes('-search-'))
    expect(second.selectedChoice).toEqual(first.selectedChoice)
    expect(second.choice.randomDraw).toBe(first.choice.randomDraw)
    expect(second.choice.stairProbability).toBe(first.choice.stairProbability)
    expect(second.choice.reason).toBe(first.choice.reason)
  })

  it('batches a stair arrival with a same-tick no-movement request', () => {
    const earlyId = meeting(1, {
      startMinute: 1, endMinute: 3, participantIds: [2],
      participantDepartures: [{ employeeId: 2, departureMinute: 1 }], homeFloor: 3,
    })
    const laterId = meeting(2, {
      startMinute: 1, endMinute: 3, participantIds: [1],
      participantDepartures: [{ employeeId: 1, departureMinute: 0 }], homeFloor: 1,
      searchRadius: 2, searchDirection: 'up', searchFloors: [2, 3],
    })
    const state = createSimulationState({ elevators: [elevator()], employees: [employee(1, 1), employee(2, 3, 3)] })
    const result = runMeetingJourneyScenario(state, schedule([laterId, earlyId]), [{ floor: 3, rooms: 1 }], {
      ...settings,
      stairSettings: { ...settings.stairSettings, secondsPerFloor: 30 },
    })
    expect(result.bookings[0].meetingId).toBe(1)
  })

  it('chooses group origin by the lowest employee id across different departure ticks', () => {
    const value = meeting(1, {
      startMinute: 13, endMinute: 15, participantIds: [2, 1],
      participantDepartures: [{ employeeId: 2, departureMinute: 11 }, { employeeId: 1, departureMinute: 10 }],
      searchRadius: 1, searchDirection: 'up', searchFloors: [3],
    })
    const execute = (departures: PlannedMeeting['participantDepartures']) => {
      const state = createSimulationState({ elevators: [elevator()], employees: [employee(1, 7), employee(2, 2)] })
      return runMeetingJourneyScenario(state, schedule([{ ...value, participantDepartures: departures }]), [{ floor: 6, rooms: 1 }], settings)
        .traces.filter((trace) => trace.id.includes('-search-')).map((trace) => trace.targetFloor)
    }
    expect(execute(value.participantDepartures)).toEqual([6, 6])
    expect(execute([{ employeeId: 1, departureMinute: 11 }, { employeeId: 2, departureMinute: 10 }])).toEqual([6, 6])
  })

  it('continues a group meeting after an earlier participant has departed for the day', () => {
    const value = meeting(1, {
      startMinute: 4, endMinute: 6, participantIds: [1, 2],
      participantDepartures: [{ employeeId: 1, departureMinute: 0 }, { employeeId: 2, departureMinute: 2 }],
      searchRadius: 2, searchDirection: 'down', searchFloors: [6, 5],
    })
    const state = createSimulationState({ elevators: [elevator()], employees: [employee(1, 2), employee(2, 7)] })
    const result = runMeetingJourneyScenario(state, schedule([value]), [{ floor: 5, rooms: 1 }], settings, [{
      id: 'departure-1', employeeId: 1, plannedStartAt: secondsToTicks(60),
      targetFloor: 1, purpose: 'departure', fixedTransportMode: 'elevator',
    }])

    expect(result.traces.at(-1)?.id).not.toBe('meeting-1-return-1')
    expect(result.traces.some((trace) => trace.id === 'meeting-1-return-1')).toBe(false)
    expect(result.traces.some((trace) => trace.id === 'meeting-1-return-2')).toBe(true)
    expect(result.bookings).toHaveLength(1)
    expect(result.bookings[0].floor).toBe(5)
    expect(result.meetings[0].decisions.map((decision) => decision.kind)).toEqual(['move-to-next-floor', 'room-acquired'])
    expect(result.traces
      .filter((trace) => trace.employeeId === 2 && trace.id.includes('-search-'))
      .map((trace) => trace.targetFloor)).toEqual([6, 5])
    expect(result.traces
      .filter((trace) => trace.employeeId === 1)
      .at(-1)?.purpose).toBe('departure')
    expect(result.meetings[0].participants.map((participant) => participant.employeeId)).toEqual([2])
  })
})
