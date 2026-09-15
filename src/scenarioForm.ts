import { DEFAULT_ARRIVAL_WINDOW, DEFAULT_DEPARTURE_WINDOW } from './engine/daySchedule'
import { DEFAULT_ELEVATOR_TIMING } from './engine/timing'

export type DistributionMode = 'manual' | 'equal'
export type DispatchStrategy = 'global-fifo' | 'nearest' | 'hybrid'
export function dispatchStrategyLabel(strategy: DispatchStrategy): string {
  if (strategy === 'global-fifo') return 'Global FIFO'
  if (strategy === 'hybrid') return 'Гибридная'
  return 'Сначала ближайший'
}

export interface FloorFormValue {
  readonly floor: number
  readonly employees: number
  readonly served: boolean
}

export interface ScenarioFormState {
  readonly seed: number
  readonly floorCount: number
  readonly totalEmployees: number
  readonly distributionMode: DistributionMode
  readonly includeFirstFloor: boolean
  readonly floors: readonly FloorFormValue[]
  readonly cafeteriaFloor: number
  readonly elevatorCount: number
  readonly elevatorCapacity: number
  readonly dispatchStrategy: DispatchStrategy
  readonly initialElevatorFloors: readonly number[]
  readonly servedFloorsByElevator: readonly (readonly number[])[]
  readonly undergroundParkingEnabled: boolean
  readonly undergroundFloorCount: number
  readonly undergroundEmployeeShare: number
  readonly secondsPerFloor: number
  readonly accelerationAndBrakingSeconds: number
  readonly doorOperationSeconds: number
  readonly openDoorDwellSeconds: number
  readonly passengerTransferSeconds: number
  readonly stairSecondsPerFloor: number
  readonly arrivalOverallStart: number
  readonly arrivalOverallEnd: number
  readonly arrivalPrimaryStart: number
  readonly arrivalPrimaryEnd: number
  readonly arrivalPrimaryShare: number
  readonly departureOverallStart: number
  readonly departureOverallEnd: number
  readonly departurePrimaryStart: number
  readonly departurePrimaryEnd: number
  readonly departurePrimaryShare: number
  readonly arrivalInfluenceOnDeparture: number
  readonly meetingStart: number
  readonly meetingEnd: number
  readonly lunchStart: number
  readonly lunchEnd: number
  readonly lunchPeak: number
  readonly lunchShare: number
  readonly meanMeetingsPerEmployee: number
  readonly maxMeetingConcurrentShare: number
  readonly meetingDurationShares: readonly [number, number, number]
  readonly meetingRoomFoundSharesByHour: readonly number[]
  readonly lunchDurationMinutes: number
  readonly lunchDurationJitterMinutes: number
  readonly lunchWaveMinutes: number
  readonly stairsConvenient: boolean
  readonly maxVoluntaryStairFloors: number
  readonly convenientStairProbabilities: readonly number[]
  readonly inconvenientStairProbabilities: readonly number[]
  readonly lunchOverloadStairsEnabled: boolean
  readonly lunchOverloadStairProbabilities: readonly number[]
  readonly inconvenientStairFactor: number
  readonly reportMorningStart: number
  readonly reportDayStart: number
  readonly reportEveningStart: number
  readonly reportEveningEnd: number
  readonly longWaitThresholds: readonly [number, number, number]
  readonly parkingByElevator: readonly ElevatorParkingForm[]
}

export interface ElevatorParkingForm { readonly enabled: boolean; readonly timeoutSeconds: number; readonly intervals: readonly { readonly startMinute: number; readonly endMinute: number; readonly floor: number }[] }

export type ScenarioFormErrors = Readonly<Record<string, string>>

