import type { Floor, TravelDirection } from './domain'
import type { MinuteOfDay } from './daySchedule'
import type { PlannedMeeting } from './meetingSchedule'
import { SeededRandom } from './random'
import { secondsToTicks, type SimulationTick } from './time'

export interface FloorRooms {
  readonly floor: Floor
  readonly rooms: number
}

export interface RoomBooking {
  readonly roomId: string
  readonly floor: Floor
  readonly meetingId: number
  readonly startMinute: MinuteOfDay
  readonly endMinute: MinuteOfDay
  readonly actualStartAt?: SimulationTick
}

export interface MeetingSearchSession {
  readonly meeting: PlannedMeeting
  readonly originFloor: Floor
  readonly searchFloors: readonly Floor[]
  searchIndex: number
  status: 'searching' | 'room-acquired' | 'outside-room' | 'ended'
  booking: RoomBooking | null
  finalFloor: Floor | null
  fallbackChoice: 'origin' | 'stay' | null
  lastArrivalKey: string | null
  lastDecision: MeetingSearchDecision | null
}

export interface MeetingArrival {
  readonly session: MeetingSearchSession
  readonly atMinute: MinuteOfDay
  readonly floor: Floor
  readonly atTick?: SimulationTick
}

export type MeetingSearchDecision =
  | { readonly kind: 'room-acquired'; readonly meetingId: number; readonly booking: RoomBooking }
  | { readonly kind: 'move-to-next-floor'; readonly meetingId: number; readonly floor: Floor }
  | { readonly kind: 'fallback-origin'; readonly meetingId: number; readonly floor: Floor }
  | { readonly kind: 'fallback-stay'; readonly meetingId: number; readonly floor: Floor }
  | { readonly kind: 'meeting-ended'; readonly meetingId: number; readonly floor: Floor }

export class MeetingRoomRuntime {
  private readonly roomsByFloor = new Map<Floor, readonly string[]>()
  private readonly bookingList: RoomBooking[] = []
  private readonly bookingByMeeting = new Map<number, RoomBooking>()
  private readonly bookingsByRoom = new Map<string, RoomBooking[]>()
  private readonly sessions = new WeakSet<MeetingSearchSession>()

  constructor(
    readonly floorCount: number,
    rooms: readonly FloorRooms[],
    private readonly seed: number,
  ) {
    new SeededRandom(seed)
    if (!Number.isSafeInteger(floorCount) || floorCount < 2 || floorCount > 100) {
      throw new RangeError('Количество этажей должно быть целым числом от 2 до 100')
    }
    const seen = new Set<Floor>()
    for (const item of rooms) {
      if (!Number.isSafeInteger(item.floor) || item.floor < 1 || item.floor > floorCount) {
        throw new RangeError('Этаж переговорных должен находиться внутри здания')
      }
      if (seen.has(item.floor)) throw new RangeError('Этажи переговорных не должны повторяться')
      if (!Number.isSafeInteger(item.rooms) || item.rooms < 0) {
        throw new RangeError('Количество переговорных должно быть целым неотрицательным числом')
      }
      seen.add(item.floor)
      this.roomsByFloor.set(
        item.floor,
        Array.from({ length: item.rooms }, (_, index) => `${item.floor}-${index + 1}`),
      )
    }
  }

  createSession(meeting: PlannedMeeting, actualOriginFloor: Floor): MeetingSearchSession {
    if (!Number.isSafeInteger(actualOriginFloor) || actualOriginFloor < 1 || actualOriginFloor > this.floorCount) {
      throw new RangeError('Исходный этаж поиска должен находиться внутри здания')
    }
    validateMeeting(meeting)
    const session: MeetingSearchSession = {
      meeting,
      originFloor: actualOriginFloor,
      searchFloors: runtimeSearchFloors(meeting, actualOriginFloor, this.floorCount),
      searchIndex: 0,
      status: 'searching',
      booking: null,
      finalFloor: null,
      fallbackChoice: null,
      lastArrivalKey: null,
      lastDecision: null,
    }
    this.sessions.add(session)
    return session
  }

  processArrivals(arrivals: readonly MeetingArrival[]): MeetingSearchDecision[] {
    return [...arrivals]
      .sort(
        (first, second) =>
          (first.atTick ?? minuteTick(first.atMinute)) -
            (second.atTick ?? minuteTick(second.atMinute)) ||
          first.session.meeting.id - second.session.meeting.id,
      )
      .map((arrival) => this.processArrival(arrival))
  }

  bookings(): readonly RoomBooking[] {
    return this.bookingList.map((booking) => ({ ...booking }))
  }

  private processArrival(arrival: MeetingArrival): MeetingSearchDecision {
    const { session, atMinute, floor } = arrival
    if (!this.sessions.has(session)) throw new Error('Сессия поиска принадлежит другому runtime')
    const meetingId = session.meeting.id

    if (!Number.isSafeInteger(atMinute) || atMinute < 0 || atMinute > 24 * 60) {
      throw new RangeError('Время прибытия должно быть целой минутой суток')
    }
    if (arrival.atTick !== undefined && (!Number.isSafeInteger(arrival.atTick) || arrival.atTick < 0)) {
      throw new RangeError('Точное время прибытия должно быть неотрицательным числом тиков')
    }
    const arrivalKey = `${arrival.atTick ?? atMinute}:${floor}`
    if (session.lastArrivalKey === arrivalKey) return session.lastDecision!
    const expectedFloor =
      session.status === 'room-acquired'
        ? session.booking!.floor
        : session.status === 'outside-room' || session.status === 'ended'
          ? session.finalFloor!
          : session.searchFloors[session.searchIndex]
    if (floor !== expectedFloor) throw new Error(`Встреча ${meetingId} прибыла не на ожидаемый этаж поиска`)

    const decision = this.resolveArrival(session, atMinute, floor, arrival.atTick)
    session.lastArrivalKey = arrivalKey
    session.lastDecision = decision
    return decision
  }

