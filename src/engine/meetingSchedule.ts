import type { EmployeeId, Floor, TravelDirection } from './domain'
import type { BusyInterval } from './lunchSchedule'
import type { DaySchedule, MinuteOfDay, ScheduledEmployee } from './daySchedule'
import { SeededRandom } from './random'

export interface WeightedValue<T> {
  readonly value: T
  readonly weight: number
}

export interface MeetingSettings {
  readonly seed: number
  readonly startMinute: MinuteOfDay
  readonly endMinute: MinuteOfDay
  readonly maxConcurrentShare: number
  readonly meanVisitsPerEmployee: number
  readonly durations: readonly WeightedValue<30 | 45 | 60>[]
  readonly groupSizes: readonly WeightedValue<1 | 2 | 3 | 4 | '5-10'>[]
  readonly hourlyRoomFoundShares: readonly number[]
}

export interface PlannedMeeting {
  readonly id: number
  readonly startMinute: MinuteOfDay
  readonly endMinute: MinuteOfDay
  readonly departureLeadMinutes: 2 | 3
  readonly participantIds: readonly EmployeeId[]
  readonly participantDepartures: readonly {
    readonly employeeId: EmployeeId
    readonly departureMinute: MinuteOfDay
  }[]
  readonly homeFloor: Floor
  readonly searchRadius: 0 | 1 | 2
  readonly searchDirection: TravelDirection | null
  readonly searchFloors: readonly Floor[]
  readonly roomFound: boolean
  readonly returnAfterFailedSearch: boolean
}

export interface MeetingSchedule {
  readonly meetings: readonly PlannedMeeting[]
  readonly targetVisits: number
  readonly assignedVisits: number
  readonly unassignedVisits: number
}

export const DEFAULT_MEETING_SETTINGS: Omit<MeetingSettings, 'seed'> = {
  startMinute: 11 * 60,
  endMinute: 19 * 60,
  maxConcurrentShare: 0.4,
  meanVisitsPerEmployee: 3,
  durations: [
    { value: 30, weight: 0.3 },
    { value: 45, weight: 0.4 },
    { value: 60, weight: 0.3 },
  ],
  groupSizes: [
    { value: 1, weight: 0.8 },
    { value: 2, weight: 0.12 },
    { value: 3, weight: 0.05 },
    { value: 4, weight: 0.02 },
    { value: '5-10', weight: 0.01 },
  ],
  hourlyRoomFoundShares: Array.from({ length: 24 }, () => 0.8),
}

const SEARCH_RADII: readonly WeightedValue<0 | 1 | 2>[] = [
  { value: 0, weight: 0.5 },
  { value: 1, weight: 0.4 },
  { value: 2, weight: 0.1 },
]

