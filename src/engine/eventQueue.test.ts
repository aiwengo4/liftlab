import { describe, expect, it } from 'vitest'
import type { SimulationEvent, SimulationEventKind } from './domain'
import { EventQueue } from './eventQueue'
import { secondsToTicks } from './time'

function event(
  seconds: number,
  kind: SimulationEventKind,
  subjectId: number,
): SimulationEvent {
  const employeeIdForOrdering = [
    'passenger-exited',
    'hall-call-created',
    'passenger-entered',
    'journey-requested',
    'stairs-segment-completed',
  ].includes(kind)
    ? subjectId
    : null

  return {
    time: secondsToTicks(seconds),
    kind,
    subjectId,
    employeeIdForOrdering,
    payload: null,
  }
}

describe('EventQueue', () => {
  it('returns events in chronological order regardless of insertion order', () => {
    const queue = new EventQueue()
    queue.enqueue(event(10, 'dispatch-requested', 1))
    queue.enqueue(event(2, 'dispatch-requested', 1))
    queue.enqueue(event(5, 'dispatch-requested', 1))

    expect(queue.dequeue()?.time).toBe(secondsToTicks(2))
    expect(queue.dequeue()?.time).toBe(secondsToTicks(5))
    expect(queue.dequeue()?.time).toBe(secondsToTicks(10))
  })

  it('uses the confirmed operation order for simultaneous events', () => {
    const queue = new EventQueue()
    const simultaneousEvents: SimulationEvent[] = [
      event(10, 'dispatch-requested', 1),
      event(10, 'elevator-doors-closed', 1),
      event(10, 'hall-call-updated', 1),
      event(10, 'passenger-entered', 1),
      event(10, 'hall-call-created', 1),
      event(10, 'passenger-exited', 1),
      event(10, 'elevator-doors-opened', 1),
      event(10, 'parking-timeout', 1),
    ]

    for (const simulationEvent of simultaneousEvents) {
      queue.enqueue(simulationEvent)
    }

    const actualKinds: SimulationEventKind[] = []

    while (!queue.isEmpty) {
      actualKinds.push(queue.dequeue()!.kind)
    }

    expect(actualKinds).toEqual([
      'elevator-doors-opened',
      'passenger-exited',
      'hall-call-created',
      'passenger-entered',
      'hall-call-updated',
      'elevator-doors-closed',
      'dispatch-requested',
      'parking-timeout',
    ])
  })

  it('orders employees with the same timestamp by numeric identifier', () => {
    const queue = new EventQueue()
    queue.enqueue(event(10, 'hall-call-created', 10))
    queue.enqueue(event(10, 'hall-call-created', 2))
    queue.enqueue(event(10, 'hall-call-created', 1))

    expect(queue.dequeue()?.subjectId).toBe(1)
    expect(queue.dequeue()?.subjectId).toBe(2)
    expect(queue.dequeue()?.subjectId).toBe(10)
  })

  it('preserves insertion order when all explicit sort fields are equal', () => {
    const queue = new EventQueue()
    queue.enqueue({ ...event(10, 'dispatch-requested', 1), payload: 'first' })
    queue.enqueue({ ...event(10, 'dispatch-requested', 1), payload: 'second' })

    expect(queue.dequeue()?.payload).toBe('first')
    expect(queue.dequeue()?.payload).toBe('second')
  })

  it('owns a snapshot so later mutation cannot reorder an event', () => {
    const queue = new EventQueue()
    const mutableEvent = event(10, 'dispatch-requested', 1) as {
      time: number
      payload: unknown
    }
    queue.enqueue(mutableEvent as SimulationEvent)
    mutableEvent.time = 1
    mutableEvent.payload = 'changed'

    expect(queue.dequeue()).toMatchObject({
      time: secondsToTicks(10),
      payload: null,
    })
  })

  it('returns a snapshot from peek so callers cannot mutate the heap', () => {
    const queue = new EventQueue()
    queue.enqueue(event(10, 'dispatch-requested', 1))
    const peeked = queue.peek() as { time: number }
    peeked.time = 1

    expect(queue.dequeue()?.time).toBe(secondsToTicks(10))
  })

  it('reports size and safely returns undefined for an empty queue', () => {
    const queue = new EventQueue()

    expect(queue.size).toBe(0)
    expect(queue.isEmpty).toBe(true)
    expect(queue.peek()).toBeUndefined()
    expect(queue.dequeue()).toBeUndefined()
  })

  it('rejects an invalid event subject identifier', () => {
    const queue = new EventQueue()

    expect(() => queue.enqueue(event(1, 'dispatch-requested', -1))).toThrow(
      RangeError,
    )
  })

  it('requires employee ordering only for employee events', () => {
    const queue = new EventQueue()
    const employeeEvent = event(1, 'passenger-entered', 1)
    const systemEvent = event(1, 'dispatch-requested', 1)

    expect(() =>
      queue.enqueue({ ...employeeEvent, employeeIdForOrdering: null }),
    ).toThrow('должен быть указан ID сотрудника')
    expect(() =>
      queue.enqueue({ ...systemEvent, employeeIdForOrdering: 1 }),
    ).toThrow('не должно сортироваться')
  })

  it('dispatches work before parking when both happen at the same time', () => {
    const queue = new EventQueue()
    queue.enqueue(event(10, 'parking-timeout', 1))
    queue.enqueue(event(10, 'dispatch-requested', 1))

    expect(queue.dequeue()?.kind).toBe('dispatch-requested')
    expect(queue.dequeue()?.kind).toBe('parking-timeout')
  })

  it('cancels indexed events for one subject without changing live order', () => {
    const queue = new EventQueue()
    queue.enqueue(event(3, 'elevator-doors-closed', 1))
    queue.enqueue(event(1, 'elevator-doors-opened', 2))
    queue.enqueue(event(2, 'elevator-doors-opened', 1))

    expect(queue.cancelKindsForSubject(
      ['elevator-doors-opened', 'elevator-doors-closed'],
      1,
    )).toBe(2)
    expect(queue.size).toBe(1)
    expect(queue.dequeue()?.subjectId).toBe(2)
    expect(queue.isEmpty).toBe(true)
  })

  it('keeps new events scheduled after an indexed cancellation', () => {
    const queue = new EventQueue()
    queue.enqueue(event(1, 'journey-requested', 7))
    expect(queue.cancelKindsForSubject(['journey-requested'], 7)).toBe(1)
    expect(queue.cancelKindsForSubject(['journey-requested'], 7)).toBe(0)
    queue.enqueue(event(2, 'journey-requested', 7))

    expect(queue.nextTime()).toBe(secondsToTicks(2))
    expect(queue.dequeue()?.time).toBe(secondsToTicks(2))
  })

  it('combines lazy cancellation with generic removal', () => {
    const queue = new EventQueue()
    queue.enqueue(event(1, 'elevator-doors-opened', 1))
    queue.enqueue(event(2, 'elevator-doors-opened', 2))
    queue.enqueue(event(3, 'dispatch-requested', 3))
    queue.cancelKindsForSubject(['elevator-doors-opened'], 1)

    expect(queue.removeWhere((candidate) => candidate.subjectId === 2)).toBe(1)
    expect(queue.size).toBe(1)
    expect(queue.dequeue()?.kind).toBe('dispatch-requested')
  })
})
