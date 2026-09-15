import type {
  Elevator,
  ElevatorId,
  EmployeeId,
  Floor,
  HallCall,
  SimulationEvent,
} from './domain'
import { floorDistance } from './domain'
import { SeededRandom } from './random'
import type {
  DoorsOpenedPayload,
  ElevatorPayload,
  HallCallCreatedPayload,
  HallCallJoinedPayload,
  HallCallUpdatedPayload,
  PassengerEnteredPayload,
  PassengerExitedPayload,
  ParkingStepPayload,
  SimulationCoordinator,
  Simulator,
} from './simulator'
import { addTicks, secondsToTicks, type SimulationTick } from './time'
import {
  movementTime,
  type ElevatorTiming,
} from './timing'

export interface ParkingInterval { readonly startMinute: number; readonly endMinute: number; readonly floor: Floor }
export interface ElevatorParkingSettings { readonly elevatorId: ElevatorId; readonly timeoutSeconds: number; readonly intervals: readonly ParkingInterval[] }
export interface ElevatorServedFloors { readonly elevatorId: ElevatorId; readonly floors: readonly Floor[] }
export type DispatchStrategy = 'global-fifo' | 'nearest' | 'hybrid'
export const HYBRID_FIFO_AFTER_SECONDS = 120

export class BaselineDispatcher implements SimulationCoordinator {
  private readonly random: SeededRandom
  private nextVisitId = 1
  private readonly activeVisitIds = new Map<ElevatorId, number>()
  private readonly parkingMoving = new Set<ElevatorId>()
  private readonly waitingCallIds = new Set<number>()
  private readonly waitingCallsByFloorDirection = new Map<string, HallCall[]>()
  private waitingCallIndexInitialized = false

  constructor(
    private readonly timing: ElevatorTiming,
    seed: number,
    private readonly parking: readonly ElevatorParkingSettings[] = [],
    private readonly strategy: DispatchStrategy = 'nearest',
    servedFloorsByElevator: readonly ElevatorServedFloors[] = [],
  ) {
    this.random = new SeededRandom(seed)
    this.servedFloorsByElevator = new Map(servedFloorsByElevator.map(({ elevatorId, floors }) => [elevatorId, new Set(floors)]))
  }

  private readonly servedFloorsByElevator: ReadonlyMap<ElevatorId, ReadonlySet<Floor>>

  private servesFloor(elevator: Elevator, floor: Floor): boolean {
    return this.servedFloorsByElevator.get(elevator.id)?.has(floor) ?? true
  }

  private servesEmployee(simulator: Simulator, elevator: Elevator, employeeId: EmployeeId, origin: Floor): boolean {
    const target = simulator.state.employees.get(employeeId)?.targetFloor
    return target !== null && target !== undefined && this.servesFloor(elevator, origin) && this.servesFloor(elevator, target)
  }

  private servesCall(simulator: Simulator, elevator: Elevator, call: HallCall): boolean {
    return call.waitingEmployeeIds.some((employeeId) => this.servesEmployee(simulator, elevator, employeeId, call.floor))
  }

  afterEvent(event: SimulationEvent, simulator: Simulator): void {
    switch (event.kind) {
      case 'hall-call-created':
        this.requestDispatch(simulator, event.payload as HallCallCreatedPayload)
        return
      case 'hall-call-joined':
        this.handleJoinedCall(simulator, event.payload as HallCallJoinedPayload)
        return
      case 'dispatch-requested':
        this.dispatchWaitingCalls(simulator)
        return
      case 'elevator-doors-opened':
        this.planOpenDoorStop(
          simulator,
          event.payload as DoorsOpenedPayload,
        )
        return
      case 'passenger-entered':
        this.completePendingBoarding(
          simulator,
          event.payload as PassengerEnteredPayload,
        )
        this.registerPassengerDestination(
          simulator,
          event.payload as PassengerEnteredPayload,
        )
        return
      case 'passenger-exited':
        this.completeCurrentStop(
          simulator,
          event.payload as PassengerExitedPayload,
        )
        return
      case 'hall-call-updated':
        this.releaseServedCall(
          simulator,
          event.payload as HallCallUpdatedPayload,
        )
        return
      case 'hall-call-reactivated':
        this.requestDispatchForCall(
          simulator,
          event.payload as HallCallUpdatedPayload,
        )
        return
      case 'elevator-doors-closed':
        this.continueElevatorRoute(
          simulator,
          event.payload as ElevatorPayload,
        )
        return
      case 'elevator-doors-closing-started':
        return
      case 'parking-timeout':
        this.handleParkingTimeout(simulator, event.payload as ElevatorPayload)
        return
      case 'parking-rule-boundary':
        this.refreshParkingRule(simulator, event.payload as ElevatorPayload)
        return
      case 'parking-step-arrived':
        this.continueAfterParkingStep(simulator, event.payload as ParkingStepPayload)
        return
    }
  }

