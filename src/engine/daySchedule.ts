import { SeededRandom } from './random'
import type { EmployeeId, Floor } from './domain'

export type MinuteOfDay = number

export interface TimeWindow {
  readonly startMinute: MinuteOfDay
  readonly endMinute: MinuteOfDay
}

export interface WeightedTimeWindow {
  readonly overall: TimeWindow
  readonly primary: TimeWindow
  readonly primaryShare: number
}

export interface FloorPopulation {
  readonly floor: Floor
  readonly employees: number
}

export interface DayScheduleSettings {
  readonly seed: number
  readonly floorCount: number
  readonly floors: readonly FloorPopulation[]
  readonly arrival: WeightedTimeWindow
  readonly departure: WeightedTimeWindow
  readonly arrivalInfluenceOnDeparture: number
  readonly undergroundParking?: UndergroundParkingSettings
}

export interface UndergroundParkingSettings {
  readonly enabled: boolean
  readonly floorCount: number
  readonly employeeShare: number
}

export interface ScheduledEmployee {
  readonly id: EmployeeId
  readonly homeFloor: Floor
  readonly arrivalMinute: MinuteOfDay
  readonly departureMinute: MinuteOfDay
  readonly arrivalFloor?: Floor
  readonly departureFloor?: Floor
}

export interface DaySchedule {
  readonly seed: number
  readonly floorCount: number
  readonly employees: readonly ScheduledEmployee[]
}

export const DEFAULT_ARRIVAL_WINDOW: WeightedTimeWindow = {
  overall: { startMinute: 8 * 60, endMinute: 14 * 60 },
  primary: { startMinute: 9 * 60, endMinute: 12 * 60 },
  primaryShare: 0.8,
}

export const DEFAULT_DEPARTURE_WINDOW: WeightedTimeWindow = {
  overall: { startMinute: 18 * 60, endMinute: 23 * 60 },
  primary: { startMinute: 18 * 60, endMinute: 20 * 60 },
  primaryShare: 0.8,
}

export function generateDaySchedule(settings: DayScheduleSettings): DaySchedule {
  validateSettings(settings)
  const random = new SeededRandom(settings.seed)
  const identities = settings.floors
    .filter(({ employees }) => employees > 0)
    .sort((first, second) => first.floor - second.floor)
    .flatMap(({ floor, employees }) =>
      Array.from({ length: employees }, () => floor),
    )
    .map((homeFloor, index) => ({ id: index + 1, homeFloor }))

  const arrivals = generateWindowTimes(identities.length, settings.arrival, random)
  const departureSlots = generateWindowTimes(
    identities.length,
    settings.departure,
    random,
  ).sort((first, second) => first - second)
  const arrivalByEmployee = identities.map((identity, index) => ({
    ...identity,
    arrivalMinute: arrivals[index],
  }))
  const priorities = departurePriorities(
    arrivalByEmployee,
    settings.arrivalInfluenceOnDeparture,
    random,
  )
  const departureByEmployee = assignDepartureSlots(priorities, departureSlots)

  const parkingFloors = assignUndergroundParking(
    arrivalByEmployee.map(({ id }) => id),
    settings.undergroundParking,
    settings.seed,
  )
  return {
    seed: settings.seed,
    floorCount: settings.floorCount,
    employees: arrivalByEmployee.map((employee) => ({
      ...employee,
      departureMinute: departureByEmployee.get(employee.id)!,
      arrivalFloor: parkingFloors.get(employee.id) ?? 1,
      departureFloor: parkingFloors.get(employee.id) ?? 1,
    })),
  }
}

function assignUndergroundParking(
  employeeIds: readonly EmployeeId[],
  parking: UndergroundParkingSettings | undefined,
  seed: number,
): Map<EmployeeId, Floor> {
  if (parking === undefined || !parking.enabled || parking.employeeShare === 0) return new Map()
  const random = new SeededRandom((seed ^ 0x7061726b) >>> 0)
  const shuffled = [...employeeIds]
  shuffle(shuffled, random)
  const count = Math.round(shuffled.length * parking.employeeShare)
  return new Map(shuffled.slice(0, count).map((id, index) => [id, -(index % parking.floorCount + 1)]))
}

function generateWindowTimes(
  count: number,
  settings: WeightedTimeWindow,
  random: SeededRandom,
): MinuteOfDay[] {
  const primaryCount = Math.round(count * settings.primaryShare)
  const outsideCount = count - primaryCount
  const times = [
    ...sampleRange(primaryCount, settings.primary, random),
    ...sampleOutsidePrimary(outsideCount, settings, random),
  ]

  shuffle(times, random)
  return times
}

function sampleRange(
  count: number,
  window: TimeWindow,
  random: SeededRandom,
): MinuteOfDay[] {
  const length = window.endMinute - window.startMinute
  return Array.from(
    { length: count },
    () => window.startMinute + Math.floor(random.next() * length),
  )
}

function sampleOutsidePrimary(
  count: number,
  settings: WeightedTimeWindow,
  random: SeededRandom,
): MinuteOfDay[] {
  const beforeLength = settings.primary.startMinute - settings.overall.startMinute
  const afterLength = settings.overall.endMinute - settings.primary.endMinute
  const totalLength = beforeLength + afterLength

  return Array.from({ length: count }, () => {
    const offset = Math.floor(random.next() * totalLength)
    return offset < beforeLength
      ? settings.overall.startMinute + offset
      : settings.primary.endMinute + offset - beforeLength
  })
}

