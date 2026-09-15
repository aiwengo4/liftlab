import type { EmployeeId, Floor } from './domain'
import type { DaySchedule } from './daySchedule'
import { runDayJourneyScenario, type DayJourneyResult } from './dayJourneyRunner'
import type { LunchSchedule } from './lunchSchedule'
import type { MeetingSchedule } from './meetingSchedule'
import { minuteToSimulationTick, type JourneyIntent, type JourneyScenarioSettings, type JourneyTrace } from './journeyRunner'
import type { SimulationState } from './state'
import { calculateSimulationMetrics, DEFAULT_REPORT_PERIODS, validateMetricsSettings, type MetricsSettings, type SimulationMetrics } from './metrics'
import { calculateOperationalMetrics, type OperationalMetrics } from './operationalMetrics'

export interface FullDayResult extends DayJourneyResult {
  readonly arrivals: readonly JourneyTrace[]
  readonly departures: readonly JourneyTrace[]
  readonly metrics: SimulationMetrics
  readonly operationalMetrics: OperationalMetrics
}

export interface FullDayScenarioSettings extends JourneyScenarioSettings {
  readonly servedFloors?: readonly Floor[]
  readonly metrics?: MetricsSettings
}

export function runFullDayScenario(
  state: SimulationState,
  day: DaySchedule,
  meetings: MeetingSchedule,
  lunches: LunchSchedule,
  settings: FullDayScenarioSettings,
): FullDayResult {
  const servedFloors = settings.servedFloors ?? Array.from({ length: settings.floorCount }, (_, index) => index + 1)
  const minFloor = settings.minFloor ?? 1
  validateMetricsSettings(settings.metrics)
  validateFullDay(state, day, meetings, lunches, settings.floorCount, minFloor, servedFloors)
  const elevatorDescriptors = [...state.elevators.values()].map(({ id, capacity }) => ({ id, capacity }))
  const intents: JourneyIntent[] = []
  for (const employee of [...day.employees].sort((a, b) => a.id - b.id)) {
    intents.push({
      id: `day-arrival-${employee.id}`,
      employeeId: employee.id,
      plannedStartAt: minuteToSimulationTick(employee.arrivalMinute),
      targetFloor: employee.homeFloor,
      purpose: 'arrival',
      fixedTransportMode: 'elevator',
      allowedElevatorFloors: servedFloors,
    })
    intents.push({
      id: `day-departure-${employee.id}`,
      employeeId: employee.id,
      plannedStartAt: minuteToSimulationTick(employee.departureMinute),
      targetFloor: employee.departureFloor ?? 1,
      purpose: 'departure',
      fixedTransportMode: 'elevator',
      allowedElevatorFloors: servedFloors,
    })
  }
  const result = runDayJourneyScenario(state, meetings, lunches, settings, intents)
  const periods = settings.metrics?.periods ?? DEFAULT_REPORT_PERIODS
  const firstEventAt = result.processedEvents[0]?.time ?? minuteToSimulationTick(periods.morning.startMinute)
  const operationsStartAt = Math.min(firstEventAt, minuteToSimulationTick(periods.morning.startMinute)) as typeof state.currentTime
  const operationsEndAt = Math.max(state.currentTime, minuteToSimulationTick(periods.evening.endMinute)) as typeof state.currentTime
  return {
    ...result,
    arrivals: result.traces.filter((trace) => trace.purpose === 'arrival'),
    departures: result.traces.filter((trace) => trace.purpose === 'departure'),
    metrics: calculateSimulationMetrics(result.traces, settings.metrics),
    operationalMetrics: calculateOperationalMetrics(result.processedEvents, elevatorDescriptors, { startAt: operationsStartAt, endAt: operationsEndAt }),
  }
}

function validateFullDay(
  state: Readonly<SimulationState>,
  day: DaySchedule,
  meetings: MeetingSchedule,
  lunches: LunchSchedule,
  floorCount: number,
  minFloor: number,
  servedFloors: readonly Floor[],
): void {
  if (servedFloors.length === 0 || new Set(servedFloors).size !== servedFloors.length) throw new Error('Разрешённые остановки должны быть заданы без повторов')
  if (!servedFloors.includes(1)) throw new Error('Лифт должен останавливаться на первом этаже')
  for (const floor of servedFloors) if (!validFloor(floor, minFloor, floorCount)) throw new Error('Разрешённая остановка должна находиться внутри здания')
  if (day.floorCount !== floorCount) throw new Error('Этажность расписания и сценария должна совпадать')
  const scheduled = new Map<EmployeeId, DaySchedule['employees'][number]>()
  for (const employee of day.employees) {
    if (scheduled.has(employee.id)) throw new Error('ID сотрудников дневного расписания должны быть уникальными')
    const actual = state.employees.get(employee.id)
    if (actual === undefined) throw new Error(`Сотрудник ${employee.id} не найден`)
    if (actual.homeFloor !== employee.homeFloor) throw new Error(`Рабочий этаж сотрудника ${employee.id} не совпадает с расписанием`)
    const arrivalFloor = employee.arrivalFloor ?? 1
    const departureFloor = employee.departureFloor ?? 1
    if (!validFloor(arrivalFloor, minFloor, floorCount) || !validFloor(departureFloor, minFloor, floorCount)) throw new Error(`Этаж прихода или ухода сотрудника ${employee.id} находится вне здания`)
    if (!servedFloors.includes(arrivalFloor) || !servedFloors.includes(departureFloor)) throw new Error(`Этаж прихода или ухода сотрудника ${employee.id} должен обслуживаться лифтом`)
    if (actual.currentFloor !== arrivalFloor) throw new Error(`До начала дня сотрудник ${employee.id} должен находиться на этаже прихода`)
    if (employee.arrivalMinute > employee.departureMinute) throw new Error(`Сотрудник ${employee.id} не может уйти раньше прихода`)
    scheduled.set(employee.id, employee)
  }
  if (scheduled.size !== state.employees.size) throw new Error('Состав сотрудников состояния и дневного расписания должен совпадать')

  for (const meeting of meetings.meetings) for (const participant of meeting.participantDepartures) {
    const employee = scheduled.get(participant.employeeId)
    if (employee === undefined) throw new Error(`Участник встречи ${participant.employeeId} отсутствует в дневном расписании`)
    if (participant.departureMinute < employee.arrivalMinute || meeting.endMinute > employee.departureMinute) {
      throw new Error(`Встреча сотрудника ${participant.employeeId} находится вне времени его присутствия`)
    }
  }
  for (const lunch of lunches.lunches) {
    const employee = scheduled.get(lunch.employeeId)
    if (employee === undefined) throw new Error(`Сотрудник с обедом ${lunch.employeeId} отсутствует в дневном расписании`)
    if (lunch.startMinute < employee.arrivalMinute || lunch.returnStartMinute > employee.departureMinute) {
      throw new Error(`Обед сотрудника ${lunch.employeeId} находится вне времени его присутствия`)
    }
  }
}

function validFloor(floor: Floor, minFloor: number, maxFloor: number): boolean {
  return Number.isSafeInteger(floor) && floor !== 0 && floor >= minFloor && floor <= maxFloor
}