  private resolveArrival(
    session: MeetingSearchSession,
    atMinute: MinuteOfDay,
    currentFloor: Floor,
    atTick?: SimulationTick,
  ): MeetingSearchDecision {
    const meetingId = session.meeting.id

    if (session.status === 'ended' || (atTick ?? minuteTick(atMinute)) >= minuteTick(session.meeting.endMinute)) {
      session.status = 'ended'
      session.finalFloor = currentFloor
      return { kind: 'meeting-ended', meetingId, floor: currentFloor }
    }
    const existingBooking = this.bookingByMeeting.get(meetingId)
    if (existingBooking !== undefined) {
      session.status = 'room-acquired'
      session.booking = existingBooking
      session.finalFloor = existingBooking.floor
      return { kind: 'room-acquired', meetingId, booking: existingBooking }
    }
    if (session.status === 'room-acquired') {
      return { kind: 'room-acquired', meetingId, booking: session.booking! }
    }
    if (session.status === 'outside-room') {
      return session.fallbackChoice === 'origin'
        ? { kind: 'fallback-origin', meetingId, floor: session.finalFloor! }
        : { kind: 'fallback-stay', meetingId, floor: session.finalFloor! }
    }
    const booking = this.tryClaimRoom(session, currentFloor, atMinute, atTick)
    if (booking !== null) {
      session.status = 'room-acquired'
      session.booking = booking
      session.finalFloor = currentFloor
      return { kind: 'room-acquired', meetingId, booking }
    }

    if (session.searchIndex + 1 < session.searchFloors.length) {
      session.searchIndex += 1
      return {
        kind: 'move-to-next-floor',
        meetingId,
        floor: session.searchFloors[session.searchIndex],
      }
    }

    const stay = this.fallbackRandom(meetingId).next() >= 0.5
    session.status = 'outside-room'
    session.fallbackChoice = stay ? 'stay' : 'origin'
    session.finalFloor = stay ? currentFloor : session.originFloor
    return stay
      ? { kind: 'fallback-stay', meetingId, floor: currentFloor }
      : { kind: 'fallback-origin', meetingId, floor: session.originFloor }
  }

  private tryClaimRoom(
    session: MeetingSearchSession,
    floor: Floor,
    atMinute: MinuteOfDay,
    atTick?: SimulationTick,
  ): RoomBooking | null {
    const meeting = session.meeting
    const availableRoom = (this.roomsByFloor.get(floor) ?? []).find((roomId) =>
      (this.bookingsByRoom.get(roomId) ?? []).every(
        (booking) =>
          meeting.endMinute <= booking.startMinute ||
          atMinute >= booking.endMinute,
      ),
    )
    if (availableRoom === undefined) return null
    const booking: RoomBooking = {
      roomId: availableRoom,
      floor,
      meetingId: meeting.id,
      startMinute: Math.max(meeting.startMinute, atMinute),
      endMinute: meeting.endMinute,
      actualStartAt: atTick,
    }
    this.bookingList.push(booking)
    this.bookingByMeeting.set(meeting.id, booking)
    const roomBookings = this.bookingsByRoom.get(availableRoom) ?? []
    roomBookings.push(booking)
    this.bookingsByRoom.set(availableRoom, roomBookings)
    return booking
  }

  private fallbackRandom(meetingId: number): SeededRandom {
    return new SeededRandom((this.seed ^ Math.imul(meetingId, 0x9e37_79b1)) >>> 0)
  }
}

function minuteTick(minute: MinuteOfDay): SimulationTick {
  return secondsToTicks(minute * 60)
}

function validateMeeting(meeting: PlannedMeeting): void {
  if (!Number.isSafeInteger(meeting.id) || meeting.id < 1) {
    throw new RangeError('ID встречи должен быть положительным целым числом')
  }
  if (
    !Number.isSafeInteger(meeting.startMinute) ||
    !Number.isSafeInteger(meeting.endMinute) ||
    meeting.startMinute < 0 ||
    meeting.startMinute >= meeting.endMinute ||
    meeting.endMinute > 24 * 60
  ) {
    throw new RangeError('Интервал встречи задан некорректно')
  }
  if (
    ![0, 1, 2].includes(meeting.searchRadius) ||
    (meeting.searchRadius === 0 && meeting.searchDirection !== null) ||
    (meeting.searchRadius > 0 && !['up', 'down'].includes(meeting.searchDirection!))
  ) {
    throw new RangeError('Радиус и направление поиска встречи заданы некорректно')
  }
}

function runtimeSearchFloors(
  meeting: PlannedMeeting,
  origin: Floor,
  floorCount: number,
): Floor[] {
  if (meeting.searchRadius === 0) return [origin]
  let radius = meeting.searchRadius
  let direction = meeting.searchDirection ?? 'up'
  const fits = (candidate: TravelDirection, distance: number) =>
    candidate === 'up'
      ? origin + distance <= floorCount
      : origin - distance >= 1

  if (!fits(direction, radius)) {
    const opposite: TravelDirection = direction === 'up' ? 'down' : 'up'
    if (fits(opposite, radius)) direction = opposite
    else {
      radius = Math.min(radius, Math.max(origin - 1, floorCount - origin)) as 1 | 2
      if (!fits(direction, radius)) direction = opposite
    }
  }
  const sign = direction === 'up' ? 1 : -1
  return Array.from({ length: radius }, (_, index) => origin + sign * (index + 1))
}
