import type {
  Elevator,
  ElevatorId,
  Employee,
  EmployeeId,
  HallCall,
  HallCallId,
  SimulationEvent,
} from './domain'
import { secondsToTicks, type SimulationTick } from './time'

export interface SimulationState {
  currentTime: SimulationTick
  readonly elevators: Map<ElevatorId, Elevator>
  readonly employees: Map<EmployeeId, Employee>
  readonly hallCalls: Map<HallCallId, HallCall>
  readonly processedEvents: SimulationEvent[]
}

export interface InitialSimulationState {
  readonly elevators?: readonly Elevator[]
  readonly employees?: readonly Employee[]
  readonly hallCalls?: readonly HallCall[]
  readonly startTime?: SimulationTick
}

function mapByUniqueId<T extends { readonly id: number }>(
  entities: readonly T[],
  entityName: string,
): Map<number, T> {
  const result = new Map<number, T>()

  for (const entity of entities) {
    if (!Number.isSafeInteger(entity.id) || entity.id < 0) {
      throw new RangeError(`${entityName} должен иметь безопасный неотрицательный целочисленный ID`)
    }

    if (result.has(entity.id)) {
      throw new Error(`${entityName} с идентификатором ${entity.id} указан повторно`)
    }

    result.set(entity.id, structuredClone(entity))
  }

  return result
}

function assertFloor(floor: number, fieldName: string): void {
  if (!Number.isSafeInteger(floor) || floor === 0) {
    throw new RangeError(`${fieldName} должен быть целым номером этажа, кроме нуля`)
  }
}

function assertOptionalTick(
  tick: SimulationTick | null,
  fieldName: string,
): void {
  if (tick !== null && (!Number.isSafeInteger(tick) || tick < 0)) {
    throw new RangeError(`${fieldName} должен быть неотрицательным целым числом тиков`)
  }
}