export function createDefaultScenarioForm(): ScenarioFormState {
  return {
    seed: 42,
    floorCount: 7,
    totalEmployees: 0,
    distributionMode: 'manual',
    includeFirstFloor: false,
    floors: createFloors(7),
    cafeteriaFloor: 1,
    elevatorCount: 2,
    elevatorCapacity: 6,
    dispatchStrategy: 'global-fifo',
    initialElevatorFloors: [1, 1],
    servedFloorsByElevator: [createFloorNumbers(7), createFloorNumbers(7)],
    undergroundParkingEnabled: false,
    undergroundFloorCount: 1,
    undergroundEmployeeShare: 0,
    ...DEFAULT_ELEVATOR_TIMING,
    stairSecondsPerFloor: 15,
    arrivalOverallStart: DEFAULT_ARRIVAL_WINDOW.overall.startMinute,
    arrivalOverallEnd: DEFAULT_ARRIVAL_WINDOW.overall.endMinute,
    arrivalPrimaryStart: DEFAULT_ARRIVAL_WINDOW.primary.startMinute,
    arrivalPrimaryEnd: DEFAULT_ARRIVAL_WINDOW.primary.endMinute,
    arrivalPrimaryShare: DEFAULT_ARRIVAL_WINDOW.primaryShare,
    departureOverallStart: DEFAULT_DEPARTURE_WINDOW.overall.startMinute,
    departureOverallEnd: DEFAULT_DEPARTURE_WINDOW.overall.endMinute,
    departurePrimaryStart: DEFAULT_DEPARTURE_WINDOW.primary.startMinute,
    departurePrimaryEnd: DEFAULT_DEPARTURE_WINDOW.primary.endMinute,
    departurePrimaryShare: DEFAULT_DEPARTURE_WINDOW.primaryShare,
    arrivalInfluenceOnDeparture: 0.7,
    meetingStart: 11 * 60,
    meetingEnd: 19 * 60,
    lunchStart: 13 * 60,
    lunchEnd: 16 * 60,
    lunchPeak: 14 * 60,
    lunchShare: 0.8,
    meanMeetingsPerEmployee: 3,
    maxMeetingConcurrentShare: 0.4,
    meetingDurationShares: [0.3, 0.4, 0.3],
    meetingRoomFoundSharesByHour: Array(24).fill(0.8),
    lunchDurationMinutes: 30,
    lunchDurationJitterMinutes: 15,
    lunchWaveMinutes: 30,
    stairsConvenient: true,
    maxVoluntaryStairFloors: 2,
    convenientStairProbabilities: [0.9, 0.7, 0.575, 0.45, 0.325, 0.2],
    inconvenientStairProbabilities: [0.3, 0.1, 0.08, 0.06, 0.04, 0.02],
    lunchOverloadStairsEnabled: true,
    lunchOverloadStairProbabilities: [0.9, 0.7, 0.6, 0.45, 0.3, 0.15, 0.05],
    inconvenientStairFactor: 0.5,
    reportMorningStart: 8 * 60,
    reportDayStart: 12 * 60,
    reportEveningStart: 18 * 60,
    reportEveningEnd: 23 * 60,
    longWaitThresholds: [120, 240, 360],
    parkingByElevator: [defaultParking(), defaultParking()],
  }
}

export function resizeFloors(values: ScenarioFormState, floorCount: number): ScenarioFormState {
  if (!Number.isSafeInteger(floorCount) || floorCount < 2 || floorCount > 100) return { ...values, floorCount }
  const previous = new Map(values.floors.map((floor) => [floor.floor, floor]))
  const floors = createFloors(floorCount).map((floor) => previous.get(floor.floor) ?? floor)
  const next = {
    ...values,
    floorCount,
    floors,
    cafeteriaFloor: Math.min(values.cafeteriaFloor, floorCount),
    initialElevatorFloors: values.initialElevatorFloors.map((floor) => Math.min(floor, floorCount)),
    servedFloorsByElevator: values.servedFloorsByElevator.map((served) => {
      const retained = served.filter((floor) => floor < 0 || floor <= floorCount)
      const added = createFloorNumbers(floorCount).filter((floor) => floor > values.floorCount)
      return [...new Set([...retained, ...added, 1])].sort((a, b) => a - b)
    }),
    parkingByElevator: values.parkingByElevator.map((parking) => ({ ...parking, intervals: parking.intervals.map((interval) => ({ ...interval, floor: interval.floor > floorCount ? 1 : interval.floor })) })),
  }
  return next.distributionMode === 'equal' ? distributeEmployees(next) : next
}