  private requestDispatch(
    simulator: Simulator,
    payload: HallCallCreatedPayload,
  ): void {
    this.trackWaitingCall(simulator, payload.call.id)
    simulator.scheduleOwned(
      this.systemEvent(simulator.state.currentTime, 'dispatch-requested', payload.call.id, null),
    )
  }

  private requestDispatchForCall(
    simulator: Simulator,
    payload: HallCallUpdatedPayload,
  ): void {
    this.trackWaitingCall(simulator, payload.callId)
    simulator.scheduleOwned(
      this.systemEvent(simulator.state.currentTime, 'dispatch-requested', payload.callId, null),
    )
  }

  private handleJoinedCall(
    simulator: Simulator,
    payload: HallCallJoinedPayload,
  ): void {
    const call = simulator.state.hallCalls.get(payload.callId)!
    if (call.status === 'waiting') {
      this.trackWaitingCall(simulator, call.id)
      this.requestDispatchForCall(simulator, { callId: call.id })
      return
    }
    if (call.status !== 'assigned' || call.assignedElevatorId === null) return
    const elevator = simulator.state.elevators.get(call.assignedElevatorId)!
    if (
      elevator.currentFloor !== call.floor ||
      elevator.direction !== call.direction ||
      !['opening-doors', 'doors-open', 'closing-doors'].includes(elevator.state)
    ) return
    if (this.availablePlacesAtFloor(simulator, elevator, call.floor) <= 0) return
    if (elevator.state === 'doors-open') {
      this.cancelDoorClosing(simulator, elevator.id)
      this.planAdditionalBoarding(simulator, elevator, call)
    } else if (elevator.state === 'closing-doors') {
      this.cancelDoorClosing(simulator, elevator.id)
      elevator.state = 'opening-doors'
      const openingStartedAt = simulator.state.currentTime
      simulator.scheduleOwned(
        this.systemEvent(
          this.afterSeconds(openingStartedAt, this.timing.doorOperationSeconds),
          'elevator-doors-opened',
          elevator.id,
          { elevatorId: elevator.id, floor: elevator.currentFloor, visitId: this.activeVisitIds.get(elevator.id), openingStartedAt } satisfies DoorsOpenedPayload,
        ),
      )
    }
  }

  private dispatchWaitingCalls(simulator: Simulator): void {
    const orderedWaitingCalls = this.waitingCalls(simulator)
      .sort((first, second) => first.createdAt - second.createdAt || first.id - second.id)
    this.assignCallsAtCurrentDoors(simulator, orderedWaitingCalls)
    this.assignPassingCalls(simulator, orderedWaitingCalls)

    while (true) {
      const waitingCalls = this.nearestAssignmentCandidates(simulator)
      const idleElevators = [...simulator.state.elevators.values()].filter(
        (elevator) => elevator.state === 'idle-closed',
      )

      const impossible = waitingCalls.find((call) => ![...simulator.state.elevators.values()].some((elevator) => this.servesCall(simulator, elevator, call)))
      if (impossible !== undefined) {
        const employee = simulator.state.employees.get(impossible.waitingEmployeeIds[0])!
        throw new Error(`Ни один лифт не обслуживает маршрут с ${impossible.floor} на ${employee.targetFloor} этаж`)
      }

      if (waitingCalls.length === 0 || idleElevators.length === 0) {
        return
      }

      const assignment = this.chooseNearestAssignment(
        idleElevators,
        waitingCalls,
        simulator.state.currentTime,
        simulator,
      )
      assignment.elevator.parkingTimeoutAt = null
      this.assignMandatoryPickup(
        simulator,
        assignment.elevator,
        assignment.call,
      )
    }
  }

  private assignCallsAtCurrentDoors(
    simulator: Simulator,
    waitingCalls: readonly HallCall[],
  ): void {
    for (const call of waitingCalls) {
      let elevator: Elevator | undefined
      for (const candidate of simulator.state.elevators.values()) {
        if (
          candidate.currentFloor === call.floor &&
          candidate.direction === call.direction &&
          ['opening-doors', 'doors-open', 'closing-doors'].includes(candidate.state) &&
          this.servesCall(simulator, candidate, call) &&
          (elevator === undefined || candidate.id < elevator.id)
        ) elevator = candidate
      }

      if (elevator === undefined) continue

      const freePlaces = this.availablePlacesAtFloor(simulator, elevator, call.floor)
      if (freePlaces <= 0) continue

      call.status = 'assigned'
      this.untrackWaitingCall(call)
      call.assignedElevatorId = elevator.id
      elevator.assignedCallIds.push(call.id)

      if (elevator.state === 'doors-open') {
        this.cancelDoorClosing(simulator, elevator.id)
        this.planAdditionalBoarding(simulator, elevator, call)
      } else if (elevator.state === 'closing-doors') {
        this.cancelDoorClosing(simulator, elevator.id)
        elevator.state = 'opening-doors'
        const openingStartedAt = simulator.state.currentTime
        simulator.scheduleOwned(
          this.systemEvent(
            this.afterSeconds(
              simulator.state.currentTime,
              this.timing.doorOperationSeconds,
            ),
            'elevator-doors-opened',
            elevator.id,
            { elevatorId: elevator.id, floor: elevator.currentFloor, visitId: this.activeVisitIds.get(elevator.id), openingStartedAt } satisfies DoorsOpenedPayload,
          ),
        )
      }
    }
  }

