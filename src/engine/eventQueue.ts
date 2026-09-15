import type { SimulationEvent, SimulationEventKind } from './domain'

const EVENT_PRIORITY: Readonly<Record<SimulationEventKind, number>> = {
  'elevator-doors-opened': 1,
  'passenger-exited': 2,
  'stairs-segment-completed': 2,
  'hall-call-created': 3,
  'hall-call-joined': 3,
  'journey-requested': 3,
  'passenger-entered': 4,
  'hall-call-updated': 5,
  'hall-call-reactivated': 5,
  'elevator-doors-closing-started': 6,
  'elevator-doors-closed': 6,
  'dispatch-requested': 7,
  'parking-timeout': 9,
  'parking-rule-boundary': 8,
  'parking-step-arrived': 1,
}

export function eventPriority(kind: SimulationEventKind): number {
  return EVENT_PRIORITY[kind]
}

interface QueuedEvent {
  readonly event: SimulationEvent
  readonly sequence: number
  readonly cancellationGeneration: number
}

interface CancellationState { generation: number; activeCount: number }

const INDEXED_CANCELLATION_KINDS = new Set<SimulationEventKind>([
  'elevator-doors-opened',
  'elevator-doors-closing-started',
  'elevator-doors-closed',
  'journey-requested',
])

const EMPLOYEE_ORDERED_EVENTS = new Set<SimulationEventKind>([
  'passenger-exited',
  'hall-call-created',
  'hall-call-joined',
  'passenger-entered',
  'journey-requested',
  'stairs-segment-completed',
])

function compareQueuedEvents(first: QueuedEvent, second: QueuedEvent): number {
  if (first.event.time !== second.event.time) {
    return first.event.time - second.event.time
  }

  const priorityDifference =
    eventPriority(first.event.kind) - eventPriority(second.event.kind)

  if (priorityDifference !== 0) {
    return priorityDifference
  }

  if (
    first.event.employeeIdForOrdering !== null &&
    second.event.employeeIdForOrdering !== null &&
    first.event.employeeIdForOrdering !== second.event.employeeIdForOrdering
  ) {
    return (
      first.event.employeeIdForOrdering - second.event.employeeIdForOrdering
    )
  }

  return first.sequence - second.sequence
}

export class EventQueue {
  private readonly heap: QueuedEvent[] = []
  private readonly cancellationStates = new Map<string, CancellationState>()
  private nextSequence = 0
  private liveSize = 0

  get size(): number {
    return this.liveSize
  }

  get isEmpty(): boolean {
    return this.liveSize === 0
  }

  enqueue(event: SimulationEvent): void {
    this.validateEvent(event)
    this.insert(structuredClone(event))
  }

  enqueueOwned(event: SimulationEvent): void {
    this.validateEvent(event)
    this.insert(event)
  }

  private validateEvent(event: SimulationEvent): void {
    if (!Number.isSafeInteger(event.time) || event.time < 0) {
      throw new RangeError('Метка времени события должна быть неотрицательным целым числом тиков')
    }

    if (!Number.isSafeInteger(event.subjectId) || event.subjectId < 0) {
      throw new RangeError('Идентификатор субъекта события должен быть неотрицательным целым числом')
    }

    if (
      event.employeeIdForOrdering !== null &&
      (!Number.isSafeInteger(event.employeeIdForOrdering) ||
        event.employeeIdForOrdering < 0)
    ) {
      throw new RangeError('ID сотрудника для сортировки должен быть безопасным неотрицательным целым числом')
    }

    const requiresEmployeeOrder = EMPLOYEE_ORDERED_EVENTS.has(event.kind)

    if (requiresEmployeeOrder && event.employeeIdForOrdering === null) {
      throw new Error(`Для события ${event.kind} должен быть указан ID сотрудника для сортировки`)
    }

    if (!requiresEmployeeOrder && event.employeeIdForOrdering !== null) {
      throw new Error(`Событие ${event.kind} не должно сортироваться по ID сотрудника`)
    }

  }

  private insert(event: SimulationEvent): void {
    const cancellationState = this.cancellationState(event.kind, event.subjectId)
    const queuedEvent = {
      event,
      sequence: this.nextSequence,
      cancellationGeneration: cancellationState?.generation ?? 0,
    }
    if (cancellationState !== undefined) cancellationState.activeCount += 1
    this.liveSize += 1
    this.nextSequence += 1
    this.heap.push(queuedEvent)
    this.bubbleUp(this.heap.length - 1)
  }

  peek(): SimulationEvent | undefined {
    this.discardCancelledRoots()
    const event = this.heap[0]?.event
    return event === undefined ? undefined : structuredClone(event)
  }