export function generateMeetingSchedule(
  day: DaySchedule,
  settings: MeetingSettings,
): MeetingSchedule {
  validateMeetingSettings(day, settings)
  const random = new SeededRandom(settings.seed)
  const targetVisits = Math.round(day.employees.length * settings.meanVisitsPerEmployee)
  const concurrentLimit = Math.floor(day.employees.length * settings.maxConcurrentShare)
  const meetings: PlannedMeeting[] = []
  const concurrentOccupancy = new Int32Array(24 * 60)
  const intervals = new Map<EmployeeId, BusyInterval[]>()
  let assignedVisits = 0
  let attempts = 0
  const maximumAttempts = Math.max(1_000, targetVisits * 100)

  while (
    assignedVisits < targetVisits &&
    concurrentLimit > 0 &&
    attempts < maximumAttempts
  ) {
    attempts += 1
    const duration = weightedChoice(settings.durations, random)
    const departureLeadMinutes = random.next() < 0.5 ? 2 : 3
    const latestStart = settings.endMinute - duration
    const earliestStart = settings.startMinute
    if (latestStart < earliestStart) continue
    const startMinute =
      earliestStart +
      Math.floor(random.next() * (latestStart - earliestStart + 1))
    const endMinute = startMinute + duration
    const remainingCapacity = minimumRemainingCapacity(
      concurrentOccupancy,
      startMinute,
      endMinute,
      concurrentLimit,
    )
    if (remainingCapacity <= 0) continue

    const employee = random.choose(day.employees)
    if (employee.arrivalMinute > startMinute || employee.departureMinute < endMinute) continue
    const employeeIntervals = intervals.get(employee.id) ?? []
    if (employeeIntervals.some((interval) => startMinute < interval.endMinute && endMinute > interval.startMinute)) continue
    const previousMeetingEnd = Math.max(
      0,
      ...employeeIntervals
        .filter((interval) => interval.endMinute <= startMinute)
        .map((interval) => interval.endMinute),
    )
    const participantIds = [employee.id]
    const participantDepartures = [{
      employeeId: employee.id,
      departureMinute: Math.max(
        startMinute - departureLeadMinutes,
        previousMeetingEnd,
        employee.arrivalMinute,
      ),
    }]
    const search = createSearchPlan(employee.homeFloor, day.floorCount, random)
    const roomFound = random.next() < settings.hourlyRoomFoundShares[Math.floor(startMinute / 60)]
    const returnAfterFailedSearch = !roomFound && random.next() < 0.5
    const meeting: PlannedMeeting = {
      id: meetings.length + 1,
      startMinute,
      endMinute,
      departureLeadMinutes,
      participantIds,
      participantDepartures,
      homeFloor: employee.homeFloor,
      ...search,
      roomFound,
      returnAfterFailedSearch,
    }
    meetings.push(meeting)
    assignedVisits += 1

    for (let minute = startMinute; minute < endMinute; minute += 1) {
      concurrentOccupancy[minute] += 1
    }

    employeeIntervals.push({ startMinute, endMinute })
    intervals.set(employee.id, employeeIntervals)
  }

  const finalizedMeetings = finalizeParticipantDepartures(meetings, day.employees)

  return {
    meetings: finalizedMeetings.sort(
      (first, second) => first.startMinute - second.startMinute || first.id - second.id,
    ),
    targetVisits,
    assignedVisits,
    unassignedVisits: targetVisits - assignedVisits,
  }
}

function finalizeParticipantDepartures(
  meetings: readonly PlannedMeeting[],
  employees: readonly ScheduledEmployee[],
): PlannedMeeting[] {
  const employeeById = new Map(employees.map((employee) => [employee.id, employee]))
  const previousEnd = new Map<EmployeeId, MinuteOfDay>()
  const departuresByMeeting = new Map<number, Array<{ employeeId: EmployeeId; departureMinute: MinuteOfDay }>>()

  for (const meeting of [...meetings].sort(
    (first, second) => first.startMinute - second.startMinute || first.id - second.id,
  )) {
    const departures = meeting.participantIds.map((employeeId) => ({
      employeeId,
      departureMinute: Math.max(
        0,
        meeting.startMinute - meeting.departureLeadMinutes,
        previousEnd.get(employeeId) ?? 0,
        employeeById.get(employeeId)!.arrivalMinute,
      ),
    }))
    departuresByMeeting.set(meeting.id, departures)
    for (const employeeId of meeting.participantIds) previousEnd.set(employeeId, meeting.endMinute)
  }

  return meetings.map((meeting) => ({
    ...meeting,
    participantDepartures: departuresByMeeting.get(meeting.id)!,
  }))
}

export function meetingBusyIntervals(
  schedule: MeetingSchedule,
): ReadonlyMap<EmployeeId, readonly BusyInterval[]> {
  const result = new Map<EmployeeId, BusyInterval[]>()
  for (const meeting of schedule.meetings) {
    for (const { employeeId, departureMinute } of meeting.participantDepartures) {
      const intervals = result.get(employeeId) ?? []
      intervals.push({ startMinute: departureMinute, endMinute: meeting.endMinute })
      result.set(employeeId, intervals)
    }
  }
  for (const intervals of result.values()) {
    intervals.sort((first, second) => first.startMinute - second.startMinute)
  }
  return result
}

function minimumRemainingCapacity(
  concurrentOccupancy: Int32Array,
  start: number,
  end: number,
  limit: number,
): number {
  let remaining = limit
  for (let minute = start; minute < end; minute += 1) {
    const active = concurrentOccupancy[minute]
    remaining = Math.min(remaining, limit - active)
  }
  return remaining
}

