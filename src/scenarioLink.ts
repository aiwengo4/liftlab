import { createDefaultScenarioForm, type ScenarioFormState } from './scenarioForm'

const VERSION = 7
const PREFIX = '#settings='
const MAX_ENCODED_LENGTH = 100_000

interface ScenarioEnvelope {
  readonly version: number
  readonly scenario: ScenarioFormState
}

export type ScenarioLinkResult =
  | { readonly ok: true; readonly scenario: ScenarioFormState; readonly migrated: boolean }
  | { readonly ok: false; readonly reason: string }

export function encodeScenario(form: ScenarioFormState): string {
  const json = JSON.stringify({ version: VERSION, scenario: form } satisfies ScenarioEnvelope)
  const bytes = new TextEncoder().encode(json)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

export function createScenarioUrl(form: ScenarioFormState, currentUrl: string): string {
  const url = new URL(currentUrl)
  url.hash = 'settings=' + encodeScenario(form)
  return url.toString()
}

export function decodeScenarioHash(hash: string): ScenarioLinkResult {
  if (!hash.startsWith(PREFIX)) return { ok: false, reason: 'В ссылке нет настроек сценария' }
  const encoded = hash.slice(PREFIX.length)
  if (encoded.length === 0 || encoded.length > MAX_ENCODED_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(encoded)) return { ok: false, reason: 'Ссылка с настройками повреждена' }
  try {
    const base64 = encoded.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - encoded.length % 4) % 4)
    const binary = atob(base64)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (!isRecord(parsed) || ![1, 2, 3, 4, 5, 6, VERSION].includes(Number(parsed.version))) return { ok: false, reason: 'Версия ссылки не поддерживается' }
    const candidate = normalizeScenarioForm(parsed.scenario, parsed.version === 1, parsed.version !== VERSION)
    if (candidate === null) return { ok: false, reason: 'Настройки в ссылке имеют неверный формат' }
    return { ok: true, scenario: candidate, migrated: parsed.version !== VERSION }
  } catch {
    return { ok: false, reason: 'Не удалось прочитать настройки из ссылки' }
  }
}

export function normalizeScenarioForm(value: unknown, allowLegacyDefaults = false, allowDispatchDefault = allowLegacyDefaults): ScenarioFormState | null {
  if (!isRecord(value)) return null
  const defaults = createDefaultScenarioForm()
  const { meetingGroupShares: _groups, wholeHourBiasEnabled: _hourBiasEnabled, wholeHourBiasShare: _hourBiasShare, ...withoutGroups } = value
  const candidate = {
    ...withoutGroups,
    floors: Array.isArray(value.floors) ? value.floors.map((floor) => {
      if (!isRecord(floor)) return floor
      const { meetingRooms: _rooms, meetingRoomsAuto: _auto, ...current } = floor
      return current
    }) : value.floors,
    ...(allowLegacyDefaults && !Array.isArray(value.meetingRoomFoundSharesByHour) ? { meetingRoomFoundSharesByHour: Array(24).fill(0.8) } : {}),
    ...(allowDispatchDefault && typeof value.dispatchStrategy !== 'string' ? { dispatchStrategy: 'nearest' } : {}),
    ...(typeof value.lunchDurationJitterMinutes !== 'number' ? { lunchDurationJitterMinutes: 0 } : {}),
    ...(typeof value.lunchOverloadStairsEnabled !== 'boolean' ? { lunchOverloadStairsEnabled: false } : {}),
    lunchOverloadStairProbabilities: normalizeLunchOverloadProbabilities(value.lunchOverloadStairProbabilities, defaults.lunchOverloadStairProbabilities),
    ...(typeof value.inconvenientStairFactor !== 'number' ? { inconvenientStairFactor: defaults.inconvenientStairFactor } : {}),
    ...(typeof value.undergroundParkingEnabled !== 'boolean' ? { undergroundParkingEnabled: false } : {}),
    ...(typeof value.undergroundFloorCount !== 'number' ? { undergroundFloorCount: 1 } : {}),
    ...(typeof value.undergroundEmployeeShare !== 'number' ? { undergroundEmployeeShare: 0 } : {}),
    ...(!Array.isArray(value.servedFloorsByElevator) ? { servedFloorsByElevator: Array.from({ length: integer(value.elevatorCount) && value.elevatorCount >= 1 && value.elevatorCount <= 20 ? value.elevatorCount : defaults.elevatorCount }, () => Array.isArray(value.floors) ? value.floors.filter((floor) => isRecord(floor) && floor.served === true).map((floor) => floor.floor as number) : defaults.floors.map(({ floor }) => floor)) } : {}),
  }
  return isScenario(candidate) ? candidate : null
}

function isScenario(value: unknown): value is ScenarioFormState {
  if (!isRecord(value)) return false
  const defaults = createDefaultScenarioForm() as unknown as Record<string, unknown>
  for (const [key, defaultValue] of Object.entries(defaults)) {
    const candidate = value[key]
    if (Array.isArray(defaultValue)) {
      if (!Array.isArray(candidate)) return false
    } else if (typeof candidate !== typeof defaultValue) return false
  }
  if (!Array.isArray(value.floors) || !value.floors.every((floor) => isRecord(floor) && integer(floor.floor) && integer(floor.employees) && typeof floor.served === 'boolean')) return false
  if (!Array.isArray(value.initialElevatorFloors) || !value.initialElevatorFloors.every(integer)) return false
  if (!Array.isArray(value.servedFloorsByElevator) || !value.servedFloorsByElevator.every((floors) => Array.isArray(floors) && floors.every(integer))) return false
  if (!Array.isArray(value.parkingByElevator) || !value.parkingByElevator.every((parking) => isRecord(parking) && typeof parking.enabled === 'boolean' && finite(parking.timeoutSeconds) && Array.isArray(parking.intervals) && parking.intervals.every((interval) => isRecord(interval) && integer(interval.startMinute) && integer(interval.endMinute) && integer(interval.floor)))) return false
  for (const key of ['meetingDurationShares','meetingRoomFoundSharesByHour','convenientStairProbabilities','inconvenientStairProbabilities','longWaitThresholds']) {
    if (!(value[key] as unknown[]).every(finite)) return false
  }
  if (!integer(value.floorCount) || value.floors.length !== value.floorCount) return false
  if (!integer(value.elevatorCount) || value.initialElevatorFloors.length !== value.elevatorCount || value.parkingByElevator.length !== value.elevatorCount || value.servedFloorsByElevator.length !== value.elevatorCount) return false
  if (!['manual', 'equal'].includes(String(value.distributionMode))) return false
  if (!['global-fifo', 'nearest', 'hybrid'].includes(String(value.dispatchStrategy))) return false
  if (!arrayLength(value.meetingDurationShares, 3) || !arrayLength(value.meetingRoomFoundSharesByHour, 24) || !arrayLength(value.convenientStairProbabilities, 6) || !arrayLength(value.inconvenientStairProbabilities, 6) || !arrayLength(value.lunchOverloadStairProbabilities, 7) || !(value.lunchOverloadStairProbabilities as unknown[]).every(finite) || !arrayLength(value.longWaitThresholds, 3)) return false
  return Object.values(value).every((item) => typeof item !== 'number' || Number.isFinite(item))
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) }
function arrayLength(value: unknown, length: number): value is unknown[] { return Array.isArray(value) && value.length === length }
function normalizeLunchOverloadProbabilities(value: unknown, defaults: readonly number[]): readonly number[] {
  if (!Array.isArray(value)) return defaults
  if (value.length === 6 && value.every(finite)) return [...value, value[5]]
  return value
}