  private planAdditionalBoarding(
    simulator: Simulator,
    elevator: Elevator,
    call: HallCall,
  ): void {
    let transferTime =
      elevator.doorServiceEndsAt !== null &&
      elevator.doorServiceEndsAt > simulator.state.currentTime
        ? elevator.doorServiceEndsAt
        : simulator.state.currentTime
    const freePlaces = this.availablePlacesAtFloor(simulator, elevator, elevator.currentFloor)
    const pending = new Set(elevator.pendingBoardingEmployeeIds)
    const employees = call.waitingEmployeeIds
      .filter((employeeId) => !pending.has(employeeId))
      .filter((employeeId) => this.servesEmployee(simulator, elevator, employeeId, call.floor))
      .slice(0, freePlaces)

    for (const employeeId of employees) {
      transferTime = this.afterSeconds(transferTime, this.timing.passengerTransferSeconds)
      elevator.pendingBoardingEmployeeIds.push(employeeId)
      simulator.scheduleOwned(
        this.employeeEvent(transferTime, 'passenger-entered', employeeId, {
          employeeId,
          elevatorId: elevator.id,
          callId: call.id,
        } satisfies PassengerEnteredPayload),
      )
      simulator.scheduleOwned(
        this.systemEvent(transferTime, 'hall-call-updated', call.id, {
          callId: call.id,
        } satisfies HallCallUpdatedPayload),
      )
    }

    elevator.doorServiceEndsAt = transferTime
    this.scheduleDoorClosing(simulator, elevator, transferTime)
  }

  private availablePlacesAtFloor(
    simulator: Simulator,
    elevator: Elevator,
    floor: Floor,
  ): number {
    const available = elevator.capacity -
      elevator.passengerIds.length -
      elevator.pendingBoardingEmployeeIds.length +
      elevator.passengerIds.filter(
        (employeeId) => simulator.state.employees.get(employeeId)?.targetFloor === floor,
      ).length
    if (this.strategy !== 'hybrid' || available <= 0) return available
    return Math.max(0, available - this.reservedPlacesForOlderCall(simulator, elevator, floor))
  }

  private reservedPlacesForOlderCall(
    simulator: Simulator,
    elevator: Elevator,
    floor: Floor,
  ): number {
    if (elevator.direction === 'idle') return 0
    const assigned = elevator.assignedCallIds
      .map((callId) => simulator.state.hallCalls.get(callId))
      .filter((call): call is HallCall => call !== undefined && call.status === 'assigned' && call.direction === elevator.direction && call.waitingEmployeeIds.length > 0)
    const currentOldest = assigned
      .filter((call) => call.floor === floor)
      .reduce((oldest, call) => Math.min(oldest, call.createdAt), Number.POSITIVE_INFINITY)
    const olderAhead = assigned
      .filter((call) => {
        const ahead = elevator.direction === 'up' ? call.floor > floor : call.floor < floor
        return ahead && call.createdAt < currentOldest
      })
      .sort((first, second) => first.createdAt - second.createdAt || first.id - second.id)[0]
    return olderAhead === undefined ? 0 : Math.min(elevator.capacity, olderAhead.waitingEmployeeIds.length)
  }

  private cancelDoorClosing(simulator: Simulator, elevatorId: ElevatorId): void {
    simulator.cancelScheduledKinds(
      ['elevator-doors-closing-started', 'elevator-doors-closed'],
      elevatorId,
    )
  }

  private assignPassingCalls(
    simulator: Simulator,
    waitingCalls: readonly HallCall[],
  ): void {
    for (const call of waitingCalls) {
      if (call.status !== 'waiting') continue
      let elevator: Elevator | undefined
      for (const candidate of simulator.state.elevators.values()) {
        if (
          this.canPickUpOnCurrentMovement(candidate, call, simulator.state.currentTime) &&
          this.servesCall(simulator, candidate, call) &&
          (elevator === undefined || candidate.id < elevator.id)
        ) elevator = candidate
      }
      if (elevator === undefined) continue
      call.status = 'assigned'
      this.untrackWaitingCall(call)
      call.assignedElevatorId = elevator.id
      elevator.assignedCallIds.push(call.id)

      if (!elevator.scheduledStops.includes(call.floor)) {
        elevator.scheduledStops.push(call.floor)
      }

      const movement = elevator.movement!
      const targetIsBeforeCurrent =
        elevator.direction === 'up'
          ? call.floor < movement.toFloor
          : call.floor > movement.toFloor

      if (targetIsBeforeCurrent) {
        const passTime = this.projectedPassTime(elevator, call.floor)
        simulator.cancelScheduledKinds(['elevator-doors-opened'], elevator.id)
        movement.toFloor = call.floor
        movement.arrivesAt = passTime
        simulator.scheduleOwned(
          this.systemEvent(
            this.afterSeconds(passTime, this.timing.doorOperationSeconds),
            'elevator-doors-opened',
            elevator.id,
            {
              elevatorId: elevator.id,
              floor: call.floor,
              visitId: this.activeVisitIds.get(elevator.id),
              openingStartedAt: passTime,
              movement: {
                fromFloor: movement.fromFloor,
                toFloor: call.floor,
                startedAt: movement.startedAt,
                endedAt: passTime,
                passengerCount: elevator.passengerIds.length,
              },
            } satisfies DoorsOpenedPayload,
          ),
        )
      }
    }
  }

