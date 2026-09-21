import { floorDistance, type EmployeeId, type Floor } from './domain'
import { SeededRandom } from './random'

export interface StairChoiceSettings {
  readonly secondsPerFloor: number
  readonly convenient: boolean
  readonly maxVoluntaryFloors: number
  readonly convenientProbabilities: readonly number[]
  readonly inconvenientProbabilities: readonly number[]
}

export interface LunchOverloadStairSettings {
  readonly enabled: boolean
  readonly thresholdCapacityMultiplier: number
  readonly probabilities: readonly number[]
  readonly inconvenientFactor: number
}

export const DEFAULT_LUNCH_OVERLOAD_STAIR_SETTINGS: LunchOverloadStairSettings = {
  enabled: true,
  thresholdCapacityMultiplier: 1.5,
  probabilities: [0.9, 0.7, 0.6, 0.45, 0.3, 0.15, 0.05],
  inconvenientFactor: 0.5,
}

export function lunchOverloadStairProbability(
  distanceFloors: number,
  convenient: boolean,
  settings: LunchOverloadStairSettings,
): number {
  if (!Number.isSafeInteger(distanceFloors) || distanceFloors < 1) throw new RangeError('Расстояние до столовой должно быть положительным целым числом этажей')
  if (settings.probabilities.length !== 7 || settings.probabilities.some((value) => !Number.isFinite(value) || value < 0 || (value > 0 && value < 0.05) || value > 1)) throw new RangeError('Нужно задать семь вероятностей лестницы: 0 для отключения или от 0,05 до 1')
  if (!Number.isFinite(settings.inconvenientFactor) || settings.inconvenientFactor < 0 || settings.inconvenientFactor > 1) throw new RangeError('Коэффициент неудобной лестницы должен быть от 0 до 1')
  if (!Number.isFinite(settings.thresholdCapacityMultiplier) || settings.thresholdCapacityMultiplier <= 0) throw new RangeError('Порог перегруза должен быть положительным')
  const base = settings.probabilities[Math.min(distanceFloors, 7) - 1]
  return base * (convenient ? 1 : settings.inconvenientFactor)
}

export interface RouteChoiceRequest {
  readonly seed: number
  readonly employeeId: EmployeeId
  readonly journeyId: string
  readonly legId: string
  readonly floorCount: number
  readonly minFloor?: number
  readonly fromFloor: Floor
  readonly toFloor: Floor
  readonly mandatoryStairs?: boolean
}

export interface RouteChoice {
  readonly mode: 'none' | 'stairs' | 'elevator'
  readonly fromFloor: Floor
  readonly toFloor: Floor
  readonly distanceFloors: number
  readonly stairProbability: number
  readonly stairDurationSeconds: number
  readonly randomDraw: number | null
  readonly reason: 'same-floor' | 'mandatory' | 'outside-voluntary-limit' | 'probability' | 'lunch-overload'
}

export interface RouteSegment {
  readonly fromFloor: Floor
  readonly toFloor: Floor
  readonly mode: 'stairs' | 'elevator'
  readonly distanceFloors: number
  readonly stairDurationSeconds: number
  readonly stairProbability: number
  readonly randomDraw: number | null
}

export const DEFAULT_STAIR_CHOICE_SETTINGS: StairChoiceSettings = {
  secondsPerFloor: 15,
  convenient: true,
  maxVoluntaryFloors: 2,
  convenientProbabilities: [0.9, 0.7, 0.575, 0.45, 0.325, 0.2],
  inconvenientProbabilities: [0.3, 0.1, 0.08, 0.06, 0.04, 0.02],
}

export function stairProbability(
  distanceFloors: number,
  settings: StairChoiceSettings,
): number {
  validateSettings(settings)
  if (!Number.isSafeInteger(distanceFloors) || distanceFloors < 0) {
    throw new RangeError('Расстояние должно быть целым неотрицательным числом этажей')
  }
  if (distanceFloors === 0 || distanceFloors > settings.maxVoluntaryFloors) return 0
  return (settings.convenient
    ? settings.convenientProbabilities
    : settings.inconvenientProbabilities)[distanceFloors - 1]
}

export function chooseDayTransport(
  request: RouteChoiceRequest,
  settings: StairChoiceSettings,
): RouteChoice {
  validateRequest(request)
  validateSettings(settings)
  const distanceFloors = floorDistance(request.toFloor, request.fromFloor)
  const stairDurationSeconds = distanceFloors * settings.secondsPerFloor

  if (distanceFloors === 0) {
    return result(request, distanceFloors, 'none', 0, 0, null, 'same-floor')
  }
  if (request.mandatoryStairs === true) {
    return result(request, distanceFloors, 'stairs', 1, stairDurationSeconds, null, 'mandatory')
  }
  if (distanceFloors > settings.maxVoluntaryFloors) {
    return result(request, distanceFloors, 'elevator', 0, 0, null, 'outside-voluntary-limit')
  }
  const probability = stairProbability(distanceFloors, settings)
  const randomDraw = keyedRandomDraw(request)
  const mode = randomDraw < probability ? 'stairs' : 'elevator'
  return result(
    request,
    distanceFloors,
    mode,
    probability,
    mode === 'stairs' ? stairDurationSeconds : 0,
    randomDraw,
    'probability',
  )
}

