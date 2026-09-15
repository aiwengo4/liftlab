import type { EmployeeId, Floor } from './domain'
import type { DaySchedule, MinuteOfDay } from './daySchedule'
import { SeededRandom } from './random'
import { secondsToTicks, type SimulationTick } from './time'

export interface BusyInterval {
  readonly startMinute: MinuteOfDay
  readonly endMinute: MinuteOfDay
}

export interface LunchSettings {
  readonly seed: number
  readonly cafeteriaFloor: Floor
  readonly startMinute: MinuteOfDay
  readonly endMinute: MinuteOfDay
  readonly peakMinute: MinuteOfDay
  readonly participationShare: number
  readonly durationMinutes: number
  readonly durationJitterMinutes?: number
  readonly waveWidthMinutes: number
}

export interface EmployeeLunch {
  readonly employeeId: EmployeeId
  readonly cafeteriaFloor: Floor
  readonly desiredStartMinute: MinuteOfDay
  readonly startMinute: MinuteOfDay
  readonly returnStartMinute: MinuteOfDay
  readonly returnStartSecond?: number
  readonly durationSeconds?: number
  /** Детерминированное распределение внутри назначенной минуты. */
  readonly startSecond?: number
  readonly shiftedFromDesired: boolean
}

export interface LunchSchedule {
  readonly lunches: readonly EmployeeLunch[]
  readonly skippedEmployeeIds: readonly EmployeeId[]
}

export const DEFAULT_LUNCH_SETTINGS: Omit<LunchSettings, 'seed' | 'cafeteriaFloor'> = {
  startMinute: 13 * 60,
  endMinute: 16 * 60,
  peakMinute: 14 * 60,
  participationShare: 0.8,
  durationMinutes: 30,
  durationJitterMinutes: 0,
  waveWidthMinutes: 30,
}

export function generateLunchSchedule(
  day: DaySchedule,
  settings: LunchSettings,
  busyByEmployee: ReadonlyMap<EmployeeId, readonly BusyInterval[]> = new Map(),
): LunchSchedule {
  validateLunchSettings(day, settings, busyByEmployee)
  const random = new SeededRandom(settings.seed)
  const secondRandom = new SeededRandom((settings.seed ^ 0x9e37_79b9) >>> 0)
  const durationRandom = new SeededRandom((settings.seed ^ 0x85eb_ca6b) >>> 0)
  const selected = selectEmployees(
    day.employees.map(({ id }) => id).sort((first, second) => first - second),
    Math.round(day.employees.length * settings.participationShare),
    random,
  )
  const employees = new Map(day.employees.map((employee) => [employee.id, employee]))
  const lunches: EmployeeLunch[] = []
  const skippedEmployeeIds: EmployeeId[] = []

  for (const employeeId of selected) {
    const employee = employees.get(employeeId)!
    const durationSeconds = randomizedDurationSeconds(settings, durationRandom)
    const occupiedMinutes = Math.ceil(durationSeconds / 60)
    const desiredStartMinute = truncatedNormalMinute(settings, random)
    const startMinute = nearestAvailableStart(
      desiredStartMinute,
      Math.max(settings.startMinute, employee.arrivalMinute),
      Math.min(
        settings.endMinute - 1,
        employee.departureMinute - occupiedMinutes,
      ),
      occupiedMinutes,
      busyByEmployee.get(employeeId) ?? [],
    )

    if (startMinute === null) {
      skippedEmployeeIds.push(employeeId)
      continue
    }

    const startSecond = safeStartSecond(startMinute, occupiedMinutes, employee.departureMinute, busyByEmployee.get(employeeId) ?? [], secondRandom)
    const returnAbsoluteSecond = startMinute * 60 + startSecond + durationSeconds
    lunches.push({
      employeeId,
      cafeteriaFloor: settings.cafeteriaFloor,
      desiredStartMinute,
      startMinute,
      returnStartMinute: Math.floor(returnAbsoluteSecond / 60),
      returnStartSecond: returnAbsoluteSecond % 60,
      durationSeconds,
      startSecond,
      shiftedFromDesired: startMinute !== desiredStartMinute,
    })
  }

  return {
    lunches: lunches.sort(
      (first, second) => first.startMinute - second.startMinute || (first.startSecond ?? 0) - (second.startSecond ?? 0) || first.employeeId - second.employeeId,
    ),
    skippedEmployeeIds: skippedEmployeeIds.sort((first, second) => first - second),
  }
}

export function lunchStartTick(lunch: EmployeeLunch): SimulationTick {
  return secondsToTicks(lunch.startMinute * 60 + (lunch.startSecond ?? 0))
}

export function lunchReturnStartTick(lunch: EmployeeLunch): SimulationTick {
  return secondsToTicks(lunch.returnStartMinute * 60 + (lunch.returnStartSecond ?? lunch.startSecond ?? 0))
}

function randomizedDurationSeconds(settings: LunchSettings, random: SeededRandom): number {
  const jitter = settings.durationJitterMinutes ?? 0
  if (jitter === 0) return settings.durationMinutes * 60
  const offsetSeconds = Math.round((random.next() * 2 - 1) * jitter * 60)
  return Math.max(15 * 60, Math.min(60 * 60, settings.durationMinutes * 60 + offsetSeconds))
}

