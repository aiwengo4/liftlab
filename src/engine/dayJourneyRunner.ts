import type { EmployeeId } from './domain'
import { lunchReturnStartTick, lunchStartTick, type LunchSchedule } from './lunchSchedule'
import { validateLunchJourneySchedule, type LunchExecution } from './lunchJourneyRunner'
import type { MeetingSchedule } from './meetingSchedule'
import type { MeetingJourneyResult } from './meetingJourneyRunner'
import { runPersonalMeetingJourneyScenario } from './personalMeetingJourneyRunner'
import { minuteToSimulationTick, type JourneyIntent, type JourneyScenarioSettings, type JourneyTrace } from './journeyRunner'
import type { SimulationState } from './state'
import { addTicks, type SimulationTick } from './time'

export interface RuntimeSkippedLunch {
  readonly employeeId: EmployeeId
  readonly attemptedAt: SimulationTick
  readonly reason: 'meeting-in-progress' | 'insufficient-time-before-meeting'
}

export interface DayLunchExecution extends Omit<LunchExecution, 'returnJourney'> {
  readonly returnJourney: JourneyTrace | null
  readonly endedByMeeting: boolean
  readonly endedByDeparture: boolean
}

export interface DayJourneyResult extends Omit<MeetingJourneyResult, 'lunches'> {
  readonly lunches: readonly DayLunchExecution[]
  readonly runtimeSkippedLunches: readonly RuntimeSkippedLunch[]
  readonly allSkippedLunchEmployeeIds: readonly EmployeeId[]
}

