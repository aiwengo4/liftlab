import { floorDistance, type ElevatorId, type Floor, type SimulationEvent, type TravelDirection } from './domain'
import type { DoorsOpenedPayload, ElevatorPayload, HallCallCreatedPayload, HallCallJoinedPayload, ParkingStepPayload, PassengerEnteredPayload, PassengerExitedPayload } from './simulator'
import { ticksToSeconds, type SimulationTick } from './time'

export interface ElevatorMetricDescriptor {
  readonly id: ElevatorId
  readonly capacity: number
}

export interface OperationalMetricsWindow {
  readonly startAt: SimulationTick
  readonly endAt: SimulationTick
}

export interface TimeUseMetric {
  readonly passengerMovementSeconds: number
  readonly stopServiceSeconds: number
  readonly emptyMovementSeconds: number
  readonly idleSeconds: number
  readonly passengerMovementShare: number
  readonly stopServiceShare: number
  readonly emptyMovementShare: number
  readonly idleShare: number
}

export interface CabinLoadMetric {
  /** Time-weighted over all movement, including empty movement. */
  readonly averagePassengers: number | null
  readonly maximumPassengers: number
  readonly averageCapacityShare: number | null
  readonly maximumCapacityShare: number
}

export interface ElevatorResourceMetric {
  readonly floorsTravelled: number
  readonly emptyFloorsTravelled: number
  readonly stops: number
  readonly doorOpeningCycles: number
  readonly transportedPassengers: number
  readonly passengersPerStop: number | null
}

export interface ElevatorOperationalMetric {
  readonly elevatorId: ElevatorId
  readonly capacity: number
  readonly timeUse: TimeUseMetric
  readonly load: CabinLoadMetric
  readonly resource: ElevatorResourceMetric
}

export interface ElevatorGroupOperationalMetric {
  readonly elevatorCount: number
  readonly timeUse: TimeUseMetric
  readonly load: CabinLoadMetric
  readonly resource: ElevatorResourceMetric
}

export interface QueueLocationMaximum {
  readonly floor: Floor
  readonly direction: TravelDirection
  readonly count: number
}

export interface QueueOperationalMetric {
  readonly maximumWaitingInBuilding: number
  readonly maximumAtFloorAndDirection: QueueLocationMaximum | null
}

export interface OperationalMetrics {
  readonly window: OperationalMetricsWindow
  readonly queue: QueueOperationalMetric
  readonly elevators: readonly ElevatorOperationalMetric[]
  readonly group: ElevatorGroupOperationalMetric
}

interface MovementRecord {
  readonly elevatorId: ElevatorId
  readonly startAt: SimulationTick
  readonly endAt: SimulationTick
  readonly fromFloor: Floor
  readonly toFloor: Floor
  readonly passengerCount: number
}

interface VisitRecord {
  readonly elevatorId: ElevatorId
  readonly visitId: number
  startAt: SimulationTick
  endAt: SimulationTick | null
  openingCycleStarts: SimulationTick[]
}

