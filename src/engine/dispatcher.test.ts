import { describe, expect, it } from 'vitest'
import { BaselineDispatcher } from './dispatcher'
import type { Elevator, Employee, HallCall, SimulationEvent } from './domain'
import { EventQueue } from './eventQueue'
import { Simulator } from './simulator'
import { createSimulationState } from './state'
import { secondsToTicks, ticksToSeconds, type SimulationTick } from './time'
import { DEFAULT_ELEVATOR_TIMING } from './timing'

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
    homeFloor: 2,
    currentFloor: 1,
    targetFloor: 2,
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
    createdAt: secondsToTicks(0),
    waitingEmployeeIds: [1],
    assignedElevatorId: null,
    status: 'waiting',
    ...overrides,
  }
}

function callCreatedEvent(call: HallCall): SimulationEvent {
  return {
    time: call.createdAt,
    kind: 'hall-call-created',
    subjectId: call.waitingEmployeeIds[0],
    employeeIdForOrdering: call.waitingEmployeeIds[0],
    payload: { call },
  }
}

describe('BaselineDispatcher', () => {
  it('reproduces reference scenario 1 with 1.2 seconds waiting and 10.2 seconds riding', () => {
    const state = createSimulationState({
      elevators: [elevator()],
      employees: [employee()],
    })
    const dispatcher = new BaselineDispatcher(DEFAULT_ELEVATOR_TIMING, 42)
    const simulator = new Simulator(state, new EventQueue(), dispatcher)
    simulator.schedule(callCreatedEvent(hallCall()))

    simulator.runUntilEmpty()

    const boarding = state.processedEvents.find(
      (event) =>
        event.kind === 'passenger-entered' && event.subjectId === 1,
    )
    const exit = state.processedEvents.find(
      (event) => event.kind === 'passenger-exited' && event.subjectId === 1,
    )

    expect(boarding).toBeDefined()
    expect(exit).toBeDefined()
    expect(ticksToSeconds(boarding!.time)).toBe(1.2)
    expect(
      ticksToSeconds((exit!.time - boarding!.time) as SimulationTick),
    ).toBe(10.2)
    expect(ticksToSeconds(exit!.time)).toBe(11.4)
    expect(state.employees.get(1)?.state).toBe('arrived')
    expect(state.elevators.get(1)).toMatchObject({
      currentFloor: 2,
      state: 'idle-closed',
      direction: 'idle',
      passengerIds: [],
      assignedCallIds: [],
      scheduledStops: [],
    })
    expect(state.hallCalls.get(1)?.status).toBe('served')
  })

  it('chooses the nearest idle elevator for the mandatory pickup', () => {
    const state = createSimulationState({
      elevators: [
        elevator({ id: 1, currentFloor: 1 }),
        elevator({ id: 2, currentFloor: 6 }),
      ],
      employees: [employee({ currentFloor: 5, targetFloor: 7 })],
    })
    const call = hallCall({ floor: 5 })
    const simulator = new Simulator(
      state,
      new EventQueue(),
      new BaselineDispatcher(DEFAULT_ELEVATOR_TIMING, 42),
    )
    simulator.schedule(callCreatedEvent(call))

    simulator.runNext()
    simulator.runNext()

    expect(state.hallCalls.get(1)?.assignedElevatorId).toBe(2)
    expect(state.elevators.get(2)?.state).toBe('moving')
    expect(state.elevators.get(1)?.state).toBe('idle-closed')
  })

  it('dispatches a call that arrived while the only elevator was busy', () => {
    const state = createSimulationState({
      elevators: [elevator()],
      employees: [
        employee(),
        employee({ id: 2, homeFloor: 3, targetFloor: 3 }),
      ],
    })
    const simulator = new Simulator(
      state,
      new EventQueue(),
      new BaselineDispatcher(DEFAULT_ELEVATOR_TIMING, 42),
    )
    simulator.schedule(callCreatedEvent(hallCall()))
    simulator.schedule(
      callCreatedEvent(
        hallCall({
          id: 2,
          createdAt: secondsToTicks(0.1),
          waitingEmployeeIds: [2],
        }),
      ),
    )

    simulator.runUntilEmpty()

    expect(state.hallCalls.get(2)?.status).toBe('served')
    expect(state.employees.get(2)?.state).toBe('arrived')
    expect(state.employees.get(2)?.currentFloor).toBe(3)
  })

  it('chooses the nearest accumulated call before an older distant call', () => {
    const nearEmployee = employee({
      id: 1,
      currentFloor: 3,
      targetFloor: 4,
      state: 'waiting-for-elevator',
      activeCallId: 1,
    })
    const farEmployee = employee({
      id: 2,
      currentFloor: 9,
      targetFloor: 10,
      state: 'waiting-for-elevator',
      activeCallId: 2,
    })
    const state = createSimulationState({
      elevators: [elevator()],
      employees: [nearEmployee, farEmployee],
      hallCalls: [
        hallCall({ floor: 3 }),
        hallCall({
          id: 2,
          floor: 9,
          createdAt: secondsToTicks(0),
          waitingEmployeeIds: [2],
        }),
      ],
    })
    const simulator = new Simulator(
      state,
      new EventQueue(),
      new BaselineDispatcher(DEFAULT_ELEVATOR_TIMING, 42),
    )
    simulator.schedule({
      time: secondsToTicks(0),
      kind: 'dispatch-requested',
      subjectId: 1,
      employeeIdForOrdering: null,
      payload: null,
    })

    simulator.runNext()

    expect(state.hallCalls.get(1)?.assignedElevatorId).toBe(1)
    expect(state.hallCalls.get(2)?.status).toBe('waiting')
  })

  it('uses the oldest building-wide call with global FIFO', () => {
    const state = createSimulationState({
      elevators: [elevator()],
      employees: [
        employee({ id: 1, currentFloor: 3, targetFloor: 4, state: 'waiting-for-elevator', activeCallId: 1 }),
        employee({ id: 2, currentFloor: 9, targetFloor: 10, state: 'waiting-for-elevator', activeCallId: 2 }),
      ],
      hallCalls: [
        hallCall({ floor: 3, createdAt: secondsToTicks(1) }),
        hallCall({ id: 2, floor: 9, createdAt: secondsToTicks(0), waitingEmployeeIds: [2] }),
      ],
    })
    const simulator = new Simulator(state, new EventQueue(), new BaselineDispatcher(DEFAULT_ELEVATOR_TIMING, 42, [], 'global-fifo'))
    simulator.schedule({ time: secondsToTicks(2), kind: 'dispatch-requested', subjectId: 1, employeeIdForOrdering: null, payload: null })
    simulator.runNext()
    expect(state.hallCalls.get(2)?.assignedElevatorId).toBe(1)
    expect(state.hallCalls.get(1)?.status).toBe('waiting')
  })

  it('switches hybrid dispatch from nearest to FIFO after 120 seconds', () => {
    const run = (at: number) => {
      const state = createSimulationState({
        elevators: [elevator()],
        employees: [
          employee({ id: 1, currentFloor: 3, targetFloor: 4, state: 'waiting-for-elevator', activeCallId: 1 }),
          employee({ id: 2, currentFloor: 9, targetFloor: 10, state: 'waiting-for-elevator', activeCallId: 2 }),
        ],
        hallCalls: [hallCall({ floor: 3, createdAt: secondsToTicks(50) }), hallCall({ id: 2, floor: 9, createdAt: secondsToTicks(0), waitingEmployeeIds: [2] })],
      })
      const simulator = new Simulator(state, new EventQueue(), new BaselineDispatcher(DEFAULT_ELEVATOR_TIMING, 42, [], 'hybrid'))
      simulator.schedule({ time: secondsToTicks(at), kind: 'dispatch-requested', subjectId: 1, employeeIdForOrdering: null, payload: null })
      simulator.runNext()
      return state
    }
    expect(run(60).hallCalls.get(1)?.assignedElevatorId).toBe(1)
    expect(run(121).hallCalls.get(2)?.assignedElevatorId).toBe(1)
  })

  it('reactivates passengers left by capacity after exactly 0.1 seconds', () => {
    const state = createSimulationState({
      elevators: [elevator({ capacity: 1 })],
      employees: [employee({ id: 1 }), employee({ id: 2 })],
    })
    const simulator = new Simulator(
      state,
      new EventQueue(),
      new BaselineDispatcher(DEFAULT_ELEVATOR_TIMING, 42),
    )
    simulator.schedule(
      callCreatedEvent(hallCall({ waitingEmployeeIds: [1, 2] })),
    )

    simulator.runUntilEmpty()

    const reactivation = state.processedEvents.find(
      (event) => event.kind === 'hall-call-reactivated',
    )
    expect(reactivation).toBeDefined()
    expect(ticksToSeconds(reactivation!.time)).toBe(4.3)
    expect(state.employees.get(1)?.state).toBe('arrived')
    expect(state.employees.get(2)?.state).toBe('arrived')
    expect(state.hallCalls.get(1)?.status).toBe('served')
  })

  it('picks up a same-direction call ahead only after the mandatory pickup', () => {
    const state = createSimulationState({
      elevators: [elevator()],
      employees: [
        employee({ id: 1, targetFloor: 5 }),
        employee({ id: 2, currentFloor: 3, targetFloor: 4, homeFloor: 4 }),
      ],
    })
    const simulator = new Simulator(state, new EventQueue(), new BaselineDispatcher(DEFAULT_ELEVATOR_TIMING, 42))
    simulator.schedule(callCreatedEvent(hallCall()))
    simulator.schedule(
      callCreatedEvent(
        hallCall({
          id: 2,
          floor: 3,
          createdAt: secondsToTicks(5),
          waitingEmployeeIds: [2],
        }),
      ),
    )

    simulator.runUntilEmpty()

    const openedFloors = state.processedEvents
      .filter((event) => event.kind === 'elevator-doors-opened')
      .map((event) => (event.payload as { floor: number }).floor)
    expect(openedFloors.slice(0, 3)).toEqual([1, 3, 4])
    expect(state.employees.get(2)?.state).toBe('arrived')
  })

  it('does not intercept a call before reaching the mandatory pickup', () => {
    const state = createSimulationState({
      elevators: [elevator()],
      employees: [
        employee({ id: 1, currentFloor: 8, targetFloor: 9, homeFloor: 9 }),
        employee({ id: 2, currentFloor: 5, targetFloor: 6, homeFloor: 6 }),
      ],
    })
    const simulator = new Simulator(state, new EventQueue(), new BaselineDispatcher(DEFAULT_ELEVATOR_TIMING, 42))
    simulator.schedule(callCreatedEvent(hallCall({ floor: 8 })))
    simulator.schedule(
      callCreatedEvent(
        hallCall({ id: 2, floor: 5, createdAt: secondsToTicks(1), waitingEmployeeIds: [2] }),
      ),
    )

    simulator.runUntilEmpty()

    const firstOpened = state.processedEvents.find(
      (event) => event.kind === 'elevator-doors-opened',
    )
    expect((firstOpened?.payload as { floor: number }).floor).toBe(8)
  })

  it('boards an employee whose call is created at the door-open timestamp', () => {
    const state = createSimulationState({
      elevators: [elevator({ state: 'opening-doors', direction: 'up' })],
      employees: [employee()],
    })
    const simulator = new Simulator(state, new EventQueue(), new BaselineDispatcher(DEFAULT_ELEVATOR_TIMING, 42))
    simulator.schedule({
      time: secondsToTicks(1),
      kind: 'elevator-doors-opened',
      subjectId: 1,
      employeeIdForOrdering: null,
      payload: { elevatorId: 1, floor: 1 },
    })
    simulator.schedule(callCreatedEvent(hallCall({ createdAt: secondsToTicks(1) })))

    simulator.runUntilEmpty()

    expect(state.employees.get(1)?.state).toBe('arrived')
  })

  it('reopens closing doors for a compatible employee at the same floor', () => {
    const state = createSimulationState({
      elevators: [elevator({ state: 'closing-doors', direction: 'up' })],
      employees: [employee()],
    })
    const simulator = new Simulator(state, new EventQueue(), new BaselineDispatcher(DEFAULT_ELEVATOR_TIMING, 42))
    simulator.schedule({
      time: secondsToTicks(1),
      kind: 'elevator-doors-closed',
      subjectId: 1,
      employeeIdForOrdering: null,
      payload: { elevatorId: 1 },
    })
    simulator.schedule(callCreatedEvent(hallCall({ createdAt: secondsToTicks(0.5) })))

    simulator.runUntilEmpty()

    const reopened = state.processedEvents.find(
      (event) =>
        event.kind === 'elevator-doors-opened' &&
        event.time === secondsToTicks(1.5),
    )
    expect(reopened).toBeDefined()
    expect(state.employees.get(1)?.state).toBe('arrived')
  })

  it('uses the full movement formula when projecting a pickup on the way', () => {
    const state = createSimulationState({
      elevators: [elevator()],
      employees: [
        employee({ id: 1, targetFloor: 8 }),
        employee({ id: 2, currentFloor: 5, targetFloor: 6 }),
      ],
    })
    const simulator = new Simulator(state, new EventQueue(), new BaselineDispatcher(DEFAULT_ELEVATOR_TIMING, 42))
    simulator.schedule(callCreatedEvent(hallCall()))
    simulator.schedule(callCreatedEvent(hallCall({
      id: 2,
      floor: 5,
      createdAt: secondsToTicks(5),
      waitingEmployeeIds: [2],
    })))

    simulator.runUntilEmpty()

    const openedAtFive = state.processedEvents.find(
      (event) =>
        event.kind === 'elevator-doors-opened' &&
        (event.payload as { floor: number }).floor === 5,
    )
    expect(ticksToSeconds(openedAtFive!.time)).toBe(23.2)
  })

  it('turns around and boards the opposite call during the same open-door stop', () => {
    const state = createSimulationState({
      elevators: [elevator({
        currentFloor: 3,
        direction: 'up',
        state: 'moving',
        passengerIds: [10],
        movement: {
          fromFloor: 3,
          toFloor: 5,
          startedAt: secondsToTicks(0),
          arrivesAt: secondsToTicks(10),
        },
      })],
      employees: [
        employee({ id: 10, currentFloor: 3, targetFloor: 5, state: 'riding-elevator', elevatorId: 1 }),
        employee({ id: 1, currentFloor: 5, targetFloor: 2, state: 'waiting-for-elevator', activeCallId: 1 }),
      ],
      hallCalls: [hallCall({ floor: 5, direction: 'down' })],
    })
    const simulator = new Simulator(state, new EventQueue(), new BaselineDispatcher(DEFAULT_ELEVATOR_TIMING, 42))
    simulator.schedule({
      time: secondsToTicks(11),
      kind: 'elevator-doors-opened',
      subjectId: 1,
      employeeIdForOrdering: null,
      payload: { elevatorId: 1, floor: 5 },
    })

    simulator.runUntilEmpty()

    const entered = state.processedEvents.find((event) => event.kind === 'passenger-entered' && event.subjectId === 1)!
    const exited = state.processedEvents.find((event) => event.kind === 'passenger-exited' && event.subjectId === 1)!
    expect(ticksToSeconds(entered.time)).toBe(11.4)
    expect(ticksToSeconds((exited.time - entered.time) as SimulationTick)).toBe(18.2)
    expect(ticksToSeconds(exited.time)).toBe(29.6)

    const firstEntryIndex = state.processedEvents.indexOf(entered)
    const firstOwnExitIndex = state.processedEvents.findIndex(
      (event) => event.kind === 'passenger-exited' && event.subjectId === 10,
    )
    expect(state.processedEvents.slice(firstOwnExitIndex, firstEntryIndex)).not.toContainEqual(
      expect.objectContaining({ kind: 'elevator-doors-closing-started' }),
    )
  })

  it('boards a caller after a passenger frees the only place at the same timestamp', () => {
    const state = createSimulationState({
      elevators: [elevator({
        capacity: 1,
        direction: 'up',
        state: 'opening-doors',
        passengerIds: [10],
      })],
      employees: [
        employee({ id: 10, currentFloor: 1, targetFloor: 1, state: 'riding-elevator', elevatorId: 1 }),
        employee(),
      ],
    })
    const simulator = new Simulator(state, new EventQueue(), new BaselineDispatcher(DEFAULT_ELEVATOR_TIMING, 42))
    simulator.schedule({
      time: secondsToTicks(1),
      kind: 'elevator-doors-opened',
      subjectId: 1,
      employeeIdForOrdering: null,
      payload: { elevatorId: 1, floor: 1 },
    })
    simulator.schedule(callCreatedEvent(hallCall({ createdAt: secondsToTicks(1) })))

    simulator.runUntilEmpty()

    const entered = state.processedEvents.find((event) => event.kind === 'passenger-entered' && event.subjectId === 1)
    expect(ticksToSeconds(entered!.time)).toBe(1.4)
    expect(state.employees.get(1)?.state).toBe('arrived')
  })

  it('serves an assigned current-direction call before turning around', () => {
    const state = createSimulationState({
      elevators: [elevator({
        currentFloor: 3,
        direction: 'up',
        state: 'moving',
        capacity: 2,
        passengerIds: [10],
        assignedCallIds: [1],
        scheduledStops: [5],
        movement: {
          fromFloor: 3,
          toFloor: 5,
          startedAt: secondsToTicks(0),
          arrivesAt: secondsToTicks(10),
        },
      })],
      employees: [
        employee({ id: 10, currentFloor: 3, targetFloor: 5, state: 'riding-elevator', elevatorId: 1 }),
        employee({ id: 1, currentFloor: 5, targetFloor: 6, state: 'waiting-for-elevator', activeCallId: 1 }),
        employee({ id: 2, currentFloor: 5, targetFloor: 2, state: 'waiting-for-elevator', activeCallId: 2 }),
      ],
      hallCalls: [
        hallCall({ floor: 5, status: 'assigned', assignedElevatorId: 1 }),
        hallCall({ id: 2, floor: 5, direction: 'down', waitingEmployeeIds: [2] }),
      ],
    })
    const simulator = new Simulator(state, new EventQueue(), new BaselineDispatcher(DEFAULT_ELEVATOR_TIMING, 42))
    simulator.schedule({
      time: secondsToTicks(11),
      kind: 'elevator-doors-opened',
      subjectId: 1,
      employeeIdForOrdering: null,
      payload: { elevatorId: 1, floor: 5 },
    })

    simulator.runUntilEmpty()

    const entries = state.processedEvents
      .filter((event) => event.kind === 'passenger-entered')
      .map((event) => event.subjectId)
    expect(entries[0]).toBe(1)
    expect(state.employees.get(1)?.state).toBe('arrived')
    expect(state.employees.get(2)?.state).toBe('arrived')
  })
})