  private canPickUpOnCurrentMovement(
    elevator: Elevator,
    call: HallCall,
    now: SimulationTick,
  ): boolean {
    if (
      this.parkingMoving.has(elevator.id) ||
      elevator.state !== 'moving' ||
      elevator.mandatoryCallId !== null ||
      elevator.movement === null ||
      elevator.direction !== call.direction
    ) {
      return false
    }

    const ahead =
      elevator.direction === 'up'
        ? call.floor > elevator.movement.fromFloor
        : call.floor < elevator.movement.fromFloor

    return ahead && now < this.projectedPassTime(elevator, call.floor)
  }

  private projectedPassTime(elevator: Elevator, floor: Floor): SimulationTick {
    const movement = elevator.movement!
    const floorsToCall = floorDistance(floor, movement.fromFloor)

    if (floor === movement.toFloor) return movement.arrivesAt

    return this.afterSeconds(
      movement.startedAt,
      movementTime(floorsToCall, this.timing),
    )
  }

  private chooseNearestAssignment(
    elevators: readonly Elevator[],
    calls: readonly HallCall[],
    now: SimulationTick,
    simulator: Simulator,
  ): { elevator: Elevator; call: HallCall } {
    const fifoCalls = this.strategy === 'global-fifo'
      ? calls
      : this.strategy === 'hybrid'
        ? calls.filter((call) => now - call.createdAt >= secondsToTicks(HYBRID_FIFO_AFTER_SECONDS))
        : []
    if (fifoCalls.length > 0) return this.chooseOldestAssignment(elevators, fifoCalls, simulator)
    let minimumDistance = Number.POSITIVE_INFINITY
    let oldestTime = Number.POSITIVE_INFINITY
    let oldest: Array<{ elevator: Elevator; call: HallCall; distance: number }> = []
    for (const elevator of elevators) {
      for (const call of calls) {
        if (!this.servesCall(simulator, elevator, call)) continue
        const candidate = {
          elevator,
          call,
          distance: floorDistance(elevator.currentFloor, call.floor),
        }
        if (candidate.distance < minimumDistance) {
          minimumDistance = candidate.distance
          oldestTime = call.createdAt
          oldest = [candidate]
        } else if (candidate.distance === minimumDistance) {
          if (call.createdAt < oldestTime) {
            oldestTime = call.createdAt
            oldest = [candidate]
          } else if (call.createdAt === oldestTime) oldest.push(candidate)
        }
      }
    }
    oldest.sort(
        (first, second) =>
          first.call.id - second.call.id ||
          first.elevator.id - second.elevator.id,
      )

    return oldest.length === 1 ? oldest[0] : this.random.choose(oldest)
  }

  private chooseOldestAssignment(
    elevators: readonly Elevator[],
    calls: readonly HallCall[],
    simulator: Simulator,
  ): { elevator: Elevator; call: HallCall } {
    const call = [...calls].filter((candidate) => elevators.some((elevator) => this.servesCall(simulator, elevator, candidate))).sort(
      (first, second) => first.createdAt - second.createdAt || first.id - second.id,
    )[0]
    const compatible = elevators.filter((elevator) => this.servesCall(simulator, elevator, call))
    const distance = Math.min(...compatible.map((elevator) => floorDistance(elevator.currentFloor, call.floor)))
    const nearest = compatible
      .filter((elevator) => floorDistance(elevator.currentFloor, call.floor) === distance)
      .sort((first, second) => first.id - second.id)
    return { elevator: nearest.length === 1 ? nearest[0] : this.random.choose(nearest), call }
  }