function createSearchPlan(
  homeFloor: Floor,
  floorCount: number,
  random: SeededRandom,
): Pick<PlannedMeeting, 'searchRadius' | 'searchDirection' | 'searchFloors'> {
  const requestedRadius = weightedChoice(SEARCH_RADII, random)
  const maximumDistance = Math.max(homeFloor - 1, floorCount - homeFloor)
  const searchRadius = Math.min(requestedRadius, maximumDistance) as 0 | 1 | 2
  if (searchRadius === 0) {
    return { searchRadius, searchDirection: null, searchFloors: [homeFloor] }
  }
  const directions: TravelDirection[] = []
  if (homeFloor + searchRadius <= floorCount) directions.push('up')
  if (homeFloor - searchRadius >= 1) directions.push('down')
  const searchDirection = random.choose(directions)
  const sign = searchDirection === 'up' ? 1 : -1
  return {
    searchRadius,
    searchDirection,
    searchFloors: Array.from(
      { length: searchRadius },
      (_, index) => homeFloor + sign * (index + 1),
    ),
  }
}

function weightedChoice<T>(
  values: readonly WeightedValue<T>[],
  random: SeededRandom,
): T {
  const threshold = random.next()
  let cumulative = 0
  for (const { value, weight } of values) {
    cumulative += weight
    if (threshold < cumulative) return value
  }
  return values[values.length - 1].value
}

function validateMeetingSettings(day: DaySchedule, settings: MeetingSettings): void {
  new SeededRandom(settings.seed)
  if (day.employees.length === 0) throw new RangeError('Нельзя создать встречи для пустого расписания')
  for (const minute of [settings.startMinute, settings.endMinute]) {
    if (!Number.isSafeInteger(minute) || minute < 0 || minute > 24 * 60) {
      throw new RangeError('Период встреч должен быть задан целыми минутами суток')
    }
  }
  if (settings.startMinute >= settings.endMinute) throw new RangeError('Начало встреч должно быть раньше окончания')
  if (!Number.isFinite(settings.maxConcurrentShare) || settings.maxConcurrentShare < 0 || settings.maxConcurrentShare > 1) {
    throw new RangeError('Максимальная доля участников встреч должна быть от 0 до 1')
  }
  if (!Number.isFinite(settings.meanVisitsPerEmployee) || settings.meanVisitsPerEmployee < 0 || settings.meanVisitsPerEmployee > 10) {
    throw new RangeError('Среднее число встреч должно быть от 0 до 10')
  }
  validateWeights(settings.durations, 'продолжительности встреч')
  validateWeights(settings.groupSizes, 'размеров групп')
  validateCategories(settings.durations, [30, 45, 60], 'продолжительности встреч')
  validateCategories(settings.groupSizes, [1, 2, 3, 4, '5-10'], 'размеров групп')
  if (settings.hourlyRoomFoundShares.length !== 24 || settings.hourlyRoomFoundShares.some((share) => !Number.isFinite(share) || share < 0 || share > 1)) {
    throw new RangeError('Почасовые доли успешного поиска должны содержать 24 значения от 0 до 1')
  }
}

function validateWeights(values: readonly WeightedValue<unknown>[], name: string): void {
  if (values.length === 0) throw new RangeError(`Распределение ${name} не может быть пустым`)
  const total = values.reduce((sum, { weight }) => {
    if (!Number.isFinite(weight) || weight < 0) throw new RangeError(`Доли ${name} должны быть неотрицательными`)
    return sum + weight
  }, 0)
  if (Math.abs(total - 1) > 1e-9) throw new RangeError(`Доли ${name} должны в сумме давать 100%`)
}

function validateCategories(
  values: readonly WeightedValue<unknown>[],
  allowed: readonly unknown[],
  name: string,
): void {
  const categories = values.map(({ value }) => value)
  if (
    categories.length !== allowed.length ||
    new Set(categories).size !== categories.length ||
    allowed.some((value) => !categories.includes(value))
  ) {
    throw new RangeError(`Распределение ${name} должно содержать все допустимые категории по одному разу`)
  }
}