export function calculateOperationalMetrics(
  events: readonly SimulationEvent[],
  elevators: readonly ElevatorMetricDescriptor[],
  window: OperationalMetricsWindow,
): OperationalMetrics {
  validateInputs(events, elevators, window)
  const ordered = events
    .map((event, index) => ({ event, index }))
    .sort((first, second) => first.event.time - second.event.time || first.index - second.index)
    .map(({ event }) => event)
  const descriptorById = new Map(elevators.map((elevator) => [elevator.id, elevator]))
  const movements: MovementRecord[] = []
  const visits = new Map<string, VisitRecord>()
  const occupancy = new Map(elevators.map((elevator) => [elevator.id, 0]))
  const maximumOccupancy = new Map(elevators.map((elevator) => [elevator.id, 0]))
  const transported = new Map(elevators.map((elevator) => [elevator.id, 0]))
  const calls = new Map<number, { floor: Floor; direction: TravelDirection; waiting: number }>()
  const earlyCreatedCallIds = new Set<number>()
  const waitingByLocation = new Map<string, QueueLocationMaximum>()
  let waitingInBuilding = 0
  let maximumWaitingInBuilding = 0
  let maximumAtFloorAndDirection: QueueLocationMaximum | null = null
  let baselineCaptured = false

  const captureStableState = (): void => {
    for (const [elevatorId, count] of occupancy) {
      if (count < 0 || count > descriptorById.get(elevatorId)!.capacity) throw new Error(`Некорректная загрузка лифта ${elevatorId} в журнале`)
      maximumOccupancy.set(elevatorId, Math.max(maximumOccupancy.get(elevatorId)!, count))
    }
    maximumWaitingInBuilding = Math.max(maximumWaitingInBuilding, waitingInBuilding)
    for (const candidate of waitingByLocation.values()) {
      if (candidate.count > 0 && betterQueueMaximum(candidate, maximumAtFloorAndDirection)) maximumAtFloorAndDirection = candidate
    }
  }

  for (let index = 0; index < ordered.length;) {
    const time = ordered[index].time
    if (!baselineCaptured && time > window.startAt) {
      captureStableState()
      baselineCaptured = true
    }
    let next = index
    while (next < ordered.length && ordered[next].time === time) {
      const event = ordered[next]
      switch (event.kind) {
        case 'hall-call-created': {
          const call = (event.payload as HallCallCreatedPayload).call
          if (earlyCreatedCallIds.delete(call.id)) break
          const previous = calls.get(call.id)
          if (previous !== undefined) {
            waitingInBuilding -= previous.waiting
            const previousKey = `${previous.floor}:${previous.direction}`
            const previousLocation = waitingByLocation.get(previousKey)!
            waitingByLocation.set(previousKey, {
              ...previousLocation,
              count: previousLocation.count - previous.waiting,
            })
          }
          const waiting = call.waitingEmployeeIds.length
          calls.set(call.id, { floor: call.floor, direction: call.direction, waiting })
          waitingInBuilding += waiting
          const key = `${call.floor}:${call.direction}`
          const current = waitingByLocation.get(key)
          waitingByLocation.set(key, {
            floor: call.floor,
            direction: call.direction,
            count: (current?.count ?? 0) + waiting,
          })
          break
        }
        case 'hall-call-joined': {
          const payload = event.payload as HallCallJoinedPayload
          let call = calls.get(payload.callId)
          if (call === undefined && payload.pendingCall !== undefined) {
            call = {
              floor: payload.pendingCall.floor,
              direction: payload.pendingCall.direction,
              waiting: payload.pendingCall.waitingEmployeeIds.length,
            }
            calls.set(payload.callId, call)
            earlyCreatedCallIds.add(payload.callId)
            waitingInBuilding += call.waiting
            const key = `${call.floor}:${call.direction}`
            const current = waitingByLocation.get(key)
            waitingByLocation.set(key, {
              floor: call.floor,
              direction: call.direction,
              count: (current?.count ?? 0) + call.waiting,
            })
          }
          if (call !== undefined) {
            call.waiting += 1
            waitingInBuilding += 1
            const key = `${call.floor}:${call.direction}`
            const current = waitingByLocation.get(key)!
            waitingByLocation.set(key, { ...current, count: current.count + 1 })
          }
          break
        }
        case 'passenger-entered': {
          const payload = event.payload as PassengerEnteredPayload
          requireElevator(descriptorById, payload.elevatorId)
          occupancy.set(payload.elevatorId, occupancy.get(payload.elevatorId)! + 1)
          const call = calls.get(payload.callId)
          if (call !== undefined && call.waiting > 0) {
            call.waiting -= 1
            waitingInBuilding -= 1
            const key = `${call.floor}:${call.direction}`
            const current = waitingByLocation.get(key)!
            waitingByLocation.set(key, { ...current, count: current.count - 1 })
          }
          break
        }
        case 'passenger-exited': {
          const payload = event.payload as PassengerExitedPayload
          requireElevator(descriptorById, payload.elevatorId)
          occupancy.set(payload.elevatorId, occupancy.get(payload.elevatorId)! - 1)
          if (time >= window.startAt && time < window.endAt) transported.set(payload.elevatorId, transported.get(payload.elevatorId)! + 1)
          break
        }
        case 'elevator-doors-opened': {
          const payload = event.payload as DoorsOpenedPayload
          requireElevator(descriptorById, payload.elevatorId)
          if (payload.visitId === undefined || payload.openingStartedAt === undefined) throw new Error('Журнал не содержит телеметрию физической остановки')
          const key = visitKey(payload.elevatorId, payload.visitId)
          const visit = visits.get(key)
          if (visit === undefined) visits.set(key, { elevatorId: payload.elevatorId, visitId: payload.visitId, startAt: payload.openingStartedAt, endAt: null, openingCycleStarts: [payload.openingStartedAt] })
          else {
            visit.startAt = Math.min(visit.startAt, payload.openingStartedAt) as SimulationTick
            visit.openingCycleStarts.push(payload.openingStartedAt)
          }
          if (payload.movement !== undefined) movements.push({ elevatorId: payload.elevatorId, startAt: payload.movement.startedAt, endAt: payload.movement.endedAt, fromFloor: payload.movement.fromFloor, toFloor: payload.movement.toFloor, passengerCount: payload.movement.passengerCount })
          break
        }
        case 'parking-step-arrived': {
          const payload = event.payload as ParkingStepPayload
          requireElevator(descriptorById, payload.elevatorId)
          movements.push({ elevatorId: payload.elevatorId, startAt: payload.movement.startedAt, endAt: payload.movement.arrivesAt, fromFloor: payload.movement.fromFloor, toFloor: payload.movement.toFloor, passengerCount: 0 })
          break
        }
        case 'elevator-doors-closed': {
          const payload = event.payload as ElevatorPayload
          if (payload.visitId === undefined) throw new Error('Журнал не содержит ID физической остановки')
          const visit = visits.get(visitKey(payload.elevatorId, payload.visitId))
          if (visit === undefined) throw new Error(`Закрытие дверей лифта ${payload.elevatorId} не связано с остановкой`)
          visit.endAt = time
          break
        }
        default:
          break
      }
      next += 1
    }
    if (time >= window.startAt && time < window.endAt) {
      captureStableState()
      baselineCaptured = true
    }
    index = next
  }
  if (!baselineCaptured) captureStableState()

  for (const visit of visits.values()) if (visit.endAt === null) throw new Error(`Остановка ${visit.visitId} лифта ${visit.elevatorId} не завершена`)
  const perElevator = [...elevators].sort((a, b) => a.id - b.id).map((descriptor) => buildElevatorMetric(
    descriptor,
    movements.filter((movement) => movement.elevatorId === descriptor.id),
    [...visits.values()].filter((visit) => visit.elevatorId === descriptor.id),
    maximumOccupancy.get(descriptor.id)!,
    transported.get(descriptor.id)!,
    window,
  ))

  return {
    window,
    queue: { maximumWaitingInBuilding, maximumAtFloorAndDirection },
    elevators: perElevator,
    group: buildGroupMetric(perElevator, window),
  }
}

