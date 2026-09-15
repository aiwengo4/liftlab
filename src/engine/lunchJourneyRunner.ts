import type { EmployeeId, Floor } from './domain'
import { lunchReturnStartTick, lunchStartTick, type EmployeeLunch, type LunchSchedule } from './lunchSchedule'
import { minuteToSimulationTick, runJourneyScenario, type JourneyIntent, type JourneyScenarioResult, type JourneyScenarioSettings, type JourneyTrace } from './journeyRunner'
import type { SimulationState } from './state'
import { addTicks, type SimulationTick } from './time'

export interface LunchExecution {
  readonly employeeId: EmployeeId
  readonly cafeteriaFloor: Floor
  readonly plannedStartAt: SimulationTick
  readonly actualStartAt: SimulationTick
  readonly plannedReturnStartAt: SimulationTick
  readonly actualReturnStartAt: SimulationTick
  readonly shiftedByRuntimeTicks: SimulationTick
  readonly outbound: JourneyTrace
  readonly returnJourney: JourneyTrace
}

export interface LunchJourneyResult extends JourneyScenarioResult {
  readonly lunches: readonly LunchExecution[]
}

export function runLunchJourneyScenario(
  state: SimulationState,
  schedule: LunchSchedule,
  settings: JourneyScenarioSettings,
): LunchJourneyResult {
  validateLunchJourneySchedule(state, schedule, settings.floorCount)
  const orderedLunches = [...schedule.lunches].sort((a, b) => a.startMinute - b.startMinute || a.employeeId - b.employeeId)
  const lunches = new Map(orderedLunches.map((lunch) => [lunch.employeeId, lunch]))
  const outboundByEmployee = new Map<EmployeeId, JourneyTrace>()
  const outboundIds = new Set(orderedLunches.map((lunch) => `lunch-outbound-${lunch.employeeId}`))
  const initial: JourneyIntent[] = orderedLunches.map((lunch) => ({
    id: `lunch-outbound-${lunch.employeeId}`,
    employeeId: lunch.employeeId,
    plannedStartAt: lunchStartTick(lunch),
    targetFloor: lunch.cafeteriaFloor,
    purpose: 'lunch',
  }))

  const result = runJourneyScenario(state, initial, {
    ...settings,
    onJourneyCompleted: undefined,
    onJourneysCompleted: (traces, currentState) => {
      const generated = [
        ...traces.flatMap((trace) => settings.onJourneyCompleted?.(trace, currentState) ?? []),
        ...(settings.onJourneysCompleted?.(traces, currentState) ?? []),
      ]
      for (const trace of traces) {
        if (!outboundIds.has(trace.id)) continue
        const lunch = lunches.get(trace.employeeId)!
        outboundByEmployee.set(trace.employeeId, trace)
        const duration = (lunchReturnStartTick(lunch) - lunchStartTick(lunch)) as SimulationTick
        const returnAt = Math.max(trace.completedAt, addTicks(trace.actualStartAt, duration)) as SimulationTick
        generated.push({
          id: `lunch-return-${trace.employeeId}`,
          employeeId: trace.employeeId,
          plannedStartAt: returnAt,
          targetFloor: currentState.employees.get(trace.employeeId)!.homeFloor,
          purpose: 'lunch-return',
        })
      }
      return generated
    },
  })

  const traces = new Map(result.traces.map((trace) => [trace.id, trace]))
  return {
    ...result,
    lunches: orderedLunches.map((lunch) => {
      const outbound = outboundByEmployee.get(lunch.employeeId)!
      const returnJourney = traces.get(`lunch-return-${lunch.employeeId}`)!
      const plannedStartAt = lunchStartTick(lunch)
      return {
        employeeId: lunch.employeeId,
        cafeteriaFloor: lunch.cafeteriaFloor,
        plannedStartAt,
        actualStartAt: outbound.actualStartAt,
        plannedReturnStartAt: lunchReturnStartTick(lunch),
        actualReturnStartAt: returnJourney.actualStartAt,
        shiftedByRuntimeTicks: (outbound.actualStartAt - plannedStartAt) as SimulationTick,
        outbound,
        returnJourney,
      }
    }),
  }
}

export function validateLunchJourneySchedule(
  state: Readonly<SimulationState>,
  schedule: LunchSchedule,
  floorCount: number,
): void {
  const employees = new Set<EmployeeId>()
  for (const lunch of schedule.lunches) {
    validateLunch(lunch, floorCount)
    if (employees.has(lunch.employeeId)) throw new Error(`Для сотрудника ${lunch.employeeId} обед запланирован повторно`)
    if (!state.employees.has(lunch.employeeId)) throw new Error(`Сотрудник ${lunch.employeeId} не найден`)
    employees.add(lunch.employeeId)
  }
  if (new Set(schedule.skippedEmployeeIds).size !== schedule.skippedEmployeeIds.length) {
    throw new Error('Список сотрудников без обеда не должен содержать повторов')
  }
  for (const employeeId of schedule.skippedEmployeeIds) {
    if (!Number.isSafeInteger(employeeId) || employeeId < 1 || !state.employees.has(employeeId)) {
      throw new Error(`Пропущенный сотрудник ${employeeId} не найден`)
    }
  }
  if (schedule.skippedEmployeeIds.some((id) => employees.has(id))) {
    throw new Error('Сотрудник не может одновременно иметь обед и находиться в списке пропущенных')
  }
}

function validateLunch(lunch: EmployeeLunch, floorCount: number): void {
  if (!Number.isSafeInteger(lunch.employeeId) || lunch.employeeId < 1) throw new RangeError('ID сотрудника должен быть положительным целым числом')
  if (!Number.isSafeInteger(lunch.cafeteriaFloor) || lunch.cafeteriaFloor < 1 || lunch.cafeteriaFloor > floorCount) throw new RangeError('Этаж столовой должен находиться внутри здания')
  for (const minute of [lunch.desiredStartMinute, lunch.startMinute, lunch.returnStartMinute]) {
    if (!Number.isSafeInteger(minute) || minute < 0 || minute > 24 * 60) throw new RangeError('Время обеда должно быть целой минутой суток')
  }
  if (!Number.isSafeInteger(lunch.startSecond ?? 0) || (lunch.startSecond ?? 0) < 0 || (lunch.startSecond ?? 0) > 59) {
    throw new RangeError('Секунда начала обеда должна быть целым числом от 0 до 59')
  }
  if (!Number.isSafeInteger(lunch.returnStartSecond ?? lunch.startSecond ?? 0) || (lunch.returnStartSecond ?? lunch.startSecond ?? 0) < 0 || (lunch.returnStartSecond ?? lunch.startSecond ?? 0) > 59) {
    throw new RangeError('Секунда возвращения с обеда должна быть целым числом от 0 до 59')
  }
  const duration = lunchReturnStartTick(lunch) - lunchStartTick(lunch)
  if (duration < minuteToSimulationTick(15) || duration > minuteToSimulationTick(60)) throw new RangeError('Продолжительность обеда должна быть от 15 до 60 минут')
  if (lunch.shiftedFromDesired !== (lunch.startMinute !== lunch.desiredStartMinute)) throw new Error('Признак переноса обеда не соответствует времени начала')
}
