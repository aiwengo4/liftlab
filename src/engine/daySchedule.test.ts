import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ARRIVAL_WINDOW,
  DEFAULT_DEPARTURE_WINDOW,
  generateDaySchedule,
  type DayScheduleSettings,
} from './daySchedule'

function settings(overrides: Partial<DayScheduleSettings> = {}): DayScheduleSettings {
  return {
    seed: 42,
    floorCount: 7,
    floors: [{ floor: 2, employees: 100 }],
    arrival: DEFAULT_ARRIVAL_WINDOW,
    departure: DEFAULT_DEPARTURE_WINDOW,
    arrivalInfluenceOnDeparture: 0.7,
    ...overrides,
  }
}

describe('generateDaySchedule', () => {
  it('creates stable employees and times for the same seed', () => {
    expect(generateDaySchedule(settings())).toEqual(generateDaySchedule(settings()))
    expect(generateDaySchedule(settings({ seed: 43 }))).not.toEqual(generateDaySchedule(settings()))
  })

  it('assigns a deterministic balanced subset to underground parking', () => {
    const parking = { enabled: true, floorCount: 4, employeeShare: 0.31 }
    const first = generateDaySchedule(settings({ undergroundParking: parking }))
    const second = generateDaySchedule(settings({ undergroundParking: parking }))
    const parked = first.employees.filter(({ arrivalFloor }) => arrivalFloor! < 0)

    expect(first).toEqual(second)
    expect(parked).toHaveLength(31)
    expect(parked.every(({ arrivalFloor, departureFloor }) => arrivalFloor === departureFloor)).toBe(true)
    const counts = [-1, -2, -3, -4].map((floor) => parked.filter(({ arrivalFloor }) => arrivalFloor === floor).length)
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1)
  })

  it('keeps everyone on the first floor when underground parking is disabled', () => {
    const schedule = generateDaySchedule(settings({ undergroundParking: { enabled: false, floorCount: 4, employeeShare: 1 } }))
    expect(schedule.employees.every(({ arrivalFloor, departureFloor }) => arrivalFloor === 1 && departureFloor === 1)).toBe(true)
  })

  it('creates exactly the configured primary-window shares', () => {
    const schedule = generateDaySchedule(settings())
    const arrivalsInPrimary = schedule.employees.filter(
      ({ arrivalMinute }) => arrivalMinute >= 9 * 60 && arrivalMinute < 12 * 60,
    )
    const departuresInPrimary = schedule.employees.filter(
      ({ departureMinute }) => departureMinute >= 18 * 60 && departureMinute < 20 * 60,
    )

    expect(arrivalsInPrimary).toHaveLength(80)
    expect(departuresInPrimary).toHaveLength(80)
  })

  it('places remaining employees only in the tails outside the primary window', () => {
    const schedule = generateDaySchedule(settings())
    for (const employee of schedule.employees) {
      expect(employee.arrivalMinute).toBeGreaterThanOrEqual(8 * 60)
      expect(employee.arrivalMinute).toBeLessThan(14 * 60)
      expect(employee.departureMinute).toBeGreaterThanOrEqual(18 * 60)
      expect(employee.departureMinute).toBeLessThan(23 * 60)
    }
  })

  it('assigns stable IDs by ascending floor while retaining empty floors', () => {
    const schedule = generateDaySchedule(settings({
      floors: [
        { floor: 7, employees: 2 },
        { floor: 1, employees: 1 },
        { floor: 4, employees: 0 },
      ],
    }))

    expect(schedule.employees.map(({ id, homeFloor }) => [id, homeFloor])).toEqual([
      [1, 1],
      [2, 7],
      [3, 7],
    ])
  })

  it('never schedules departure before the employee arrival', () => {
    const schedule = generateDaySchedule(settings({
      floors: [{ floor: 2, employees: 500 }],
      arrival: {
        overall: { startMinute: 8 * 60, endMinute: 20 * 60 },
        primary: { startMinute: 9 * 60, endMinute: 12 * 60 },
        primaryShare: 0.8,
      },
      departure: {
        overall: { startMinute: 10 * 60, endMinute: 23 * 60 },
        primary: { startMinute: 18 * 60, endMinute: 20 * 60 },
        primaryShare: 0.8,
      },
    }))

    expect(schedule.employees.every(
      (employee) => employee.departureMinute >= employee.arrivalMinute,
    )).toBe(true)
  })

  it('makes departure order equal arrival order at 100% influence', () => {
    const schedule = generateDaySchedule(settings({ arrivalInfluenceOnDeparture: 1 }))
    const arrivalOrder = [...schedule.employees]
      .sort((first, second) => first.arrivalMinute - second.arrivalMinute || first.id - second.id)
      .map(({ departureMinute }) => departureMinute)

    expect(arrivalOrder).toEqual([...arrivalOrder].sort((first, second) => first - second))
  })

  it('rejects empty populations and invalid nested windows', () => {
    expect(() => generateDaySchedule(settings({ floors: [{ floor: 2, employees: 0 }] }))).toThrow(
      'от 1 до 10000',
    )
    expect(() => generateDaySchedule(settings({
      arrival: {
        overall: { startMinute: 9 * 60, endMinute: 12 * 60 },
        primary: { startMinute: 8 * 60, endMinute: 10 * 60 },
        primaryShare: 0.8,
      },
    }))).toThrow('внутри общего периода')
  })

  it('rejects an impossible departure multiset instead of moving times silently', () => {
    expect(() => generateDaySchedule(settings({
      floors: [{ floor: 2, employees: 10 }],
      arrival: {
        overall: { startMinute: 12 * 60, endMinute: 14 * 60 },
        primary: { startMinute: 13 * 60, endMinute: 14 * 60 },
        primaryShare: 1,
      },
      departure: {
        overall: { startMinute: 8 * 60, endMinute: 10 * 60 },
        primary: { startMinute: 8 * 60, endMinute: 9 * 60 },
        primaryShare: 1,
      },
    }))).toThrow('не может уйти до прихода')
  })

  it('validates the building, population, seed and proportions', () => {
    expect(() => generateDaySchedule(settings({ floorCount: 1 }))).toThrow('от 2 до 100')
    expect(() => generateDaySchedule(settings({ floors: [{ floor: 8, employees: 1 }] }))).toThrow('внутри здания')
    expect(() => generateDaySchedule(settings({ floors: [
      { floor: 2, employees: 1 },
      { floor: 2, employees: 1 },
    ] }))).toThrow('не должны повторяться')
    expect(() => generateDaySchedule(settings({ floors: [{ floor: 2, employees: -1 }] }))).toThrow('неотрицательным')
    expect(() => generateDaySchedule(settings({ floors: [{ floor: 2, employees: 10_001 }] }))).toThrow('от 1 до 10000')
    expect(() => generateDaySchedule(settings({ seed: -1 }))).toThrow('Seed')
    expect(() => generateDaySchedule(settings({ arrivalInfluenceOnDeparture: 1.01 }))).toThrow('от 0 до 1')
    expect(() => generateDaySchedule(settings({ arrival: {
      ...DEFAULT_ARRIVAL_WINDOW,
      primaryShare: -0.1,
    } }))).toThrow('Доля')
    expect(() => generateDaySchedule(settings({ arrival: {
      overall: { startMinute: 9 * 60, endMinute: 12 * 60 },
      primary: { startMinute: 9 * 60, endMinute: 12 * 60 },
      primaryShare: 0.8,
    } }))).toThrow('не осталось времени')
    expect(() => generateDaySchedule(settings({ arrival: {
      overall: { startMinute: -1, endMinute: 12 * 60 },
      primary: { startMinute: 9 * 60, endMinute: 10 * 60 },
      primaryShare: 1,
    } }))).toThrow('минутами суток')
  })

  it('rounds the primary count to the nearest whole employee', () => {
    const schedule = generateDaySchedule(settings({ floors: [{ floor: 2, employees: 3 }] }))
    expect(schedule.employees.filter(
      ({ arrivalMinute }) => arrivalMinute >= 9 * 60 && arrivalMinute < 12 * 60,
    )).toHaveLength(2)
  })

  it('supports zero share and a 100% window without tails', () => {
    const zeroShare = generateDaySchedule(settings({ arrival: {
      ...DEFAULT_ARRIVAL_WINDOW,
      primaryShare: 0,
    } }))
    expect(zeroShare.employees.every(
      ({ arrivalMinute }) => arrivalMinute < 9 * 60 || arrivalMinute >= 12 * 60,
    )).toBe(true)

    const fullShare = generateDaySchedule(settings({ arrival: {
      overall: { startMinute: 9 * 60, endMinute: 12 * 60 },
      primary: { startMinute: 9 * 60, endMinute: 12 * 60 },
      primaryShare: 1,
    } }))
    expect(fullShare.employees.every(
      ({ arrivalMinute }) => arrivalMinute >= 9 * 60 && arrivalMinute < 12 * 60,
    )).toBe(true)
  })

  it('at 0% influence keeps departure assignment independent of arrival times', () => {
    const early = generateDaySchedule(settings({
      arrivalInfluenceOnDeparture: 0,
      arrival: {
        overall: { startMinute: 6 * 60, endMinute: 9 * 60 },
        primary: { startMinute: 7 * 60, endMinute: 8 * 60 },
        primaryShare: 0.8,
      },
    }))
    const late = generateDaySchedule(settings({
      arrivalInfluenceOnDeparture: 0,
      arrival: {
        overall: { startMinute: 9 * 60, endMinute: 12 * 60 },
        primary: { startMinute: 10 * 60, endMinute: 11 * 60 },
        primaryShare: 0.8,
      },
    }))

    expect(early.employees.map(({ departureMinute }) => departureMinute)).toEqual(
      late.employees.map(({ departureMinute }) => departureMinute),
    )
  })

  it('at the default 70% influence earlier arrivals leave earlier on average', () => {
    const schedule = generateDaySchedule(settings({ floors: [{ floor: 2, employees: 500 }] }))
    const byArrival = [...schedule.employees].sort(
      (first, second) => first.arrivalMinute - second.arrivalMinute || first.id - second.id,
    )
    const mean = (values: readonly number[]) =>
      values.reduce((sum, value) => sum + value, 0) / values.length
    const earlyMean = mean(byArrival.slice(0, 100).map(({ departureMinute }) => departureMinute))
    const lateMean = mean(byArrival.slice(-100).map(({ departureMinute }) => departureMinute))

    expect(earlyMean).toBeLessThan(lateMean)
  })
})
