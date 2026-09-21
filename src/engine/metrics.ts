import type { EmployeeId } from './domain'
import type { JourneyTrace } from './journeyRunner'
import { secondsToTicks, ticksToSeconds, type SimulationTick } from './time'

export interface ReportPeriod {
  readonly startMinute: number
  readonly endMinute: number
}

export interface ReportPeriods {
  readonly morning: ReportPeriod
  readonly day: ReportPeriod
  readonly evening: ReportPeriod
}

export interface MetricsSettings {
  readonly periods?: ReportPeriods
  readonly longWaitThresholdSeconds?: readonly number[]
}

export interface TimeStatistics {
  readonly sampleSize: number
  readonly meanSeconds: number | null
  readonly medianSeconds: number | null
  readonly p75Seconds: number | null
  readonly p90Seconds: number | null
  readonly p95Seconds: number | null
}

export interface LongWaitStatistic {
  readonly thresholdSeconds: number
  readonly count: number
  readonly share: number | null
}

export interface MetricSlice {
  readonly routeCount: number
  readonly waiting: TimeStatistics
  readonly riding: TimeStatistics
  readonly total: TimeStatistics
  readonly longWaits: readonly LongWaitStatistic[]
  /** Raw values used by the UI to build a histogram with selectable buckets. */
  readonly waitingDistributionSeconds: readonly number[]
  /** Raw values used by the UI to build a histogram with selectable buckets. */
  readonly totalDistributionSeconds: readonly number[]
  readonly routeGroups: RouteMetricGroups
}

export interface RouteMetricGroup {
  readonly routeCount: number
  readonly shareOfAllRoutes: number | null
  readonly waiting: TimeStatistics
  readonly riding: TimeStatistics
  readonly total: TimeStatistics
}

export interface RouteMetricGroups {
  /** Routes that used an elevator, including routes completed with mandatory stairs. */
  readonly elevator: RouteMetricGroup
  /** Routes completed entirely by stairs. */
  readonly stairs: RouteMetricGroup
  /** All completed routes, regardless of transport mode. */
  readonly all: RouteMetricGroup
}

export interface HourMetricSlice extends MetricSlice {
  readonly hour: number
  readonly startMinute: number
  readonly endMinute: number
}

export interface SimulationCounters {
  readonly arrivedEmployees: number
  readonly departedEmployees: number
  readonly completedRoutes: number
  readonly employeesUsingVoluntaryStairs: number
  readonly voluntaryStairsEmployeeShare: number | null
  readonly combinedRoutes: number
  /** Always zero for a successfully completed full-day run whose event queue is drained. */
  readonly unfinishedRoutes: 0
  /** End-of-run snapshot; live counters require event-log aggregation. */
  readonly waitingNow: 0
}

export interface SimulationMetrics {
  readonly wholeDay: MetricSlice
  readonly morning: MetricSlice
  readonly day: MetricSlice
  readonly evening: MetricSlice
  readonly hours: readonly HourMetricSlice[]
  readonly counters: SimulationCounters
}

export const DEFAULT_REPORT_PERIODS: ReportPeriods = {
  morning: { startMinute: 8 * 60, endMinute: 12 * 60 },
  day: { startMinute: 12 * 60, endMinute: 18 * 60 },
  evening: { startMinute: 18 * 60, endMinute: 23 * 60 },
}

export const DEFAULT_LONG_WAIT_THRESHOLDS_SECONDS = [120, 240, 360] as const

export function calculateSimulationMetrics(
  traces: readonly JourneyTrace[],
  settings: MetricsSettings = {},
): SimulationMetrics {
  const periods = settings.periods ?? DEFAULT_REPORT_PERIODS
  const thresholds = settings.longWaitThresholdSeconds ?? DEFAULT_LONG_WAIT_THRESHOLDS_SECONDS
  validateMetricsSettings(settings)
  validateTraces(traces)

  const ordered = [...traces].sort(
    (first, second) => first.actualStartAt - second.actualStartAt || first.employeeId - second.employeeId || first.id.localeCompare(second.id),
  )
  const movementTraces = ordered.filter((trace) => trace.fromFloor !== trace.targetFloor)
  const morning = tracesInPeriod(movementTraces, periods.morning)
  const day = tracesInPeriod(movementTraces, periods.day)
  const evening = tracesInPeriod(movementTraces, periods.evening)
  const routedEmployees = new Set(movementTraces.map((trace) => trace.employeeId))
  const voluntaryStairsEmployees = new Set<EmployeeId>(
    movementTraces.filter((trace) => trace.choice.mode === 'stairs' && ['probability', 'lunch-overload'].includes(trace.choice.reason)).map((trace) => trace.employeeId),
  )

  return {
    wholeDay: buildSlice(movementTraces, thresholds),
    morning: buildSlice(morning, thresholds),
    day: buildSlice(day, thresholds),
    evening: buildSlice(evening, thresholds),
    hours: Array.from({ length: 24 }, (_, hour) => {
      const hourTraces = movementTraces.filter((trace) => tickToMinute(trace.actualStartAt) >= hour * 60 && tickToMinute(trace.actualStartAt) < (hour + 1) * 60)
      return { hour, startMinute: hour * 60, endMinute: (hour + 1) * 60, ...buildSlice(hourTraces, thresholds) }
    }),
    counters: {
      arrivedEmployees: new Set(ordered.filter((trace) => trace.purpose === 'arrival').map((trace) => trace.employeeId)).size,
      departedEmployees: new Set(ordered.filter((trace) => trace.purpose === 'departure').map((trace) => trace.employeeId)).size,
      completedRoutes: movementTraces.length,
      employeesUsingVoluntaryStairs: voluntaryStairsEmployees.size,
      voluntaryStairsEmployeeShare: routedEmployees.size === 0 ? null : voluntaryStairsEmployees.size / routedEmployees.size,
      combinedRoutes: movementTraces.filter((trace) => trace.boardedAt !== null && trace.stairsTicks > 0).length,
      unfinishedRoutes: 0,
      waitingNow: 0,
    },
  }
}

