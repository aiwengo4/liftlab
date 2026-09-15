import { describe, expect, it } from 'vitest'
import type { Elevator, Employee } from './domain'
import type { MeetingSchedule, PlannedMeeting } from './meetingSchedule'
import { runPersonalMeetingJourneyScenario } from './personalMeetingJourneyRunner'
import { DEFAULT_STAIR_CHOICE_SETTINGS } from './routeChoice'
import { createSimulationState } from './state'
import { DEFAULT_ELEVATOR_TIMING } from './timing'
import { minuteToSimulationTick, type JourneyIntent } from './journeyRunner'

function elevator(): Elevator {
  return { id: 1, capacity: 6, currentFloor: 1, direction: 'idle', state: 'idle-closed', passengerIds: [], assignedCallIds: [], scheduledStops: [], mandatoryCallId: null, movement: null, pendingBoardingEmployeeIds: [], doorServiceEndsAt: null, parkingFloor: null, parkingTimeoutAt: null }
}

function employee(id = 1): Employee {
  return { id, homeFloor: 2, currentFloor: 2, targetFloor: 2, state: 'arrived', activeCallId: null, elevatorId: null }
}

function meeting(id: number, overrides: Partial<PlannedMeeting> = {}): PlannedMeeting {
  return {
    id, startMinute: 4, endMinute: 6, departureLeadMinutes: 2,
    participantIds: [1], participantDepartures: [{ employeeId: 1, departureMinute: 2 }],
    homeFloor: 2, searchRadius: 2, searchDirection: 'up', searchFloors: [3, 4],
    roomFound: true, returnAfterFailedSearch: false,
    ...overrides,
  }
}

function schedule(values: PlannedMeeting[]): MeetingSchedule {
  return { meetings: values, targetVisits: values.length, assignedVisits: values.length, unassignedVisits: 0 }
}

const settings = {
  seed: 42, floorCount: 7, elevatorTiming: DEFAULT_ELEVATOR_TIMING,
  stairSettings: { ...DEFAULT_STAIR_CHOICE_SETTINGS, convenientProbabilities: [1, 1, 1, 1, 1, 1], maxVoluntaryFloors: 6 },
}

describe('runPersonalMeetingJourneyScenario', () => {
  it('moves directly to the resolved floor and returns after a found meeting ends', () => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee()] })
    const result = runPersonalMeetingJourneyScenario(state, schedule([meeting(1)]), settings)
    expect(result.traces.map((trace) => [trace.fromFloor, trace.targetFloor])).toEqual([[2, 4], [4, 2]])
    expect(result.traces[1].actualStartAt).toBe(minuteToSimulationTick(6))
    expect(result.bookings).toHaveLength(1)
    expect(result.meetings[0].decisions[0].kind).toBe('room-acquired')
  })

  it('returns immediately when no room is found and the fallback says return', () => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee()] })
    const result = runPersonalMeetingJourneyScenario(state, schedule([meeting(1, {
      roomFound: false, returnAfterFailedSearch: true,
    })]), settings)
    expect(result.traces[1].actualStartAt).toBe(result.traces[0].completedAt)
    expect(result.meetings[0].decisions[0].kind).toBe('fallback-origin')
    expect(result.meetings[0].finalFloor).toBe(2)
    expect(state.employees.get(1)?.currentFloor).toBe(2)
    expect(result.bookings).toEqual([])
  })

  it('stays until the end when no room is found and the fallback says stay', () => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee()] })
    const result = runPersonalMeetingJourneyScenario(state, schedule([meeting(1, { roomFound: false })]), settings)
    expect(result.traces[1].actualStartAt).toBe(minuteToSimulationTick(6))
    expect(result.meetings[0].decisions[0].kind).toBe('fallback-stay')
  })

  it('does not claim a room when travel finishes after the meeting', () => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee()] })
    const result = runPersonalMeetingJourneyScenario(state, schedule([meeting(1, { endMinute: 3 })]), {
      ...settings,
      stairSettings: { ...settings.stairSettings, secondsPerFloor: 40 },
    })
    expect(result.meetings[0].decisions[0].kind).toBe('meeting-ended')
    expect(result.bookings).toEqual([])
    expect(result.traces[1].actualStartAt).toBe(result.traces[0].completedAt)
  })

  it('does not return home between back-to-back meetings', () => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee()] })
    const result = runPersonalMeetingJourneyScenario(state, schedule([
      meeting(1),
      meeting(2, { startMinute: 7, endMinute: 9, participantDepartures: [{ employeeId: 1, departureMinute: 6 }], searchFloors: [5] }),
    ]), settings)
    expect(result.traces.some((trace) => trace.id === 'meeting-1-return-1')).toBe(false)
    expect(result.traces.find((trace) => trace.id === 'meeting-2-search-0-1')?.fromFloor).toBe(4)
  })

  it('does return immediately after failed search even before a back-to-back meeting', () => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee()] })
    const result = runPersonalMeetingJourneyScenario(state, schedule([
      meeting(1, { roomFound: false, returnAfterFailedSearch: true }),
      meeting(2, { startMinute: 7, endMinute: 9, participantDepartures: [{ employeeId: 1, departureMinute: 6 }], searchFloors: [5] }),
    ]), settings)
    const outbound = result.traces.find((trace) => trace.id === 'meeting-1-search-0-1')!
    const immediateReturn = result.traces.find((trace) => trace.id === 'meeting-1-return-1')!
    expect(immediateReturn.actualStartAt).toBe(outbound.completedAt)
  })

  it('keeps departure terminal and preserves external callback validation', () => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee()] })
    const departure: JourneyIntent = { id: 'departure', employeeId: 1, plannedStartAt: minuteToSimulationTick(3), targetFloor: 1, purpose: 'departure', fixedTransportMode: 'elevator' }
    const result = runPersonalMeetingJourneyScenario(state, schedule([meeting(1)]), settings, [departure])
    expect(result.traces.filter((trace) => trace.employeeId === 1).at(-1)?.purpose).toBe('departure')
    expect(result.traces.some((trace) => trace.id === 'meeting-1-return-1')).toBe(false)

    const invalidState = createSimulationState({ elevators: [elevator()], employees: [employee()] })
    expect(() => runPersonalMeetingJourneyScenario(invalidState, schedule([]), {
      ...settings,
      onJourneyCompleted: (trace) => trace.purpose === 'departure' ? [{ ...departure, id: 'after-departure', plannedStartAt: trace.completedAt, purpose: 'meeting' }] : [],
    }, [departure])).toThrow('уже завершил уход')
  })
})
