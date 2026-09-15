import { describe, expect, it } from 'vitest'
import type { Elevator, Employee } from './domain'
import { runJourneyScenario, minuteToSimulationTick, type JourneyIntent } from './journeyRunner'
import { createSimulationState } from './state'
import { secondsToTicks, ticksToSeconds } from './time'
import { DEFAULT_ELEVATOR_TIMING } from './timing'
import { DEFAULT_LUNCH_OVERLOAD_STAIR_SETTINGS, DEFAULT_STAIR_CHOICE_SETTINGS } from './routeChoice'

function elevator(): Elevator {
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
  }
}

function employee(id = 1): Employee {
  return {
    id,
    homeFloor: 2,
    currentFloor: 1,
    targetFloor: 1,
    state: 'arrived',
    activeCallId: null,
    elevatorId: null,
  }
}

const elevatorOnly = {
  ...DEFAULT_STAIR_CHOICE_SETTINGS,
  convenientProbabilities: [0, 0, 0, 0, 0, 0],
}

function intent(overrides: Partial<JourneyIntent> = {}): JourneyIntent {
  return {
    id: 'arrival-1',
    employeeId: 1,
    plannedStartAt: secondsToTicks(0),
    targetFloor: 2,
    purpose: 'arrival',
    ...overrides,
  }
}

