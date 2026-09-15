import { BaselineDispatcher, type ElevatorParkingSettings, type ElevatorServedFloors } from './dispatcher'
import { floorDistance, type EmployeeId, type Floor, type HallCall, type SimulationEvent, type TravelDirection } from './domain'
import type { SimulationState } from './state'
import type { DispatchStrategy } from './dispatcher'
import { Simulator, type HallCallCreatedPayload, type HallCallJoinedPayload, type PassengerEnteredPayload, type PassengerExitedPayload, type SimulationCoordinator, type StairsSegmentCompletedPayload } from './simulator'
import { EventQueue } from './eventQueue'
import { addTicks, secondsToTicks, type SimulationTick } from './time'
import type { ElevatorTiming } from './timing'
import { chooseDayTransport, lunchOverloadStairProbability, type LunchOverloadStairSettings, type RouteChoice, type StairChoiceSettings } from './routeChoice'
import { stairProbability } from './routeChoice'

export interface JourneyIntent {
  readonly id: string
  readonly employeeId: EmployeeId
  readonly plannedStartAt: SimulationTick
  readonly targetFloor: Floor
  readonly purpose: 'arrival' | 'departure' | 'meeting' | 'meeting-return' | 'lunch' | 'lunch-return' | 'meeting-search'
  readonly mandatoryStairs?: boolean
  readonly fixedTransportMode?: 'stairs' | 'elevator'
  readonly transportChoiceTargetFloor?: Floor
  readonly useCurrentFloorAsTarget?: boolean
  readonly fixedChoice?: RouteChoice
  readonly elevatorBoardingFloor?: Floor
  readonly elevatorExitFloor?: Floor
  readonly allowedElevatorFloors?: readonly Floor[]
}

export interface JourneyTrace {
  readonly id: string
  readonly employeeId: EmployeeId
  readonly purpose: JourneyIntent['purpose']
  readonly plannedStartAt: SimulationTick
  readonly actualStartAt: SimulationTick
  readonly fromFloor: Floor
  readonly targetFloor: Floor
  readonly choice: RouteChoice
  readonly selectedChoice: RouteChoice
  boardedAt: SimulationTick | null
  completedAt: SimulationTick
  waitingTicks: SimulationTick
  ridingTicks: SimulationTick
  stairsTicks: SimulationTick
  totalTicks: SimulationTick
}

export interface JourneyScenarioSettings {
  readonly seed: number
  readonly floorCount: number
  readonly minFloor?: number
  readonly elevatorTiming: ElevatorTiming
  readonly stairSettings: StairChoiceSettings
  readonly onJourneyCompleted?: JourneyCompletionHandler
  readonly onJourneysCompleted?: JourneyBatchCompletionHandler
  readonly servedFloors?: readonly Floor[]
  readonly servedFloorsByElevator?: readonly ElevatorServedFloors[]
  readonly parking?: readonly ElevatorParkingSettings[]
  readonly dispatchStrategy?: DispatchStrategy
  readonly lunchOverloadStairs?: LunchOverloadStairSettings
}

export type JourneyCompletionHandler = (
  trace: Readonly<JourneyTrace>,
  state: Readonly<SimulationState>,
) => readonly JourneyIntent[]

export type JourneyBatchCompletionHandler = (
  traces: readonly Readonly<JourneyTrace>[],
  state: Readonly<SimulationState>,
) => readonly JourneyIntent[]

export interface JourneyScenarioResult {
  readonly traces: readonly JourneyTrace[]
  readonly processedEvents: readonly SimulationEvent[]
  readonly state: SimulationState
}

interface JourneyRequestedPayload {
  readonly intent: JourneyIntent
}

interface ActiveJourney {
  readonly intent: JourneyIntent
  readonly trace: JourneyTrace
  phase: 'stairs-before' | 'elevator' | 'stairs-after' | 'single'
  phaseStartedAt: SimulationTick
  elevatorRequestedAt: SimulationTick | null
  elevatorExitedAt: SimulationTick | null
}

export function minuteToSimulationTick(minute: number): SimulationTick {
  if (!Number.isSafeInteger(minute) || minute < 0 || minute > 24 * 60) {
    throw new RangeError('Минута суток должна быть целым числом от 0 до 1440')
  }
  return secondsToTicks(minute * 60)
}

