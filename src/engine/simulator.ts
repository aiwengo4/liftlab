import type {
  Elevator,
  ElevatorId,
  Employee,
  EmployeeId,
  Floor,
  HallCall,
  HallCallId,
  SimulationEvent,
} from './domain'
import { EventQueue, eventPriority } from './eventQueue'
import type { SimulationState } from './state'

export interface DoorsOpenedPayload {
  readonly elevatorId: ElevatorId
  readonly floor: Floor
  readonly visitId?: number
  readonly openingStartedAt?: SimulationEvent['time']
  readonly movement?: {
    readonly fromFloor: Floor
    readonly toFloor: Floor
    readonly startedAt: SimulationEvent['time']
    readonly endedAt: SimulationEvent['time']
    readonly passengerCount: number
  }
}

export interface ElevatorPayload {
  readonly elevatorId: ElevatorId
  readonly visitId?: number
}

export interface PassengerEnteredPayload {
  readonly employeeId: EmployeeId
  readonly elevatorId: ElevatorId
  readonly callId: HallCallId
}

export interface PassengerExitedPayload {
  readonly employeeId: EmployeeId
  readonly elevatorId: ElevatorId
}

export interface HallCallCreatedPayload {
  readonly call: HallCall
}

export interface HallCallUpdatedPayload {
  readonly callId: HallCallId
}

export interface HallCallJoinedPayload {
  readonly callId: HallCallId
  readonly employeeId: EmployeeId
  readonly pendingCall?: HallCall
}

export interface StairsSegmentCompletedPayload {
  readonly employeeId: EmployeeId
  readonly targetFloor: Floor
  readonly journeyId: string
}

export interface ParkingStepPayload {
  readonly elevatorId: ElevatorId
  readonly targetFloor: Floor
  readonly finalParkingFloor: Floor
  readonly movement: NonNullable<Elevator['movement']> & { readonly passengerCount: 0 }
}

export interface SimulationCoordinator {
  afterEvent(event: SimulationEvent, simulator: Simulator): void
}

export class Simulator {
  private orderingFloorEvent: SimulationEvent | null = null
  private readonly earlyCreatedHallCallIds = new Set<HallCallId>()

  constructor(
    readonly state: SimulationState,
    readonly queue: EventQueue = new EventQueue(),
    private readonly coordinator: SimulationCoordinator | null = null,
  ) {}

  schedule(event: SimulationEvent): void {
    this.validateScheduledEvent(event)
    this.queue.enqueue(event)
  }

  scheduleOwned(event: SimulationEvent): void {
    this.validateScheduledEvent(event)
    this.queue.enqueueOwned(event)
  }

  private validateScheduledEvent(event: SimulationEvent): void {
    if (event.time < this.state.currentTime) {
      throw new RangeError('Нельзя запланировать событие раньше текущего времени симуляции')
    }

    if (
      this.orderingFloorEvent !== null &&
      event.time === this.orderingFloorEvent.time
    ) {
      const activePriority = eventPriority(this.orderingFloorEvent.kind)
      const newPriority = eventPriority(event.kind)

      if (
        newPriority < activePriority ||
        (newPriority === activePriority &&
          event.employeeIdForOrdering !== null &&
          this.orderingFloorEvent.employeeIdForOrdering !== null &&
          event.employeeIdForOrdering <
            this.orderingFloorEvent.employeeIdForOrdering)
      ) {
        throw new RangeError('Нельзя добавить событие в уже завершённую фазу текущей временной метки')
      }
    }

  }

  cancelScheduled(predicate: (event: SimulationEvent) => boolean): number {
    return this.queue.removeWhere(predicate)
  }

  cancelScheduledKinds(
    kinds: readonly SimulationEvent['kind'][],
    subjectId: number,
  ): number {
    return this.queue.cancelKindsForSubject(kinds, subjectId)
  }

  startNewWaveAtCurrentTime(): void {
    if (this.queue.nextTime() === this.state.currentTime) {
      throw new Error('Новая волна событий возможна только после завершения текущей временной метки')
    }
    this.orderingFloorEvent = null
  }

