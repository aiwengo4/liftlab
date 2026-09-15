import { describe, expect, it } from 'vitest'
import type { Elevator, Employee, HallCall, SimulationEvent } from './domain'
import { Simulator } from './simulator'
import { createSimulationState } from './state'
import { secondsToTicks } from './time'

function elevator(overrides: Partial<Elevator> = {}): Elevator {
  return {
    id: 1,
    capacity: 6,
    currentFloor: 1,
    direction: 'idle',
    state: 'idle-closed',
    passengerIds: [],
    assignedCallIds: [],
    scheduledStops: [],
    mandatoryCallId: null,
    movement: null,
    pendingBoardingEmployeeIds: [],
    doorServiceEndsAt: null,
    parkingFloor: null,
    parkingTimeoutAt: null,
    ...overrides,
  }
}

function employee(overrides: Partial<Employee> = {}): Employee {
  return {
    id: 1,
    homeFloor: 4,
    currentFloor: 1,
    targetFloor: 4,
    state: 'on-floor',
    activeCallId: null,
    elevatorId: null,
    ...overrides,
  }
}

function hallCall(overrides: Partial<HallCall> = {}): HallCall {
  return {
    id: 1,
    floor: 1,
    direction: 'up',
    createdAt: secondsToTicks(1),
    waitingEmployeeIds: [1],
    assignedElevatorId: null,
    status: 'waiting',
    ...overrides,
  }
}

function simulationEvent(
  seconds: number,
  kind: SimulationEvent['kind'],
  subjectId: number,
  payload: unknown,
): SimulationEvent {
  const employeeIdForOrdering = [
    'passenger-exited',
    'hall-call-created',
    'passenger-entered',
  ].includes(kind)
    ? subjectId
    : null

  return {
    time: secondsToTicks(seconds),
    kind,
    subjectId,
    employeeIdForOrdering,
    payload,
  }
}

