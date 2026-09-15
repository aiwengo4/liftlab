import { describe, expect, it } from 'vitest'
import type { HallCall, SimulationEvent } from './domain'
import { calculateOperationalMetrics } from './operationalMetrics'
import { secondsToTicks } from './time'

function event(seconds: number, kind: SimulationEvent['kind'], subjectId: number, payload: unknown): SimulationEvent {
  return { time: secondsToTicks(seconds), kind, subjectId, employeeIdForOrdering: null, payload }
}

function call(id: number, floor: number, direction: HallCall['direction'], employees: number[]): HallCall {
  return { id, floor, direction, createdAt: secondsToTicks(0), waitingEmployeeIds: employees, assignedElevatorId: null, status: 'waiting' }
}

describe('calculateOperationalMetrics', () => {
  it('calculates time use, load and resource for an elevator and group', () => {
    const events: SimulationEvent[] = [
      event(11, 'elevator-doors-opened', 1, { elevatorId: 1, floor: 3, visitId: 1, openingStartedAt: secondsToTicks(10), movement: { fromFloor: 1, toFloor: 3, startedAt: secondsToTicks(0), endedAt: secondsToTicks(10), passengerCount: 0 } }),
      event(15, 'passenger-entered', 1, { elevatorId: 1, employeeId: 1, callId: 1 }),
      event(20, 'elevator-doors-closed', 1, { elevatorId: 1, visitId: 1 }),
      event(31, 'elevator-doors-opened', 1, { elevatorId: 1, floor: 5, visitId: 2, openingStartedAt: secondsToTicks(30), movement: { fromFloor: 3, toFloor: 5, startedAt: secondsToTicks(20), endedAt: secondsToTicks(30), passengerCount: 1 } }),
      event(32, 'passenger-exited', 1, { elevatorId: 1, employeeId: 1 }),
      event(40, 'elevator-doors-closed', 1, { elevatorId: 1, visitId: 2 }),
    ]
    const result = calculateOperationalMetrics(events, [{ id: 1, capacity: 2 }], { startAt: secondsToTicks(0), endAt: secondsToTicks(100) })
    expect(result.elevators[0].timeUse).toEqual({ passengerMovementSeconds: 10, stopServiceSeconds: 20, emptyMovementSeconds: 10, idleSeconds: 60, passengerMovementShare: 0.1, stopServiceShare: 0.2, emptyMovementShare: 0.1, idleShare: 0.6 })
    expect(result.elevators[0].load).toEqual({ averagePassengers: 0.5, maximumPassengers: 1, averageCapacityShare: 0.25, maximumCapacityShare: 0.5 })
    expect(result.elevators[0].resource).toEqual({ floorsTravelled: 4, emptyFloorsTravelled: 2, stops: 2, doorOpeningCycles: 2, transportedPassengers: 1, passengersPerStop: 0.5 })
    expect(result.group.timeUse).toEqual(result.elevators[0].timeUse)
  })

  it('measures queue maxima only after the full event batch at a tick', () => {
    const events = [
      event(1, 'hall-call-created', 1, { call: call(1, 4, 'up', [1]) }),
      event(1, 'hall-call-created', 2, { call: call(2, 4, 'up', [2]) }),
      event(2, 'hall-call-created', 3, { call: call(3, 7, 'down', [3]) }),
      event(2, 'passenger-entered', 1, { elevatorId: 1, employeeId: 1, callId: 1 }),
      event(2, 'passenger-entered', 2, { elevatorId: 1, employeeId: 2, callId: 2 }),
    ]
    const result = calculateOperationalMetrics(events, [{ id: 1, capacity: 4 }], { startAt: secondsToTicks(0), endAt: secondsToTicks(10) })
    expect(result.queue.maximumWaitingInBuilding).toBe(2)
    expect(result.queue.maximumAtFloorAndDirection).toEqual({ floor: 4, direction: 'up', count: 2 })
  })

  it('distinguishes a physical stop from repeated door opening', () => {
    const events = [
      event(11, 'elevator-doors-opened', 1, { elevatorId: 1, floor: 3, visitId: 7, openingStartedAt: secondsToTicks(10), movement: { fromFloor: 1, toFloor: 3, startedAt: secondsToTicks(0), endedAt: secondsToTicks(10), passengerCount: 0 } }),
      event(16, 'elevator-doors-opened', 1, { elevatorId: 1, floor: 3, visitId: 7, openingStartedAt: secondsToTicks(15) }),
      event(20, 'elevator-doors-closed', 1, { elevatorId: 1, visitId: 7 }),
    ]
    const result = calculateOperationalMetrics(events, [{ id: 1, capacity: 6 }], { startAt: secondsToTicks(0), endAt: secondsToTicks(30) })
    expect(result.elevators[0].resource.stops).toBe(1)
    expect(result.elevators[0].resource.doorOpeningCycles).toBe(2)
    expect(result.elevators[0].timeUse.stopServiceSeconds).toBe(10)
  })

  it('aggregates elevator-seconds for a group with different capacities', () => {
    const events = [
      event(11, 'elevator-doors-opened', 1, { elevatorId: 1, floor: 2, visitId: 1, openingStartedAt: secondsToTicks(10), movement: { fromFloor: 1, toFloor: 2, startedAt: secondsToTicks(0), endedAt: secondsToTicks(10), passengerCount: 2 } }),
      event(12, 'elevator-doors-closed', 1, { elevatorId: 1, visitId: 1 }),
    ]
    const result = calculateOperationalMetrics(events, [{ id: 1, capacity: 2 }, { id: 2, capacity: 4 }], { startAt: secondsToTicks(0), endAt: secondsToTicks(20) })
    expect(result.group.timeUse.passengerMovementShare).toBe(0.25)
    expect(result.group.load.averagePassengers).toBe(2)
    expect(result.group.load.averageCapacityShare).toBe(1)
    expect(result.elevators[1].timeUse.idleShare).toBe(1)
  })

  it('rejects incomplete telemetry and invalid inputs', () => {
    expect(() => calculateOperationalMetrics([], [], { startAt: secondsToTicks(0), endAt: secondsToTicks(1) })).toThrow('непустой')
    expect(() => calculateOperationalMetrics([event(1, 'elevator-doors-opened', 1, { elevatorId: 1, floor: 1 })], [{ id: 1, capacity: 1 }], { startAt: secondsToTicks(0), endAt: secondsToTicks(2) })).toThrow('телеметрию')
  })

  it('uses a half-open window and does not report a zero-sized queue as a maximum', () => {
    const events = [
      event(1, 'hall-call-created', 1, { call: call(1, 2, 'up', [1]) }),
      event(1, 'passenger-entered', 1, { elevatorId: 1, employeeId: 1, callId: 1 }),
      event(10, 'passenger-exited', 1, { elevatorId: 1, employeeId: 1 }),
    ]
    const result = calculateOperationalMetrics(events, [{ id: 1, capacity: 1 }], { startAt: secondsToTicks(0), endAt: secondsToTicks(10) })
    expect(result.queue.maximumWaitingInBuilding).toBe(0)
    expect(result.queue.maximumAtFloorAndDirection).toBeNull()
    expect(result.elevators[0].resource.transportedPassengers).toBe(0)
  })

  it('counts a zero-duration physical stop without inventing service time', () => {
    const events = [
      event(1, 'elevator-doors-opened', 1, { elevatorId: 1, floor: 1, visitId: 1, openingStartedAt: secondsToTicks(1) }),
      event(1, 'elevator-doors-closed', 1, { elevatorId: 1, visitId: 1 }),
    ]
    const result = calculateOperationalMetrics(events, [{ id: 1, capacity: 1 }], { startAt: secondsToTicks(0), endAt: secondsToTicks(2) })
    expect(result.elevators[0].resource.stops).toBe(1)
    expect(result.elevators[0].resource.doorOpeningCycles).toBe(1)
    expect(result.elevators[0].timeUse.stopServiceSeconds).toBe(0)
  })

  it('captures queue and occupancy already present at the start of the window', () => {
    const queueEvents = [
      event(1, 'hall-call-created', 1, { call: call(1, 2, 'up', [1]) }),
      event(20, 'passenger-entered', 1, { elevatorId: 1, employeeId: 1, callId: 1 }),
    ]
    const queueResult = calculateOperationalMetrics(queueEvents, [{ id: 1, capacity: 2 }], { startAt: secondsToTicks(10), endAt: secondsToTicks(15) })
    expect(queueResult.queue.maximumWaitingInBuilding).toBe(1)
    expect(queueResult.queue.maximumAtFloorAndDirection?.count).toBe(1)

    const loadEvents = [
      event(1, 'passenger-entered', 1, { elevatorId: 1, employeeId: 1, callId: 999 }),
      event(20, 'passenger-exited', 1, { elevatorId: 1, employeeId: 1 }),
    ]
    const loadResult = calculateOperationalMetrics(loadEvents, [{ id: 1, capacity: 2 }], { startAt: secondsToTicks(10), endAt: secondsToTicks(15) })
    expect(loadResult.elevators[0].load.maximumPassengers).toBe(1)
  })

  it('excludes a positive visit ending at the window boundary but includes a zero-duration visit on it', () => {
    const events = [
      event(1, 'elevator-doors-opened', 1, { elevatorId: 1, floor: 1, visitId: 1, openingStartedAt: secondsToTicks(0) }),
      event(10, 'elevator-doors-closed', 1, { elevatorId: 1, visitId: 1 }),
      event(10, 'elevator-doors-opened', 1, { elevatorId: 1, floor: 1, visitId: 2, openingStartedAt: secondsToTicks(10) }),
      event(10, 'elevator-doors-closed', 1, { elevatorId: 1, visitId: 2 }),
    ]
    const result = calculateOperationalMetrics(events, [{ id: 1, capacity: 1 }], { startAt: secondsToTicks(10), endAt: secondsToTicks(20) })
    expect(result.elevators[0].resource.stops).toBe(1)
    expect(result.elevators[0].resource.doorOpeningCycles).toBe(1)
  })

  it('rejects overlapping active intervals instead of returning shares above one', () => {
    const movement = { fromFloor: 1, toFloor: 2, startedAt: secondsToTicks(0), endedAt: secondsToTicks(10), passengerCount: 0 }
    const events = [
      event(11, 'elevator-doors-opened', 1, { elevatorId: 1, floor: 2, visitId: 1, openingStartedAt: secondsToTicks(10), movement }),
      event(12, 'elevator-doors-closed', 1, { elevatorId: 1, visitId: 1 }),
      event(13, 'elevator-doors-opened', 1, { elevatorId: 1, floor: 2, visitId: 2, openingStartedAt: secondsToTicks(12), movement }),
      event(14, 'elevator-doors-closed', 1, { elevatorId: 1, visitId: 2 }),
    ]
    expect(() => calculateOperationalMetrics(events, [{ id: 1, capacity: 1 }], { startAt: secondsToTicks(0), endAt: secondsToTicks(20) })).toThrow('перекрывающиеся')
  })

  it('applies the complete batch at startAt before taking the first snapshot', () => {
    const events = [
      event(1, 'hall-call-created', 1, { call: call(1, 2, 'up', [2]) }),
      event(1, 'passenger-entered', 1, { elevatorId: 1, employeeId: 1, callId: 999 }),
      event(10, 'passenger-entered', 2, { elevatorId: 1, employeeId: 2, callId: 1 }),
      event(10, 'passenger-exited', 1, { elevatorId: 1, employeeId: 1 }),
      event(10, 'passenger-exited', 2, { elevatorId: 1, employeeId: 2 }),
    ]
    const result = calculateOperationalMetrics(events, [{ id: 1, capacity: 2 }], { startAt: secondsToTicks(10), endAt: secondsToTicks(20) })
    expect(result.queue.maximumWaitingInBuilding).toBe(0)
    expect(result.queue.maximumAtFloorAndDirection).toBeNull()
    expect(result.elevators[0].load.maximumPassengers).toBe(0)
  })
})