export function runJourneyScenario(
  state: SimulationState,
  intents: readonly JourneyIntent[],
  settings: JourneyScenarioSettings,
): JourneyScenarioResult {
  validateScenario(state, intents, settings)
  const processedEventStart = state.processedEvents.length
  const dispatcher = new BaselineDispatcher(settings.elevatorTiming, settings.seed, settings.parking, settings.dispatchStrategy, settings.servedFloorsByElevator)
  const nextCallId = Math.max(0, ...state.hallCalls.keys()) + 1
  if (!Number.isSafeInteger(nextCallId)) throw new RangeError('Закончился диапазон ID вызовов')
  const coordinator = new JourneyCoordinator(dispatcher, settings, nextCallId)
  const simulator = new Simulator(state, new EventQueue(), coordinator)
  for (const config of settings.parking ?? []) {
    const boundaryTicks = new Set<SimulationTick>([state.currentTime])
    for (const minute of new Set(config.intervals.flatMap((interval) => [interval.startMinute, interval.endMinute]))) {
      const tick = minuteToSimulationTick(minute)
      if (tick >= state.currentTime) boundaryTicks.add(tick)
    }
    for (const time of boundaryTicks) simulator.scheduleOwned({ time, kind: 'parking-rule-boundary', subjectId: config.elevatorId, employeeIdForOrdering: null, payload: { elevatorId: config.elevatorId } })
  }

  const orderedIntents = [...intents].sort(
    (first, second) =>
      first.plannedStartAt - second.plannedStartAt ||
      first.employeeId - second.employeeId ||
      journeyPriority(first) - journeyPriority(second) ||
      first.id.localeCompare(second.id),
  )
  for (const intent of orderedIntents) {
    simulator.schedule({
      time: intent.plannedStartAt,
      kind: 'journey-requested',
      subjectId: intent.employeeId,
      employeeIdForOrdering: intent.employeeId,
      payload: { intent } satisfies JourneyRequestedPayload,
    })
  }
  simulator.runUntilEmpty()
  coordinator.assertFinished()
  return {
    traces: coordinator.completedTraces(),
    processedEvents: state.processedEvents.slice(processedEventStart),
    state,
  }
}

class JourneyCoordinator implements SimulationCoordinator {
  private readonly active = new Map<EmployeeId, ActiveJourney>()
  private readonly pending = new Map<EmployeeId, JourneyIntent[]>()
  private readonly completed: JourneyTrace[] = []
  private readonly intentIds = new Set<string>()
  private readonly departed = new Set<EmployeeId>()
  private completedAtCurrentTick: JourneyTrace[] = []
  private readonly activeHallCallByDirectionFloor = new Map<string, number>()
  private readonly pendingHallCalls = new Map<number, HallCall>()

  constructor(
    private readonly dispatcher: BaselineDispatcher,
    private readonly settings: JourneyScenarioSettings,
    private nextCallId: number,
  ) {}

  afterEvent(event: SimulationEvent, simulator: Simulator): void {
    this.dispatcher.afterEvent(event, simulator)
    switch (event.kind) {
      case 'journey-requested':
        this.requestJourney(simulator, (event.payload as JourneyRequestedPayload).intent)
        break
      case 'passenger-entered':
        this.recordBoarding(event, event.payload as PassengerEnteredPayload)
        break
      case 'passenger-exited':
        this.finishElevatorJourney(simulator, event, event.payload as PassengerExitedPayload)
        this.flushCompletionBatchIfReady(event, simulator)
        break
      case 'stairs-segment-completed':
        this.handleStairsCompletion(simulator, (event.payload as StairsSegmentCompletedPayload).employeeId, event.time)
        this.flushCompletionBatchIfReady(event, simulator)
        break
      case 'hall-call-updated': {
        const callId = (event.payload as { callId: number }).callId
        const call = simulator.state.hallCalls.get(callId)
        if (call?.status === 'served') {
          const key = `${call.floor}:${call.direction}`
          if (this.activeHallCallByDirectionFloor.get(key) === call.id) {
            this.activeHallCallByDirectionFloor.delete(key)
          }
        }
        break
      }
      case 'hall-call-created':
        this.pendingHallCalls.delete((event.payload as HallCallCreatedPayload).call.id)
        break
      default:
        break
    }
    this.flushCompletionBatchIfReady(event, simulator)
  }

  completedTraces(): readonly JourneyTrace[] {
    return [...this.completed].sort(
      (first, second) => first.actualStartAt - second.actualStartAt || first.employeeId - second.employeeId,
    )
  }

  assertFinished(): void {
    const pendingCount = [...this.pending.values()].reduce((sum, queue) => sum + queue.length, 0)
    if (this.active.size > 0 || pendingCount > 0) {
      throw new Error(`Сценарий завершил очередь событий с незавершёнными маршрутами: ${this.active.size + pendingCount}`)
    }
  }

  private requestJourney(simulator: Simulator, intent: JourneyIntent): void {
    if (this.departed.has(intent.employeeId)) throw new Error(`Сотрудник ${intent.employeeId} уже завершил уход`)
    if (this.intentIds.has(intent.id)) throw new Error(`Маршрут ${intent.id} уже был запланирован`)
    validateIntent(simulator.state, intent, this.settings, this.intentIds)
    this.intentIds.add(intent.id)
    const employee = simulator.state.employees.get(intent.employeeId)!
    if (this.active.has(intent.employeeId) || !['on-floor', 'arrived'].includes(employee.state)) {
      const queue = this.pending.get(intent.employeeId) ?? []
      queue.push(intent)
      queue.sort((first, second) => journeyPriority(first) - journeyPriority(second) || first.plannedStartAt - second.plannedStartAt || first.id.localeCompare(second.id))
      this.pending.set(intent.employeeId, queue)
      return
    }
    this.startJourney(simulator, intent)
  }