  nextTime(): SimulationEvent['time'] | undefined {
    this.discardCancelledRoots()
    return this.heap[0]?.event.time
  }

  dequeue(): SimulationEvent | undefined {
    const event = this.dequeueOwned()
    return event === undefined ? undefined : structuredClone(event)
  }

  /** Internal simulation hot path: transfers the queue-owned immutable snapshot. */
  dequeueOwned(): SimulationEvent | undefined {
    this.discardCancelledRoots()
    const first = this.heap[0]

    if (first === undefined) {
      return undefined
    }

    const last = this.heap.pop()

    if (this.heap.length > 0 && last !== undefined) {
      this.heap[0] = last
      this.bubbleDown(0)
    }

    this.liveSize -= 1
    const state = this.cancellationState(first.event.kind, first.event.subjectId)
    if (state !== undefined) state.activeCount -= 1
    return first.event
  }

  cancelKindsForSubject(
    kinds: readonly SimulationEventKind[],
    subjectId: number,
  ): number {
    let removed = 0
    for (const kind of kinds) {
      if (!INDEXED_CANCELLATION_KINDS.has(kind)) {
        throw new Error(`Тип события ${kind} не поддерживает адресную отмену`)
      }
      const key = cancellationKey(kind, subjectId)
      const state = this.cancellationStates.get(key)
      if (state === undefined || state.activeCount === 0) continue
      removed += state.activeCount
      this.liveSize -= state.activeCount
      state.activeCount = 0
      state.generation += 1
    }
    this.discardCancelledRoots()
    return removed
  }

  removeWhere(predicate: (event: SimulationEvent) => boolean): number {
    const live = this.heap.filter((queued) => !this.isCancelled(queued))
    const retained = live.filter(({ event }) => !predicate(event))
    const removedCount = live.length - retained.length

    if (removedCount === 0) {
      return 0
    }

    this.heap.length = 0
    this.heap.push(...retained)
    this.liveSize = retained.length
    for (const state of this.cancellationStates.values()) state.activeCount = 0
    for (const queued of retained) {
      const state = this.cancellationState(queued.event.kind, queued.event.subjectId)
      if (state !== undefined) state.activeCount += 1
    }

    for (let index = Math.floor(this.heap.length / 2) - 1; index >= 0; index -= 1) {
      this.bubbleDown(index)
    }

    return removedCount
  }

  private cancellationState(
    kind: SimulationEventKind,
    subjectId: number,
  ): CancellationState | undefined {
    if (!INDEXED_CANCELLATION_KINDS.has(kind)) return undefined
    const key = cancellationKey(kind, subjectId)
    let state = this.cancellationStates.get(key)
    if (state === undefined) {
      state = { generation: 0, activeCount: 0 }
      this.cancellationStates.set(key, state)
    }
    return state
  }

  private isCancelled(queued: QueuedEvent): boolean {
    const state = this.cancellationState(queued.event.kind, queued.event.subjectId)
    return state !== undefined && queued.cancellationGeneration !== state.generation
  }

  private discardCancelledRoots(): void {
    while (this.heap[0] !== undefined && this.isCancelled(this.heap[0])) {
      const last = this.heap.pop()
      if (this.heap.length > 0 && last !== undefined) {
        this.heap[0] = last
        this.bubbleDown(0)
      }
    }
  }

  private bubbleUp(startIndex: number): void {
    let index = startIndex

    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2)

      if (compareQueuedEvents(this.heap[parentIndex], this.heap[index]) <= 0) {
        return
      }

      this.swap(index, parentIndex)
      index = parentIndex
    }
  }

  private bubbleDown(startIndex: number): void {
    let index = startIndex

    while (true) {
      const leftIndex = index * 2 + 1
      const rightIndex = leftIndex + 1
      let smallestIndex = index

      if (
        leftIndex < this.heap.length &&
        compareQueuedEvents(this.heap[leftIndex], this.heap[smallestIndex]) < 0
      ) {
        smallestIndex = leftIndex
      }

      if (
        rightIndex < this.heap.length &&
        compareQueuedEvents(this.heap[rightIndex], this.heap[smallestIndex]) < 0
      ) {
        smallestIndex = rightIndex
      }

      if (smallestIndex === index) {
        return
      }

      this.swap(index, smallestIndex)
      index = smallestIndex
    }
  }

  private swap(firstIndex: number, secondIndex: number): void {
    const first = this.heap[firstIndex]
    this.heap[firstIndex] = this.heap[secondIndex]
    this.heap[secondIndex] = first
  }
}

function cancellationKey(kind: SimulationEventKind, subjectId: number): string {
  return `${kind}:${subjectId}`
}