export function resizeElevators(values: ScenarioFormState, elevatorCount: number): ScenarioFormState {
  if (!Number.isSafeInteger(elevatorCount) || elevatorCount < 1 || elevatorCount > 20) return { ...values, elevatorCount }
  return {
    ...values,
    elevatorCount,
    initialElevatorFloors: Array.from({ length: elevatorCount }, (_, index) => values.initialElevatorFloors[index] ?? 1),
    servedFloorsByElevator: Array.from({ length: elevatorCount }, (_, index) => values.servedFloorsByElevator[index] ?? availableFloors(values)),
    parkingByElevator: Array.from({ length: elevatorCount }, (_, index) => values.parkingByElevator[index] ?? defaultParking()),
  }
}

export function distributeEmployees(values: ScenarioFormState): ScenarioFormState {
  const eligible = values.floors.filter((floor) => values.includeFirstFloor || floor.floor !== 1)
  const base = Math.floor(values.totalEmployees / eligible.length)
  const remainder = values.totalEmployees % eligible.length
  let position = 0
  return {
    ...values,
    floors: values.floors.map((floor) => {
      if (!values.includeFirstFloor && floor.floor === 1) return { ...floor, employees: 0 }
      const employees = base + (position < remainder ? 1 : 0)
      position += 1
      return { ...floor, employees }
    }),
  }
}