  runNext(): SimulationEvent | undefined {
    const event = this.queue.dequeueOwned()

    if (event === undefined) {
      return undefined
    }

    if (event.time < this.state.currentTime) {
      throw new Error('Очередь содержит событие из прошлого')
    }

    this.state.currentTime = event.time
    this.orderingFloorEvent = event
    this.process(event)
    this.state.processedEvents.push(event)
    this.coordinator?.afterEvent(event, this)

    return event
  }

  runUntilEmpty(maxEvents = 1_000_000): number {
    if (!Number.isInteger(maxEvents) || maxEvents <= 0) {
      throw new RangeError('Лимит событий должен быть положительным целым числом')
    }

    let processedCount = 0

    while (!this.queue.isEmpty) {
      if (processedCount >= maxEvents) {
        throw new Error(`Превышен лимит обработки: ${maxEvents} событий`)
      }

      this.runNext()
      processedCount += 1
    }

    return processedCount
  }

  private process(event: SimulationEvent): void {
    switch (event.kind) {
      case 'elevator-doors-opened':
        this.openElevatorDoors(event.payload as DoorsOpenedPayload)
        return
      case 'passenger-exited':
        this.exitPassenger(event.payload as PassengerExitedPayload)
        return
      case 'hall-call-created':
        this.createHallCall(event.payload as HallCallCreatedPayload)
        return
      case 'hall-call-joined':
        this.joinHallCall(event.payload as HallCallJoinedPayload)
        return
      case 'passenger-entered':
        this.enterPassenger(event.payload as PassengerEnteredPayload)
        return
      case 'hall-call-updated':
        this.updateHallCall(event.payload as HallCallUpdatedPayload)
        return
      case 'hall-call-reactivated':
        this.reactivateHallCall(event.payload as HallCallUpdatedPayload)
        return
      case 'elevator-doors-closing-started':
        this.startClosingElevatorDoors(event.payload as ElevatorPayload)
        return
      case 'elevator-doors-closed':
        this.closeElevatorDoors(event.payload as ElevatorPayload)
        return
      case 'dispatch-requested':
      case 'parking-timeout':
      case 'parking-rule-boundary':
      case 'journey-requested':
        return
      case 'parking-step-arrived':
        this.completeParkingStep(event.payload as ParkingStepPayload)
        return
      case 'stairs-segment-completed':
        this.completeStairsSegment(event.payload as StairsSegmentCompletedPayload)
        return
    }
  }

  private completeParkingStep(payload: ParkingStepPayload): void {
    const elevator = this.requireElevator(payload.elevatorId)
    if (elevator.state !== 'moving' || elevator.passengerIds.length > 0) throw new Error(`Парковочное движение лифта ${elevator.id} задано некорректно`)
    elevator.currentFloor = payload.targetFloor
    elevator.movement = null
    elevator.state = 'idle-closed'
    elevator.direction = 'idle'
  }

  private openElevatorDoors(payload: DoorsOpenedPayload): void {
    const elevator = this.requireElevator(payload.elevatorId)

    if (elevator.state !== 'moving' && elevator.state !== 'opening-doors') {
      throw new Error(`Нельзя открыть двери лифта ${elevator.id} из состояния ${elevator.state}`)
    }

    elevator.currentFloor = payload.floor
    elevator.state = 'doors-open'
  }

  private closeElevatorDoors(payload: ElevatorPayload): void {
    const elevator = this.requireElevator(payload.elevatorId)

    if (elevator.state !== 'closing-doors') {
      throw new Error(`Нельзя закрыть двери лифта ${elevator.id} из состояния ${elevator.state}`)
    }

    elevator.state =
      elevator.passengerIds.length > 0 || elevator.scheduledStops.length > 0
        ? 'moving'
        : 'idle-closed'

    if (elevator.state === 'idle-closed') {
      elevator.direction = 'idle'
    }
  }

  private startClosingElevatorDoors(payload: ElevatorPayload): void {
    const elevator = this.requireElevator(payload.elevatorId)

    if (elevator.state !== 'doors-open') {
      throw new Error(`Нельзя начать закрытие дверей лифта ${elevator.id} из состояния ${elevator.state}`)
    }

    elevator.state = 'closing-doors'
  }