  private startJourney(simulator: Simulator, intent: JourneyIntent): void {
    const employee = simulator.state.employees.get(intent.employeeId)!
    const fromFloor = employee.currentFloor
    const targetFloor = intent.useCurrentFloorAsTarget === true ? fromFloor : intent.targetFloor
    let choice = intent.fixedChoice ?? chooseDayTransport({
      seed: this.settings.seed,
      employeeId: employee.id,
      journeyId: intent.id,
      legId: intent.purpose,
      floorCount: this.settings.floorCount,
      minFloor: this.settings.minFloor,
      fromFloor,
      toFloor: intent.transportChoiceTargetFloor ?? targetFloor,
      mandatoryStairs: intent.fixedTransportMode === 'stairs' || intent.mandatoryStairs,
    }, this.settings.stairSettings)
    if (intent.fixedChoice === undefined && intent.fixedTransportMode === undefined) {
      choice = this.lunchOverloadChoice(simulator, intent, fromFloor, targetFloor, choice)
    }
    const actualDistance = floorDistance(targetFloor, fromFloor)
    const selectedMode = intent.fixedTransportMode ?? (choice.mode === 'none' && actualDistance > 0 ? 'elevator' : choice.mode)
    const effectiveChoice = {
      ...choice,
      mode: actualDistance === 0 ? 'none' as const : selectedMode,
      fromFloor,
      toFloor: targetFloor,
      distanceFloors: actualDistance,
      stairDurationSeconds: selectedMode === 'stairs' ? actualDistance * this.settings.stairSettings.secondsPerFloor : 0,
    }
    const trace: JourneyTrace = {
      id: intent.id,
      employeeId: employee.id,
      purpose: intent.purpose,
      plannedStartAt: intent.plannedStartAt,
      actualStartAt: simulator.state.currentTime,
      fromFloor,
      targetFloor,
      choice: effectiveChoice,
      selectedChoice: choice,
      boardedAt: null,
      completedAt: simulator.state.currentTime,
      waitingTicks: secondsToTicks(0),
      ridingTicks: secondsToTicks(0),
      stairsTicks: secondsToTicks(0),
      totalTicks: secondsToTicks(0),
    }
    const allowed = selectedMode === 'elevator' ? (intent.allowedElevatorFloors ?? this.settings.servedFloors) : undefined
    const compatiblePair = selectedMode === 'elevator' && this.settings.servedFloorsByElevator !== undefined
      ? resolveCompatibleElevatorPair(fromFloor, targetFloor, allowed, intent, this.settings)
      : null
    const elevatorExitFloor = compatiblePair?.exit ?? intent.elevatorExitFloor ?? (
      allowed !== undefined && !allowed.includes(targetFloor)
        ? nearestAllowedFloor(targetFloor, allowed, fromFloor, this.settings, employee.id, intent.id, 'exit')
        : targetFloor
    )
    const boardingFloor = compatiblePair?.boarding ?? intent.elevatorBoardingFloor ?? (
      allowed !== undefined && !allowed.includes(fromFloor)
        ? nearestAllowedFloor(fromFloor, allowed, elevatorExitFloor, this.settings, employee.id, intent.id, 'boarding')
        : fromFloor
    )
    const resolvedIntent = { ...intent, targetFloor, elevatorBoardingFloor: boardingFloor, elevatorExitFloor }
    const active: ActiveJourney = {
      intent: resolvedIntent, trace, phase: 'single', phaseStartedAt: simulator.state.currentTime,
      elevatorRequestedAt: null, elevatorExitedAt: null,
    }
    this.active.set(employee.id, active)

    if (boardingFloor !== fromFloor) {
      active.phase = 'stairs-before'
      this.scheduleMandatoryStairs(simulator, active, boardingFloor)
      return
    }

    if (effectiveChoice.mode === 'none') {
      this.finishJourney(simulator, employee.id, simulator.state.currentTime)
      return
    }
    employee.targetFloor = targetFloor
    if (effectiveChoice.mode === 'stairs') {
      employee.state = 'using-stairs'
      simulator.scheduleOwned({
        time: addTicks(simulator.state.currentTime, secondsToTicks(effectiveChoice.stairDurationSeconds)),
        kind: 'stairs-segment-completed',
        subjectId: employee.id,
        employeeIdForOrdering: employee.id,
        payload: {
          employeeId: employee.id,
          targetFloor,
          journeyId: intent.id,
        } satisfies StairsSegmentCompletedPayload,
      })
      return
    }

    this.beginElevatorSegment(simulator, active)
  }

