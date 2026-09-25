import type { BrowserSimulationResult } from './browserResult'
import type { ScenarioFormState } from './scenarioForm'
import { decodeScenarioHash, encodeScenario, normalizeScenarioForm } from './scenarioLink'
import { reportFingerprint, SIMULATION_MODEL_VERSION, trafficFingerprint } from './scenarioComparison'

export const SAVED_SCENARIOS_KEY = 'liftlab.saved-scenarios.v1'
export const MAX_SAVED_SCENARIOS = 20

export interface ScenarioSnapshot {
  snapshotVersion: 3
  simulationModelVersion: string
  trafficFingerprint: string
  reportFingerprint: string
  waitingMeanSeconds: number | null
  waitingMedianSeconds: number | null
  waitingP90Seconds: number | null
  totalMeanSeconds: number | null
  totalMedianSeconds: number | null
  maximumQueue: number
  emptyFloorsTravelled: number
}
export interface SavedScenario {
  id: string
  name: string
  comment: string
  savedAt: string
  form: ScenarioFormState
  snapshot: ScenarioSnapshot | null
  migratedFromLegacy?: boolean
  snapshotNeedsUpgrade?: boolean
}
interface StoreEnvelope { version: 1; items: readonly SavedScenario[] }

export function snapshotResult(result: BrowserSimulationResult | null, form: ScenarioFormState): ScenarioSnapshot | null {
  if (!result) return null
  return {
    snapshotVersion: 3,
    simulationModelVersion: SIMULATION_MODEL_VERSION,
    trafficFingerprint: trafficFingerprint(form),
    reportFingerprint: reportFingerprint(form),
    waitingMeanSeconds: result.metrics.wholeDay.waiting.meanSeconds,
    waitingMedianSeconds: result.metrics.wholeDay.waiting.medianSeconds,
    waitingP90Seconds: result.metrics.wholeDay.waiting.p90Seconds,
    totalMeanSeconds: result.metrics.wholeDay.total.meanSeconds,
    totalMedianSeconds: result.metrics.wholeDay.total.medianSeconds,
    maximumQueue: result.operationalMetrics.queue.maximumWaitingInBuilding,
    emptyFloorsTravelled: result.operationalMetrics.group.resource.emptyFloorsTravelled,
  }
}

export function loadSavedScenarios(storage: Pick<Storage, 'getItem'>): SavedScenario[] {
  try {
    const raw = storage.getItem(SAVED_SCENARIOS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!record(parsed) || parsed.version !== 1 || !Array.isArray(parsed.items)) return []
    return parsed.items.flatMap((item): SavedScenario[] => {
      if (!record(item)) return []
      const form = normalizeScenarioForm(item.form, true)
      if (form === null) return []
      const migrated = !Array.isArray((item.form as Record<string, unknown>).meetingRoomFoundSharesByHour)
      const legacyMarker = migrated || item.migratedFromLegacy === true
      const snapshot = normalizeSnapshot(item.snapshot)
      const snapshotMatchesForm = snapshot !== null && snapshot.trafficFingerprint === trafficFingerprint(form) && snapshot.reportFingerprint === reportFingerprint(form)
      const snapshotNeedsUpgrade = !legacyMarker && item.snapshot !== null && !snapshotMatchesForm
      const { migratedFromLegacy: _rawMarker, snapshotNeedsUpgrade: _rawUpgrade, ...cleanItem } = item
      const candidate = { ...cleanItem, form, snapshot: legacyMarker || snapshotNeedsUpgrade ? null : snapshot, ...(legacyMarker ? { migratedFromLegacy: true } : {}), ...(snapshotNeedsUpgrade ? { snapshotNeedsUpgrade: true } : {}) }
      return isSavedScenario(candidate) ? [candidate] : []
    }).slice(0, MAX_SAVED_SCENARIOS)
  } catch { return [] }
}

export function persistSavedScenarios(storage: Pick<Storage, 'setItem'>, items: readonly SavedScenario[]): void {
  if (items.length > MAX_SAVED_SCENARIOS) throw new RangeError('Можно сохранить не более 20 сценариев')
  storage.setItem(SAVED_SCENARIOS_KEY, JSON.stringify({ version: 1, items } satisfies StoreEnvelope))
}

