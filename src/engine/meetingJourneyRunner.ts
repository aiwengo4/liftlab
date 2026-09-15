import type { EmployeeId, Floor } from './domain'
import type { MeetingSchedule, PlannedMeeting } from './meetingSchedule'
import { MeetingRoomRuntime, type FloorRooms, type MeetingSearchDecision, type MeetingSearchSession, type RoomBooking } from './meetingRooms'
import { minuteToSimulationTick, runJourneyScenario, type JourneyIntent, type JourneyScenarioResult, type JourneyScenarioSettings, type JourneyTrace } from './journeyRunner'
import type { SimulationState } from './state'
import { TICKS_PER_SECOND, type SimulationTick } from './time'
import type { RouteChoice } from './routeChoice'

export interface MeetingParticipantResult {
  readonly employeeId: EmployeeId
  readonly arrivedAt: SimulationTick
  readonly lateByTicks: SimulationTick
  readonly withinFiveMinuteTolerance: boolean
}

export interface MeetingExecutionResult {
  readonly meetingId: number
  readonly plannedStartMinute: number
  readonly roomFound: boolean
  readonly returnAfterFailedSearch: boolean
  readonly decisions: readonly MeetingSearchDecision[]
  readonly booking: RoomBooking | null
  readonly finalFloor: Floor | null
  readonly participants: readonly MeetingParticipantResult[]
}

export interface MeetingJourneyResult extends JourneyScenarioResult {
  readonly meetings: readonly MeetingExecutionResult[]
  readonly bookings: readonly RoomBooking[]
}

interface LegMeta {
  readonly meetingId: number
  readonly phase: 'prepare' | 'search' | 'fallback-origin'
}

interface RuntimeMeeting {
  readonly meeting: PlannedMeeting
  session: MeetingSearchSession | null
  readonly decisions: MeetingSearchDecision[]
  readonly arrivals: Map<EmployeeId, JourneyTrace>
  readonly participantResults: Map<EmployeeId, MeetingParticipantResult>
  readonly fixedChoices: Map<EmployeeId, RouteChoice>
  readonly prepareOrigins: Map<EmployeeId, Floor>
}