  private lunchOverloadChoice(
    simulator: Simulator,
    intent: JourneyIntent,
    fromFloor: Floor,
    targetFloor: Floor,
    fallback: RouteChoice,
  ): RouteChoice {
    const overload = this.settings.lunchOverloadStairs
    if (overload?.enabled !== true || intent.purpose !== 'lunch' || targetFloor >= fromFloor) return fallback
    const callId = this.activeHallCallByDirectionFloor.get(`${fromFloor}:down`)
    const call = callId === undefined ? undefined : (simulator.state.hallCalls.get(callId) ?? this.pendingHallCalls.get(callId))
    const waitingAhead = call?.waitingEmployeeIds.length ?? 0
    const capacity = simulator.state.elevators.values().next().value?.capacity
    if (capacity === undefined || waitingAhead < overload.thresholdCapacityMultiplier * capacity) return fallback
    const distanceFloors = fromFloor - targetFloor
    const probability = lunchOverloadStairProbability(distanceFloors, this.settings.stairSettings.convenient, overload)
    const randomDraw = stableDraw([this.settings.seed, intent.employeeId, intent.id, 'lunch-overload', fromFloor, targetFloor])
    const mode = randomDraw < probability ? 'stairs' : 'elevator'
    return {
      mode,
      fromFloor,
      toFloor: targetFloor,
      distanceFloors,
      stairProbability: probability,
      stairDurationSeconds: mode === 'stairs' ? distanceFloors * this.settings.stairSettings.secondsPerFloor : 0,
      randomDraw,
      reason: 'lunch-overload',
    }
  }

  private beginElevatorSegment(simulator: Simulator, active: ActiveJourney): void {
    const employee = simulator.state.employees.get(active.intent.employeeId)!
    const targetFloor = active.intent.elevatorExitFloor ?? active.intent.targetFloor
    active.phase = 'elevator'
    active.phaseStartedAt = simulator.state.currentTime
    active.elevatorRequestedAt = simulator.state.currentTime
    if (employee.currentFloor === targetFloor) {
      this.completeElevatorSegment(simulator, active, simulator.state.currentTime)
      return
    }
    employee.targetFloor = targetFloor
    employee.state = 'on-floor'
    const direction: TravelDirection = targetFloor > employee.currentFloor ? 'up' : 'down'
    const callKey = `${employee.currentFloor}:${direction}`
    const existingCallId = this.activeHallCallByDirectionFloor.get(callKey)
    if (existingCallId !== undefined) {
      const pendingCall = this.pendingHallCalls.get(existingCallId)
      simulator.scheduleOwned({
        time: simulator.state.currentTime,
        kind: 'hall-call-joined',
        subjectId: employee.id,
        employeeIdForOrdering: employee.id,
        payload: {
          callId: existingCallId,
          employeeId: employee.id,
          pendingCall: pendingCall === undefined
            ? undefined
            : { ...pendingCall, waitingEmployeeIds: [...pendingCall.waitingEmployeeIds] },
        } satisfies HallCallJoinedPayload,
      })
      return
    }
    const call: HallCall = {
      id: this.nextCallId,
      floor: employee.currentFloor,
      direction,
      createdAt: simulator.state.currentTime,
      waitingEmployeeIds: [employee.id],
      assignedElevatorId: null,
      status: 'waiting',
    }
    this.activeHallCallByDirectionFloor.set(callKey, call.id)
    this.pendingHallCalls.set(call.id, call)
    this.nextCallId += 1
    simulator.scheduleOwned({
      time: simulator.state.currentTime,
      kind: 'hall-call-created',
      subjectId: employee.id,
      employeeIdForOrdering: employee.id,
      payload: { call } satisfies HallCallCreatedPayload,
    })
  }

  private recordBoarding(event: SimulationEvent, payload: PassengerEnteredPayload): void {
    const active = this.active.get(payload.employeeId)
    if (active !== undefined) {
      active.trace.boardedAt = event.time
      active.trace.waitingTicks = (event.time - active.elevatorRequestedAt!) as SimulationTick
    }
  }

  private finishElevatorJourney(
    simulator: Simulator,
    event: SimulationEvent,
    payload: PassengerExitedPayload,
  ): void {
    const active = this.active.get(payload.employeeId)
    if (active === undefined) return
    const employee = simulator.state.employees.get(payload.employeeId)!
    const elevatorTarget = active.intent.elevatorExitFloor ?? active.intent.targetFloor
    if (employee.currentFloor === elevatorTarget) this.completeElevatorSegment(simulator, active, event.time)
  }

  private completeElevatorSegment(simulator: Simulator, active: ActiveJourney, at: SimulationTick): void {
    active.elevatorExitedAt = at
    if (active.trace.boardedAt !== null) active.trace.ridingTicks = (at - active.trace.boardedAt) as SimulationTick
    if (active.intent.elevatorExitFloor !== undefined && active.intent.elevatorExitFloor !== active.intent.targetFloor) {
      active.phase = 'stairs-after'
      active.phaseStartedAt = at
      this.scheduleMandatoryStairs(simulator, active, active.intent.targetFloor)
      return
    }
    this.finishJourney(simulator, active.intent.employeeId, at)
  }