  private assignMandatoryPickup(
    simulator: Simulator,
    elevator: Elevator,
    call: HallCall,
  ): void {
    call.status = 'assigned'
    this.untrackWaitingCall(call)
    call.assignedElevatorId = elevator.id
    elevator.assignedCallIds.push(call.id)
    elevator.mandatoryCallId = call.id
    elevator.direction = call.direction

    const distance = floorDistance(elevator.currentFloor, call.floor)
    const travelSeconds = distance === 0 ? 0 : movementTime(distance, this.timing)
    const movementEndsAt = this.afterSeconds(simulator.state.currentTime, travelSeconds)
    const arrivalTime = this.afterSeconds(movementEndsAt, this.timing.doorOperationSeconds)

    elevator.state = distance === 0 ? 'opening-doors' : 'moving'
    elevator.movement =
      distance === 0
        ? null
        : {
            fromFloor: elevator.currentFloor,
            toFloor: call.floor,
            startedAt: simulator.state.currentTime,
            arrivesAt: movementEndsAt,
          }
    const visitId = this.nextVisitId++
    this.activeVisitIds.set(elevator.id, visitId)
    simulator.scheduleOwned(
      this.systemEvent(arrivalTime, 'elevator-doors-opened', elevator.id, {
        elevatorId: elevator.id,
        floor: call.floor,
        visitId,
        openingStartedAt: movementEndsAt,
        movement: distance === 0 ? undefined : {
          fromFloor: elevator.currentFloor,
          toFloor: call.floor,
          startedAt: simulator.state.currentTime,
          endedAt: movementEndsAt,
          passengerCount: elevator.passengerIds.length,
        },
      } satisfies DoorsOpenedPayload),
    )
  }

  private planOpenDoorStop(
    simulator: Simulator,
    payload: DoorsOpenedPayload,
  ): void {
    const elevator = simulator.state.elevators.get(payload.elevatorId)!
    elevator.movement = null
    elevator.scheduledStops = elevator.scheduledStops.filter(
      (floor) => floor !== payload.floor,
    )

    if (elevator.mandatoryCallId !== null) {
      const mandatoryCall = simulator.state.hallCalls.get(elevator.mandatoryCallId)
      if (mandatoryCall?.floor === payload.floor) elevator.mandatoryCallId = null
    }
    const exitingIds = elevator.passengerIds
      .filter(
        (employeeId) =>
          simulator.state.employees.get(employeeId)?.targetFloor === payload.floor,
      )
      .sort((first, second) => first - second)

    this.claimOppositeCallAtTurnaround(simulator, elevator, exitingIds)

    let transferTime = simulator.state.currentTime

    for (const employeeId of exitingIds) {
      transferTime = this.afterSeconds(
        transferTime,
        this.timing.passengerTransferSeconds,
      )
      simulator.scheduleOwned(
        this.employeeEvent(transferTime, 'passenger-exited', employeeId, {
          employeeId,
          elevatorId: elevator.id,
        } satisfies PassengerExitedPayload),
      )
    }

    const callsAtFloor = elevator.assignedCallIds
      .map((callId) => simulator.state.hallCalls.get(callId)!)
      .filter(
        (call) =>
          call.floor === payload.floor && call.direction === elevator.direction,
      )
      .sort((first, second) => first.createdAt - second.createdAt || first.id - second.id)
    const availablePlaces =
      elevator.capacity - (elevator.passengerIds.length - exitingIds.length)
    const boarding: Array<{ employeeId: EmployeeId; call: HallCall }> = []

    for (const call of callsAtFloor) {
      for (const employeeId of call.waitingEmployeeIds) {
        if (!this.servesEmployee(simulator, elevator, employeeId, call.floor)) continue
        if (boarding.length >= availablePlaces) {
          break
        }

        boarding.push({ employeeId, call })
      }
    }

    for (const { employeeId, call } of boarding) {
      transferTime = this.afterSeconds(
        transferTime,
        this.timing.passengerTransferSeconds,
      )
      elevator.pendingBoardingEmployeeIds.push(employeeId)
      simulator.scheduleOwned(
        this.employeeEvent(transferTime, 'passenger-entered', employeeId, {
          employeeId,
          elevatorId: elevator.id,
          callId: call.id,
        } satisfies PassengerEnteredPayload),
      )
      simulator.scheduleOwned(
        this.systemEvent(transferTime, 'hall-call-updated', call.id, {
          callId: call.id,
        } satisfies HallCallUpdatedPayload),
      )
    }
    elevator.doorServiceEndsAt = transferTime
    this.scheduleDoorClosing(simulator, elevator, transferTime)
  }

