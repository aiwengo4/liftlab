import { describe, expect, it } from 'vitest'
import type { DaySchedule, ScheduledEmployee } from './daySchedule'
import { DEFAULT_LUNCH_SETTINGS, generateLunchSchedule, lunchReturnStartTick, lunchStartTick, type LunchSettings } from './lunchSchedule'

function day(count = 1000): DaySchedule {
  const employees: ScheduledEmployee[] = Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    homeFloor: 2 + index % 6,
    arrivalMinute: 8 * 60,
    departureMinute: 23 * 60,
  }))
  return { seed: 42, floorCount: 7, employees }
}

function settings(overrides: Partial<LunchSettings> = {}): LunchSettings {
  return {
    seed: 42,
    cafeteriaFloor: 1,
    ...DEFAULT_LUNCH_SETTINGS,
    ...overrides,
  }
}

describe('generateLunchSchedule', () => {
  it('is reproducible and selects exactly 80% of employees', () => {
    const first = generateLunchSchedule(day(), settings())
    const second = generateLunchSchedule(day(), settings())

    expect(first).toEqual(second)
    expect(first.lunches).toHaveLength(800)
    expect(first.skippedEmployeeIds).toHaveLength(0)
  })

  it('generates minute-level starts across both tails around the peak', () => {
    const schedule = generateLunchSchedule(day(5000), settings({ waveWidthMinutes: 60 }))
    expect(schedule.lunches.every(
      ({ startMinute }) => Number.isInteger(startMinute) && startMinute >= 13 * 60 && startMinute < 16 * 60,
    )).toBe(true)

    const nearPeak = schedule.lunches.filter(
      ({ desiredStartMinute }) => desiredStartMinute >= 13 * 60 + 30 && desiredStartMinute < 14 * 60 + 30,
    ).length
    const leftEdge = schedule.lunches.filter(
      ({ desiredStartMinute }) => desiredStartMinute < 13 * 60 + 30,
    ).length
    const rightEdge = schedule.lunches.filter(
      ({ desiredStartMinute }) => desiredStartMinute >= 15 * 60 + 30,
    ).length
    const edges = leftEdge + rightEdge
    expect(leftEdge).toBeGreaterThan(0)
    expect(rightEdge).toBeGreaterThan(0)
    expect(nearPeak).toBeGreaterThan(edges)
  })

  it('spreads starts reproducibly across seconds inside each generated minute', () => {
    const first = generateLunchSchedule(day(5000), settings())
    const second = generateLunchSchedule(day(5000), settings())
    expect(first.lunches.map(({ startSecond }) => startSecond)).toEqual(second.lunches.map(({ startSecond }) => startSecond))
    expect(new Set(first.lunches.map(({ startSecond }) => startSecond)).size).toBeGreaterThan(30)
    expect(first.lunches.every(({ startSecond }) => Number.isSafeInteger(startSecond) && startSecond! >= 0 && startSecond! <= 59)).toBe(true)
  })

  it('defines duration as the gap between movement starts', () => {
    const schedule = generateLunchSchedule(day(10), settings({ durationMinutes: 37 }))
    expect(schedule.lunches.every(
      (lunch) => lunch.returnStartMinute - lunch.startMinute === 37,
    )).toBe(true)
    expect(schedule.lunches.every(
      (lunch) => lunchReturnStartTick(lunch) - lunchStartTick(lunch) === 37 * 60 * 10,
    )).toBe(true)
  })

  it('adds a reproducible second-level duration jitter within the configured bounds', () => {
    const first = generateLunchSchedule(day(1000), settings({ durationMinutes: 30, durationJitterMinutes: 15 }))
    const second = generateLunchSchedule(day(1000), settings({ durationMinutes: 30, durationJitterMinutes: 15 }))
    const durations = first.lunches.map((lunch) => (lunchReturnStartTick(lunch) - lunchStartTick(lunch)) / 10)
    expect(first).toEqual(second)
    expect(Math.min(...durations)).toBeGreaterThanOrEqual(15 * 60)
    expect(Math.max(...durations)).toBeLessThanOrEqual(45 * 60)
    expect(new Set(durations).size).toBeGreaterThan(100)
  })

  it('does not shift into a meeting that starts exactly when lunch returns', () => {
    const base = generateLunchSchedule(day(1), settings({ participationShare: 1 })).lunches[0]
    const busy = new Map([[1, [{ startMinute: base.desiredStartMinute + 30, endMinute: base.desiredStartMinute + 60 }]]])
    const lunch = generateLunchSchedule(day(1), settings({ participationShare: 1 }), busy).lunches[0]
    expect(lunch.startMinute + 30).toBe(base.desiredStartMinute + 30)
    expect(lunch.startSecond).toBe(0)
  })

  it('moves lunch to the nearest earlier free minute when a meeting overlaps', () => {
    const onlyEmployee = day(1)
    const desired = generateLunchSchedule(onlyEmployee, settings({ participationShare: 1 })).lunches[0]
    const busy = new Map([[1, [{
      startMinute: desired.desiredStartMinute,
      endMinute: desired.desiredStartMinute + 30,
    }]]])
    const shifted = generateLunchSchedule(onlyEmployee, settings({ participationShare: 1 }), busy).lunches[0]

    const expected = desired.desiredStartMinute - 30 >= 13 * 60
      ? desired.desiredStartMinute - 30
      : desired.desiredStartMinute + 30
    expect(shifted.startMinute).toBe(expected)
    expect(shifted.shiftedFromDesired).toBe(true)
  })

  it('skips lunch when no complete free interval remains', () => {
    const schedule = generateLunchSchedule(
      day(1),
      settings({ participationShare: 1 }),
      new Map([[1, [{ startMinute: 13 * 60, endMinute: 16 * 60 }]]]),
    )
    expect(schedule.lunches).toHaveLength(0)
    expect(schedule.skippedEmployeeIds).toEqual([1])
  })

  it('keeps lunch between employee arrival and departure', () => {
    const schedule = generateLunchSchedule({
      seed: 42,
      floorCount: 7,
      employees: [{
        id: 1,
        homeFloor: 2,
        arrivalMinute: 14 * 60 + 10,
        departureMinute: 15 * 60,
      }],
    }, settings({ participationShare: 1, durationMinutes: 30 }))
    expect(schedule.lunches[0].startMinute).toBeGreaterThanOrEqual(14 * 60 + 10)
    expect(schedule.lunches[0].returnStartMinute).toBeLessThanOrEqual(15 * 60)
  })

  it('keeps desired starts independent of lunch duration', () => {
    const short = generateLunchSchedule(day(100), settings({ durationMinutes: 15 }))
    const long = generateLunchSchedule(day(100), settings({ durationMinutes: 60 }))
    expect(short.lunches.map(({ employeeId, desiredStartMinute }) => [employeeId, desiredStartMinute])).toEqual(
      long.lunches.map(({ employeeId, desiredStartMinute }) => [employeeId, desiredStartMinute]),
    )
  })

  it('treats touching busy intervals as non-overlapping', () => {
    const base = generateLunchSchedule(day(1), settings({ participationShare: 1 })).lunches[0]
    const before = generateLunchSchedule(
      day(1),
      settings({ participationShare: 1 }),
      new Map([[1, [{ startMinute: base.desiredStartMinute - 10, endMinute: base.desiredStartMinute }]]]),
    ).lunches[0]
    const after = generateLunchSchedule(
      day(1),
      settings({ participationShare: 1 }),
      new Map([[1, [{ startMinute: base.desiredStartMinute + 30, endMinute: base.desiredStartMinute + 40 }]]]),
    ).lunches[0]
    expect(before.startMinute).toBe(base.desiredStartMinute)
    expect(after.startMinute).toBe(base.desiredStartMinute)
  })

  it('skips an employee who is not present for a complete lunch interval', () => {
    const unavailable: DaySchedule = {
      seed: 42,
      floorCount: 7,
      employees: [{ id: 1, homeFloor: 2, arrivalMinute: 15 * 60 + 50, departureMinute: 16 * 60 }],
    }
    expect(generateLunchSchedule(unavailable, settings({ participationShare: 1 })).skippedEmployeeIds).toEqual([1])
  })

  it('supports 0% and rounds a fractional employee count', () => {
    expect(generateLunchSchedule(day(3), settings({ participationShare: 0 })).lunches).toHaveLength(0)
    expect(generateLunchSchedule(day(3), settings({ participationShare: 0.8 })).lunches).toHaveLength(2)
  })

  it('validates lunch parameters and busy intervals', () => {
    expect(() => generateLunchSchedule(day(1), settings({ durationMinutes: 14 }))).toThrow('от 15 до 60')
    expect(() => generateLunchSchedule(day(1), settings({ durationJitterMinutes: 16 }))).toThrow('от 0 до 15')
    expect(() => generateLunchSchedule(day(1), settings({ seed: -1 }))).toThrow('Seed')
    expect(() => generateLunchSchedule({ seed: 1, floorCount: 7, employees: [] }, settings())).toThrow('пустого расписания')
    expect(() => generateLunchSchedule(day(1), settings({ cafeteriaFloor: 8 }))).toThrow('внутри здания')
    expect(() => generateLunchSchedule(day(1), settings({ participationShare: 1.1 }))).toThrow('от 0 до 1')
    expect(() => generateLunchSchedule(day(1), settings({ peakMinute: 16 * 60 }))).toThrow('внутри периода')
    expect(() => generateLunchSchedule(day(1), settings({ waveWidthMinutes: 4 }))).toThrow('от 5 до 120')
    expect(() => generateLunchSchedule(day(1), settings({ startMinute: -1 }))).toThrow('минутами суток')
    expect(() => generateLunchSchedule(day(1), settings(), new Map([[2, []]]))).toThrow('отсутствующего сотрудника')
    expect(() => generateLunchSchedule(day(1), settings(), new Map([[1, [{ startMinute: 900, endMinute: 800 }]]]))).toThrow('Некорректный интервал')
  })
})