function buildElevatorMetric(descriptor: ElevatorMetricDescriptor, movements: readonly MovementRecord[], visits: readonly VisitRecord[], maximumPassengers: number, transportedPassengers: number, window: OperationalMetricsWindow): ElevatorOperationalMetric {
  validateNonOverlappingTelemetry(movements, visits, window, descriptor.id)
  let passengerMovementSeconds = 0
  let emptyMovementSeconds = 0
  let passengerSeconds = 0
  let capacitySeconds = 0
  let floorsTravelled = 0
  let emptyFloorsTravelled = 0
  for (const movement of movements) {
    const seconds = clippedSeconds(movement.startAt, movement.endAt, window)
    if (seconds === 0) continue
    if (movement.passengerCount > 0) passengerMovementSeconds += seconds
    else emptyMovementSeconds += seconds
    passengerSeconds += movement.passengerCount * seconds
    capacitySeconds += descriptor.capacity * seconds
    const coveredShare = seconds / ticksToSeconds((movement.endAt - movement.startAt) as SimulationTick)
    const floors = floorDistance(movement.toFloor, movement.fromFloor) * coveredShare
    floorsTravelled += floors
    if (movement.passengerCount === 0) emptyFloorsTravelled += floors
  }
  const relevantVisits = visits.filter((visit) =>
    (visit.startAt < window.endAt && visit.endAt! > window.startAt) ||
    (visit.startAt === visit.endAt && visit.startAt >= window.startAt && visit.startAt < window.endAt),
  )
  const stopServiceSeconds = relevantVisits.reduce((sum, visit) => sum + clippedSeconds(visit.startAt, visit.endAt!, window), 0)
  const horizonSeconds = ticksToSeconds((window.endAt - window.startAt) as SimulationTick)
  const idleSeconds = Math.max(0, horizonSeconds - passengerMovementSeconds - emptyMovementSeconds - stopServiceSeconds)
  const movementSeconds = passengerMovementSeconds + emptyMovementSeconds
  const stops = relevantVisits.length
  return {
    elevatorId: descriptor.id,
    capacity: descriptor.capacity,
    timeUse: timeUse(passengerMovementSeconds, stopServiceSeconds, emptyMovementSeconds, idleSeconds, horizonSeconds),
    load: {
      averagePassengers: movementSeconds === 0 ? null : passengerSeconds / movementSeconds,
      maximumPassengers,
      averageCapacityShare: capacitySeconds === 0 ? null : passengerSeconds / capacitySeconds,
      maximumCapacityShare: maximumPassengers / descriptor.capacity,
    },
    resource: {
      floorsTravelled,
      emptyFloorsTravelled,
      stops,
      doorOpeningCycles: relevantVisits.reduce((sum, visit) => sum + visit.openingCycleStarts.filter((at) => at >= window.startAt && at < window.endAt).length, 0),
      transportedPassengers,
      passengersPerStop: stops === 0 ? null : transportedPassengers / stops,
    },
  }
}