function validateState(state: SimulationState): void {
  if (!Number.isSafeInteger(state.currentTime) || state.currentTime < 0) {
    throw new RangeError('Начальное время должно быть неотрицательным целым числом тиков')
  }

  const employeesInElevators = new Set<EmployeeId>()

  for (const elevator of state.elevators.values()) {
    assertFloor(elevator.currentFloor, `Текущий этаж лифта ${elevator.id}`)

    if (!Number.isSafeInteger(elevator.capacity) || elevator.capacity < 1) {
      throw new RangeError(`Вместимость лифта ${elevator.id} должна быть положительным целым числом`)
    }

    if (new Set(elevator.passengerIds).size !== elevator.passengerIds.length) {
      throw new Error(`В лифте ${elevator.id} один сотрудник указан несколько раз`)
    }

    if (elevator.passengerIds.length > elevator.capacity) {
      throw new Error(`Лифт ${elevator.id} переполнен в начальном состоянии`)
    }

    if (new Set(elevator.assignedCallIds).size !== elevator.assignedCallIds.length) {
      throw new Error(`У лифта ${elevator.id} один вызов назначен несколько раз`)
    }

    if (
      new Set(elevator.pendingBoardingEmployeeIds).size !==
      elevator.pendingBoardingEmployeeIds.length
    ) {
      throw new Error(`У лифта ${elevator.id} один сотрудник ожидает посадку несколько раз`)
    }

    for (const floor of elevator.scheduledStops) {
      assertFloor(floor, `Запланированная остановка лифта ${elevator.id}`)
    }

    if (new Set(elevator.scheduledStops).size !== elevator.scheduledStops.length) {
      throw new Error(`У лифта ${elevator.id} одна остановка запланирована несколько раз`)
    }

    if (elevator.parkingFloor !== null) {
      assertFloor(elevator.parkingFloor, `Парковочный этаж лифта ${elevator.id}`)
    }

    assertOptionalTick(elevator.parkingTimeoutAt, `Тайм-аут парковки лифта ${elevator.id}`)
    assertOptionalTick(elevator.doorServiceEndsAt, `Окончание обслуживания дверей лифта ${elevator.id}`)

    if (elevator.movement !== null) {
      assertFloor(elevator.movement.fromFloor, `Начальный этаж движения лифта ${elevator.id}`)
      assertFloor(elevator.movement.toFloor, `Целевой этаж движения лифта ${elevator.id}`)
      assertOptionalTick(elevator.movement.startedAt, `Начало движения лифта ${elevator.id}`)
      assertOptionalTick(elevator.movement.arrivesAt, `Окончание движения лифта ${elevator.id}`)

      if (elevator.movement.arrivesAt <= elevator.movement.startedAt) {
        throw new Error(`Интервал движения лифта ${elevator.id} задан некорректно`)
      }
    }

    if (elevator.state === 'moving' && elevator.movement === null) {
      throw new Error(`Движущийся лифт ${elevator.id} должен иметь активный участок движения`)
    }

    if (elevator.state !== 'moving' && elevator.movement !== null) {
      throw new Error(`Неподвижный лифт ${elevator.id} не должен иметь активный участок движения`)
    }

    if (elevator.mandatoryCallId !== null) {
      const mandatoryCall = state.hallCalls.get(elevator.mandatoryCallId)
      if (
        mandatoryCall === undefined ||
        mandatoryCall.assignedElevatorId !== elevator.id ||
        !elevator.assignedCallIds.includes(mandatoryCall.id)
      ) {
        throw new Error(`Обязательная точка подачи лифта ${elevator.id} не согласована с вызовом`)
      }

      if (!['moving', 'opening-doors'].includes(elevator.state)) {
        throw new Error(`Лифт ${elevator.id} с обязательной точкой подачи должен двигаться или открывать двери`)
      }

      if (
        elevator.state === 'moving' &&
        elevator.movement?.toFloor !== mandatoryCall.floor
      ) {
        throw new Error(`Движение лифта ${elevator.id} не ведёт к обязательной точке подачи`)
      }

      if (
        elevator.state === 'opening-doors' &&
        elevator.currentFloor !== mandatoryCall.floor
      ) {
        throw new Error(`Лифт ${elevator.id} открывает двери не на обязательной точке подачи`)
      }
    }

    if (elevator.state === 'moving' && elevator.direction === 'idle') {
      throw new Error(`Движущийся лифт ${elevator.id} должен иметь направление`)
    }

    if (elevator.state === 'idle-closed' && elevator.direction !== 'idle') {
      throw new Error(`Свободный лифт ${elevator.id} не должен иметь направление движения`)
    }

    for (const employeeId of elevator.passengerIds) {
      if (employeesInElevators.has(employeeId)) {
        throw new Error(`Сотрудник ${employeeId} находится сразу в нескольких лифтах`)
      }

      const employee = state.employees.get(employeeId)

      if (employee === undefined) {
        throw new Error(`В лифте ${elevator.id} указан отсутствующий сотрудник ${employeeId}`)
      }

      if (employee.state !== 'riding-elevator' || employee.elevatorId !== elevator.id) {
        throw new Error(`Состояние сотрудника ${employeeId} не соответствует лифту ${elevator.id}`)
      }

      employeesInElevators.add(employeeId)
    }
  }

  for (const call of state.hallCalls.values()) {
    assertFloor(call.floor, `Этаж вызова ${call.id}`)
    assertOptionalTick(call.createdAt, `Время создания вызова ${call.id}`)

    if (new Set(call.waitingEmployeeIds).size !== call.waitingEmployeeIds.length) {
      throw new Error(`Вызов ${call.id} содержит повторяющихся сотрудников`)
    }

    if (call.status === 'served' && call.waitingEmployeeIds.length > 0) {
      throw new Error(`Обслуженный вызов ${call.id} не может содержать ожидающих сотрудников`)
    }

    if (call.status === 'assigned' && call.assignedElevatorId === null) {
      throw new Error(`Назначенный вызов ${call.id} должен иметь лифт`)
    }

    if (call.status !== 'assigned' && call.assignedElevatorId !== null) {
      throw new Error(`Вызов ${call.id} имеет лифт, но не находится в статусе assigned`)
    }

    if (
      call.assignedElevatorId !== null &&
      !state.elevators.has(call.assignedElevatorId)
    ) {
      throw new Error(`Вызов ${call.id} назначен отсутствующему лифту ${call.assignedElevatorId}`)
    }

    for (const employeeId of call.waitingEmployeeIds) {
      const employee = state.employees.get(employeeId)

      if (employee === undefined) {
        throw new Error(`В вызове ${call.id} указан отсутствующий сотрудник ${employeeId}`)
      }

      if (
        employee.state !== 'waiting-for-elevator' ||
        employee.activeCallId !== call.id
      ) {
        throw new Error(`Состояние сотрудника ${employeeId} не соответствует вызову ${call.id}`)
      }


      if (employee.currentFloor !== call.floor) {
        throw new Error(`Сотрудник ${employeeId} находится не на этаже вызова ${call.id}`)
      }
    }
  }

  for (const employee of state.employees.values()) {
    assertFloor(employee.homeFloor, `Рабочий этаж сотрудника ${employee.id}`)
    assertFloor(employee.currentFloor, `Текущий этаж сотрудника ${employee.id}`)

    if (employee.targetFloor !== null) {
      assertFloor(employee.targetFloor, `Целевой этаж сотрудника ${employee.id}`)
    }

    if (employee.state === 'riding-elevator') {
      if (employee.elevatorId === null || !employeesInElevators.has(employee.id)) {
        throw new Error(`Сотрудник ${employee.id} едет в лифте, но не указан в его кабине`)
      }
    } else if (employee.elevatorId !== null) {
      throw new Error(`Сотрудник ${employee.id} имеет лифт, но не находится в состоянии поездки`)
    }

    if (employee.state === 'waiting-for-elevator') {
      if (
        employee.activeCallId === null ||
        !state.hallCalls.has(employee.activeCallId)
      ) {
        throw new Error(`Ожидающий сотрудник ${employee.id} не связан с вызовом`)
      }

      const activeCall = state.hallCalls.get(employee.activeCallId)!

      if (
        activeCall.status === 'served' ||
        !activeCall.waitingEmployeeIds.includes(employee.id) ||
        activeCall.floor !== employee.currentFloor
      ) {
        throw new Error(`Ожидающий сотрудник ${employee.id} некорректно связан с вызовом ${activeCall.id}`)
      }
    } else if (employee.activeCallId !== null) {
      throw new Error(`Сотрудник ${employee.id} связан с вызовом, но не ожидает лифт`)
    }
  }

  for (const elevator of state.elevators.values()) {
    for (const callId of elevator.assignedCallIds) {
      const call = state.hallCalls.get(callId)

      if (call === undefined || call.assignedElevatorId !== elevator.id) {
        throw new Error(`Назначение вызова ${callId} не согласовано с лифтом ${elevator.id}`)
      }
    }
  }

  for (const call of state.hallCalls.values()) {
    if (call.assignedElevatorId !== null) {
      const elevator = state.elevators.get(call.assignedElevatorId)!

      if (!elevator.assignedCallIds.includes(call.id)) {
        throw new Error(`Лифт ${elevator.id} не содержит назначенный ему вызов ${call.id}`)
      }
    }
  }
}

export function createSimulationState(
  initial: InitialSimulationState = {},
): SimulationState {
  const state: SimulationState = {
    currentTime: initial.startTime ?? secondsToTicks(0),
    elevators: mapByUniqueId(initial.elevators ?? [], 'Лифт'),
    employees: mapByUniqueId(initial.employees ?? [], 'Сотрудник'),
    hallCalls: mapByUniqueId(initial.hallCalls ?? [], 'Вызов'),
    processedEvents: [],
  }

  validateState(state)
  return state
}
