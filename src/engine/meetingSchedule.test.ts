import { describe, expect, it } from 'vitest'
import type { DaySchedule, ScheduledEmployee } from './daySchedule'
import { DEFAULT_MEETING_SETTINGS, generateMeetingSchedule, meetingBusyIntervals, type MeetingSettings } from './meetingSchedule'

function day(count = 100, floorCount = 7): DaySchedule {
  const employees: ScheduledEmployee[] = Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    homeFloor: 2 + index % Math.max(1, floorCount - 1),
    arrivalMinute: 8 * 60,
    departureMinute: 23 * 60,
  }))
  return { seed: 42, floorCount, employees }
}

function settings(overrides: Partial<MeetingSettings> = {}): MeetingSettings {
  return { seed: 42, ...DEFAULT_MEETING_SETTINGS, ...overrides }
}

describe('generateMeetingSchedule', () => {
  it('reproduces meetings and reaches the rounded target when feasible', () => {
    const first = generateMeetingSchedule(day(), settings())
    const second = generateMeetingSchedule(day(), settings())
    expect(first).toEqual(second)
    expect(first.targetVisits).toBe(300)
    expect(first.assignedVisits).toBe(300)
    expect(first.unassignedVisits).toBe(0)
    expect(generateMeetingSchedule(day(), settings({ seed: 43 }))).not.toEqual(first)
    expect(first.meetings.every((meeting) => meeting.participantIds.length === 1)).toBe(true)
  })

  it('uses hourly room-found shares and a reproducible 50/50 failed-search fallback', () => {
    const neverFound = generateMeetingSchedule(day(1_000), settings({
      hourlyRoomFoundShares: Array.from({ length: 24 }, () => 0),
    }))
    expect(neverFound.meetings.every((meeting) => !meeting.roomFound)).toBe(true)
    const returns = neverFound.meetings.filter((meeting) => meeting.returnAfterFailedSearch).length
    expect(returns / neverFound.meetings.length).toBeGreaterThan(0.45)
    expect(returns / neverFound.meetings.length).toBeLessThan(0.55)

    const alwaysFound = generateMeetingSchedule(day(), settings({
      hourlyRoomFoundShares: Array.from({ length: 24 }, () => 1),
    }))
    expect(alwaysFound.meetings.every((meeting) => meeting.roomFound && !meeting.returnAfterFailedSearch)).toBe(true)
    expect(generateMeetingSchedule(day(1_000), settings({
      hourlyRoomFoundShares: Array.from({ length: 24 }, () => 0),
    }))).toEqual(neverFound)
  })

  it('ignores the legacy group-size distribution', () => {
    const baseline = generateMeetingSchedule(day(), settings())
    const singleOnly = generateMeetingSchedule(day(), settings({
      groupSizes: [
        { value: 1, weight: 1 }, { value: 2, weight: 0 },
        { value: 3, weight: 0 }, { value: 4, weight: 0 },
        { value: '5-10', weight: 0 },
      ],
    }))
    expect(singleOnly).toEqual(baseline)
  })

  it('keeps meetings, participants and the 40% concurrency limit valid', () => {
    const source = day()
    const schedule = generateMeetingSchedule(source, settings())
    const employees = new Map(source.employees.map((employee) => [employee.id, employee]))
    for (const meeting of schedule.meetings) {
      expect(meeting.startMinute).toBeGreaterThanOrEqual(11 * 60)
      expect(meeting.endMinute).toBeLessThanOrEqual(19 * 60)
      expect(new Set(meeting.participantIds).size).toBe(meeting.participantIds.length)
      expect(new Set(meeting.participantIds.map((id) => employees.get(id)!.homeFloor)).size).toBe(1)
      expect(meeting.participantIds.every((id) => {
        const employee = employees.get(id)!
        const departure = meeting.participantDepartures.find(({ employeeId }) => employeeId === id)!
        return employee.arrivalMinute <= departure.departureMinute && employee.departureMinute >= meeting.endMinute
      })).toBe(true)
    }
    for (let minute = 11 * 60; minute < 19 * 60; minute += 1) {
      const active = schedule.meetings
        .filter((meeting) => meeting.startMinute <= minute && minute < meeting.endMinute)
        .reduce((sum, meeting) => sum + meeting.participantIds.length, 0)
      expect(active).toBeLessThanOrEqual(40)
    }
  })

  it('never overlaps meetings of the same employee and exports matching busy intervals', () => {
    const schedule = generateMeetingSchedule(day(), settings())
    const busy = meetingBusyIntervals(schedule)
    for (const intervals of busy.values()) {
      for (let index = 1; index < intervals.length; index += 1) {
        expect(intervals[index - 1].endMinute).toBeLessThanOrEqual(intervals[index].startMinute)
      }
    }
    expect([...busy.values()].reduce((sum, intervals) => sum + intervals.length, 0)).toBe(schedule.assignedVisits)
  })

  it('uses only two- or three-minute departure leads and both occur', () => {
    const meetings = generateMeetingSchedule(day(), settings()).meetings
    expect(new Set(meetings.map(({ departureLeadMinutes }) => departureLeadMinutes))).toEqual(new Set([2, 3]))
    expect(meetings.every((meeting) => meeting.participantDepartures.every(
      ({ departureMinute }) =>
        departureMinute >= meeting.startMinute - meeting.departureLeadMinutes &&
        departureMinute <= meeting.startMinute,
    ))).toBe(true)
  })

  it('creates only physically possible search paths at building edges', () => {
    const edgeDay: DaySchedule = {
      seed: 42,
      floorCount: 7,
      employees: Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        homeFloor: index % 2 === 0 ? 1 : 7,
        arrivalMinute: 8 * 60,
        departureMinute: 23 * 60,
      })),
    }
    const meetings = generateMeetingSchedule(edgeDay, settings()).meetings
    for (const meeting of meetings) {
      expect(meeting.searchFloors.every((floor) => floor >= 1 && floor <= 7)).toBe(true)
      if (meeting.homeFloor === 1 && meeting.searchRadius > 0) expect(meeting.searchDirection).toBe('up')
      if (meeting.homeFloor === 7 && meeting.searchRadius > 0) expect(meeting.searchDirection).toBe('down')
    }
  })

  it('reports an unreachable target instead of exceeding a zero hard cap', () => {
    const schedule = generateMeetingSchedule(day(3), settings({ maxConcurrentShare: 0.3 }))
    expect(schedule.assignedVisits).toBe(0)
    expect(schedule.unassignedVisits).toBe(schedule.targetVisits)
  })

  it('respects employees with narrow presence windows', () => {
    const source: DaySchedule = {
      seed: 42,
      floorCount: 7,
      employees: [{ id: 1, homeFloor: 2, arrivalMinute: 12 * 60, departureMinute: 13 * 60 }],
    }
    const schedule = generateMeetingSchedule(source, settings({ maxConcurrentShare: 1, meanVisitsPerEmployee: 1 }))
    expect(schedule.assignedVisits).toBe(1)
    expect(schedule.meetings[0].participantDepartures[0].departureMinute).toBeGreaterThanOrEqual(12 * 60)
    expect(schedule.meetings[0].endMinute).toBeLessThanOrEqual(13 * 60)
  })

  it('allows arrival shortly before a meeting and departs as soon as the employee is present', () => {
    const source: DaySchedule = {
      seed: 42,
      floorCount: 7,
      employees: [{ id: 1, homeFloor: 2, arrivalMinute: 10 * 60 + 59, departureMinute: 23 * 60 }],
    }
    const fixedWindow = settings({
      startMinute: 11 * 60,
      endMinute: 11 * 60 + 30,
      maxConcurrentShare: 1,
      meanVisitsPerEmployee: 1,
      durations: [
        { value: 30, weight: 1 },
        { value: 45, weight: 0 },
        { value: 60, weight: 0 },
      ],
    })
    const schedule = generateMeetingSchedule(source, fixedWindow)
    expect(schedule.assignedVisits).toBe(1)
    expect(schedule.meetings[0].participantDepartures[0].departureMinute).toBe(10 * 60 + 59)
  })

  it('never produces a negative departure minute', () => {
    const midnightDay: DaySchedule = {
      seed: 42,
      floorCount: 7,
      employees: Array.from({ length: 10 }, (_, index) => ({
        id: index + 1,
        homeFloor: 2,
        arrivalMinute: 0,
        departureMinute: 24 * 60,
      })),
    }
    const schedule = generateMeetingSchedule(midnightDay, settings({
      startMinute: 0,
      endMinute: 30,
      meanVisitsPerEmployee: 1,
      maxConcurrentShare: 1,
      durations: [
        { value: 30, weight: 1 },
        { value: 45, weight: 0 },
        { value: 60, weight: 0 },
      ],
    }))
    expect(schedule.assignedVisits).toBeGreaterThan(0)
    expect(schedule.meetings.every((meeting) => meeting.participantDepartures.every(
      ({ departureMinute }) => departureMinute >= 0,
    ))).toBe(true)
  })

  it('allows back-to-back meetings and leaves for the second after the first ends', () => {
    const source: DaySchedule = {
      seed: 42,
      floorCount: 7,
      employees: [{ id: 1, homeFloor: 2, arrivalMinute: 0, departureMinute: 24 * 60 }],
    }
    let schedule = generateMeetingSchedule(source, settings({ meanVisitsPerEmployee: 0 }))
    for (let seed = 0; seed < 200 && schedule.assignedVisits < 2; seed += 1) {
      schedule = generateMeetingSchedule(source, settings({
        seed,
        startMinute: 11 * 60,
        endMinute: 12 * 60,
        maxConcurrentShare: 1,
        meanVisitsPerEmployee: 2,
        durations: [
          { value: 30, weight: 1 },
          { value: 45, weight: 0 },
          { value: 60, weight: 0 },
        ],
      }))
    }
    expect(schedule.assignedVisits).toBe(2)
    const ordered = [...schedule.meetings].sort((first, second) => first.startMinute - second.startMinute)
    expect(ordered[0].endMinute).toBe(ordered[1].startMinute)
    expect(ordered[1].participantDepartures[0].departureMinute).toBe(ordered[0].endMinute)
    expect(ordered[1].startMinute - ordered[1].participantDepartures[0].departureMinute).toBe(0)
  })

  it('rounds down the hard cap for a small population', () => {
    const schedule = generateMeetingSchedule(day(3), settings({
      maxConcurrentShare: 0.4,
      meanVisitsPerEmployee: 1,
    }))
    for (let minute = 11 * 60; minute < 19 * 60; minute += 1) {
      const active = schedule.meetings
        .filter((meeting) => meeting.startMinute <= minute && minute < meeting.endMinute)
        .reduce((sum, meeting) => sum + meeting.participantIds.length, 0)
      expect(active).toBeLessThanOrEqual(1)
    }
  })

  it('reduces impossible search radii and builds consecutive paths', () => {
    const meetings = generateMeetingSchedule(day(100, 2), settings()).meetings
    for (const meeting of meetings) {
      expect(meeting.searchRadius).toBeLessThanOrEqual(1)
      expect(meeting.searchFloors).toHaveLength(meeting.searchRadius === 0 ? 1 : meeting.searchRadius)
      if (meeting.searchRadius > 0) {
        expect(Math.abs(meeting.searchFloors[0] - meeting.homeFloor)).toBe(1)
      }
    }
  })

  it('validates seed, windows, shares, means and weight totals', () => {
    expect(() => generateMeetingSchedule(day(), settings({ seed: -1 }))).toThrow('Seed')
    expect(() => generateMeetingSchedule(day(), settings({ startMinute: 900, endMinute: 800 }))).toThrow('раньше')
    expect(() => generateMeetingSchedule(day(), settings({ maxConcurrentShare: 1.1 }))).toThrow('от 0 до 1')
    expect(() => generateMeetingSchedule(day(), settings({ meanVisitsPerEmployee: 11 }))).toThrow('от 0 до 10')
    expect(() => generateMeetingSchedule(day(), settings({ durations: [{ value: 30, weight: 0.5 }] }))).toThrow('100%')
    expect(() => generateMeetingSchedule(day(), settings({ groupSizes: [] }))).toThrow('пустым')
    expect(() => generateMeetingSchedule(day(), settings({ hourlyRoomFoundShares: [0.8] }))).toThrow('24')
    expect(() => generateMeetingSchedule(day(), settings({ hourlyRoomFoundShares: Array.from({ length: 24 }, (_, hour) => hour === 12 ? 1.1 : 0.8) }))).toThrow('от 0 до 1')
    expect(() => generateMeetingSchedule(day(), settings({
      durations: [
        { value: 30, weight: 0.3 },
        { value: 30, weight: 0.4 },
        { value: 60, weight: 0.3 },
      ],
    }))).toThrow('категории')
    expect(() => generateMeetingSchedule(day(), settings({
      groupSizes: [
        { value: 1, weight: 0.8 },
        { value: 2, weight: 0.12 },
        { value: 3, weight: 0.05 },
        { value: 4, weight: 0.02 },
        { value: 99 as 4, weight: 0.01 },
      ],
    }))).toThrow('категории')
  })
})