function validateNonOverlappingTelemetry(movements: readonly MovementRecord[], visits: readonly VisitRecord[], window: OperationalMetricsWindow, elevatorId: ElevatorId): void {
  const intervals = [
    ...movements.map((movement) => ({ start: Math.max(movement.startAt, window.startAt), end: Math.min(movement.endAt, window.endAt) })),
    ...visits.map((visit) => ({ start: Math.max(visit.startAt, window.startAt), end: Math.min(visit.endAt!, window.endAt) })),
  ].filter((interval) => interval.end > interval.start).sort((first, second) => first.start - second.start || first.end - second.end)
  for (let index = 1; index < intervals.length; index += 1) {
    if (intervals[index].start < intervals[index - 1].end) throw new Error(`Телеметрия лифта ${elevatorId} содержит перекрывающиеся интервалы`)
  }
}

function buildGroupMetric(elevators: readonly ElevatorOperationalMetric[], window: OperationalMetricsWindow): ElevatorGroupOperationalMetric {
  const horizon = ticksToSeconds((window.endAt - window.startAt) as SimulationTick) * elevators.length
  const sumTime = (key: keyof Pick<TimeUseMetric, 'passengerMovementSeconds' | 'stopServiceSeconds' | 'emptyMovementSeconds' | 'idleSeconds'>) => elevators.reduce((sum, elevator) => sum + elevator.timeUse[key], 0)
  const passengerMovementSeconds = sumTime('passengerMovementSeconds')
  const stopServiceSeconds = sumTime('stopServiceSeconds')
  const emptyMovementSeconds = sumTime('emptyMovementSeconds')
  const idleSeconds = sumTime('idleSeconds')
  const movementSeconds = passengerMovementSeconds + emptyMovementSeconds
  const passengerSeconds = elevators.reduce((sum, elevator) => sum + (elevator.load.averagePassengers ?? 0) * (elevator.timeUse.passengerMovementSeconds + elevator.timeUse.emptyMovementSeconds), 0)
  const capacitySeconds = elevators.reduce((sum, elevator) => sum + elevator.capacity * (elevator.timeUse.passengerMovementSeconds + elevator.timeUse.emptyMovementSeconds), 0)
  const resource = elevators.reduce((total, elevator) => ({
    floorsTravelled: total.floorsTravelled + elevator.resource.floorsTravelled,
    emptyFloorsTravelled: total.emptyFloorsTravelled + elevator.resource.emptyFloorsTravelled,
    stops: total.stops + elevator.resource.stops,
    doorOpeningCycles: total.doorOpeningCycles + elevator.resource.doorOpeningCycles,
    transportedPassengers: total.transportedPassengers + elevator.resource.transportedPassengers,
  }), { floorsTravelled: 0, emptyFloorsTravelled: 0, stops: 0, doorOpeningCycles: 0, transportedPassengers: 0 })
  return {
    elevatorCount: elevators.length,
    timeUse: timeUse(passengerMovementSeconds, stopServiceSeconds, emptyMovementSeconds, idleSeconds, horizon),
    load: {
      averagePassengers: movementSeconds === 0 ? null : passengerSeconds / movementSeconds,
      maximumPassengers: Math.max(0, ...elevators.map((elevator) => elevator.load.maximumPassengers)),
      averageCapacityShare: capacitySeconds === 0 ? null : passengerSeconds / capacitySeconds,
      maximumCapacityShare: Math.max(0, ...elevators.map((elevator) => elevator.load.maximumCapacityShare)),
    },
    resource: { ...resource, passengersPerStop: resource.stops === 0 ? null : resource.transportedPassengers / resource.stops },
  }
}