export function runDayJourneyScenario(
  state: SimulationState,
  meetings: MeetingSchedule,
  lunches: LunchSchedule,
  settings: JourneyScenarioSettings,
  additionalIntents: readonly JourneyIntent[] = [],
): DayJourneyResult {
  validateLunchJourneySchedule(state, lunches, settings.floorCount)
  const orderedLunches = [...lunches.lunches].sort((a, b) => a.startMinute - b.startMinute || a.employeeId - b.employeeId)
  const lunchByEmployee = new Map(orderedLunches.map((lunch) => [lunch.employeeId, lunch]))
  const outboundByEmployee = new Map<EmployeeId, JourneyTrace>()
  const returnByEmployee = new Map<EmployeeId, JourneyTrace>()
  const actualStartByEmployee = new Map<EmployeeId, SimulationTick>()
  const actualReturnByEmployee = new Map<EmployeeId, SimulationTick>()
  const endedByMeeting = new Set<EmployeeId>()
  const endedByDeparture = new Set<EmployeeId>()
  const runtimeSkipped: RuntimeSkippedLunch[] = []
  const ownIds = new Set<string>()

  const initial: JourneyIntent[] = orderedLunches.map((lunch) => {
    const id = `day-lunch-prepare-${lunch.employeeId}`
    ownIds.add(id)
    return {
      id,
      employeeId: lunch.employeeId,
      plannedStartAt: lunchStartTick(lunch),
      targetFloor: lunch.cafeteriaFloor,
      useCurrentFloorAsTarget: true,
      purpose: 'lunch',
    }
  })
  initial.push(...additionalIntents)

  const meetingIntervals = new Map<EmployeeId, Array<{ departure: SimulationTick; end: SimulationTick }>>()
  for (const meeting of meetings.meetings) for (const departure of meeting.participantDepartures) {
    const values = meetingIntervals.get(departure.employeeId) ?? []
    values.push({ departure: minuteToSimulationTick(departure.departureMinute), end: minuteToSimulationTick(meeting.endMinute) })
    meetingIntervals.set(departure.employeeId, values)
  }
  for (const values of meetingIntervals.values()) values.sort((a, b) => a.departure - b.departure || a.end - b.end)

  const originalSingle = settings.onJourneyCompleted
  const originalBatch = settings.onJourneysCompleted
  const result = runPersonalMeetingJourneyScenario(state, meetings, {
    ...settings,
    onJourneyCompleted: undefined,
    onJourneysCompleted: (traces, currentState) => {
      const departedInBatch = new Map(
        traces.filter((trace) => trace.purpose === 'departure').map((trace) => [trace.employeeId, trace]),
      )
      for (const [employeeId, departure] of departedInBatch) {
        if (outboundByEmployee.has(employeeId) && !returnByEmployee.has(employeeId)) {
          actualReturnByEmployee.set(employeeId, departure.actualStartAt)
          endedByDeparture.add(employeeId)
        }
      }
      const publicTraces = traces.filter((trace) =>
        !trace.id.startsWith('day-lunch-prepare-') && !/^meeting-\d+-prepare-/.test(trace.id),
      )
      const generated: JourneyIntent[] = [
        ...publicTraces.flatMap((trace) => originalSingle?.(trace, currentState) ?? []),
        ...(publicTraces.length > 0 ? originalBatch?.(publicTraces, currentState) ?? [] : []),
      ]
      const publicGeneratedCount = generated.length
      for (const trace of traces) {
        if (!ownIds.has(trace.id)) continue
        const lunch = lunchByEmployee.get(trace.employeeId)!
        if (trace.id.startsWith('day-lunch-prepare-')) {
          const duration = (lunchReturnStartTick(lunch) - lunchStartTick(lunch)) as SimulationTick
          const intendedReturn = addTicks(trace.actualStartAt, duration)
          const intervals = meetingIntervals.get(trace.employeeId) ?? []
          const currentMeeting = intervals.find(({ departure, end }) => departure <= trace.actualStartAt && trace.actualStartAt < end)
          const nextMeeting = intervals.find(({ departure }) => departure > trace.actualStartAt)
          if (currentMeeting !== undefined || (nextMeeting !== undefined && intendedReturn > nextMeeting.departure)) {
            runtimeSkipped.push({
              employeeId: trace.employeeId,
              attemptedAt: trace.actualStartAt,
              reason: currentMeeting !== undefined ? 'meeting-in-progress' : 'insufficient-time-before-meeting',
            })
            continue
          }
          actualStartByEmployee.set(trace.employeeId, trace.actualStartAt)
          const id = `day-lunch-outbound-${trace.employeeId}`
          ownIds.add(id)
          generated.push({ id, employeeId: trace.employeeId, plannedStartAt: trace.actualStartAt, targetFloor: lunch.cafeteriaFloor, purpose: 'lunch' })
          continue
        }
        if (trace.id.startsWith('day-lunch-outbound-')) {
          outboundByEmployee.set(trace.employeeId, trace)
          const departure = departedInBatch.get(trace.employeeId)
          if (departure !== undefined) {
            actualReturnByEmployee.set(trace.employeeId, departure.actualStartAt)
            endedByDeparture.add(trace.employeeId)
            continue
          }
          const duration = (lunchReturnStartTick(lunch) - lunchStartTick(lunch)) as SimulationTick
          const returnAt = Math.max(trace.completedAt, addTicks(actualStartByEmployee.get(trace.employeeId)!, duration)) as SimulationTick
          const lunchStartedAt = actualStartByEmployee.get(trace.employeeId)!
          const meetingAtReturn = (meetingIntervals.get(trace.employeeId) ?? []).find(({ departure }) => lunchStartedAt <= departure && departure <= returnAt)
          if (meetingAtReturn !== undefined) {
            actualReturnByEmployee.set(trace.employeeId, returnAt)
            endedByMeeting.add(trace.employeeId)
            continue
          }
          const id = `day-lunch-return-${trace.employeeId}`
          ownIds.add(id)
          generated.push({ id, employeeId: trace.employeeId, plannedStartAt: returnAt, targetFloor: currentState.employees.get(trace.employeeId)!.homeFloor, purpose: 'lunch-return' })
          continue
        }
        returnByEmployee.set(trace.employeeId, trace)
        actualReturnByEmployee.set(trace.employeeId, trace.actualStartAt)
      }
      return generated.filter(
        (intent, index) => index < publicGeneratedCount || !departedInBatch.has(intent.employeeId),
      )
    },
  }, initial)

  const executions = orderedLunches.flatMap((lunch): DayLunchExecution[] => {
    const outbound = outboundByEmployee.get(lunch.employeeId)
    const returnJourney = returnByEmployee.get(lunch.employeeId)
    if (outbound === undefined || (returnJourney === undefined && !endedByMeeting.has(lunch.employeeId) && !endedByDeparture.has(lunch.employeeId))) return []
    const plannedStartAt = lunchStartTick(lunch)
    return [{
      employeeId: lunch.employeeId,
      cafeteriaFloor: lunch.cafeteriaFloor,
      plannedStartAt,
      actualStartAt: actualStartByEmployee.get(lunch.employeeId)!,
      plannedReturnStartAt: lunchReturnStartTick(lunch),
      actualReturnStartAt: actualReturnByEmployee.get(lunch.employeeId)!,
      shiftedByRuntimeTicks: (actualStartByEmployee.get(lunch.employeeId)! - plannedStartAt) as SimulationTick,
      outbound,
      returnJourney: returnJourney ?? null,
      endedByMeeting: endedByMeeting.has(lunch.employeeId),
      endedByDeparture: endedByDeparture.has(lunch.employeeId),
    }]
  })
  const hiddenIds = new Set(initial.filter(({ id }) => id.startsWith('day-lunch-prepare-')).map(({ id }) => id))
  return {
    ...result,
    traces: result.traces.filter((trace) => !hiddenIds.has(trace.id)),
    lunches: executions,
    runtimeSkippedLunches: runtimeSkipped.sort((a, b) => a.attemptedAt - b.attemptedAt || a.employeeId - b.employeeId),
    allSkippedLunchEmployeeIds: [...new Set([...lunches.skippedEmployeeIds, ...runtimeSkipped.map(({ employeeId }) => employeeId)])].sort((a, b) => a - b),
  }
}