describe('runJourneyScenario', () => {
  it('assigns a call only to a cabin serving both origin and destination', () => {
    const first = { ...elevator(), id: 1 }
    const second = { ...elevator(), id: 2 }
    const result = runJourneyScenario(
      createSimulationState({ elevators: [first, second], employees: [employee()] }),
      [intent({ fixedTransportMode: 'elevator', elevatorBoardingFloor: 1, elevatorExitFloor: 2 })],
      {
        seed: 42, floorCount: 7, elevatorTiming: DEFAULT_ELEVATOR_TIMING, stairSettings: elevatorOnly,
        servedFloorsByElevator: [
          { elevatorId: 1, floors: [1, 3, 5, 7] },
          { elevatorId: 2, floors: [1, 2, 4, 6] },
        ],
      },
    )

    const entered = result.processedEvents.find((event) => event.kind === 'passenger-entered')!
    expect((entered.payload as { elevatorId: number }).elevatorId).toBe(2)
  })

  it('fails predictably when no cabin serves the complete elevator leg', () => {
    expect(() => runJourneyScenario(
      createSimulationState({ elevators: [elevator()], employees: [employee()] }),
      [intent({ fixedTransportMode: 'elevator', elevatorBoardingFloor: 1, elevatorExitFloor: 2 })],
      {
        seed: 42, floorCount: 7, elevatorTiming: DEFAULT_ELEVATOR_TIMING, stairSettings: elevatorOnly,
        servedFloorsByElevator: [{ elevatorId: 1, floors: [1, 3, 5, 7] }],
      },
    )).toThrow('Ни один лифт не может обслужить маршрут с 1 на 2 этаж')
  })

  it('resolves a daytime zoned route through one cabin and a stair access leg', () => {
    const worker = { ...employee(), currentFloor: 2, targetFloor: 2 }
    const result = runJourneyScenario(
      createSimulationState({ elevators: [elevator(), { ...elevator(), id: 2 }], employees: [worker] }),
      [intent({ purpose: 'meeting', targetFloor: 5, fixedTransportMode: 'elevator' })],
      {
        seed: 42, floorCount: 7, elevatorTiming: DEFAULT_ELEVATOR_TIMING, stairSettings: elevatorOnly,
        servedFloors: [1, 2, 3, 5],
        servedFloorsByElevator: [
          { elevatorId: 1, floors: [1, 2] },
          { elevatorId: 2, floors: [1, 3, 5] },
        ],
      },
    )

    expect(result.traces[0]).toMatchObject({ fromFloor: 2, targetFloor: 5 })
    expect(result.traces[0].stairsTicks).toBe(secondsToTicks(15))
    expect(result.processedEvents.filter((event) => event.kind === 'passenger-entered').map((event) => (event.payload as { elevatorId: number }).elevatorId)).toEqual([2])
    expect(result.state.employees.get(1)?.currentFloor).toBe(5)
  })

  it('does not board a passenger whose destination is incompatible with the assigned cabin', () => {
    const employees = [employee(1), { ...employee(2), homeFloor: 3 }]
    const result = runJourneyScenario(
      createSimulationState({ elevators: [{ ...elevator(), capacity: 1 }, { ...elevator(), id: 2 }], employees }),
      [intent({ employeeId: 1, targetFloor: 2, fixedTransportMode: 'elevator' }), intent({ id: 'arrival-2', employeeId: 2, targetFloor: 3, fixedTransportMode: 'elevator' })],
      {
        seed: 42, floorCount: 7, elevatorTiming: DEFAULT_ELEVATOR_TIMING, stairSettings: elevatorOnly,
        servedFloorsByElevator: [
          { elevatorId: 1, floors: [1, 2] },
          { elevatorId: 2, floors: [1, 3] },
        ],
      },
    )
    const boardedByEmployee = new Map(result.processedEvents.filter((event) => event.kind === 'passenger-entered').map((event) => [event.subjectId, (event.payload as { elevatorId: number }).elevatorId]))
    expect(boardedByEmployee).toEqual(new Map([[1, 1], [2, 2]]))
  })
  it('offers stairs for a lunch descent only after 1.5 cabin capacities are already waiting', () => {
    const employees = Array.from({ length: 10 }, (_, index) => ({ ...employee(index + 1), homeFloor: 7, currentFloor: 7 }))
    const result = runJourneyScenario(
      createSimulationState({ elevators: [elevator()], employees }),
      employees.map(({ id }) => intent({ id: `lunch-${id}`, employeeId: id, targetFloor: 1, purpose: 'lunch' })),
      {
        seed: 42,
        floorCount: 7,
        elevatorTiming: DEFAULT_ELEVATOR_TIMING,
        stairSettings: elevatorOnly,
        lunchOverloadStairs: { ...DEFAULT_LUNCH_OVERLOAD_STAIR_SETTINGS, probabilities: [1, 1, 1, 1, 1, 1, 1] },
      },
    )
    const stairTraces = result.traces.filter((trace) => trace.choice.reason === 'lunch-overload' && trace.choice.mode === 'stairs')
    expect(stairTraces).toHaveLength(1)
    expect(stairTraces[0].employeeId).toBe(10)
  })
  it('uses one FIFO hall call for simultaneous passengers in the same direction', () => {
    const state = createSimulationState({
      elevators: [elevator()],
      employees: [employee(1), employee(2), employee(3)],
    })
    const result = runJourneyScenario(state, [1, 2, 3].map((employeeId) =>
      intent({ id: `arrival-${employeeId}`, employeeId })), {
      seed: 42,
      floorCount: 7,
      elevatorTiming: DEFAULT_ELEVATOR_TIMING,
      stairSettings: elevatorOnly,
    })

    expect(result.state.hallCalls.size).toBe(1)
    expect(result.processedEvents.filter((event) => event.kind === 'hall-call-created')).toHaveLength(1)
    expect(result.processedEvents.filter((event) => event.kind === 'hall-call-joined')).toHaveLength(2)
    expect(result.processedEvents
      .filter((event) => event.kind === 'passenger-entered')
      .map((event) => event.subjectId)).toEqual([1, 2, 3])
  })

  it('reactivates one residual shared call when the cabin is full', () => {
    const smallElevator = { ...elevator(), capacity: 2 }
    const employees = [1, 2, 3, 4].map((id) => employee(id))
    const result = runJourneyScenario(
      createSimulationState({ elevators: [smallElevator], employees }),
      employees.map(({ id }) => intent({ id: `arrival-${id}`, employeeId: id })),
      {
        seed: 42,
        floorCount: 7,
        elevatorTiming: DEFAULT_ELEVATOR_TIMING,
        stairSettings: elevatorOnly,
      },
    )

    expect(result.state.hallCalls.size).toBe(1)
    expect([...result.state.hallCalls.values()][0].status).toBe('served')
    expect(new Set(result.processedEvents
      .filter((event) => event.kind === 'hall-call-reactivated')
      .map((event) => event.subjectId))).toEqual(new Set([1]))
    expect(result.traces).toHaveLength(4)
  })

  it('runs a real elevator journey and records exact W, R and T', () => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee()] })
    const result = runJourneyScenario(state, [intent()], {
      seed: 42,
      floorCount: 7,
      elevatorTiming: DEFAULT_ELEVATOR_TIMING,
      stairSettings: elevatorOnly,
    })
    const trace = result.traces[0]
    expect(ticksToSeconds(trace.waitingTicks)).toBe(1.2)
    expect(ticksToSeconds(trace.ridingTicks)).toBe(10.2)
    expect(ticksToSeconds(trace.totalTicks)).toBe(11.4)
    expect(result.state.employees.get(1)?.currentFloor).toBe(2)
    expect(result.state.hallCalls.get(1)?.status).toBe('served')
  })

  it('runs a stair journey without creating a hall call', () => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee()] })
    const result = runJourneyScenario(state, [intent({ targetFloor: 3, mandatoryStairs: true })], {
      seed: 42,
      floorCount: 7,
      elevatorTiming: DEFAULT_ELEVATOR_TIMING,
      stairSettings: DEFAULT_STAIR_CHOICE_SETTINGS,
    })
    expect(ticksToSeconds(result.traces[0].totalTicks)).toBe(30)
    expect(ticksToSeconds(result.traces[0].ridingTicks)).toBe(0)
    expect(ticksToSeconds(result.traces[0].stairsTicks)).toBe(30)
    expect(result.traces[0].choice.mode).toBe('stairs')
    expect(result.state.hallCalls.size).toBe(0)
    expect(result.state.employees.get(1)?.currentFloor).toBe(3)
  })

  it('delays a second route until the employee finishes the first', () => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee()] })
    const result = runJourneyScenario(state, [
      intent({ id: 'first', targetFloor: 2, mandatoryStairs: true }),
      intent({ id: 'second', plannedStartAt: secondsToTicks(5), targetFloor: 3, purpose: 'meeting', mandatoryStairs: true }),
    ], {
      seed: 42,
      floorCount: 7,
      elevatorTiming: DEFAULT_ELEVATOR_TIMING,
      stairSettings: DEFAULT_STAIR_CHOICE_SETTINGS,
    })
    const [first, second] = result.traces
    expect(ticksToSeconds(first.completedAt)).toBe(15)
    expect(ticksToSeconds(second.actualStartAt)).toBe(15)
    expect(ticksToSeconds(second.completedAt)).toBe(30)
    expect(result.state.employees.get(1)?.currentFloor).toBe(3)
  })

  it('handles simultaneous mixed stair and elevator journeys deterministically', () => {
    const execute = () => runJourneyScenario(
      createSimulationState({ elevators: [elevator()], employees: [employee(1), employee(2)] }),
      [
        intent({ id: 'stairs', employeeId: 1, mandatoryStairs: true }),
        intent({ id: 'lift', employeeId: 2 }),
      ],
      {
        seed: 42,
        floorCount: 7,
        elevatorTiming: DEFAULT_ELEVATOR_TIMING,
        stairSettings: elevatorOnly,
      },
    )
    const first = execute()
    const second = execute()
    expect(first.traces).toEqual(second.traces)
    expect(first.processedEvents).toEqual(second.processedEvents)
    expect(first.traces.map(({ choice }) => choice.mode).sort()).toEqual(['elevator', 'stairs'])
  })

  it('converts an absolute minute of day without losing time precision', () => {
    expect(minuteToSimulationTick(8 * 60)).toBe(secondsToTicks(8 * 60 * 60))
    expect(() => minuteToSimulationTick(1.5)).toThrow('целым числом')
  })

  it('allocates new call IDs and returns only events from the current run', () => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee()] })
    const settings = {
      seed: 42,
      floorCount: 7,
      elevatorTiming: DEFAULT_ELEVATOR_TIMING,
      stairSettings: elevatorOnly,
    }
    runJourneyScenario(state, [intent()], settings)
    const historicalEvents = state.processedEvents.length
    const second = runJourneyScenario(state, [intent({
      id: 'second-run',
      plannedStartAt: state.currentTime,
      targetFloor: 3,
    })], settings)
    expect(state.hallCalls.has(2)).toBe(true)
    expect(second.processedEvents.length).toBe(state.processedEvents.length - historicalEvents)
    expect(second.processedEvents.every((event) => event.time >= second.traces[0].actualStartAt)).toBe(true)
  })

  it('orders simultaneous intents of one employee by stable journey ID', () => {
    const execute = (intents: JourneyIntent[]) => runJourneyScenario(
      createSimulationState({ elevators: [elevator()], employees: [employee()] }),
      intents,
      {
        seed: 42,
        floorCount: 7,
        elevatorTiming: DEFAULT_ELEVATOR_TIMING,
        stairSettings: DEFAULT_STAIR_CHOICE_SETTINGS,
      },
    ).traces.map(({ id, fromFloor, targetFloor, actualStartAt }) => ({ id, fromFloor, targetFloor, actualStartAt }))
    const values = [
      intent({ id: 'z', targetFloor: 2, mandatoryStairs: true }),
      intent({ id: 'a', targetFloor: 3, mandatoryStairs: true }),
    ]
    expect(execute(values)).toEqual(execute([...values].reverse()))
    expect(execute(values)[0].id).toBe('a')
  })

  it('rejects a scenario that cannot start or complete routes', () => {
    const settings = {
      seed: 42,
      floorCount: 7,
      elevatorTiming: DEFAULT_ELEVATOR_TIMING,
      stairSettings: DEFAULT_STAIR_CHOICE_SETTINGS,
    }
    expect(() => runJourneyScenario(
      createSimulationState({ employees: [employee()] }),
      [intent()],
      settings,
    )).toThrow('хотя бы один лифт')
    expect(() => runJourneyScenario(
      createSimulationState({ elevators: [elevator()], employees: [{ ...employee(), state: 'using-stairs' }] }),
      [intent()],
      settings,
    )).toThrow()
    expect(() => runJourneyScenario(
      createSimulationState({ elevators: [{ ...elevator(), scheduledStops: [7] }], employees: [employee()] }),
      [intent()],
      settings,
    )).toThrow('свободными закрытыми')
  })

  it('rejects explicit elevator segment floors outside the served set', () => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee()] })
    expect(() => runJourneyScenario(state, [intent({ elevatorExitFloor: 3 })], {
      seed: 42, floorCount: 7, elevatorTiming: DEFAULT_ELEVATOR_TIMING,
      stairSettings: elevatorOnly, servedFloors: [1, 2, 4],
    })).toThrow('разрешённой остановкой')
    expect(state.processedEvents).toEqual([])
  })

  it('validates unique journeys and known employees', () => {
    const state = createSimulationState({ elevators: [elevator()], employees: [employee()] })
    const settings = {
      seed: 42,
      floorCount: 7,
      elevatorTiming: DEFAULT_ELEVATOR_TIMING,
      stairSettings: DEFAULT_STAIR_CHOICE_SETTINGS,
    }
    expect(() => runJourneyScenario(state, [intent(), intent()], settings)).toThrow('уникальными')
    expect(() => runJourneyScenario(state, [intent({ employeeId: 2 })], settings)).toThrow('не найден')
    expect(() => runJourneyScenario(state, [], {
      ...settings,
      elevatorTiming: { ...DEFAULT_ELEVATOR_TIMING, secondsPerFloor: 0 },
    })).toThrow('некорректно')
    const untouched = createSimulationState({ elevators: [elevator()], employees: [employee()] })
    expect(() => runJourneyScenario(untouched, [intent()], {
      ...settings,
      elevatorTiming: { ...DEFAULT_ELEVATOR_TIMING, passengerTransferSeconds: 0.15 },
    })).toThrow('точностью до десятой')
    expect(untouched.processedEvents).toHaveLength(0)
    expect(untouched.employees.get(1)).toMatchObject({ state: 'arrived', currentFloor: 1 })
    expect(untouched.elevators.get(1)).toMatchObject({ state: 'idle-closed', passengerIds: [] })
    expect(() => runJourneyScenario(state, [intent({ id: 1 as unknown as string })], settings)).toThrow('непустыми')
  })
})