function timeUse(passengerMovementSeconds: number, stopServiceSeconds: number, emptyMovementSeconds: number, idleSeconds: number, denominator: number): TimeUseMetric {
  return {
    passengerMovementSeconds, stopServiceSeconds, emptyMovementSeconds, idleSeconds,
    passengerMovementShare: passengerMovementSeconds / denominator,
    stopServiceShare: stopServiceSeconds / denominator,
    emptyMovementShare: emptyMovementSeconds / denominator,
    idleShare: idleSeconds / denominator,
  }
}

function clippedSeconds(startAt: SimulationTick, endAt: SimulationTick, window: OperationalMetricsWindow): number {
  const start = Math.max(startAt, window.startAt)
  const end = Math.min(endAt, window.endAt)
  return end <= start ? 0 : ticksToSeconds((end - start) as SimulationTick)
}

function betterQueueMaximum(candidate: QueueLocationMaximum, current: QueueLocationMaximum | null): boolean {
  if (current === null || candidate.count !== current.count) return current === null || candidate.count > current.count
  return candidate.floor < current.floor || (candidate.floor === current.floor && candidate.direction === 'up' && current.direction === 'down')
}

function visitKey(elevatorId: ElevatorId, visitId: number): string { return `${elevatorId}:${visitId}` }
function requireElevator(map: ReadonlyMap<ElevatorId, ElevatorMetricDescriptor>, elevatorId: ElevatorId): void {
  if (!map.has(elevatorId)) throw new Error(`Событие относится к неизвестному лифту ${elevatorId}`)
}
function validateInputs(events: readonly SimulationEvent[], elevators: readonly ElevatorMetricDescriptor[], window: OperationalMetricsWindow): void {
  if (!Number.isSafeInteger(window.startAt) || !Number.isSafeInteger(window.endAt) || window.startAt < 0 || window.endAt <= window.startAt) throw new RangeError('Окно операционных метрик задано некорректно')
  if (elevators.length === 0 || new Set(elevators.map((elevator) => elevator.id)).size !== elevators.length) throw new Error('Для операционных метрик нужен непустой список уникальных лифтов')
  for (const elevator of elevators) if (!Number.isSafeInteger(elevator.id) || !Number.isSafeInteger(elevator.capacity) || elevator.capacity < 1) throw new RangeError('Описание лифта для метрик задано некорректно')
  for (const event of events) if (!Number.isSafeInteger(event.time) || event.time < 0) throw new RangeError('Журнал содержит некорректное время события')
}