function departurePriorities(
  employees: readonly (Omit<ScheduledEmployee, 'departureMinute'>)[],
  influence: number,
  random: SeededRandom,
): Array<Omit<ScheduledEmployee, 'departureMinute'> & { priority: number }> {
  const arrivalOrder = [...employees].sort(
    (first, second) =>
      first.arrivalMinute - second.arrivalMinute || first.id - second.id,
  )
  const randomOrder = employees
    .map((employee) => ({ employee, value: random.next() }))
    .sort((first, second) => first.value - second.value || first.employee.id - second.employee.id)
  const arrivalRank = new Map(arrivalOrder.map((employee, rank) => [employee.id, rank]))
  const randomRank = new Map(randomOrder.map(({ employee }, rank) => [employee.id, rank]))

  return employees
    .map((employee) => ({
      ...employee,
      priority:
        influence * arrivalRank.get(employee.id)! +
        (1 - influence) * randomRank.get(employee.id)!,
    }))
    .sort((first, second) => first.priority - second.priority || first.id - second.id)
}

function assignDepartureSlots(
  employees: readonly (Omit<ScheduledEmployee, 'departureMinute'> & { priority: number })[],
  slots: readonly MinuteOfDay[],
): Map<EmployeeId, MinuteOfDay> {
  const unassigned = [...employees]
  const result = new Map<EmployeeId, MinuteOfDay>()

  for (const slot of slots) {
    const employeeIndex = unassigned.findIndex(
      (employee) => employee.arrivalMinute <= slot,
    )
    if (employeeIndex < 0) {
      throw new RangeError(
        'Набор времён ухода несовместим со временем прихода: сотрудник не может уйти до прихода',
      )
    }
    const [employee] = unassigned.splice(employeeIndex, 1)
    result.set(employee.id, slot)
  }

  return result
}

function shuffle<T>(items: T[], random: SeededRandom): void {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const replacement = Math.floor(random.next() * (index + 1))
    ;[items[index], items[replacement]] = [items[replacement], items[index]]
  }
}

function validateSettings(settings: DayScheduleSettings): void {
  new SeededRandom(settings.seed)
  if (settings.undergroundParking !== undefined) {
    const parking = settings.undergroundParking
    if (typeof parking.enabled !== 'boolean') throw new RangeError('Признак паркинга должен быть логическим')
    if (!Number.isSafeInteger(parking.floorCount) || parking.floorCount < 1 || parking.floorCount > 4) throw new RangeError('Количество подземных этажей должно быть от 1 до 4')
    if (!Number.isFinite(parking.employeeShare) || parking.employeeShare < 0 || parking.employeeShare > 1) throw new RangeError('Доля сотрудников с паркинга должна быть от 0 до 1')
  }
  if (
    !Number.isFinite(settings.arrivalInfluenceOnDeparture) ||
    settings.arrivalInfluenceOnDeparture < 0 ||
    settings.arrivalInfluenceOnDeparture > 1
  ) {
    throw new RangeError('Влияние времени прихода на уход должно быть от 0 до 1')
  }

  for (const [name, window] of [
    ['прихода', settings.arrival],
    ['ухода', settings.departure],
  ] as const) {
    validateWeightedWindow(name, window)
  }

  const seenFloors = new Set<number>()
  let total = 0
  if (!Number.isSafeInteger(settings.floorCount) || settings.floorCount < 2 || settings.floorCount > 100) {
    throw new RangeError('Количество этажей должно быть целым числом от 2 до 100')
  }
  for (const { floor, employees } of settings.floors) {
    if (!Number.isSafeInteger(floor) || floor < 1 || floor > settings.floorCount) {
      throw new RangeError('Этаж сотрудника должен находиться внутри здания')
    }
    if (seenFloors.has(floor)) {
      throw new RangeError('Этажи в распределении сотрудников не должны повторяться')
    }
    if (!Number.isSafeInteger(employees) || employees < 0) {
      throw new RangeError('Количество сотрудников на этаже должно быть целым неотрицательным числом')
    }
    seenFloors.add(floor)
    total += employees
  }
  if (total < 1 || total > 10_000) {
    throw new RangeError('Общее количество сотрудников должно быть от 1 до 10000')
  }
}

function validateWeightedWindow(name: string, window: WeightedTimeWindow): void {
  for (const value of [
    window.overall.startMinute,
    window.overall.endMinute,
    window.primary.startMinute,
    window.primary.endMinute,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 24 * 60) {
      throw new RangeError(`Границы периода ${name} должны быть целыми минутами суток`)
    }
  }
  if (
    window.overall.startMinute >= window.overall.endMinute ||
    window.primary.startMinute >= window.primary.endMinute ||
    window.primary.startMinute < window.overall.startMinute ||
    window.primary.endMinute > window.overall.endMinute
  ) {
    throw new RangeError(`Основное окно ${name} должно находиться внутри общего периода`)
  }
  if (!Number.isFinite(window.primaryShare) || window.primaryShare < 0 || window.primaryShare > 1) {
    throw new RangeError(`Доля основного окна ${name} должна быть от 0 до 1`)
  }
  const outsideLength =
    window.primary.startMinute - window.overall.startMinute +
    window.overall.endMinute - window.primary.endMinute
  if (window.primaryShare < 1 && outsideLength === 0) {
    throw new RangeError(`Для сотрудников вне основного окна ${name} не осталось времени`)
  }
}