  private scheduleMandatoryStairs(simulator: Simulator, active: ActiveJourney, targetFloor: Floor): void {
    const employee = simulator.state.employees.get(active.intent.employeeId)!
    employee.targetFloor = targetFloor
    employee.state = 'using-stairs'
    const duration = secondsToTicks(floorDistance(targetFloor, employee.currentFloor) * this.settings.stairSettings.secondsPerFloor)
    simulator.scheduleOwned({
      time: addTicks(simulator.state.currentTime, duration), kind: 'stairs-segment-completed',
      subjectId: employee.id, employeeIdForOrdering: employee.id,
      payload: { employeeId: employee.id, targetFloor, journeyId: active.intent.id } satisfies StairsSegmentCompletedPayload,
    })
  }

  private handleStairsCompletion(simulator: Simulator, employeeId: EmployeeId, at: SimulationTick): void {
    const active = this.active.get(employeeId)!
    active.trace.stairsTicks = (active.trace.stairsTicks + at - active.phaseStartedAt) as SimulationTick
    if (active.phase === 'stairs-before') {
      this.beginElevatorSegment(simulator, active)
      return
    }
    this.finishJourney(simulator, employeeId, at)
  }

  private finishJourney(simulator: Simulator, employeeId: EmployeeId, completedAt: SimulationTick): void {
    const active = this.active.get(employeeId)!
    const trace = active.trace
    trace.completedAt = completedAt
    trace.totalTicks = (completedAt - trace.actualStartAt) as SimulationTick
    if (trace.boardedAt === null && trace.choice.mode === 'stairs' && trace.stairsTicks === 0) {
      trace.stairsTicks = trace.totalTicks
    }
    this.completed.push(trace)
    this.active.delete(employeeId)
    if (trace.purpose === 'departure') {
      this.departed.add(employeeId)
      this.pending.delete(employeeId)
      simulator.cancelScheduledKinds(['journey-requested'], employeeId)
    }
    const continuations = this.settings.onJourneysCompleted === undefined && trace.purpose !== 'departure'
      ? this.settings.onJourneyCompleted?.(trace, simulator.state) ?? []
      : []
    this.scheduleContinuations(simulator, continuations)
    if (this.settings.onJourneysCompleted !== undefined) this.completedAtCurrentTick.push(trace)
    const queue = this.pending.get(employeeId)
    if (!this.active.has(employeeId) && queue !== undefined && queue.length > 0) {
      const next = queue.shift()!
      if (queue.length === 0) this.pending.delete(employeeId)
      this.startJourney(simulator, next)
    }
  }

  private flushCompletionBatchIfReady(event: SimulationEvent, simulator: Simulator): void {
    if (this.completedAtCurrentTick.length === 0 || this.settings.onJourneysCompleted === undefined) return
    if (simulator.queue.nextTime() === event.time) return
    const batch = this.completedAtCurrentTick
    this.completedAtCurrentTick = []
    simulator.startNewWaveAtCurrentTime()
    this.scheduleContinuations(simulator, this.settings.onJourneysCompleted(batch, simulator.state))
  }

  private scheduleContinuations(simulator: Simulator, continuations: readonly JourneyIntent[]): void {
    for (const continuation of continuations) {
      if (this.departed.has(continuation.employeeId)) throw new Error(`Сотрудник ${continuation.employeeId} уже завершил уход`)
      validateIntent(simulator.state, continuation, this.settings, this.intentIds)
      simulator.schedule({
        time: continuation.plannedStartAt,
        kind: 'journey-requested',
        subjectId: continuation.employeeId,
        employeeIdForOrdering: continuation.employeeId,
        payload: { intent: continuation } satisfies JourneyRequestedPayload,
      })
    }
  }
}

function journeyPriority(intent: JourneyIntent): number {
  if (intent.purpose === 'arrival' || intent.purpose === 'departure') return 0
  if (['meeting', 'meeting-return', 'meeting-search'].includes(intent.purpose)) return 1
  if (['lunch', 'lunch-return'].includes(intent.purpose)) return 2
  return 3
}

function stableDraw(parts: readonly (string | number)[]): number {
  const key = JSON.stringify(parts)
  let hash = 0x811c9dc5
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) / 0x1_0000_0000
}