export function makeSavedScenario(form: ScenarioFormState, result: BrowserSimulationResult | null, name: string, comment: string, id: string, savedAt: string): SavedScenario {
  const cleanName = name.trim()
  if (cleanName.length < 1 || cleanName.length > 80) throw new RangeError('Название должно содержать от 1 до 80 символов')
  if (comment.trim().length > 300) throw new RangeError('Комментарий должен быть не длиннее 300 символов')
  return { id, name: cleanName, comment: comment.trim(), savedAt, form, snapshot: snapshotResult(result, form) }
}

export function metricDelta(current: number | null, baseline: number | null): number | null {
  if (current === null || baseline === null) return null
  if (baseline === 0) return current === 0 ? 0 : null
  return (current - baseline) / baseline
}

export interface MetricComparison {
  absoluteDelta: number | null
  relativeDelta: number | null
  verdict: 'better' | 'worse' | 'same' | 'not-comparable'
}

export function compareMetric(current: number | null, baseline: number | null, allowVerdict = true): MetricComparison {
  if (current === null || baseline === null) return { absoluteDelta: null, relativeDelta: null, verdict: 'not-comparable' }
  const absoluteDelta = current - baseline
  const relativeDelta = baseline === 0 ? (current === 0 ? 0 : null) : absoluteDelta / baseline
  return { absoluteDelta, relativeDelta, verdict: !allowVerdict ? 'not-comparable' : absoluteDelta < 0 ? 'better' : absoluteDelta > 0 ? 'worse' : 'same' }
}

export function comparisonCompatibility(baseline: SavedScenario, current: SavedScenario): { paired: boolean; reasons: string[]; reportsDiffer: boolean } {
  if (!baseline.snapshot || !current.snapshot) return { paired: false, reasons: ['Нет актуального результата расчёта'], reportsDiffer: false }
  const reasons: string[] = []
  if (baseline.snapshot.simulationModelVersion !== current.snapshot.simulationModelVersion) reasons.push('Использованы разные версии модели')
  if (baseline.form.seed !== current.form.seed) reasons.push('Различается seed пассажиропотока')
  else if (baseline.snapshot.trafficFingerprint !== current.snapshot.trafficFingerprint) reasons.push('Различаются сотрудники или расписание дня')
  return { paired: reasons.length === 0, reasons, reportsDiffer: baseline.snapshot.reportFingerprint !== current.snapshot.reportFingerprint }
}

function isSavedScenario(value: unknown): value is SavedScenario {
  if (!record(value) || typeof value.id !== 'string' || typeof value.name !== 'string' || value.name.length === 0 || value.name.length > 80 || typeof value.comment !== 'string' || value.comment.length > 300 || typeof value.savedAt !== 'string') return false
  if (value.migratedFromLegacy !== undefined && value.migratedFromLegacy !== true) return false
  if (value.snapshotNeedsUpgrade !== undefined && value.snapshotNeedsUpgrade !== true) return false
  const decoded = decodeScenarioHash('#settings=' + encodeScenario(value.form as ScenarioFormState))
  if (!decoded.ok) return false
  return value.snapshot === null || isSnapshot(value.snapshot)
}
function isSnapshot(value: unknown): value is ScenarioSnapshot {
  if (!record(value) || value.snapshotVersion !== 3 || value.simulationModelVersion !== SIMULATION_MODEL_VERSION || typeof value.trafficFingerprint !== 'string' || typeof value.reportFingerprint !== 'string') return false
  return nullable(value.waitingMeanSeconds) && nullable(value.waitingMedianSeconds) && nullable(value.waitingP90Seconds) && nullable(value.totalMeanSeconds) && nullable(value.totalMedianSeconds) && finite(value.maximumQueue) && finite(value.emptyFloorsTravelled)
}
function normalizeSnapshot(value: unknown): ScenarioSnapshot | null {
  if (isSnapshot(value)) return value
  if (!record(value) || value.snapshotVersion !== 2 || value.simulationModelVersion !== SIMULATION_MODEL_VERSION || typeof value.trafficFingerprint !== 'string' || typeof value.reportFingerprint !== 'string') return null
  if (!nullable(value.waitingMeanSeconds) || !nullable(value.waitingP90Seconds) || !nullable(value.totalMeanSeconds) || !finite(value.maximumQueue) || !finite(value.emptyFloorsTravelled)) return null
  return { ...value, snapshotVersion: 3, waitingMedianSeconds: null, totalMedianSeconds: null } as ScenarioSnapshot
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) }
function nullable(value: unknown): value is number | null { return value === null || finite(value) }
