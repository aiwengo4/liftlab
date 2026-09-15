import type { EmployeeId, Floor } from './domain'
import type { MeetingSchedule, PlannedMeeting } from './meetingSchedule'
import type { MeetingSearchDecision, RoomBooking } from './meetingRooms'
import {
  minuteToSimulationTick,
  runJourneyScenario,
  type JourneyIntent,
  type JourneyScenarioSettings,
  type JourneyTrace,
} from './journeyRunner'
import type { MeetingExecutionResult, MeetingJourneyResult, MeetingParticipantResult } from './meetingJourneyRunner'
import type { SimulationState } from './state'
import { TICKS_PER_SECOND, type SimulationTick } from './time'

interface RuntimeMeeting {
  readonly meeting: PlannedMeeting
  readonly targetFloor: Floor
  outbound: JourneyTrace | null
  participant: MeetingParticipantResult | null
  booking: RoomBooking | null
  decision: MeetingSearchDecision | null
}

/** Executes pre-resolved personal meetings without room-search simulation. */
export function runPersonalMeetingJourneyScenario(
  state: SimulationState,
  schedule: MeetingSchedule,
  settings: JourneyScenarioSettings,
  additionalIntents: readonly JourneyIntent[] = [],
): MeetingJourneyResult {
  validatePersonalSchedule(state, schedule)
  const meetings = [...schedule.meetings].sort((a, b) => a.startMinute - b.startMinute || a.id - b.id)
  const runtimeByMeeting = new Map<number, RuntimeMeeting>()
  const meetingByOutboundId = new Map<string, RuntimeMeeting>()
  const departedEmployees = new Set<EmployeeId>()
  const nextByMeeting = nextMeetingByEmployee(meetings)
  const initial: JourneyIntent[] = [...additionalIntents]

  for (const meeting of meetings) {
    const employeeId = meeting.participantIds[0]
    const targetFloor = meeting.searchFloors.at(-1) ?? meeting.homeFloor
    const runtime: RuntimeMeeting = {
      meeting, targetFloor, outbound: null, participant: null, booking: null, decision: null,
    }
    runtimeByMeeting.set(meeting.id, runtime)
    const id = outboundId(meeting.id, employeeId)
    meetingByOutboundId.set(id, runtime)
    initial.push({
      id,
      employeeId,
      plannedStartAt: minuteToSimulationTick(meeting.participantDepartures[0].departureMinute),
      targetFloor,
      purpose: 'meeting-search',
    })
  }

  const result = runJourneyScenario(state, initial, {
    ...settings,
    onJourneyCompleted: undefined,
    onJourneysCompleted: (traces, currentState) => {
      for (const trace of traces) if (trace.purpose === 'departure') departedEmployees.add(trace.employeeId)
      const generated: JourneyIntent[] = [
        ...traces.flatMap((trace) => settings.onJourneyCompleted?.(trace, currentState) ?? []),
        ...(settings.onJourneysCompleted?.(traces, currentState) ?? []),
      ]
      const publicGeneratedCount = generated.length

      for (const trace of traces) {
        const runtime = meetingByOutboundId.get(trace.id)
        if (runtime === undefined || departedEmployees.has(trace.employeeId)) continue
        runtime.outbound = trace
        const meetingStart = minuteToSimulationTick(runtime.meeting.startMinute)
        const lateByTicks = Math.max(0, trace.completedAt - meetingStart) as SimulationTick
        runtime.participant = {
          employeeId: trace.employeeId,
          arrivedAt: trace.completedAt,
          lateByTicks,
          withinFiveMinuteTolerance: lateByTicks <= 5 * 60 * TICKS_PER_SECOND,
        }
        const meetingEnded = trace.completedAt >= minuteToSimulationTick(runtime.meeting.endMinute)
        runtime.booking = runtime.meeting.roomFound && !meetingEnded ? booking(runtime, trace.completedAt) : null
        runtime.decision = meetingEnded
          ? { kind: 'meeting-ended', meetingId: runtime.meeting.id, floor: runtime.targetFloor }
          : decision(runtime)

        const next = nextByMeeting.get(runtime.meeting.id)
        const nextDeparture = next?.participantDepartures[0].departureMinute
        if (nextDeparture !== undefined && nextDeparture <= runtime.meeting.endMinute && (runtime.meeting.roomFound || !runtime.meeting.returnAfterFailedSearch)) continue
        const returnAt = !runtime.meeting.roomFound && runtime.meeting.returnAfterFailedSearch
          ? trace.completedAt
          : Math.max(trace.completedAt, minuteToSimulationTick(runtime.meeting.endMinute)) as SimulationTick
        generated.push({
          id: returnId(runtime.meeting.id, trace.employeeId),
          employeeId: trace.employeeId,
          plannedStartAt: returnAt,
          targetFloor: runtime.meeting.homeFloor,
          purpose: 'meeting-return',
        })
      }
      return generated.filter(
        (intent, index) => index < publicGeneratedCount || !departedEmployees.has(intent.employeeId),
      )
    },
  })

  const executions: MeetingExecutionResult[] = meetings.map((meeting) => {
    const runtime = runtimeByMeeting.get(meeting.id)!
    return {
      meetingId: meeting.id,
      plannedStartMinute: meeting.startMinute,
      roomFound: meeting.roomFound,
      returnAfterFailedSearch: meeting.returnAfterFailedSearch,
      decisions: runtime.decision === null ? [] : [runtime.decision],
      booking: runtime.booking,
      finalFloor: runtime.outbound === null ? null : runtime.decision?.kind === 'fallback-origin' ? runtime.meeting.homeFloor : runtime.targetFloor,
      participants: runtime.participant === null ? [] : [runtime.participant],
    }
  })
  return {
    ...result,
    meetings: executions,
    bookings: executions.flatMap(({ booking: value }) => value === null ? [] : [value]),
  }
}