  private createHallCall(payload: HallCallCreatedPayload): void {
    const call = structuredClone(payload.call)

    if (this.state.hallCalls.has(call.id)) {
      if (this.earlyCreatedHallCallIds.delete(call.id)) return
      throw new Error(`Вызов ${call.id} уже существует`)
    }

    if (new Set(call.waitingEmployeeIds).size !== call.waitingEmployeeIds.length) {
      throw new Error(`Вызов ${call.id} содержит повторяющихся сотрудников`)
    }

    const waitingEmployees = call.waitingEmployeeIds.map((employeeId) => {
      const employee = this.requireEmployee(employeeId)

      if (employee.currentFloor !== call.floor) {
        throw new Error(`Сотрудник ${employeeId} находится не на этаже вызова ${call.floor}`)
      }

      if (employee.state !== 'on-floor' || employee.activeCallId !== null) {
        throw new Error(`Сотрудник ${employeeId} уже выполняет маршрут или ожидает другой лифт`)
      }

      if (employee.targetFloor === null) {
        throw new Error(`Для сотрудника ${employeeId} не указан целевой этаж`)
      }

      const directionIsValid =
        call.direction === 'up'
          ? employee.targetFloor > call.floor
          : employee.targetFloor < call.floor

      if (!directionIsValid) {
        throw new Error(`Целевой этаж сотрудника ${employeeId} не соответствует направлению вызова`)
      }

      return employee
    })

    call.waitingEmployeeIds.sort((first, second) => first - second)

    for (const employee of waitingEmployees) {
      employee.state = 'waiting-for-elevator'
      employee.activeCallId = call.id
    }

    this.state.hallCalls.set(call.id, call)
  }

  private joinHallCall(payload: HallCallJoinedPayload): void {
    if (!this.state.hallCalls.has(payload.callId)) {
      if (payload.pendingCall === undefined || payload.pendingCall.id !== payload.callId) {
        throw new Error(`Вызов ${payload.callId} не найден`)
      }
      this.createHallCall({ call: payload.pendingCall })
      this.earlyCreatedHallCallIds.add(payload.callId)
    }
    const call = this.requireHallCall(payload.callId)
    const employee = this.requireEmployee(payload.employeeId)
    if (call.status === 'served') throw new Error(`Нельзя присоединиться к обслуженному вызову ${call.id}`)
    if (call.waitingEmployeeIds.includes(employee.id)) throw new Error(`Сотрудник ${employee.id} уже ожидает по вызову ${call.id}`)
    if (employee.currentFloor !== call.floor) throw new Error(`Сотрудник ${employee.id} находится не на этаже вызова ${call.floor}`)
    if (employee.state !== 'on-floor' || employee.activeCallId !== null) throw new Error(`Сотрудник ${employee.id} уже выполняет маршрут или ожидает другой лифт`)
    if (employee.targetFloor === null) throw new Error(`Для сотрудника ${employee.id} не указан целевой этаж`)
    const directionIsValid = call.direction === 'up'
      ? employee.targetFloor > call.floor
      : employee.targetFloor < call.floor
    if (!directionIsValid) throw new Error(`Целевой этаж сотрудника ${employee.id} не соответствует направлению вызова`)
    call.waitingEmployeeIds.push(employee.id)
    employee.state = 'waiting-for-elevator'
    employee.activeCallId = call.id
  }