export function applyTransportChoiceToPath(
  choice: RouteChoice,
  pathFloors: readonly Floor[],
  floorCount: number,
  settings: StairChoiceSettings,
): readonly RouteSegment[] {
  validateSettings(settings)
  if (!Number.isSafeInteger(floorCount) || floorCount < 2 || floorCount > 100) {
    throw new RangeError('Количество этажей должно быть целым числом от 2 до 100')
  }
  if (choice.mode === 'none') {
    if (pathFloors.length === 1 && pathFloors[0] === choice.fromFloor) return []
    throw new RangeError('Для маршрута без движения путь должен содержать только исходный этаж')
  }
  if (
    pathFloors.length < 2 ||
    pathFloors[0] !== choice.fromFloor ||
    pathFloors[pathFloors.length - 1] !== choice.toFloor
  ) {
    throw new RangeError('Путь должен начинаться и заканчиваться этажами исходного выбора')
  }
  for (const floor of pathFloors) {
    if (!Number.isSafeInteger(floor) || floor < 1 || floor > floorCount) {
      throw new RangeError('Этаж участка должен находиться внутри здания')
    }
  }
  const mode: RouteSegment['mode'] = choice.mode
  return pathFloors.slice(1).map((toFloor, index) => {
    const fromFloor = pathFloors[index]
    const distanceFloors = Math.abs(toFloor - fromFloor)
    if (distanceFloors === 0) throw new RangeError('Участок маршрута должен соединять разные этажи')
    return {
      fromFloor,
      toFloor,
      mode,
      distanceFloors,
      stairDurationSeconds: mode === 'stairs' ? distanceFloors * settings.secondsPerFloor : 0,
      stairProbability: choice.stairProbability,
      randomDraw: choice.randomDraw,
    }
  })
}

function result(
  request: RouteChoiceRequest,
  distanceFloors: number,
  mode: RouteChoice['mode'],
  stairProbabilityValue: number,
  stairDurationSeconds: number,
  randomDraw: number | null,
  reason: RouteChoice['reason'],
): RouteChoice {
  return {
    mode,
    fromFloor: request.fromFloor,
    toFloor: request.toFloor,
    distanceFloors,
    stairProbability: stairProbabilityValue,
    stairDurationSeconds,
    randomDraw,
    reason,
  }
}

function keyedRandomDraw(request: RouteChoiceRequest): number {
  const key = JSON.stringify([
    request.seed,
    request.employeeId,
    request.journeyId,
    request.legId,
    request.fromFloor,
    request.toFloor,
  ])
  let hash = 0x811c9dc5
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return new SeededRandom(hash >>> 0).next()
}

function validateRequest(request: RouteChoiceRequest): void {
  new SeededRandom(request.seed)
  if (!Number.isSafeInteger(request.employeeId) || request.employeeId < 1) {
    throw new RangeError('ID сотрудника должен быть положительным целым числом')
  }
  if (
    typeof request.journeyId !== 'string' ||
    typeof request.legId !== 'string' ||
    request.journeyId.trim() === '' ||
    request.legId.trim() === ''
  ) {
    throw new RangeError('Для выбора транспорта нужны непустые ID маршрута и участка')
  }
  if (request.mandatoryStairs !== undefined && typeof request.mandatoryStairs !== 'boolean') {
    throw new RangeError('Признак обязательной лестницы должен быть логическим значением')
  }
  if (!Number.isSafeInteger(request.floorCount) || request.floorCount < 2 || request.floorCount > 100) {
    throw new RangeError('Количество этажей должно быть целым числом от 2 до 100')
  }
  for (const floor of [request.fromFloor, request.toFloor]) {
    if (!Number.isSafeInteger(floor) || floor === 0 || floor < (request.minFloor ?? 1) || floor > request.floorCount) {
      throw new RangeError('Этаж маршрута должен находиться внутри здания')
    }
  }
}

function validateSettings(settings: StairChoiceSettings): void {
  if (!Number.isFinite(settings.secondsPerFloor) || settings.secondsPerFloor < 1 || settings.secondsPerFloor > 120) {
    throw new RangeError('Время на этаж должно быть от 1 до 120 секунд')
  }
  if (!Number.isSafeInteger(settings.maxVoluntaryFloors) || settings.maxVoluntaryFloors < 1 || settings.maxVoluntaryFloors > 6) {
    throw new RangeError('Максимальный добровольный путь должен быть от 1 до 6 этажей')
  }
  if (typeof settings.convenient !== 'boolean') {
    throw new RangeError('Удобство лестницы должно быть логическим значением')
  }
  for (const probabilities of [settings.convenientProbabilities, settings.inconvenientProbabilities]) {
    if (probabilities.length !== 6) throw new RangeError('Нужно задать вероятности для расстояний от 1 до 6 этажей')
    if (Array.from({ length: 6 }, (_, index) => probabilities[index]).some(
      (value) => !Number.isFinite(value) || value < 0 || value > 1,
    )) {
      throw new RangeError('Вероятность лестницы должна быть от 0 до 1')
    }
  }
}
