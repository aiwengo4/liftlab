import { describe, expect, it } from 'vitest'
import type { Elevator, Employee } from './domain'
import { runJourneyScenario, type JourneyIntent } from './journeyRunner'
import { DEFAULT_STAIR_CHOICE_SETTINGS } from './routeChoice'
import { createSimulationState } from './state'
import { secondsToTicks } from './time'
import { DEFAULT_ELEVATOR_TIMING } from './timing'
import { calculateOperationalMetrics } from './operationalMetrics'

function elevator(): Elevator { return { id: 1, capacity: 6, currentFloor: 1, direction: 'idle', state: 'idle-closed', passengerIds: [], assignedCallIds: [], scheduledStops: [], mandatoryCallId: null, movement: null, pendingBoardingEmployeeIds: [], doorServiceEndsAt: null, parkingFloor: null, parkingTimeoutAt: null } }
function employee(): Employee { return { id: 1, homeFloor: 3, currentFloor: 3, targetFloor: 3, state: 'arrived', activeCallId: null, elevatorId: null } }
const settings = { seed: 42, floorCount: 7, elevatorTiming: DEFAULT_ELEVATOR_TIMING, stairSettings: DEFAULT_STAIR_CHOICE_SETTINGS, servedFloors: [1,2,3,4,5,6,7], parking: [{ elevatorId: 1, timeoutSeconds: 0, intervals: [{ startMinute: 0, endMinute: 10, floor: 5 }] }] }

describe('elevator parking', () => {
  it('moves empty by floors without opening doors and records telemetry', () => {
    const result = runJourneyScenario(createSimulationState({ elevators: [elevator()] }), [], settings)
    const steps = result.processedEvents.filter((event) => event.kind === 'parking-step-arrived')
    expect(steps).toHaveLength(4)
    expect(result.state.elevators.get(1)?.currentFloor).toBe(5)
    expect(result.processedEvents.some((event) => event.kind === 'elevator-doors-opened')).toBe(false)
    const metrics = calculateOperationalMetrics(result.processedEvents, [{ id: 1, capacity: 6 }], { startAt: secondsToTicks(0), endAt: secondsToTicks(600) })
    expect(metrics.group.resource.emptyFloorsTravelled).toBe(4)
    expect(metrics.group.resource.stops).toBe(0)
    expect(metrics.group.resource.doorOpeningCycles).toBe(0)
  })

  it('serves a call after reaching the next floor and cancels the remaining parking route', () => {
    const intent: JourneyIntent = { id: 'work', employeeId: 1, plannedStartAt: secondsToTicks(3), targetFloor: 4, purpose: 'meeting', fixedTransportMode: 'elevator' }
    const result = runJourneyScenario(createSimulationState({ elevators: [elevator()], employees: [employee()] }), [intent], settings)
    expect(result.traces).toHaveLength(1)
    const firstWorkDoors = result.processedEvents.find((event) => event.kind === 'elevator-doors-opened')
    expect(firstWorkDoors).toBeDefined()
    expect(result.traces[0].actualStartAt).toBe(secondsToTicks(3))
  })

  it('lets a work call win when it coincides with the parking timeout', () => {
    const intent: JourneyIntent = { id: 'work', employeeId: 1, plannedStartAt: secondsToTicks(60), targetFloor: 4, purpose: 'meeting', fixedTransportMode: 'elevator' }
    const result = runJourneyScenario(createSimulationState({ elevators: [elevator()], employees: [employee()] }), [intent], { ...settings, parking: [{ ...settings.parking[0], timeoutSeconds: 60 }] })
    const beforeBoarding = result.processedEvents.slice(0, result.processedEvents.findIndex((event) => event.kind === 'passenger-entered'))
    expect(beforeBoarding.some((event) => event.kind === 'parking-step-arrived')).toBe(false)
  })

  it('lets a work call win exactly when a parking step reaches a floor', () => {
    const initial = runJourneyScenario(createSimulationState({ elevators: [elevator()] }), [], settings)
    const firstStepAt = initial.processedEvents.find((event) => event.kind === 'parking-step-arrived')!.time
    const intent: JourneyIntent = { id: 'boundary-work', employeeId: 1, plannedStartAt: firstStepAt, targetFloor: 4, purpose: 'meeting', fixedTransportMode: 'elevator' }
    const result = runJourneyScenario(createSimulationState({ elevators: [elevator()], employees: [employee()] }), [intent], settings)
    const firstWorkDoorsIndex = result.processedEvents.findIndex((event) => event.kind === 'elevator-doors-opened')
    expect(result.processedEvents.slice(0, firstWorkDoorsIndex).filter((event) => event.kind === 'parking-step-arrived')).toHaveLength(1)
  })

  it('switches to the new parking floor at the exact rule boundary', () => {
    const parking = [{ elevatorId: 1, timeoutSeconds: 0, intervals: [{ startMinute: 0, endMinute: 1, floor: 5 }, { startMinute: 1, endMinute: 10, floor: 2 }] }]
    const result = runJourneyScenario(createSimulationState({ elevators: [elevator()] }), [], { ...settings, parking })
    expect(result.state.elevators.get(1)?.currentFloor).toBe(2)
    expect(result.processedEvents.some((event) => event.kind === 'parking-rule-boundary' && event.time === secondsToTicks(60))).toBe(true)
  })

  it('rejects overlapping intervals and forbidden parking floors before mutation', () => {
    const state = createSimulationState({ elevators: [elevator()] })
    expect(() => runJourneyScenario(state, [], { ...settings, parking: [{ elevatorId: 1, timeoutSeconds: 60, intervals: [{ startMinute: 1, endMinute: 5, floor: 2 }, { startMinute: 4, endMinute: 6, floor: 3 }] }] })).toThrow('пересекаться')
    expect(() => runJourneyScenario(state, [], { ...settings, servedFloors: [1,3], parking: [{ elevatorId: 1, timeoutSeconds: 60, intervals: [{ startMinute: 1, endMinute: 5, floor: 2 }] }] })).toThrow('разрешённой')
    expect(state.processedEvents).toEqual([])
    expect(() => runJourneyScenario(createSimulationState({ elevators: [elevator()] }), [], { ...settings, parking: [{ ...settings.parking[0], timeoutSeconds: 0.5 }] })).toThrow('целым')
  })

  it('rejects a scheduled parking floor unavailable to that cabin', () => {
    expect(() => runJourneyScenario(createSimulationState({ elevators: [elevator()] }), [], {
      ...settings,
      servedFloorsByElevator: [{ elevatorId: 1, floors: [1, 2, 3, 4] }],
    })).toThrow('не может парковаться')
  })
})