  private enterPassenger(payload: PassengerEnteredPayload): void {
    const elevator = this.requireElevator(payload.elevatorId)
    const employee = this.requireEmployee(payload.employeeId)

    if (elevator.state !== 'doors-open') {
      throw new Error(`Сотрудник ${employee.id} не может войти: двери лифта закрыты`)
    }

    if (elevator.passengerIds.length >= elevator.capacity) {
      throw new Error(`Сотрудник ${employee.id} не может войти: лифт заполнен`)
    }

    if (employee.currentFloor !== elevator.currentFloor) {
      throw new Error(`Сотрудник ${employee.id} и лифт ${elevator.id} находятся на разных этажах`)
    }

    if (employee.state !== 'waiting-for-elevator') {
      throw new Error(`Сотрудник ${employee.id} не находится в состоянии ожидания лифта`)
    }

    if (elevator.passengerIds.includes(employee.id)) {
      throw new Error(`Сотрудник ${employee.id} уже находится в лифте ${elevator.id}`)
    }

    if (payload.callId === null || payload.callId === undefined) {
      throw new Error(`Для посадки сотрудника ${employee.id} должен быть указан вызов`)
    }

    const call = this.requireHallCall(payload.callId)

    if (employee.activeCallId !== call.id) {
      throw new Error(`Сотрудник ${employee.id} ожидает не по вызову ${call.id}`)
    }

    if (call.floor !== elevator.currentFloor) {
      throw new Error(`Вызов ${call.id} относится к другому этажу`)
    }
    const waitingIndex = call.waitingEmployeeIds.indexOf(employee.id)

    if (waitingIndex === -1) {
      throw new Error(`Сотрудник ${employee.id} не ожидает по вызову ${call.id}`)
    }

    call.waitingEmployeeIds.splice(waitingIndex, 1)

    elevator.passengerIds.push(employee.id)
    employee.state = 'riding-elevator'
    employee.elevatorId = elevator.id
    employee.activeCallId = null
  }

  private exitPassenger(payload: PassengerExitedPayload): void {
    const elevator = this.requireElevator(payload.elevatorId)
    const employee = this.requireEmployee(payload.employeeId)
    const passengerIndex = elevator.passengerIds.indexOf(employee.id)

    if (elevator.state !== 'doors-open') {
      throw new Error(`Сотрудник ${employee.id} не может выйти: двери лифта закрыты`)
    }

    if (passengerIndex === -1 || employee.elevatorId !== elevator.id) {
      throw new Error(`Сотрудник ${employee.id} не находится в лифте ${elevator.id}`)
    }

    elevator.passengerIds.splice(passengerIndex, 1)
    employee.currentFloor = elevator.currentFloor
    employee.elevatorId = null
    employee.state = employee.targetFloor === elevator.currentFloor ? 'arrived' : 'on-floor'
  }

  private updateHallCall(payload: HallCallUpdatedPayload): void {
    const call = this.requireHallCall(payload.callId)

    if (call.waitingEmployeeIds.length === 0) {
      call.status = 'served'
      call.assignedElevatorId = null
    }
  }

  private reactivateHallCall(payload: HallCallUpdatedPayload): void {
    const call = this.requireHallCall(payload.callId)

    if (call.waitingEmployeeIds.length === 0) {
      throw new Error(`Нельзя повторно активировать пустой вызов ${call.id}`)
    }

    call.status = 'waiting'
    call.assignedElevatorId = null

    for (const elevator of this.state.elevators.values()) {
      elevator.assignedCallIds = elevator.assignedCallIds.filter(
        (callId) => callId !== call.id,
      )
    }
  }

  private completeStairsSegment(payload: StairsSegmentCompletedPayload): void {
    const employee = this.requireEmployee(payload.employeeId)
    if (employee.state !== 'using-stairs') {
      throw new Error(`Сотрудник ${employee.id} не находится на лестнице`)
    }
    employee.currentFloor = payload.targetFloor
    employee.targetFloor = payload.targetFloor
    employee.state = 'arrived'
  }

  private requireElevator(id: ElevatorId): Elevator {
    const elevator = this.state.elevators.get(id)

    if (elevator === undefined) {
      throw new Error(`Лифт ${id} не найден`)
    }

    return elevator
  }

  private requireEmployee(id: EmployeeId): Employee {
    const employee = this.state.employees.get(id)

    if (employee === undefined) {
      throw new Error(`Сотрудник ${id} не найден`)
    }

    return employee
  }

  private requireHallCall(id: HallCallId): HallCall {
    const call = this.state.hallCalls.get(id)

    if (call === undefined) {
      throw new Error(`Вызов ${id} не найден`)
    }

    return call
  }
}