export function runMeetingJourneyScenario(
  state: SimulationState,
  schedule: MeetingSchedule,
  rooms: readonly FloorRooms[],
  settings: JourneyScenarioSettings,
  additionalIntents: readonly JourneyIntent[] = [],
): MeetingJourneyResult {
  validateSchedule(state, schedule)
  const runtime = new MeetingRoomRuntime(settings.floorCount, rooms, settings.seed)
  const meetings = [...schedule.meetings].sort((a, b) => a.startMinute - b.startMinute || a.id - b.id)
  const executions = new Map<number, RuntimeMeeting>()
  const executionsByEmployee = new Map<EmployeeId, RuntimeMeeting[]>()
  const legById = new Map<string, LegMeta>()
  const nextByEmployee = nextMeetingsByEmployee(meetings)
  const departedEmployees = new Set<EmployeeId>()
  const initial: JourneyIntent[] = [...additionalIntents]

  for (const meeting of meetings) {
    const execution: RuntimeMeeting = {
      meeting,
      session: null,
      decisions: [],
      arrivals: new Map(),
      participantResults: new Map(),
      fixedChoices: new Map(),
      prepareOrigins: new Map(),
    }
    executions.set(meeting.id, execution)
    for (const employeeId of meeting.participantIds) {
      const employeeExecutions = executionsByEmployee.get(employeeId) ?? []
      employeeExecutions.push(execution)
      executionsByEmployee.set(employeeId, employeeExecutions)
    }
    for (const departure of meeting.participantDepartures) {
      const id = legId(meeting.id, 'prepare', 0, departure.employeeId)
      legById.set(id, { meetingId: meeting.id, phase: 'prepare' })
      initial.push({
        id,
        employeeId: departure.employeeId,
        plannedStartAt: minuteToSimulationTick(departure.departureMinute),
        targetFloor: meeting.homeFloor,
        useCurrentFloorAsTarget: true,
        purpose: 'meeting-search',
      })
    }
  }

  const result = runJourneyScenario(state, initial, {
    ...settings,
    onJourneyCompleted: undefined,
    onJourneysCompleted: (traces, currentState) => {
      const departedInBatch = new Set(
        traces
          .filter((trace) => trace.purpose === 'departure')
          .map((trace) => trace.employeeId),
      )
      for (const employeeId of departedInBatch) {
        departedEmployees.add(employeeId)
        for (const execution of executionsByEmployee.get(employeeId) ?? []) {
          execution.arrivals.delete(employeeId)
          execution.prepareOrigins.delete(employeeId)
          execution.fixedChoices.delete(employeeId)
        }
      }
      const generated = [
        ...traces.flatMap((trace) => settings.onJourneyCompleted?.(trace, currentState) ?? []),
        ...(settings.onJourneysCompleted?.(traces, currentState) ?? []),
      ]
      const ready: Array<{ execution: RuntimeMeeting; meta: LegMeta; arrival: SimulationTick; floor: Floor }> = []
      for (const trace of traces) {
        const meta = legById.get(trace.id)
        if (meta === undefined) continue
        const execution = executions.get(meta.meetingId)!
        if (departedEmployees.has(trace.employeeId)) continue
        execution.arrivals.set(trace.employeeId, trace)
        if (meta.phase === 'prepare') execution.prepareOrigins.set(trace.employeeId, trace.fromFloor)
        if (meta.phase === 'search' && !execution.fixedChoices.has(trace.employeeId)) execution.fixedChoices.set(trace.employeeId, trace.selectedChoice)
        const activeParticipantCount = execution.meeting.participantIds.filter(
          (employeeId) => !departedEmployees.has(employeeId),
        ).length
        if (activeParticipantCount === 0 || execution.arrivals.size !== activeParticipantCount) continue
        const arrival = Math.max(...[...execution.arrivals.values()].map((item) => item.completedAt)) as SimulationTick
        for (const item of execution.arrivals.values()) {
          const late = Math.max(0, arrival - minuteToSimulationTick(execution.meeting.startMinute)) as SimulationTick
          execution.participantResults.set(item.employeeId, {
            employeeId: item.employeeId, arrivedAt: arrival, lateByTicks: late,
            withinFiveMinuteTolerance: late <= 5 * 60 * TICKS_PER_SECOND,
          })
        }
        execution.arrivals.clear()
        ready.push({ execution, meta, arrival, floor: trace.targetFloor })
      }

      const continuations = [...generated]
      const preparedSearches: typeof ready = []
      for (const item of ready.filter(({ meta }) => meta.phase === 'prepare')) {
        const origin = [...item.execution.prepareOrigins.entries()]
          .sort((a, b) => a[0] - b[0])[0]?.[1] ?? item.floor
        item.execution.session = runtime.createSession(item.execution.meeting, origin)
        const firstFloor = item.execution.session.searchFloors[0]
        if (firstFloor === origin) preparedSearches.push({ ...item, meta: { ...item.meta, phase: 'search' }, floor: origin })
        else continuations.push(...groupLeg(item.execution, firstFloor, item.arrival, legById, 'search'))
      }
      for (const item of ready.filter(({ meta }) => meta.phase === 'fallback-origin')) {
        continuations.push(...returnIntents(item.execution, item.arrival, nextByEmployee))
      }
      const searches = [...ready.filter(({ meta }) => meta.phase === 'search'), ...preparedSearches]
        .sort((a, b) => a.execution.meeting.id - b.execution.meeting.id)
      const decisions = runtime.processArrivals(searches.map(({ execution, arrival, floor }) => ({
        session: execution.session!,
        atMinute: Math.floor(arrival / (60 * TICKS_PER_SECOND)),
        atTick: arrival,
        floor,
      })))
      decisions.forEach((decision, index) => {
        const item = searches[index]
        item.execution.decisions.push(decision)
        if (decision.kind === 'move-to-next-floor') continuations.push(...groupLeg(item.execution, decision.floor, item.arrival, legById, 'search'))
        else if (decision.kind === 'fallback-origin' && decision.floor !== item.floor) continuations.push(...groupLeg(item.execution, decision.floor, item.arrival, legById, 'fallback-origin'))
        else continuations.push(...returnIntents(item.execution, item.arrival, nextByEmployee))
      })
      return continuations.filter(
        (intent, index) => index < generated.length || !departedEmployees.has(intent.employeeId),
      )
    },
  })

  return {
    ...result,
    traces: result.traces.filter((trace) => legById.get(trace.id)?.phase !== 'prepare'),
    bookings: runtime.bookings(),
    meetings: meetings.map((meeting) => {
      const execution = executions.get(meeting.id)!
      return {
        meetingId: meeting.id,
        plannedStartMinute: meeting.startMinute,
        roomFound: meeting.roomFound,
        returnAfterFailedSearch: meeting.returnAfterFailedSearch,
        decisions: execution.decisions,
        booking: execution.session?.booking ?? null,
        finalFloor: execution.session?.finalFloor ?? null,
        participants: [...execution.participantResults.values()].sort((a, b) => a.employeeId - b.employeeId),
      }
    }),
  }
}

