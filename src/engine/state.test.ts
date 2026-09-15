import { describe, expect, it } from 'vitest'
import type { Elevator, Employee, HallCall } from './domain'
import { createSimulationState } from './state'
import { secondsToTicks, type SimulationTick } from './time'

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
    createdAt: secondsToTicks(0),
    waitingEmployeeIds: [1],
    assignedElevatorId: null,
    status: 'waiting',
    ...overrides,
  }
}

const activeMovement = {
  fromFloor: 1,
  toFloor: 2,
  startedAt: secondsToTicks(0),
  arrivesAt: secondsToTicks(6),
}

describe('createSimulationState', () => {
  it('clones input entities so external mutation cannot change simulation state', () => {
    const sourceElevator = elevator()
    const state = createSimulationState({ elevators: [sourceElevator] })
    sourceElevator.currentFloor = 10

    expect(state.elevators.get(1)?.currentFloor).toBe(1)
  })

  it('rejects an invalid start time at runtime', () => {
    expect(() =>
      createSimulationState({ startTime: -1 as SimulationTick }),
    ).toThrow('Начальное время')
  })

  it('rejects an elevator with invalid capacity or movement direction', () => {
    expect(() =>
      createSimulationState({ elevators: [elevator({ capacity: 0 })] }),
    ).toThrow('Вместимость')
    expect(() =>
      createSimulationState({
        elevators: [elevator({ state: 'moving', direction: 'idle', movement: activeMovement })],
      }),
    ).toThrow('должен иметь направление')
  })

  it('rejects a passenger reference to a missing employee', () => {
    expect(() =>
      createSimulationState({
        elevators: [
          elevator({
            state: 'moving',
            direction: 'up',
            passengerIds: [99],
            movement: activeMovement,
          }),
        ],
      }),
    ).toThrow('отсутствующий сотрудник')
  })

  it('rejects a waiting employee whose call relation is inconsistent', () => {
    expect(() =>
      createSimulationState({
        employees: [
          employee({ state: 'waiting-for-elevator', activeCallId: 2 }),
        ],
        hallCalls: [hallCall()],
      }),
    ).toThrow('не соответствует вызову')
  })

  it('rejects a waiting employee missing from the referenced call queue', () => {
    expect(() =>
      createSimulationState({
        employees: [
          employee({ state: 'waiting-for-elevator', activeCallId: 1 }),
          employee({
            id: 2,
            state: 'waiting-for-elevator',
            activeCallId: 1,
          }),
        ],
        hallCalls: [hallCall({ waitingEmployeeIds: [2] })],
      }),
    ).toThrow('некорректно связан')
  })

  it('rejects an employee waiting on a different floor', () => {
    expect(() =>
      createSimulationState({
        employees: [
          employee({
            currentFloor: 5,
            state: 'waiting-for-elevator',
            activeCallId: 1,
          }),
        ],
        hallCalls: [hallCall()],
      }),
    ).toThrow('не на этаже вызова')
  })

  it('rejects duplicate scheduled elevator stops', () => {
    expect(() =>
      createSimulationState({
        elevators: [elevator({ scheduledStops: [2, 2] })],
      }),
    ).toThrow('остановка запланирована несколько раз')
  })

  it('accepts mutually consistent elevator, passenger and assigned call links', () => {
    const state = createSimulationState({
      elevators: [
        elevator({
          direction: 'up',
          state: 'moving',
          passengerIds: [2],
          assignedCallIds: [1],
          movement: activeMovement,
        }),
      ],
      employees: [
        employee({ state: 'waiting-for-elevator', activeCallId: 1 }),
        employee({ id: 2, state: 'riding-elevator', elevatorId: 1 }),
      ],
      hallCalls: [
        hallCall({ status: 'assigned', assignedElevatorId: 1 }),
      ],
    })

    expect(state.elevators.get(1)?.passengerIds).toEqual([2])
    expect(state.hallCalls.get(1)?.assignedElevatorId).toBe(1)
  })

  it('rejects an inactive or wrongly routed mandatory pickup', () => {
    const assignedCall = hallCall({ status: 'assigned', assignedElevatorId: 1 })
    const waitingEmployee = employee({ state: 'waiting-for-elevator', activeCallId: 1 })

    expect(() => createSimulationState({
      elevators: [elevator({ assignedCallIds: [1], mandatoryCallId: 1 })],
      employees: [waitingEmployee],
      hallCalls: [assignedCall],
    })).toThrow('должен двигаться или открывать двери')

    expect(() => createSimulationState({
      elevators: [elevator({
        state: 'moving',
        direction: 'up',
        assignedCallIds: [1],
        mandatoryCallId: 1,
        movement: { ...activeMovement, toFloor: 3 },
      })],
      employees: [waitingEmployee],
      hallCalls: [assignedCall],
    })).toThrow('не ведёт к обязательной точке подачи')
  })

  it('rejects inconsistent active movement state', () => {
    expect(() => createSimulationState({
      elevators: [elevator({ state: 'moving', direction: 'up' })],
    })).toThrow('должен иметь активный участок движения')

    expect(() => createSimulationState({
      elevators: [elevator({ movement: activeMovement })],
    })).toThrow('не должен иметь активный участок движения')
  })

  it('rejects a mandatory pickup missing its assigned call relation', () => {
    expect(() => createSimulationState({
      elevators: [elevator({
        state: 'moving',
        direction: 'up',
        mandatoryCallId: 1,
        movement: activeMovement,
      })],
    })).toThrow('не согласована с вызовом')
  })
})