function nearestAllowedFloor(
  floor: Floor,
  allowed: readonly Floor[],
  otherElevatorFloor: Floor,
  settings: JourneyScenarioSettings,
  employeeId: EmployeeId,
  journeyId: string,
  leg: string,
): Floor {
  const minimum = Math.min(...allowed.map((candidate) => floorDistance(candidate, floor)))
  const nearest = allowed.filter((candidate) => floorDistance(candidate, floor) === minimum)
  const cost = (candidate: Floor) =>
    floorDistance(candidate, floor) * settings.stairSettings.secondsPerFloor +
    floorDistance(candidate, otherElevatorFloor) * settings.elevatorTiming.secondsPerFloor
  const minimumCost = Math.min(...nearest.map(cost))
  const candidates = nearest.filter((candidate) => cost(candidate) === minimumCost).sort((a, b) => a - b)
  if (candidates.length === 1) return candidates[0]
  const key = `${settings.seed}:${employeeId}:${journeyId}:${leg}:${floor}:${candidates.join(',')}`
  let hash = 0x811c9dc5
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return candidates[(hash >>> 0) % candidates.length]
}

function resolveCompatibleElevatorPair(
  fromFloor: Floor,
  targetFloor: Floor,
  globallyAllowed: readonly Floor[] | undefined,
  intent: JourneyIntent,
  settings: JourneyScenarioSettings,
): { boarding: Floor; exit: Floor } {
  const global = globallyAllowed === undefined ? null : new Set(globallyAllowed)
  const candidates: Array<{ elevatorId: number; boarding: Floor; exit: Floor; cost: number }> = []
  for (const config of settings.servedFloorsByElevator ?? []) {
    const floors = config.floors.filter((floor) => global === null || global.has(floor))
    const boardingFloors = intent.elevatorBoardingFloor === undefined ? floors : floors.filter((floor) => floor === intent.elevatorBoardingFloor)
    const exitFloors = intent.elevatorExitFloor === undefined ? floors : floors.filter((floor) => floor === intent.elevatorExitFloor)
    for (const boarding of boardingFloors) for (const exit of exitFloors) {
      const elevatorFloors = floorDistance(boarding, exit)
      const cost =
        floorDistance(fromFloor, boarding) * settings.stairSettings.secondsPerFloor +
        (elevatorFloors === 0 ? 0 : elevatorFloors * settings.elevatorTiming.secondsPerFloor + settings.elevatorTiming.accelerationAndBrakingSeconds) +
        floorDistance(exit, targetFloor) * settings.stairSettings.secondsPerFloor
      candidates.push({ elevatorId: config.elevatorId, boarding, exit, cost })
    }
  }
  if (candidates.length === 0) throw new Error(`Ни один лифт не может обслужить маршрут с ${fromFloor} на ${targetFloor} этаж`)
  candidates.sort((first, second) => first.cost - second.cost || first.elevatorId - second.elevatorId || first.boarding - second.boarding || first.exit - second.exit)
  return candidates[0]
}