function safeStartSecond(
  startMinute: MinuteOfDay,
  durationMinutes: number,
  departureMinute: MinuteOfDay,
  busyIntervals: readonly BusyInterval[],
  random: SeededRandom,
): number {
  const returnMinute = startMinute + durationMinutes
  // Если свободный интервал заканчивается ровно на границе встречи или ухода,
  // сдвиг внутрь минуты создал бы новое пересечение.
  if (returnMinute >= departureMinute || busyIntervals.some((busy) => busy.startMinute === returnMinute)) return 0
  return Math.floor(random.next() * 60)
}

function selectEmployees(
  employeeIds: readonly EmployeeId[],
  count: number,
  random: SeededRandom,
): EmployeeId[] {
  const shuffled = [...employeeIds]
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const replacement = Math.floor(random.next() * (index + 1))
    ;[shuffled[index], shuffled[replacement]] = [shuffled[replacement], shuffled[index]]
  }
  return shuffled.slice(0, count)
}

function truncatedNormalMinute(
  settings: LunchSettings,
  random: SeededRandom,
): MinuteOfDay {
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const first = Math.max(random.next(), Number.MIN_VALUE)
    const second = random.next()
    const standardNormal =
      Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second)
    const minute = Math.floor(
      settings.peakMinute + standardNormal * settings.waveWidthMinutes,
    )
    if (minute >= settings.startMinute && minute < settings.endMinute) {
      return minute
    }
  }

  return Math.min(
    settings.endMinute - 1,
    Math.max(settings.startMinute, settings.peakMinute),
  )
}

function nearestAvailableStart(
  desired: MinuteOfDay,
  earliest: MinuteOfDay,
  latest: MinuteOfDay,
  duration: number,
  busyIntervals: readonly BusyInterval[],
): MinuteOfDay | null {
  if (earliest > latest) return null
  const origin = Math.min(latest, Math.max(earliest, desired))

  for (let distance = 0; distance <= latest - earliest; distance += 1) {
    const earlier = origin - distance
    if (earlier >= earliest && isFree(earlier, duration, busyIntervals)) return earlier
    const later = origin + distance
    if (
      distance > 0 &&
      later <= latest &&
      isFree(later, duration, busyIntervals)
    ) return later
  }
  return null
}

function isFree(
  start: MinuteOfDay,
  duration: number,
  busyIntervals: readonly BusyInterval[],
): boolean {
  const end = start + duration
  return busyIntervals.every(
    (busy) => end <= busy.startMinute || start >= busy.endMinute,
  )
}

function validateLunchSettings(
  day: DaySchedule,
  settings: LunchSettings,
  busyByEmployee: ReadonlyMap<EmployeeId, readonly BusyInterval[]>,
): void {
  new SeededRandom(settings.seed)
  if (day.employees.length === 0) {
    throw new RangeError('Нельзя создать обеды для пустого расписания сотрудников')
  }
  if (
    !Number.isSafeInteger(settings.cafeteriaFloor) ||
    settings.cafeteriaFloor < 1 ||
    settings.cafeteriaFloor > day.floorCount
  ) {
    throw new RangeError('Этаж столовой должен находиться внутри здания')
  }
  for (const minute of [settings.startMinute, settings.endMinute, settings.peakMinute]) {
    if (!Number.isSafeInteger(minute) || minute < 0 || minute > 24 * 60) {
      throw new RangeError('Период обеда должен быть задан целыми минутами суток')
    }
  }
  if (
    settings.startMinute >= settings.endMinute ||
    settings.peakMinute < settings.startMinute ||
    settings.peakMinute >= settings.endMinute
  ) {
    throw new RangeError('Пик обеда должен находиться внутри периода обеда')
  }
  if (!Number.isFinite(settings.participationShare) || settings.participationShare < 0 || settings.participationShare > 1) {
    throw new RangeError('Доля сотрудников, идущих на обед, должна быть от 0 до 1')
  }
  if (!Number.isSafeInteger(settings.durationMinutes) || settings.durationMinutes < 15 || settings.durationMinutes > 60) {
    throw new RangeError('Продолжительность обеда должна быть целым числом от 15 до 60 минут')
  }
  if (!Number.isFinite(settings.durationJitterMinutes ?? 0) || (settings.durationJitterMinutes ?? 0) < 0 || (settings.durationJitterMinutes ?? 0) > 15) {
    throw new RangeError('Разброс продолжительности обеда должен быть от 0 до 15 минут')
  }
  if (!Number.isFinite(settings.waveWidthMinutes) || settings.waveWidthMinutes < 5 || settings.waveWidthMinutes > 120) {
    throw new RangeError('Ширина волны обеда должна быть от 5 до 120 минут')
  }

  const employeeIds = new Set(day.employees.map(({ id }) => id))
  for (const [employeeId, intervals] of busyByEmployee) {
    if (!employeeIds.has(employeeId)) {
      throw new RangeError(`Занятость указана для отсутствующего сотрудника ${employeeId}`)
    }
    for (const interval of intervals) {
      if (
        !Number.isSafeInteger(interval.startMinute) ||
        !Number.isSafeInteger(interval.endMinute) ||
        interval.startMinute < 0 ||
        interval.startMinute >= interval.endMinute ||
        interval.endMinute > 24 * 60
      ) {
        throw new RangeError(`Некорректный интервал занятости сотрудника ${employeeId}`)
      }
    }
  }
}