  private claimOppositeCallAtTurnaround(
    simulator: Simulator,
    elevator: Elevator,
    exitingIds: readonly EmployeeId[],
  ): void {
    if (elevator.direction === 'idle') return

    const leaving = new Set(exitingIds)
    const hasPassengerAhead = elevator.passengerIds.some((employeeId) => {
      if (leaving.has(employeeId)) return false
      const target = simulator.state.employees.get(employeeId)?.targetFloor
      if (target === null || target === undefined) return false
      return elevator.direction === 'up'
        ? target > elevator.currentFloor
        : target < elevator.currentFloor
    })
    const hasAssignedCallAhead = elevator.assignedCallIds.some((callId) => {
      const call = simulator.state.hallCalls.get(callId)
      if (
        call === undefined ||
        call.status !== 'assigned' ||
        call.direction !== elevator.direction
      ) return false
      return elevator.direction === 'up'
        ? call.floor >= elevator.currentFloor
        : call.floor <= elevator.currentFloor
    })

    if (hasPassengerAhead || hasAssignedCallAhead) return

    const oppositeDirection = elevator.direction === 'up' ? 'down' : 'up'
    this.initializeWaitingCallIndex(simulator)
    const oppositeCall = this.waitingCallsByFloorDirection.get(
      this.waitingGroupKey(elevator.currentFloor, oppositeDirection),
    )?.[0]

    if (oppositeCall === undefined || !this.servesCall(simulator, elevator, oppositeCall)) return

    oppositeCall.status = 'assigned'
    this.untrackWaitingCall(oppositeCall)
    oppositeCall.assignedElevatorId = elevator.id
    elevator.assignedCallIds.push(oppositeCall.id)
    elevator.direction = oppositeDirection
  }

  private scheduleDoorClosing(
    simulator: Simulator,
    elevator: Elevator,
    serviceEndsAt: SimulationTick,
  ): void {
    const closingStartedAt = this.afterSeconds(serviceEndsAt, this.timing.openDoorDwellSeconds)
    const closedAt = this.afterSeconds(closingStartedAt, this.timing.doorOperationSeconds)
    const visitId = this.activeVisitIds.get(elevator.id)
    simulator.scheduleOwned(this.systemEvent(closingStartedAt, 'elevator-doors-closing-started', elevator.id, { elevatorId: elevator.id, visitId } satisfies ElevatorPayload))
    simulator.scheduleOwned(this.systemEvent(closedAt, 'elevator-doors-closed', elevator.id, { elevatorId: elevator.id, visitId } satisfies ElevatorPayload))
  }

  private completePendingBoarding(
    simulator: Simulator,
    payload: PassengerEnteredPayload,
  ): void {
    const elevator = simulator.state.elevators.get(payload.elevatorId)!
    elevator.pendingBoardingEmployeeIds = elevator.pendingBoardingEmployeeIds.filter(
      (employeeId) => employeeId !== payload.employeeId,
    )
  }

  private registerPassengerDestination(
    simulator: Simulator,
    payload: PassengerEnteredPayload,
  ): void {
    const elevator = simulator.state.elevators.get(payload.elevatorId)!
    const employee = simulator.state.employees.get(payload.employeeId)!

    if (
      employee.targetFloor !== null &&
      !elevator.scheduledStops.includes(employee.targetFloor)
    ) {
      elevator.scheduledStops.push(employee.targetFloor)
    }
  }

  private completeCurrentStop(
    simulator: Simulator,
    payload: PassengerExitedPayload,
  ): void {
    const elevator = simulator.state.elevators.get(payload.elevatorId)!
    const stillNeeded = elevator.passengerIds.some(
      (employeeId) =>
        simulator.state.employees.get(employeeId)?.targetFloor ===
        elevator.currentFloor,
    )

    if (!stillNeeded) {
      elevator.scheduledStops = elevator.scheduledStops.filter(
        (floor) => floor !== elevator.currentFloor,
      )
    }
  }

  private releaseServedCall(
    simulator: Simulator,
    payload: HallCallUpdatedPayload,
  ): void {
    const call = simulator.state.hallCalls.get(payload.callId)!

    if (call.status !== 'served') {
      return
    }

    this.untrackWaitingCall(call)

    for (const elevator of simulator.state.elevators.values()) {
      elevator.assignedCallIds = elevator.assignedCallIds.filter(
        (callId) => callId !== call.id,
      )
    }
  }

  private continueElevatorRoute(
    simulator: Simulator,
    payload: ElevatorPayload,
  ): void {
    const elevator = simulator.state.elevators.get(payload.elevatorId)!
    elevator.doorServiceEndsAt = null

    const residualCalls = elevator.assignedCallIds
      .map((callId) => simulator.state.hallCalls.get(callId)!)
      .filter(
        (call) =>
          call.floor === elevator.currentFloor &&
          call.waitingEmployeeIds.length > 0,
      )

    for (const call of residualCalls) {
      simulator.scheduleOwned(
        this.systemEvent(
          addTicks(simulator.state.currentTime, secondsToTicks(0.1)),
          'hall-call-reactivated',
          call.id,
          { callId: call.id } satisfies HallCallUpdatedPayload,
        ),
      )
    }

    if (elevator.state === 'idle-closed') {
      this.requestDispatchIfNeeded(simulator, elevator.id)
      this.armParkingIfNeeded(simulator, elevator)
      return
    }

    const target = this.nextStop(elevator)

    if (target === null) {
      elevator.state = 'idle-closed'
      elevator.direction = 'idle'
      this.requestDispatchIfNeeded(simulator, elevator.id)
      return
    }

    const distance = floorDistance(target, elevator.currentFloor)
    const movementEndsAt = this.afterSeconds(
      simulator.state.currentTime,
      movementTime(distance, this.timing),
    )
    const arrivalTime = this.afterSeconds(movementEndsAt, this.timing.doorOperationSeconds)
    elevator.movement = {
      fromFloor: elevator.currentFloor,
      toFloor: target,
      startedAt: simulator.state.currentTime,
      arrivesAt: movementEndsAt,
    }
    const visitId = this.nextVisitId++
    this.activeVisitIds.set(elevator.id, visitId)
    simulator.scheduleOwned(
      this.systemEvent(arrivalTime, 'elevator-doors-opened', elevator.id, {
        elevatorId: elevator.id,
        floor: target,
        visitId,
        openingStartedAt: movementEndsAt,
        movement: {
          fromFloor: elevator.currentFloor,
          toFloor: target,
          startedAt: simulator.state.currentTime,
          endedAt: movementEndsAt,
          passengerCount: elevator.passengerIds.length,
        },
      } satisfies DoorsOpenedPayload),
    )
  }