function validateScenario(
  state: SimulationState,
  intents: readonly JourneyIntent[],
  settings: JourneyScenarioSettings,
): void {
  new BaselineDispatcher(settings.elevatorTiming, settings.seed, settings.parking, settings.dispatchStrategy, settings.servedFloorsByElevator)
  stairProbability(1, settings.stairSettings)
  if (settings.lunchOverloadStairs !== undefined) lunchOverloadStairProbability(1, settings.stairSettings.convenient, settings.lunchOverloadStairs)
  if (!Number.isSafeInteger(settings.floorCount) || settings.floorCount < 2 || settings.floorCount > 100) {
    throw new RangeError('Количество этажей должно быть от 2 до 100')
  }
  const minFloor = settings.minFloor ?? 1
  if (!Number.isSafeInteger(minFloor) || minFloor === 0 || minFloor > 1 || minFloor < -4) throw new RangeError('Нижний этаж сценария задан некорректно')
  if (settings.servedFloors !== undefined) {
    if (settings.servedFloors.length === 0 || new Set(settings.servedFloors).size !== settings.servedFloors.length) {
      throw new RangeError('Список остановок сценария должен быть непустым и не содержать повторов')
    }
    for (const floor of settings.servedFloors) if (!validScenarioFloor(floor, minFloor, settings.floorCount)) {
      throw new RangeError('Остановка сценария должна находиться внутри здания')
    }
  }
  if (state.elevators.size < 1) throw new Error('Для сценария нужен хотя бы один лифт')
  const serviceByElevator = new Map<number, ReadonlySet<Floor>>()
  for (const config of settings.servedFloorsByElevator ?? []) {
    if (serviceByElevator.has(config.elevatorId) || !state.elevators.has(config.elevatorId)) throw new Error('Настройки остановок должны относиться к уникальным существующим лифтам')
    if (config.floors.length === 0 || new Set(config.floors).size !== config.floors.length) throw new Error('Остановки лифта должны быть непустыми и не повторяться')
    if (config.floors.some((floor) => !validScenarioFloor(floor, minFloor, settings.floorCount))) throw new RangeError('Остановка лифта должна находиться внутри здания')
    serviceByElevator.set(config.elevatorId, new Set(config.floors))
  }
  if (settings.servedFloorsByElevator !== undefined && serviceByElevator.size !== state.elevators.size) throw new Error('Для каждого лифта нужно задать остановки')
  const parkingIds = new Set<number>()
  for (const config of settings.parking ?? []) {
    if (parkingIds.has(config.elevatorId) || !state.elevators.has(config.elevatorId)) throw new Error('Настройки парковки должны относиться к уникальным существующим лифтам')
    parkingIds.add(config.elevatorId)
    if (!Number.isSafeInteger(config.timeoutSeconds) || config.timeoutSeconds < 0 || config.timeoutSeconds > 3600) throw new RangeError('Тайм-аут парковки должен быть целым числом от 0 до 3600 секунд')
    const intervals = [...config.intervals].sort((a,b) => a.startMinute - b.startMinute)
    for (const [index, interval] of intervals.entries()) {
      if (!Number.isInteger(interval.startMinute) || !Number.isInteger(interval.endMinute) || interval.startMinute < 0 || interval.endMinute > 1440 || interval.startMinute >= interval.endMinute) throw new RangeError('Интервал парковки задан некорректно')
      if (index > 0 && intervals[index - 1].endMinute > interval.startMinute) throw new Error('Интервалы парковки одного лифта не должны пересекаться')
      if (!validScenarioFloor(interval.floor, minFloor, settings.floorCount) || (settings.servedFloors !== undefined && !settings.servedFloors.includes(interval.floor))) throw new RangeError('Парковочный этаж должен быть разрешённой остановкой')
      if (serviceByElevator.size > 0 && !serviceByElevator.get(config.elevatorId)?.has(interval.floor)) throw new RangeError('Лифт не может парковаться на недоступном ему этаже')
    }
  }
  for (const elevator of state.elevators.values()) {
    if (
      !validScenarioFloor(elevator.currentFloor, minFloor, settings.floorCount) ||
      (elevator.parkingFloor !== null && !validScenarioFloor(elevator.parkingFloor, minFloor, settings.floorCount)) ||
      elevator.scheduledStops.some((floor) => !validScenarioFloor(floor, minFloor, settings.floorCount))
    ) {
      throw new RangeError('Этаж лифта должен находиться внутри здания сценария')
    }
    if (settings.servedFloors !== undefined && (!settings.servedFloors.includes(elevator.currentFloor) || (elevator.parkingFloor !== null && !settings.servedFloors.includes(elevator.parkingFloor)))) {
      throw new RangeError('Лифт и его парковочный этаж должны находиться на разрешённых остановках')
    }
    const elevatorService = serviceByElevator.get(elevator.id)
    if (elevatorService !== undefined && (!elevatorService.has(elevator.currentFloor) || (elevator.parkingFloor !== null && !elevatorService.has(elevator.parkingFloor)))) throw new RangeError('Лифт и его парковочный этаж должны быть ему доступны')
    if (
      elevator.state !== 'idle-closed' ||
      elevator.passengerIds.length > 0 ||
      elevator.assignedCallIds.length > 0 ||
      elevator.scheduledStops.length > 0 ||
      elevator.pendingBoardingEmployeeIds.length > 0 ||
      elevator.mandatoryCallId !== null ||
      elevator.movement !== null ||
      elevator.doorServiceEndsAt !== null ||
      elevator.parkingTimeoutAt !== null
    ) {
      throw new Error('Сценарий должен начинаться со свободными закрытыми лифтами')
    }
  }
  for (const employee of state.employees.values()) {
    if (!validScenarioFloor(employee.currentFloor, minFloor, settings.floorCount) || !validScenarioFloor(employee.homeFloor, minFloor, settings.floorCount) || !validScenarioFloor(employee.targetFloor ?? 1, minFloor, settings.floorCount)) {
      throw new RangeError('Этаж сотрудника должен находиться внутри здания сценария')
    }
    if (!['on-floor', 'arrived'].includes(employee.state) || employee.activeCallId !== null || employee.elevatorId !== null) {
      throw new Error('Сценарий должен начинаться без активных маршрутов сотрудников')
    }
  }
  if ([...state.hallCalls.values()].some((call) => call.status !== 'served')) {
    throw new Error('Сценарий должен начинаться без активных вызовов лифта')
  }
  const timingValues = [
    settings.elevatorTiming.secondsPerFloor,
    settings.elevatorTiming.accelerationAndBrakingSeconds,
    settings.elevatorTiming.doorOperationSeconds,
    settings.elevatorTiming.openDoorDwellSeconds,
    settings.elevatorTiming.passengerTransferSeconds,
  ]
  if (
    !Number.isFinite(timingValues[0]) || timingValues[0] <= 0 ||
    timingValues.slice(1).some((value) => !Number.isFinite(value) || value < 0)
  ) {
    throw new RangeError('Временные параметры лифта заданы некорректно')
  }
  for (const value of [...timingValues, settings.stairSettings.secondsPerFloor]) {
    secondsToTicks(value)
  }
  const ids = new Set<string>()
  for (const intent of intents) {
    validateIntent(state, intent, settings, ids)
    ids.add(intent.id)
  }
}