export function validateScenarioForm(values: ScenarioFormState): ScenarioFormErrors {
  const errors: Record<string, string> = {}
  if (!Number.isSafeInteger(values.seed) || values.seed < 0 || values.seed > 0xffff_ffff) errors.seed = 'Seed должен быть целым числом от 0 до 4 294 967 295'
  if (!['manual', 'equal'].includes(values.distributionMode)) errors.distributionMode = 'Выберите способ распределения сотрудников'
  integerRange(errors, 'floorCount', values.floorCount, 2, 100, 'Укажите от 2 до 100 этажей')
  integerRange(errors, 'totalEmployees', values.totalEmployees, 1, 10_000, values.totalEmployees === 0 ? 'Укажите количество сотрудников по этажам' : 'Допустимо от 1 до 10 000 сотрудников')
  integerRange(errors, 'elevatorCount', values.elevatorCount, 1, 20, 'Укажите от 1 до 20 лифтов')
  integerRange(errors, 'elevatorCapacity', values.elevatorCapacity, 1, 40, 'Вместимость должна быть от 1 до 40 человек')
  if (values.undergroundParkingEnabled) {
    integerRange(errors, 'undergroundFloorCount', values.undergroundFloorCount, 1, 4, 'Укажите от 1 до 4 подземных этажей')
    numberRange(errors, 'undergroundEmployeeShare', values.undergroundEmployeeShare, 0, 1, 'Доля сотрудников парковки должна быть от 0 до 100%')
  }
  if (!['global-fifo', 'nearest', 'hybrid'].includes(values.dispatchStrategy)) errors.dispatchStrategy = 'Выберите алгоритм управления лифтами'
  numberRange(errors, 'secondsPerFloor', values.secondsPerFloor, 0.5, 30, 'Допустимо от 0,5 до 30 секунд')
  numberRange(errors, 'accelerationAndBrakingSeconds', values.accelerationAndBrakingSeconds, 0, 30, 'Допустимо от 0 до 30 секунд')
  numberRange(errors, 'doorOperationSeconds', values.doorOperationSeconds, 0, 30, 'Допустимо от 0 до 30 секунд')
  numberRange(errors, 'openDoorDwellSeconds', values.openDoorDwellSeconds, 0, 60, 'Допустимо от 0 до 60 секунд')
  numberRange(errors, 'passengerTransferSeconds', values.passengerTransferSeconds, 0, 5, 'Допустимо от 0 до 5 секунд')
  numberRange(errors, 'stairSecondsPerFloor', values.stairSecondsPerFloor, 1, 120, 'Допустимо от 1 до 120 секунд')
  for (const [key, value] of [
    ['secondsPerFloor', values.secondsPerFloor],
    ['accelerationAndBrakingSeconds', values.accelerationAndBrakingSeconds],
    ['doorOperationSeconds', values.doorOperationSeconds],
    ['openDoorDwellSeconds', values.openDoorDwellSeconds],
    ['passengerTransferSeconds', values.passengerTransferSeconds],
    ['stairSecondsPerFloor', values.stairSecondsPerFloor],
  ] as const) if (!errors[key] && !hasStep(value, 0.1)) errors[key] = 'Укажите время с точностью до 0,1 секунды'
  numberRange(errors, 'arrivalPrimaryShare', values.arrivalPrimaryShare, 0, 1, 'Доля прихода должна быть от 0 до 100%')
  numberRange(errors, 'departurePrimaryShare', values.departurePrimaryShare, 0, 1, 'Доля ухода должна быть от 0 до 100%')
  numberRange(errors, 'arrivalInfluenceOnDeparture', values.arrivalInfluenceOnDeparture, 0, 1, 'Влияние прихода должно быть от 0 до 100%')
  numberRange(errors, 'lunchShare', values.lunchShare, 0, 1, 'Доля обеда должна быть от 0 до 100%')
  numberRange(errors, 'meanMeetingsPerEmployee', values.meanMeetingsPerEmployee, 0, 10, 'Допустимо от 0 до 10 встреч, включая дробные значения')
  numberRange(errors, 'maxMeetingConcurrentShare', values.maxMeetingConcurrentShare, 0, 1, 'Доля участников должна быть от 0 до 100%')
  integerRange(errors, 'lunchDurationMinutes', values.lunchDurationMinutes, 15, 60, 'Продолжительность должна быть целым числом от 15 до 60 минут')
  numberRange(errors, 'lunchDurationJitterMinutes', values.lunchDurationJitterMinutes, 0, 15, 'Разброс должен быть от 0 до 15 минут')
  numberRange(errors, 'lunchWaveMinutes', values.lunchWaveMinutes, 5, 120, 'Ширина волны должна быть от 5 до 120 минут')
  integerRange(errors, 'maxVoluntaryStairFloors', values.maxVoluntaryStairFloors, 1, 6, 'Допустимо от 1 до 6 этажей')
  validateShares(errors, 'meetingDurationShares', values.meetingDurationShares, 3)
  if (values.meetingRoomFoundSharesByHour.length !== 24 || values.meetingRoomFoundSharesByHour.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) errors.meetingRoomFoundSharesByHour = 'Для каждого часа укажите вероятность от 0 до 100%'
  validateProbabilities(errors, 'convenientStairProbabilities', values.convenientStairProbabilities)
  validateProbabilities(errors, 'inconvenientStairProbabilities', values.inconvenientStairProbabilities)
  if (values.lunchOverloadStairProbabilities.length !== 7 || values.lunchOverloadStairProbabilities.some((value) => !Number.isFinite(value) || value < 0.05 || value > 1)) errors.lunchOverloadStairProbabilities = 'Укажите семь вероятностей от 5 до 100%'
  numberRange(errors, 'inconvenientStairFactor', values.inconvenientStairFactor, 0, 1, 'Коэффициент должен быть от 0 до 1')
  if (![values.reportMorningStart, values.reportDayStart, values.reportEveningStart, values.reportEveningEnd].every((value) => Number.isInteger(value) && value >= 0 && value <= 24 * 60) || !(values.reportMorningStart < values.reportDayStart && values.reportDayStart < values.reportEveningStart && values.reportEveningStart < values.reportEveningEnd)) errors.reportPeriods = 'Отчётные периоды должны идти подряд без пересечений'
  if (values.longWaitThresholds.some((value, index) => !Number.isSafeInteger(value) || value <= 0 || (index > 0 && value <= values.longWaitThresholds[index - 1]))) errors.longWaitThresholds = 'Пороги ожидания должны быть целыми, положительными и возрастать'
  const floorSum = values.floors.reduce((sum, floor) => sum + floor.employees, 0)
  const expectedFloors = Array.from({ length: values.floorCount }, (_, index) => index + 1)
  if (values.floors.length !== values.floorCount || values.floors.some((floor, index) => floor.floor !== expectedFloors[index])) errors.floors = 'Список этажей должен соответствовать этажности здания'
  else if (values.floors.some((floor) => !Number.isSafeInteger(floor.employees) || floor.employees < 0 || floor.employees > 10_000)) errors.floors = 'Численность каждого этажа должна быть целым числом от 0 до 10 000'
  else if (floorSum !== values.totalEmployees) errors.floors = `По этажам указано ${floorSum}, а всего — ${values.totalEmployees}`
  if (!values.floors.find((floor) => floor.floor === 1)?.served) errors.servedFloors = 'Первый этаж должен быть доступен лифтам'
  const served = new Set(values.floors.filter((floor) => floor.served).map((floor) => floor.floor))
  if (values.initialElevatorFloors.length !== values.elevatorCount) errors.elevators = 'Для каждого лифта нужен начальный этаж'
  if (values.servedFloorsByElevator.length !== values.elevatorCount) errors.elevatorStops = 'Для каждого лифта выберите этажи остановок'
  const allowedFloors = new Set(availableFloors(values))
  values.servedFloorsByElevator.forEach((floors, index) => {
    if (floors.length === 0 || new Set(floors).size !== floors.length || !floors.includes(1) || floors.some((floor) => !allowedFloors.has(floor))) errors[`elevator-stops-${index}`] = 'Выберите допустимые остановки; первый этаж обязателен'
    if (!floors.includes(values.initialElevatorFloors[index])) errors[`elevator-${index}`] = 'Начальный этаж должен быть доступен этому лифту'
  })
  if (values.undergroundParkingEnabled && values.undergroundEmployeeShare > 0) {
    const missing = Array.from({ length: values.undergroundFloorCount }, (_, index) => -(index + 1)).filter((floor) => !values.servedFloorsByElevator.some((floors) => floors.includes(floor)))
    if (missing.length > 0) errors.undergroundParking = `Добавьте остановку ${missing.join(', ')} хотя бы одному лифту`
  }
  if (values.parkingByElevator.length !== values.elevatorCount) errors.parking = 'Для каждого лифта нужны настройки парковки'
  values.parkingByElevator.forEach((parking, elevatorIndex) => {
    if (!parking.enabled) return
    const key = `parking-${elevatorIndex}`
    if (!Number.isSafeInteger(parking.timeoutSeconds) || parking.timeoutSeconds < 0 || parking.timeoutSeconds > 3600) errors[key] = 'Тайм-аут должен быть целым числом от 0 до 3600 секунд'
    if (parking.intervals.length === 0 && !errors[key]) errors[key] = 'Добавьте хотя бы один интервал'
    const ordered = [...parking.intervals].sort((a,b) => a.startMinute - b.startMinute)
    ordered.forEach((interval,index) => {
      if (!validPeriod(interval.startMinute, interval.endMinute) && !errors[key]) errors[key] = 'Начало периода парковки должно быть раньше окончания'
      if (!values.servedFloorsByElevator[elevatorIndex]?.includes(interval.floor) && !errors[key]) errors[key] = 'Этаж парковки должен быть доступен этому лифту'
      if (index > 0 && ordered[index - 1].endMinute > interval.startMinute && !errors[key]) errors[key] = 'Интервалы парковки пересекаются'
    })
  })
  values.initialElevatorFloors.forEach((floor, index) => { if (!allowedFloors.has(floor) || (floor > 0 && !served.has(floor)) || !values.servedFloorsByElevator[index]?.includes(floor)) errors[`elevator-${index}`] = 'Выберите этаж, на котором этот лифт может останавливаться' })
  if (!Number.isSafeInteger(values.cafeteriaFloor) || values.cafeteriaFloor < 1 || values.cafeteriaFloor > values.floorCount) errors.cafeteriaFloor = 'Выберите существующий этаж'
  validateWindow(errors, 'arrival', values.arrivalOverallStart, values.arrivalOverallEnd, values.arrivalPrimaryStart, values.arrivalPrimaryEnd, values.arrivalPrimaryShare)
  validateWindow(errors, 'departure', values.departureOverallStart, values.departureOverallEnd, values.departurePrimaryStart, values.departurePrimaryEnd, values.departurePrimaryShare)
  if (!errors.arrival && (values.arrivalPrimaryStart < values.reportMorningStart || values.arrivalPrimaryEnd > values.reportDayStart)) errors.reportArrivalWarning = 'Основное окно прихода выходит за границы утра'
  if (!errors.departure && (values.departurePrimaryStart < values.reportEveningStart || values.departurePrimaryEnd > values.reportEveningEnd)) errors.reportDepartureWarning = 'Основное окно ухода выходит за границы вечера'
  if (!validPeriod(values.meetingStart, values.meetingEnd)) errors.meeting = 'Проверьте начало и конец периода встреч'
  if (!validPeriod(values.lunchStart, values.lunchEnd) || values.lunchPeak < values.lunchStart || values.lunchPeak >= values.lunchEnd) errors.lunch = 'Пик обеда должен находиться внутри периода обеда'
  return errors
}

