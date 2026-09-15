import type { SimulationTick } from './time'

export type EmployeeId = number
export type ElevatorId = number
export type HallCallId = number
export type Floor = number

/** Physical floor distance for numbering that omits floor zero (-1, 1). */
export function floorDistance(first: Floor, second: Floor): number {
  const numericDistance = Math.abs(first - second)
  return first * second < 0 ? numericDistance - 1 : numericDistance
}

export type TravelDirection = 'up' | 'down'
export type ElevatorDirection = TravelDirection | 'idle'

export type ElevatorState =
  | 'idle-closed'
  | 'moving'
  | 'opening-doors'
  | 'doors-open'
  | 'closing-doors'

export type EmployeeState =
  | 'on-floor'
  | 'waiting-for-elevator'
  | 'riding-elevator'
  | 'using-stairs'
  | 'arrived'

export interface Employee {
  readonly id: EmployeeId
  readonly homeFloor: Floor
  currentFloor: Floor
  targetFloor: Floor | null
  state: EmployeeState
  activeCallId: HallCallId | null
  elevatorId: ElevatorId | null
}

export interface HallCall {
  readonly id: HallCallId
  readonly floor: Floor
  readonly direction: TravelDirection
  readonly createdAt: SimulationTick
  waitingEmployeeIds: EmployeeId[]
  assignedElevatorId: ElevatorId | null
  status: 'waiting' | 'assigned' | 'served'
}

export interface Elevator {
  readonly id: ElevatorId
  readonly capacity: number
  currentFloor: Floor
  direction: ElevatorDirection
  state: ElevatorState
  passengerIds: EmployeeId[]
  assignedCallIds: HallCallId[]
  scheduledStops: Floor[]
  mandatoryCallId: HallCallId | null
  movement: {
    readonly fromFloor: Floor
    toFloor: Floor
    readonly startedAt: SimulationTick
    arrivesAt: SimulationTick
  } | null
  pendingBoardingEmployeeIds: EmployeeId[]
  doorServiceEndsAt: SimulationTick | null
  parkingFloor: Floor | null
  parkingTimeoutAt: SimulationTick | null
}

export type SimulationEventKind =
  | 'elevator-doors-opened'
  | 'passenger-exited'
  | 'hall-call-created'
  | 'hall-call-joined'
  | 'passenger-entered'
  | 'hall-call-updated'
  | 'hall-call-reactivated'
  | 'elevator-doors-closing-started'
  | 'elevator-doors-closed'
  | 'dispatch-requested'
  | 'parking-timeout'
  | 'parking-rule-boundary'
  | 'parking-step-arrived'
  | 'journey-requested'
  | 'stairs-segment-completed'

export interface SimulationEvent<TPayload = unknown> {
  readonly time: SimulationTick
  readonly kind: SimulationEventKind
  readonly subjectId: number
  readonly employeeIdForOrdering: EmployeeId | null
  readonly payload: TPayload
}