  private refreshParkingRule(simulator: Simulator, payload: ElevatorPayload): void {
    const elevator = simulator.state.elevators.get(payload.elevatorId)!
    elevator.parkingTimeoutAt = null
    elevator.parkingFloor = this.activeParkingFloor(elevator.id, simulator.state.currentTime)
    if (elevator.state === 'idle-closed') this.armParkingIfNeeded(simulator, elevator)
  }

  private armParkingIfNeeded(simulator: Simulator, elevator: Elevator): void {
    const config = this.parking.find((item) => item.elevatorId === elevator.id)
    const floor = this.activeParkingFloor(elevator.id, simulator.state.currentTime)
    elevator.parkingFloor = floor
    if (config === undefined || floor === null || floor === elevator.currentFloor || elevator.state !== 'idle-closed') return
    const at = this.afterSeconds(simulator.state.currentTime, config.timeoutSeconds)
    elevator.parkingTimeoutAt = at
    simulator.scheduleOwned(this.systemEvent(at, 'parking-timeout', elevator.id, { elevatorId: elevator.id } satisfies ElevatorPayload))
  }

  private handleParkingTimeout(simulator: Simulator, payload: ElevatorPayload): void {
    const elevator = simulator.state.elevators.get(payload.elevatorId)!
    if (elevator.state !== 'idle-closed' || elevator.parkingTimeoutAt !== simulator.state.currentTime) return
    elevator.parkingTimeoutAt = null
    if (this.hasWaitingCalls(simulator)) { this.requestDispatchIfNeeded(simulator, elevator.id); return }
    this.startParkingStep(simulator, elevator)
  }

  private startParkingStep(simulator: Simulator, elevator: Elevator): void {
    const target = this.activeParkingFloor(elevator.id, simulator.state.currentTime)
    elevator.parkingFloor = target
    if (target === null || target === elevator.currentFloor) return
    const nextFloor = elevator.currentFloor + Math.sign(target - elevator.currentFloor)
    const startedAt = simulator.state.currentTime
    const arrivesAt = this.afterSeconds(startedAt, movementTime(1, this.timing))
    elevator.state = 'moving'; elevator.direction = nextFloor > elevator.currentFloor ? 'up' : 'down'
    this.parkingMoving.add(elevator.id)
    elevator.movement = { fromFloor: elevator.currentFloor, toFloor: nextFloor, startedAt, arrivesAt }
    simulator.scheduleOwned(this.systemEvent(arrivesAt, 'parking-step-arrived', elevator.id, {
      elevatorId: elevator.id, targetFloor: nextFloor, finalParkingFloor: target,
      movement: { fromFloor: elevator.currentFloor, toFloor: nextFloor, startedAt, arrivesAt, passengerCount: 0 },
    } satisfies ParkingStepPayload))
  }

  private continueAfterParkingStep(simulator: Simulator, payload: ParkingStepPayload): void {
    const elevator = simulator.state.elevators.get(payload.elevatorId)!
    this.parkingMoving.delete(elevator.id)
    const hasWork = this.hasWaitingCalls(simulator)
    if (hasWork) { this.requestDispatchIfNeeded(simulator, elevator.id); return }
    // Continue only after work events and dispatching at this exact tick have run.
    elevator.parkingTimeoutAt = simulator.state.currentTime
    simulator.scheduleOwned(this.systemEvent(simulator.state.currentTime, 'parking-timeout', elevator.id, { elevatorId: elevator.id } satisfies ElevatorPayload))
  }

  private activeParkingFloor(elevatorId: ElevatorId, tick: SimulationTick): Floor | null {
    const minute = tick / 600
    const config = this.parking.find((item) => item.elevatorId === elevatorId)
    return config?.intervals.find((interval) => minute >= interval.startMinute && minute < interval.endMinute)?.floor ?? null
  }

