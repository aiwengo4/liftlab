import type { FullDayResult } from './engine/fullDayRunner'

export interface BrowserMeetingResult {
  readonly plannedStartMinute: number
  readonly decisionKinds: readonly string[]
}

export interface BrowserSimulationResult {
  readonly metrics: FullDayResult['metrics']
  readonly operationalMetrics: FullDayResult['operationalMetrics']
  readonly meetings: readonly BrowserMeetingResult[]
}

export function prepareBrowserResult(result: FullDayResult): BrowserSimulationResult {
  return {
    metrics: result.metrics,
    operationalMetrics: result.operationalMetrics,
    meetings: result.meetings.map((meeting) => ({
      plannedStartMinute: meeting.plannedStartMinute,
      decisionKinds: meeting.decisions.map((decision) => decision.kind),
    })),
  }
}