function validateIntent(
  state: Readonly<SimulationState>,
  intent: JourneyIntent,
  settings: JourneyScenarioSettings,
  existingIds: ReadonlySet<string>,
): void {
  if (typeof intent.id !== 'string' || intent.id.trim() === '' || existingIds.has(intent.id)) throw new Error('ID маршрутов должны быть непустыми и уникальными')
  if (!state.employees.has(intent.employeeId)) throw new Error(`Сотрудник ${intent.employeeId} не найден`)
  if (!Number.isSafeInteger(intent.plannedStartAt) || intent.plannedStartAt < state.currentTime) {
    throw new RangeError('Время маршрута не может быть раньше текущего времени симуляции')
  }
  const minFloor = settings.minFloor ?? 1
  if (!validScenarioFloor(intent.targetFloor, minFloor, settings.floorCount)) {
    throw new RangeError('Целевой этаж маршрута должен находиться внутри здания')
  }
  if (intent.mandatoryStairs !== undefined && typeof intent.mandatoryStairs !== 'boolean') {
    throw new RangeError('Признак обязательной лестницы должен быть логическим значением')
  }
  if (intent.fixedTransportMode !== undefined && !['stairs', 'elevator'].includes(intent.fixedTransportMode)) {
    throw new RangeError('Зафиксированный способ движения должен быть лифтом или лестницей')
  }
  if (intent.transportChoiceTargetFloor !== undefined && (!Number.isSafeInteger(intent.transportChoiceTargetFloor) || intent.transportChoiceTargetFloor < 1 || intent.transportChoiceTargetFloor > settings.floorCount)) {
    throw new RangeError('Этаж для выбора способа движения должен находиться внутри здания')
  }
  if (intent.useCurrentFloorAsTarget !== undefined && typeof intent.useCurrentFloorAsTarget !== 'boolean') {
    throw new RangeError('Признак текущего этажа должен быть логическим значением')
  }
  if (intent.allowedElevatorFloors !== undefined) {
    if (intent.allowedElevatorFloors.length === 0 || new Set(intent.allowedElevatorFloors).size !== intent.allowedElevatorFloors.length) {
      throw new RangeError('Список остановок лифта должен быть непустым и не содержать повторов')
    }
    for (const floor of intent.allowedElevatorFloors) if (!validScenarioFloor(floor, minFloor, settings.floorCount)) {
      throw new RangeError('Разрешённая остановка должна находиться внутри здания')
    }
  }
  for (const [name, floor] of [['Этаж посадки', intent.elevatorBoardingFloor], ['Этаж выхода', intent.elevatorExitFloor]] as const) {
    if (floor !== undefined && !validScenarioFloor(floor, minFloor, settings.floorCount)) {
      throw new RangeError(`${name} лифта должен находиться внутри здания`)
    }
    const allowed = intent.allowedElevatorFloors ?? settings.servedFloors
    if (floor !== undefined && allowed !== undefined && !allowed.includes(floor)) {
      throw new RangeError(`${name} лифта должен быть разрешённой остановкой`)
    }
  }
  if (intent.fixedChoice !== undefined) {
    const choice = intent.fixedChoice
    if (!['none', 'stairs', 'elevator'].includes(choice.mode) ||
      !Number.isSafeInteger(choice.fromFloor) || choice.fromFloor < 1 || choice.fromFloor > settings.floorCount ||
      !Number.isSafeInteger(choice.toFloor) || choice.toFloor < 1 || choice.toFloor > settings.floorCount ||
      !Number.isSafeInteger(choice.distanceFloors) || choice.distanceFloors < 0 ||
      !Number.isFinite(choice.stairProbability) || choice.stairProbability < 0 || choice.stairProbability > 1 ||
      !Number.isFinite(choice.stairDurationSeconds) || choice.stairDurationSeconds < 0 ||
      (choice.randomDraw !== null && (!Number.isFinite(choice.randomDraw) || choice.randomDraw < 0 || choice.randomDraw >= 1))) {
      throw new RangeError('Зафиксированный выбор транспорта задан некорректно')
    }
    if (intent.fixedTransportMode !== undefined && intent.fixedTransportMode !== choice.mode) {
      throw new RangeError('Зафиксированные способы движения противоречат друг другу')
    }
  }
  if (!['arrival', 'departure', 'meeting', 'meeting-return', 'lunch', 'lunch-return', 'meeting-search'].includes(intent.purpose)) {
    throw new RangeError('Назначение маршрута не поддерживается')
  }
}

function validScenarioFloor(floor: number, minFloor: number, maxFloor: number): boolean {
  return Number.isSafeInteger(floor) && floor !== 0 && floor >= minFloor && floor <= maxFloor
}