  private requestDispatchIfNeeded(
    simulator: Simulator,
    elevatorId: ElevatorId,
  ): void {
    const hasWaitingCalls = this.hasWaitingCalls(simulator)

    if (hasWaitingCalls) {
      simulator.scheduleOwned(
        this.systemEvent(simulator.state.currentTime, 'dispatch-requested', elevatorId, null),
      )
    }
  }

  private initializeWaitingCallIndex(simulator: Simulator): void {
    if (this.waitingCallIndexInitialized) return
    for (const call of simulator.state.hallCalls.values()) {
      if (call.status === 'waiting') this.insertWaitingCall(call)
    }
    this.waitingCallIndexInitialized = true
  }

  private trackWaitingCall(simulator: Simulator, callId: number): void {
    this.initializeWaitingCallIndex(simulator)
    const call = simulator.state.hallCalls.get(callId)
    if (call?.status === 'waiting') this.insertWaitingCall(call)
  }

  private waitingCalls(simulator: Simulator): HallCall[] {
    this.initializeWaitingCallIndex(simulator)
    const calls: HallCall[] = []
    for (const callId of this.waitingCallIds) {
      const call = simulator.state.hallCalls.get(callId)
      if (call?.status === 'waiting') calls.push(call)
      else if (call !== undefined) this.untrackWaitingCall(call)
      else this.waitingCallIds.delete(callId)
    }
    return calls
  }

  private hasWaitingCalls(simulator: Simulator): boolean {
    this.initializeWaitingCallIndex(simulator)
    for (const callId of this.waitingCallIds) {
      const call = simulator.state.hallCalls.get(callId)
      if (call?.status === 'waiting') return true
      if (call !== undefined) this.untrackWaitingCall(call)
      else this.waitingCallIds.delete(callId)
    }
    return false
  }

  private nearestAssignmentCandidates(simulator: Simulator): HallCall[] {
    this.initializeWaitingCallIndex(simulator)
    return [...this.waitingCallsByFloorDirection.values()]
      .flatMap((calls) => {
        const oldestTime = calls[0]?.createdAt
        return calls.filter((call) => call.createdAt === oldestTime)
      })
      .filter((call): call is HallCall => call?.status === 'waiting')
  }

  private waitingGroupKey(floor: Floor, direction: HallCall['direction']): string {
    return `${floor}:${direction}`
  }

  private insertWaitingCall(call: HallCall): void {
    if (this.waitingCallIds.has(call.id)) return
    this.waitingCallIds.add(call.id)
    const key = this.waitingGroupKey(call.floor, call.direction)
    const calls = this.waitingCallsByFloorDirection.get(key) ?? []
    const position = calls.findIndex(
      (candidate) =>
        candidate.createdAt > call.createdAt ||
        (candidate.createdAt === call.createdAt && candidate.id > call.id),
    )
    if (position === -1) calls.push(call)
    else calls.splice(position, 0, call)
    this.waitingCallsByFloorDirection.set(key, calls)
  }

  private untrackWaitingCall(call: HallCall): void {
    if (!this.waitingCallIds.delete(call.id)) return
    const key = this.waitingGroupKey(call.floor, call.direction)
    const calls = this.waitingCallsByFloorDirection.get(key)
    if (calls === undefined) return
    const position = calls.findIndex((candidate) => candidate.id === call.id)
    if (position !== -1) calls.splice(position, 1)
    if (calls.length === 0) this.waitingCallsByFloorDirection.delete(key)
  }

  private nextStop(elevator: Elevator): Floor | null {
    const stops = [...elevator.scheduledStops]

    if (stops.length === 0) {
      return null
    }

    if (elevator.direction === 'up') {
      const above = stops.filter((floor) => floor > elevator.currentFloor)
      if (above.length > 0) return Math.min(...above)
      elevator.direction = 'down'
      return Math.max(...stops)
    }

    if (elevator.direction === 'down') {
      const below = stops.filter((floor) => floor < elevator.currentFloor)
      if (below.length > 0) return Math.max(...below)
      elevator.direction = 'up'
      return Math.min(...stops)
    }

    throw new Error(`Лифт ${elevator.id} имеет остановки, но не имеет направления`)
  }

  private afterSeconds(time: SimulationTick, seconds: number): SimulationTick {
    return addTicks(time, secondsToTicks(seconds))
  }

  private systemEvent<T>(
    time: SimulationTick,
    kind: SimulationEvent['kind'],
    subjectId: number,
    payload: T,
  ): SimulationEvent<T> {
    return { time, kind, subjectId, employeeIdForOrdering: null, payload }
  }

  private employeeEvent<T>(
    time: SimulationTick,
    kind: 'passenger-entered' | 'passenger-exited',
    employeeId: EmployeeId,
    payload: T,
  ): SimulationEvent<T> {
    return {
      time,
      kind,
      subjectId: employeeId,
      employeeIdForOrdering: employeeId,
      payload,
    }
  }
}
