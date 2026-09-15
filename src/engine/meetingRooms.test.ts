import { describe, expect, it } from 'vitest'
import type { PlannedMeeting } from './meetingSchedule'
import { MeetingRoomRuntime } from './meetingRooms'

function meeting(id: number, overrides: Partial<PlannedMeeting> = {}): PlannedMeeting {
  return {
    id,
    startMinute: 100,
    endMinute: 200,
    departureLeadMinutes: 2,
    participantIds: [id],
    roomFound: true,
    returnAfterFailedSearch: false,
    participantDepartures: [{ employeeId: id, departureMinute: 98 }],
    homeFloor: 2,
    searchRadius: 0,
    searchDirection: null,
    searchFloors: [2],
    ...overrides,
  }
}

describe('MeetingRoomRuntime', () => {
  it('claims one room per meeting regardless of group size', () => {
    const runtime = new MeetingRoomRuntime(7, [{ floor: 2, rooms: 1 }], 42)
    const value = meeting(1, { participantIds: [1, 2, 3, 4] })
    const session = runtime.createSession(value, 2)
    expect(runtime.processArrivals([{ session, atMinute: 100, floor: 2 }])[0].kind).toBe('room-acquired')
    expect(runtime.bookings()).toHaveLength(1)
  })

  it('resolves simultaneous competition by meeting id independent of input order', () => {
    const run = (reversed: boolean) => {
      const runtime = new MeetingRoomRuntime(7, [{ floor: 2, rooms: 1 }], 42)
      const first = runtime.createSession(meeting(1, { startMinute: 110 }), 2)
      const second = runtime.createSession(meeting(2, { startMinute: 100 }), 2)
      const arrivals = [{ session: first, atMinute: 110, floor: 2 }, { session: second, atMinute: 110, floor: 2 }]
      const decisions = runtime.processArrivals(reversed ? arrivals.reverse() : arrivals)
      return {
        decisions: decisions.map((result) => ({
          kind: result.kind,
          meetingId: result.meetingId,
          roomId: result.kind === 'room-acquired' ? result.booking.roomId : null,
        })),
        bookings: runtime.bookings(),
      }
    }
    expect(run(false).decisions[0]).toEqual({ kind: 'room-acquired', meetingId: 1, roomId: '2-1' })
    expect(run(true)).toEqual(run(false))
  })

  it('reuses a room at the touching half-open boundary', () => {
    const runtime = new MeetingRoomRuntime(7, [{ floor: 2, rooms: 1 }], 42)
    const first = runtime.createSession(meeting(1), 2)
    const second = runtime.createSession(meeting(2, { startMinute: 200, endMinute: 230 }), 2)
    expect(runtime.processArrivals([{ session: first, atMinute: 100, floor: 2 }])[0].kind).toBe('room-acquired')
    expect(runtime.processArrivals([{ session: second, atMinute: 200, floor: 2 }])[0].kind).toBe('room-acquired')
    expect(runtime.bookings().map(({ roomId }) => roomId)).toEqual(['2-1', '2-1'])
  })

  it('moves through a radius-two path and claims only after actual arrival', () => {
    const runtime = new MeetingRoomRuntime(7, [{ floor: 4, rooms: 1 }], 42)
    const value = meeting(1, { searchRadius: 2, searchDirection: 'up', searchFloors: [3, 4] })
    const session = runtime.createSession(value, 2)
    expect(runtime.processArrivals([{ session, atMinute: 100, floor: 3 }])[0]).toEqual({
      kind: 'move-to-next-floor', meetingId: 1, floor: 4,
    })
    expect(runtime.bookings()).toHaveLength(0)
    expect(runtime.processArrivals([{ session, atMinute: 105, floor: 4 }])[0].kind).toBe('room-acquired')
  })

  it('uses actual origin and flips an impossible direction at a building edge', () => {
    const runtime = new MeetingRoomRuntime(7, [], 42)
    const value = meeting(1, { searchRadius: 2, searchDirection: 'up', searchFloors: [3, 4] })
    const session = runtime.createSession(value, 7)
    expect(session.originFloor).toBe(7)
    expect(session.searchFloors).toEqual([6, 5])

    const lower = runtime.createSession(meeting(2, { searchRadius: 2, searchDirection: 'down' }), 1)
    expect(lower.searchFloors).toEqual([2, 3])

    const twoFloors = new MeetingRoomRuntime(2, [], 42)
    const reduced = twoFloors.createSession(meeting(3, { searchRadius: 2, searchDirection: 'up' }), 1)
    expect(reduced.searchFloors).toEqual([2])

    const own = runtime.createSession(meeting(4), 6)
    expect(own.searchFloors).toEqual([6])
  })

  it('returns a stable fallback only after the final searched floor', () => {
    const runtime = new MeetingRoomRuntime(7, [], 42)
    const value = meeting(5, { searchRadius: 2, searchDirection: 'up', searchFloors: [3, 4] })
    const session = runtime.createSession(value, 2)
    expect(runtime.processArrivals([{ session, atMinute: 100, floor: 3 }])[0].kind).toBe('move-to-next-floor')
    const fallback = runtime.processArrivals([{ session, atMinute: 105, floor: 4 }])[0]
    expect(['fallback-origin', 'fallback-stay']).toContain(fallback.kind)
    expect(runtime.processArrivals([{ session, atMinute: 106, floor: 4 }])[0]).toEqual(fallback)
    expect(runtime.bookings()).toHaveLength(0)
  })

  it('does not claim a room after the scheduled meeting end', () => {
    const runtime = new MeetingRoomRuntime(7, [{ floor: 2, rooms: 1 }], 42)
    const session = runtime.createSession(meeting(1), 2)
    expect(runtime.processArrivals([{ session, atMinute: 200, floor: 2 }])[0].kind).toBe('meeting-ended')
    expect(runtime.bookings()).toHaveLength(0)
  })

  it('transitions acquired and fallback sessions to ended at the meeting boundary', () => {
    const withRoom = new MeetingRoomRuntime(7, [{ floor: 2, rooms: 1 }], 42)
    const acquired = withRoom.createSession(meeting(1), 2)
    withRoom.processArrivals([{ session: acquired, atMinute: 199, floor: 2 }])
    expect(withRoom.processArrivals([{ session: acquired, atMinute: 200, floor: 2 }])[0].kind).toBe('meeting-ended')

    const withoutRoom = new MeetingRoomRuntime(7, [], 42)
    const fallback = withoutRoom.createSession(meeting(2), 2)
    withoutRoom.processArrivals([{ session: fallback, atMinute: 199, floor: 2 }])
    expect(withoutRoom.processArrivals([{ session: fallback, atMinute: 200, floor: 2 }])[0].kind).toBe('meeting-ended')
  })

  it('accepts the actual return to origin after an exhausted search', () => {
    const runtime = new MeetingRoomRuntime(7, [], 42)
    let selected: { session: ReturnType<typeof runtime.createSession>; fallback: ReturnType<typeof runtime.processArrivals>[number] } | null = null
    for (let id = 1; id < 100 && selected === null; id += 1) {
      const session = runtime.createSession(meeting(id, {
        searchRadius: 1,
        searchDirection: 'up',
        searchFloors: [3],
      }), 2)
      const fallback = runtime.processArrivals([{ session, atMinute: 100, floor: 3 }])[0]
      if (fallback.kind === 'fallback-origin') selected = { session, fallback }
    }
    expect(selected).not.toBeNull()
    const ended = runtime.processArrivals([{ session: selected!.session, atMinute: 200, floor: 2 }])[0]
    expect(ended).toEqual({ kind: 'meeting-ended', meetingId: selected!.session.meeting.id, floor: 2 })
    expect(selected!.session.finalFloor).toBe(2)
  })

  it('never gives two rooms to duplicate sessions of one meeting', () => {
    const runtime = new MeetingRoomRuntime(7, [{ floor: 2, rooms: 2 }], 42)
    const value = meeting(1)
    const first = runtime.createSession(value, 2)
    const duplicate = runtime.createSession(value, 2)
    const decisions = runtime.processArrivals([
      { session: duplicate, atMinute: 100, floor: 2 },
      { session: first, atMinute: 100, floor: 2 },
    ])
    expect(decisions.every((decision) => decision.kind === 'room-acquired')).toBe(true)
    expect(runtime.bookings()).toHaveLength(1)
    expect(new Set(decisions.map((decision) => decision.kind === 'room-acquired' ? decision.booking.roomId : null))).toEqual(new Set(['2-1']))
  })

  it('treats a repeated arrival event as idempotent', () => {
    const runtime = new MeetingRoomRuntime(7, [{ floor: 4, rooms: 1 }], 42)
    const session = runtime.createSession(meeting(1, {
      searchRadius: 2,
      searchDirection: 'up',
      searchFloors: [3, 4],
    }), 2)
    const arrival = { session, atMinute: 100, floor: 3 }
    const first = runtime.processArrivals([arrival])[0]
    const repeated = runtime.processArrivals([arrival])[0]
    expect(repeated).toEqual(first)
    expect(runtime.bookings()).toHaveLength(0)
    expect(session.searchIndex).toBe(1)
  })

  it('claims a room only from a late actual arrival', () => {
    const runtime = new MeetingRoomRuntime(7, [{ floor: 2, rooms: 1 }], 42)
    const earlier = runtime.createSession(meeting(1, { endMinute: 140 }), 2)
    const late = runtime.createSession(meeting(2), 2)
    runtime.processArrivals([{ session: earlier, atMinute: 100, floor: 2 }])
    const decision = runtime.processArrivals([{ session: late, atMinute: 150, floor: 2 }])[0]
    expect(decision.kind).toBe('room-acquired')
    expect(runtime.bookings()[1].startMinute).toBe(150)
  })

  it('uses all rooms in stable order before falling back', () => {
    const runtime = new MeetingRoomRuntime(7, [{ floor: 2, rooms: 2 }], 42)
    const sessions = [1, 2, 3].map((id) => runtime.createSession(meeting(id), 2))
    const decisions = runtime.processArrivals(sessions.reverse().map((session) => ({
      session,
      atMinute: 100,
      floor: 2,
    })))
    expect(decisions.slice(0, 2).map((decision) => decision.kind === 'room-acquired' ? decision.booking.roomId : null)).toEqual(['2-1', '2-2'])
    expect(['fallback-origin', 'fallback-stay']).toContain(decisions[2].kind)
  })

  it('validates room configuration and actual origins', () => {
    expect(() => new MeetingRoomRuntime(7, [{ floor: 8, rooms: 1 }], 42)).toThrow('внутри здания')
    expect(() => new MeetingRoomRuntime(7, [{ floor: 2, rooms: -1 }], 42)).toThrow('неотрицательным')
    expect(() => new MeetingRoomRuntime(7, [{ floor: 2, rooms: 1 }, { floor: 2, rooms: 1 }], 42)).toThrow('не должны повторяться')
    const runtime = new MeetingRoomRuntime(7, [], 42)
    expect(() => runtime.createSession(meeting(1), 8)).toThrow('внутри здания')
    expect(() => runtime.createSession(meeting(0), 2)).toThrow('ID встречи')
    expect(() => runtime.createSession(meeting(1, { endMinute: 100 }), 2)).toThrow('Интервал встречи')
    const session = runtime.createSession(meeting(2), 2)
    expect(() => runtime.processArrivals([{ session, atMinute: 100, floor: 3 }])).toThrow('ожидаемый этаж')
    expect(() => runtime.processArrivals([{ session, atMinute: 1.5, floor: 2 }])).toThrow('целой минутой')
  })
})