function booking(runtime: RuntimeMeeting, actualStartAt: SimulationTick): RoomBooking {
  return {
    roomId: `personal-${runtime.meeting.id}`,
    floor: runtime.targetFloor,
    meetingId: runtime.meeting.id,
    startMinute: Math.max(runtime.meeting.startMinute, Math.floor(actualStartAt / (60 * TICKS_PER_SECOND))),
    endMinute: runtime.meeting.endMinute,
    actualStartAt,
  }
}

function decision(runtime: RuntimeMeeting): MeetingSearchDecision {
  if (runtime.booking !== null) return { kind: 'room-acquired', meetingId: runtime.meeting.id, booking: runtime.booking }
  return runtime.meeting.returnAfterFailedSearch
    ? { kind: 'fallback-origin', meetingId: runtime.meeting.id, floor: runtime.meeting.homeFloor }
    : { kind: 'fallback-stay', meetingId: runtime.meeting.id, floor: runtime.targetFloor }
}

function nextMeetingByEmployee(meetings: readonly PlannedMeeting[]): Map<number, PlannedMeeting | null> {
  const result = new Map<number, PlannedMeeting | null>()
  const byEmployee = new Map<EmployeeId, PlannedMeeting[]>()
  for (const meeting of meetings) {
    const employeeId = meeting.participantIds[0]
    const values = byEmployee.get(employeeId) ?? []
    values.push(meeting)
    byEmployee.set(employeeId, values)
  }
  for (const values of byEmployee.values()) {
    values.sort((a, b) => a.startMinute - b.startMinute || a.id - b.id)
    values.forEach((meeting, index) => result.set(meeting.id, values[index + 1] ?? null))
  }
  return result
}

function validatePersonalSchedule(state: Readonly<SimulationState>, schedule: MeetingSchedule): void {
  const ids = new Set<number>()
  for (const meeting of schedule.meetings) {
    if (ids.has(meeting.id)) throw new Error('ID встреч должны быть уникальными')
    ids.add(meeting.id)
    if (meeting.participantIds.length !== 1 || meeting.participantDepartures.length !== 1) {
      throw new Error(`Встреча ${meeting.id} должна принадлежать одному сотруднику`)
    }
    if (meeting.participantDepartures[0].employeeId !== meeting.participantIds[0]) {
      throw new Error(`Время выхода встречи ${meeting.id} должно соответствовать участнику`)
    }
    if (!state.employees.has(meeting.participantIds[0])) throw new Error(`Сотрудник ${meeting.participantIds[0]} не найден`)
    if (typeof meeting.roomFound !== 'boolean' || typeof meeting.returnAfterFailedSearch !== 'boolean') {
      throw new Error(`Для встречи ${meeting.id} нужен результат упрощённого поиска переговорной`)
    }
  }
}

function outboundId(meetingId: number, employeeId: EmployeeId): string {
  return `meeting-${meetingId}-search-0-${employeeId}`
}

function returnId(meetingId: number, employeeId: EmployeeId): string {
  return `meeting-${meetingId}-return-${employeeId}`
}