export function validateMetricsSettings(settings: MetricsSettings = {}): void {
  const periods = settings.periods ?? DEFAULT_REPORT_PERIODS
  const thresholds = settings.longWaitThresholdSeconds ?? DEFAULT_LONG_WAIT_THRESHOLDS_SECONDS
  validateSettings(periods, thresholds)
}

function buildSlice(traces: readonly JourneyTrace[], thresholds: readonly number[]): MetricSlice {
  const elevatorTraces = traces.filter((trace) => trace.boardedAt !== null)
  const stairTraces = traces.filter((trace) => trace.boardedAt === null && trace.stairsTicks > 0)
  const waiting = elevatorTraces.map((trace) => ticksToSeconds(trace.waitingTicks))
  const riding = elevatorTraces.map((trace) => ticksToSeconds(trace.ridingTicks))
  const total = traces.map((trace) => ticksToSeconds(trace.totalTicks))
  return {
    routeCount: traces.length,
    waiting: statistics(waiting),
    riding: statistics(riding),
    total: statistics(total),
    longWaits: thresholds.map((thresholdSeconds) => ({
      thresholdSeconds,
      count: waiting.filter((seconds) => seconds > thresholdSeconds).length,
      share: waiting.length === 0 ? null : waiting.filter((seconds) => seconds > thresholdSeconds).length / waiting.length,
    })),
    waitingDistributionSeconds: [...waiting].sort((a, b) => a - b),
    totalDistributionSeconds: [...total].sort((a, b) => a - b),
    routeGroups: {
      elevator: buildRouteGroup(elevatorTraces, traces.length),
      stairs: buildRouteGroup(stairTraces, traces.length),
      all: buildRouteGroup(traces, traces.length),
    },
  }
}

function buildRouteGroup(traces: readonly JourneyTrace[], allRouteCount: number): RouteMetricGroup {
  const elevatorTraces = traces.filter((trace) => trace.boardedAt !== null)
  return {
    routeCount: traces.length,
    shareOfAllRoutes: allRouteCount === 0 ? null : traces.length / allRouteCount,
    waiting: statistics(elevatorTraces.map((trace) => ticksToSeconds(trace.waitingTicks))),
    riding: statistics(elevatorTraces.map((trace) => ticksToSeconds(trace.ridingTicks))),
    total: statistics(traces.map((trace) => ticksToSeconds(trace.totalTicks))),
  }
}

function statistics(values: readonly number[]): TimeStatistics {
  if (values.length === 0) return { sampleSize: 0, meanSeconds: null, medianSeconds: null, p75Seconds: null, p90Seconds: null, p95Seconds: null }
  const sorted = [...values].sort((a, b) => a - b)
  return {
    sampleSize: sorted.length,
    meanSeconds: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    medianSeconds: median(sorted),
    p75Seconds: percentileNearestRank(sorted, 0.75),
    p90Seconds: percentileNearestRank(sorted, 0.9),
    p95Seconds: percentileNearestRank(sorted, 0.95),
  }
}

function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function percentileNearestRank(sorted: readonly number[], percentile: number): number {
  return sorted[Math.ceil(percentile * sorted.length) - 1]
}

function tracesInPeriod(traces: readonly JourneyTrace[], period: ReportPeriod): JourneyTrace[] {
  return traces.filter((trace) => {
    const minute = tickToMinute(trace.actualStartAt)
    return minute >= period.startMinute && minute < period.endMinute
  })
}

function tickToMinute(tick: SimulationTick): number {
  return ticksToSeconds(tick) / 60
}

function validateSettings(periods: ReportPeriods, thresholds: readonly number[]): void {
  for (const [name, period] of Object.entries(periods)) {
    if (!Number.isInteger(period.startMinute) || !Number.isInteger(period.endMinute) || period.startMinute < 0 || period.endMinute > 24 * 60 || period.startMinute >= period.endMinute) {
      throw new RangeError(`Отчётный период «${name}» задан некорректно`)
    }
  }
  if (periods.morning.endMinute !== periods.day.startMinute || periods.day.endMinute !== periods.evening.startMinute) {
    throw new Error('Отчётные периоды не должны пересекаться или иметь разрывы')
  }
  if (thresholds.some((value, index) => !Number.isFinite(value) || value < 0 || (index > 0 && value <= thresholds[index - 1]))) {
    throw new RangeError('Пороги долгого ожидания должны быть возрастающими неотрицательными числами')
  }
}

function validateTraces(traces: readonly JourneyTrace[]): void {
  const ids = new Set<string>()
  for (const trace of traces) {
    if (ids.has(trace.id)) throw new Error(`Маршрут ${trace.id} указан в метриках повторно`)
    ids.add(trace.id)
    for (const value of [trace.actualStartAt, trace.completedAt, trace.waitingTicks, trace.ridingTicks, trace.stairsTicks, trace.totalTicks]) {
      if (!Number.isSafeInteger(value) || value < secondsToTicks(0)) throw new RangeError(`Маршрут ${trace.id} содержит некорректное время`)
    }
    if (trace.completedAt < trace.actualStartAt) throw new Error(`Маршрут ${trace.id} завершился раньше начала`)
  }
}