function createFloors(count: number): FloorFormValue[] { return Array.from({ length: count }, (_, index) => ({ floor: index + 1, employees: 0, served: true })) }
function createFloorNumbers(count: number): number[] { return Array.from({ length: count }, (_, index) => index + 1) }
export function availableFloors(values: Pick<ScenarioFormState, 'floorCount' | 'undergroundParkingEnabled' | 'undergroundFloorCount'>): number[] {
  const validUndergroundCount = Number.isSafeInteger(values.undergroundFloorCount) && values.undergroundFloorCount >= 1 && values.undergroundFloorCount <= 4 ? values.undergroundFloorCount : 0
  const underground = values.undergroundParkingEnabled ? Array.from({ length: validUndergroundCount }, (_, index) => -(index + 1)) : []
  return [...underground, ...createFloorNumbers(values.floorCount)].sort((a, b) => a - b)
}
function defaultParking(): ElevatorParkingForm { return { enabled: false, timeoutSeconds: 60, intervals: [] } }
function integerRange(errors: Record<string, string>, key: string, value: number, min: number, max: number, message: string): void { if (!Number.isSafeInteger(value) || value < min || value > max) errors[key] = message }
function numberRange(errors: Record<string, string>, key: string, value: number, min: number, max: number, message: string): void { if (!Number.isFinite(value) || value < min || value > max) errors[key] = message }
function hasStep(value: number, step: number): boolean { return Number.isFinite(value) && Math.abs(value / step - Math.round(value / step)) < 1e-9 }
function validateWindow(errors: Record<string, string>, key: string, overallStart: number, overallEnd: number, primaryStart: number, primaryEnd: number, primaryShare: number): void {
  if (![overallStart, overallEnd, primaryStart, primaryEnd].every((value) => Number.isInteger(value) && value >= 0 && value <= 24 * 60) || overallStart >= overallEnd) errors[key] = 'Проверьте начало и конец общего периода'
  else if (primaryStart < overallStart || primaryEnd > overallEnd || primaryStart >= primaryEnd) errors[key] = 'Основное окно должно находиться внутри общего периода'
  else if (primaryShare < 1 && primaryStart === overallStart && primaryEnd === overallEnd) errors[key] = 'Для сотрудников вне основного окна не осталось времени'
}
function validPeriod(start: number, end: number): boolean { return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= 24 * 60 && start < end }
function validateShares(errors: Record<string, string>, key: string, values: readonly number[], length: number): void { if (values.length !== length || values.some((value) => !Number.isFinite(value) || value < 0 || value > 1) || Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 1e-9) errors[key] = 'Доли должны быть от 0 до 100% и в сумме давать 100%' }
function validateProbabilities(errors: Record<string, string>, key: string, values: readonly number[]): void { if (values.length !== 6 || values.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) errors[key] = 'Укажите шесть вероятностей от 0 до 100%' }