describe('Simulator', () => {
  it('advances virtual time by events without intermediate calculation steps', () => {
    const simulator = new Simulator(createSimulationState())
    simulator.schedule(simulationEvent(10, 'dispatch-requested', 1, null))
    simulator.schedule(simulationEvent(2, 'dispatch-requested', 1, null))

    expect(simulator.runNext()?.time).toBe(secondsToTicks(2))
    expect(simulator.state.currentTime).toBe(secondsToTicks(2))
    expect(simulator.runNext()?.time).toBe(secondsToTicks(10))
    expect(simulator.state.currentTime).toBe(secondsToTicks(10))
  })

  it('creates a call and moves its employee into the waiting state', () => {
    const state = createSimulationState({ employees: [employee()] })
    const simulator = new Simulator(state)
    simulator.schedule(
      simulationEvent(1, 'hall-call-created', 1, { call: hallCall() }),
    )

    simulator.runUntilEmpty()

    expect(state.hallCalls.get(1)?.waitingEmployeeIds).toEqual([1])
    expect(state.employees.get(1)?.state).toBe('waiting-for-elevator')
    expect(state.employees.get(1)?.activeCallId).toBe(1)
  })

  it('orders simultaneous employees by ID and validates their direction', () => {
    const state = createSimulationState({
      employees: [employee({ id: 3 }), employee({ id: 1 }), employee({ id: 2 })],
    })
    const simulator = new Simulator(state)
    simulator.schedule(
      simulationEvent(1, 'hall-call-created', 1, {
        call: hallCall({ waitingEmployeeIds: [3, 1, 2] }),
      }),
    )
    simulator.runNext()

    expect(state.hallCalls.get(1)?.waitingEmployeeIds).toEqual([1, 2, 3])

    const invalidState = createSimulationState({
      employees: [employee({ targetFloor: 1, currentFloor: 4 })],
    })
    const invalidSimulator = new Simulator(invalidState)
    invalidSimulator.schedule(
      simulationEvent(1, 'hall-call-created', 1, {
        call: hallCall({ floor: 4, direction: 'up' }),
      }),
    )
    expect(() => invalidSimulator.runNext()).toThrow(
      'не соответствует направлению',
    )
  })

  it('processes opening, entry, call update, closing and exit in chronological order', () => {
    const state = createSimulationState({
      elevators: [elevator({ state: 'opening-doors' })],
      employees: [employee({ state: 'waiting-for-elevator', activeCallId: 1 })],
      hallCalls: [hallCall()],
    })
    const simulator = new Simulator(state)

    simulator.schedule(
      simulationEvent(1, 'elevator-doors-opened', 1, {
        elevatorId: 1,
        floor: 1,
      }),
    )
    simulator.schedule(
      simulationEvent(1.2, 'passenger-entered', 1, {
        employeeId: 1,
        elevatorId: 1,
        callId: 1,
      }),
    )
    simulator.schedule(
      simulationEvent(1.2, 'hall-call-updated', 1, { callId: 1 }),
    )
    simulator.schedule(
      simulationEvent(4.2, 'elevator-doors-closed', 1, { elevatorId: 1 }),
    )
    simulator.schedule(
      simulationEvent(11.2, 'elevator-doors-opened', 1, {
        elevatorId: 1,
        floor: 4,
      }),
    )
    simulator.schedule(
      simulationEvent(11.4, 'passenger-exited', 1, {
        employeeId: 1,
        elevatorId: 1,
      }),
    )

    expect(simulator.runNext()?.kind).toBe('elevator-doors-opened')
    expect(simulator.runNext()?.kind).toBe('passenger-entered')
    expect(simulator.runNext()?.kind).toBe('hall-call-updated')
    state.elevators.get(1)!.state = 'closing-doors'
    expect(simulator.runNext()?.kind).toBe('elevator-doors-closed')
    expect(simulator.runNext()?.kind).toBe('elevator-doors-opened')
    expect(simulator.runNext()?.kind).toBe('passenger-exited')
    expect(state.currentTime).toBe(secondsToTicks(11.4))
    expect(state.hallCalls.get(1)?.status).toBe('served')
    expect(state.elevators.get(1)?.passengerIds).toEqual([])
    expect(state.employees.get(1)).toMatchObject({
      currentFloor: 4,
      state: 'arrived',
      elevatorId: null,
    })
    expect(state.processedEvents).toHaveLength(6)
  })

  it('does not allow a passenger to enter a full elevator', () => {
    const state = createSimulationState({
      elevators: [
        elevator({ state: 'doors-open', capacity: 1, passengerIds: [2] }),
      ],
      employees: [
        employee({ state: 'waiting-for-elevator', activeCallId: 1 }),
        employee({ id: 2, state: 'riding-elevator', elevatorId: 1 }),
      ],
      hallCalls: [hallCall()],
    })
    const simulator = new Simulator(state)
    simulator.schedule(
      simulationEvent(1, 'passenger-entered', 1, {
        employeeId: 1,
        elevatorId: 1,
        callId: 1,
      }),
    )

    expect(() => simulator.runNext()).toThrow('лифт заполнен')
    expect(state.elevators.get(1)?.passengerIds).toEqual([2])
  })

  it('does not allow boarding without the employee hall call', () => {
    const state = createSimulationState({
      elevators: [elevator({ state: 'doors-open' })],
      employees: [
        employee({ state: 'waiting-for-elevator', activeCallId: 1 }),
      ],
      hallCalls: [hallCall()],
    })
    const simulator = new Simulator(state)
    simulator.schedule(
      simulationEvent(1, 'passenger-entered', 1, {
        employeeId: 1,
        elevatorId: 1,
        callId: null,
      }),
    )

    expect(() => simulator.runNext()).toThrow('должен быть указан вызов')
    expect(state.elevators.get(1)?.passengerIds).toEqual([])
    expect(state.hallCalls.get(1)?.waitingEmployeeIds).toEqual([1])
  })

  it('rejects completing door closing from an invalid elevator state', () => {
    const state = createSimulationState({ elevators: [elevator()] })
    const simulator = new Simulator(state)
    simulator.schedule(
      simulationEvent(1, 'elevator-doors-closed', 1, { elevatorId: 1 }),
    )

    expect(() => simulator.runNext()).toThrow('Нельзя закрыть двери')
    expect(state.elevators.get(1)?.state).toBe('idle-closed')
  })

  it('rejects scheduling an event in the past', () => {
    const state = createSimulationState({ startTime: secondsToTicks(10) })
    const simulator = new Simulator(state)

    expect(() =>
      simulator.schedule(simulationEvent(9.9, 'dispatch-requested', 1, null)),
    ).toThrow(RangeError)
  })

  it('rejects opening doors from an invalid elevator state without teleporting it', () => {
    const state = createSimulationState({ elevators: [elevator()] })
    const simulator = new Simulator(state)
    simulator.schedule(
      simulationEvent(1, 'elevator-doors-opened', 1, {
        elevatorId: 1,
        floor: 5,
      }),
    )

    expect(() => simulator.runNext()).toThrow('Нельзя открыть двери')
    expect(state.elevators.get(1)).toMatchObject({
      currentFloor: 1,
      state: 'idle-closed',
    })
  })

  it('validates every employee before atomically creating a hall call', () => {
    const state = createSimulationState({
      employees: [employee(), employee({ id: 2, currentFloor: 2 })],
    })
    const simulator = new Simulator(state)
    simulator.schedule(
      simulationEvent(1, 'hall-call-created', 1, {
        call: hallCall({ waitingEmployeeIds: [1, 2] }),
      }),
    )

    expect(() => simulator.runNext()).toThrow('находится не на этаже вызова')
    expect(state.hallCalls.size).toBe(0)
    expect(state.employees.get(1)).toMatchObject({
      state: 'on-floor',
      activeCallId: null,
    })
  })

  it('does not allow a derived event to return to an earlier phase of the current tick', () => {
    const simulator = new Simulator(createSimulationState())
    simulator.schedule(simulationEvent(10, 'dispatch-requested', 1, null))
    expect(simulator.runNext()?.kind).toBe('dispatch-requested')

    expect(() =>
      simulator.schedule(
        simulationEvent(10, 'passenger-exited', 1, {
          employeeId: 1,
          elevatorId: 1,
        }),
      ),
    ).toThrow('уже завершённую фазу')
  })

  it('stops runaway processing at the configured event limit', () => {
    const simulator = new Simulator(createSimulationState())
    simulator.schedule(simulationEvent(1, 'dispatch-requested', 1, null))
    simulator.schedule(simulationEvent(2, 'dispatch-requested', 1, null))

    expect(() => simulator.runUntilEmpty(1)).toThrow(
      'Превышен лимит обработки',
    )
  })
})