function groupLeg(
  execution: RuntimeMeeting,
  floor: Floor,
  at: SimulationTick,
  metadata: Map<string, LegMeta>,
  phase: LegMeta['phase'],
): JourneyIntent[] {
  return execution.meeting.participantIds.map((employeeId) => {
    const index = execution.decisions.length
    const id = legId(execution.meeting.id, phase, index, employeeId)
    metadata.set(id, { meetingId: execution.meeting.id, phase })
    return {
      id,
      employeeId,
      plannedStartAt: at,
      targetFloor: floor,
      purpose: 'meeting-search',
      fixedChoice: execution.fixedChoices.get(employeeId),
      transportChoiceTargetFloor: execution.fixedChoices.has(employeeId)
        ? undefined
        : execution.session!.searchFloors[execution.session!.searchFloors.length - 1],
    }
  })
}

function returnIntents(
  execution: RuntimeMeeting,
  now: SimulationTick,
  nextByEmployee: ReadonlyMap<string, PlannedMeeting | null>,
): JourneyIntent[] {
  const end = minuteToSimulationTick(execution.meeting.endMinute)
  return execution.meeting.participantIds.flatMap((employeeId) => {
    const next = nextByEmployee.get(`${execution.meeting.id}:${employeeId}`)
    const nextDeparture = next?.participantDepartures.find((item) => item.employeeId === employeeId)?.departureMinute
    if (nextDeparture !== undefined && nextDeparture <= execution.meeting.endMinute) return []
    return [{
      id: `meeting-${execution.meeting.id}-return-${employeeId}`,
      employeeId,
      plannedStartAt: Math.max(now, end) as SimulationTick,
      targetFloor: execution.meeting.homeFloor,
      purpose: 'meeting-return' as const,
    }]
  })
}

function nextMeetingsByEmployee(meetings: readonly PlannedMeeting[]): Map<string, PlannedMeeting | null> {
  const result = new Map<string, PlannedMeeting | null>()
  const byEmployee = new Map<EmployeeId, PlannedMeeting[]>()
  for (const meeting of meetings) for (const employeeId of meeting.participantIds) {
    const values = byEmployee.get(employeeId) ?? []
    values.push(meeting)
    byEmployee.set(employeeId, values)
  }
  for (const [employeeId, values] of byEmployee) {
    values.sort((a, b) => a.startMinute - b.startMinute || a.id - b.id)
    values.forEach((meeting, index) => result.set(`${meeting.id}:${employeeId}`, values[index + 1] ?? null))
  }
  return result
}

function legId(meetingId: number, phase: string, index: number, employeeId: EmployeeId): string {
  return `meeting-${meetingId}-${phase}-${index}-${employeeId}`
}

function validateSchedule(state: Readonly<SimulationState>, schedule: MeetingSchedule): void {
  const ids = new Set<number>()
  for (const meeting of schedule.meetings) {
    if (ids.has(meeting.id)) throw new Error('ID встреч должны быть уникальными')
    ids.add(meeting.id)
    if (new Set(meeting.participantIds).size !== meeting.participantIds.length) throw new Error(`Во встрече ${meeting.id} участники не должны повторяться`)
    if (meeting.participantIds.length === 0) throw new Error(`Во встрече ${meeting.id} должен быть хотя бы один участник`)
    if (meeting.participantDepartures.length !== meeting.participantIds.length) throw new Error(`Для встречи ${meeting.id} нужны времена выхода всех участников`)
    const participantSet = new Set(meeting.participantIds)
    const departureSet = new Set(meeting.participantDepartures.map((item) => item.employeeId))
    if (departureSet.size !== participantSet.size || [...participantSet].some((employeeId) => !departureSet.has(employeeId))) {
      throw new Error(`Времена выхода встречи ${meeting.id} должны соответствовать её участникам`)
    }
    for (const employeeId of meeting.participantIds) if (!state.employees.has(employeeId)) throw new Error(`Сотрудник ${employeeId} не найден`)
  }
}
