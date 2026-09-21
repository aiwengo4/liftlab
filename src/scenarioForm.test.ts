import { describe, expect, it } from 'vitest'
import { createDefaultScenarioForm, distributeEmployees, resizeElevators, resizeFloors, validateScenarioForm } from './scenarioForm'
import { runScenarioFromForm } from './scenarioRunner'

describe('scenario form model', () => {
  it('starts with safe defaults and blocks an empty scenario', () => {
    const values = createDefaultScenarioForm()
    expect(values.elevatorCount).toBe(2)
    expect(values.initialElevatorFloors).toEqual([1, 1])
    expect(values.lunchDurationJitterMinutes).toBe(15)
    expect(values.lunchOverloadStairsEnabled).toBe(true)
    expect(values.lunchOverloadStairProbabilities).toEqual([0.9, 0.7, 0.6, 0.45, 0.3, 0.15, 0.05])
    expect(values.inconvenientStairFactor).toBe(0.5)
    expect(validateScenarioForm(values).totalEmployees).toContain('Укажите')
  })

  it('distributes all employees exactly and optionally includes floor one', () => {
    const initial = { ...createDefaultScenarioForm(), floorCount: 4, floors: createDefaultScenarioForm().floors.slice(0, 4), totalEmployees: 10, distributionMode: 'equal' as const }
    expect(distributeEmployees(initial).floors.map((floor) => floor.employees)).toEqual([0, 4, 3, 3])
    expect(distributeEmployees({ ...initial, includeFirstFloor: true }).floors.map((floor) => floor.employees)).toEqual([3, 3, 2, 2])
    expect(distributeEmployees({ ...initial, totalEmployees: 0 }).floors.every((floor) => floor.employees === 0)).toBe(true)
  })

  it.each([
    { floors: 25, employees: 4_000 },
    { floors: 100, employees: 4_000 },
    { floors: 25, employees: 10_000 },
    { floors: 100, employees: 10_000 },
    { floors: 2, employees: 10_000 },
    { floors: 100, employees: 1 },
  ])('keeps large employee counts intact for $floors floors and $employees employees', ({ floors, employees }) => {
    const resized = resizeFloors(createDefaultScenarioForm(), floors)
    const distributed = distributeEmployees({ ...resized, totalEmployees: employees, distributionMode: 'equal' })
    expect(distributed.floors).toHaveLength(floors)
    expect(distributed.floors.reduce((sum, floor) => sum + floor.employees, 0)).toBe(employees)
    expect(distributed.floors.every((floor) => Number.isSafeInteger(floor.employees) && floor.employees >= 0)).toBe(true)
    expect(validateScenarioForm(distributed).floors).toBeUndefined()
  })

  it('preserves existing floor and elevator values while resizing', () => {
    const initial = { ...createDefaultScenarioForm(), floors: createDefaultScenarioForm().floors.map((floor) => floor.floor === 2 ? { ...floor, employees: 7 } : floor), initialElevatorFloors: [1, 3] }
    expect(resizeFloors(initial, 5).floors[1].employees).toBe(7)
    expect(resizeElevators(initial, 3).initialElevatorFloors).toEqual([1, 3, 1])
    expect(resizeFloors(initial, -1).floors).toEqual(initial.floors)
    expect(resizeElevators(initial, 999).initialElevatorFloors).toEqual(initial.initialElevatorFloors)
  })

  it('validates totals, served starts and nested time windows', () => {
    const initial = createDefaultScenarioForm()
    const values = { ...initial, totalEmployees: 1, floors: initial.floors.map((floor) => floor.floor === 2 ? { ...floor, employees: 1 } : floor), initialElevatorFloors: [1, 2], departurePrimaryStart: 17 * 60 }
    expect(validateScenarioForm(values)).toEqual({ departure: 'Основное окно должно находиться внутри общего периода' })
    const forbidden = { ...values, floors: values.floors.map((floor) => floor.floor === 2 ? { ...floor, served: false } : floor) }
    expect(validateScenarioForm(forbidden)['elevator-1']).toContain('может останавливаться')
  })

  it('validates shares and structural collections', () => {
    const initial = createDefaultScenarioForm()
    const broken = { ...initial, totalEmployees: 1, floors: [{ ...initial.floors[0], floor: 2, employees: 1 }, ...initial.floors.slice(1)], initialElevatorFloors: [1], arrivalPrimaryShare: 1.1 }
    const errors = validateScenarioForm(broken)
    expect(errors.floors).toContain('соответствовать')
    expect(errors.elevators).toContain('каждого лифта')
    expect(errors.arrivalPrimaryShare).toContain('100%')
    const noTail = { ...initial, totalEmployees: 1, floors: initial.floors.map((floor) => floor.floor === 2 ? { ...floor, employees: 1 } : floor), arrivalOverallStart: 9 * 60, arrivalOverallEnd: 12 * 60 }
    expect(validateScenarioForm(noTail).arrival).toContain('не осталось времени')
  })

  it('validates advanced distributions, reports, stairs and lunch', () => {
    const initial = createDefaultScenarioForm()
    const broken = { ...initial, meetingDurationShares: [0.5, 0.5, 0.5] as [number,number,number], lunchDurationMinutes: 14, lunchDurationJitterMinutes: 16, maxVoluntaryStairFloors: 7, lunchOverloadStairProbabilities: [0.9], inconvenientStairFactor: 2, reportDayStart: initial.reportMorningStart, longWaitThresholds: [120, 100, 360] as [number,number,number] }
    const errors = validateScenarioForm(broken)
    expect(errors.meetingDurationShares).toContain('100%')
    expect(errors.lunchDurationMinutes).toContain('15')
    expect(errors.lunchDurationJitterMinutes).toContain('15')
    expect(errors.lunchOverloadStairProbabilities).toContain('семь')
    expect(errors.inconvenientStairFactor).toContain('от 0 до 1')
    expect(errors.maxVoluntaryStairFloors).toContain('6')
    expect(errors.reportPeriods).toBeDefined()
    expect(errors.longWaitThresholds).toContain('возрастать')
    expect(validateScenarioForm({ ...initial, longWaitThresholds: [0, 240, 360] }).longWaitThresholds).toContain('положительными')
    expect(validateScenarioForm({ ...initial, meetingRoomFoundSharesByHour: [0.8] }).meetingRoomFoundSharesByHour).toContain('каждого часа')
  })

  it('keeps parking off by default and validates each enabled elevator locally', () => {
    const initial = createDefaultScenarioForm()
    expect(initial.parkingByElevator.every((parking) => !parking.enabled)).toBe(true)
    const empty = { ...initial, parkingByElevator: initial.parkingByElevator.map((parking,index) => index === 0 ? { ...parking, enabled: true } : parking) }
    expect(validateScenarioForm(empty)['parking-0']).toContain('интервал')
    const overlap = { ...empty, parkingByElevator: empty.parkingByElevator.map((parking,index) => index === 0 ? { ...parking, intervals: [{ startMinute: 60, endMinute: 180, floor: 1 }, { startMinute: 120, endMinute: 240, floor: 1 }] } : parking) }
    expect(validateScenarioForm(overlap)['parking-0']).toContain('пересекаются')
  })

  it('validates every editable numeric boundary and blocks calculation', () => {
    const base = distributeEmployees({ ...createDefaultScenarioForm(), totalEmployees: 10, distributionMode: 'equal' })
    const cases: Array<[string, typeof base]> = [
      ['seed', { ...base, seed: -1 }],
      ['floorCount', { ...base, floorCount: 101 }],
      ['totalEmployees', { ...base, totalEmployees: 10_001 }],
      ['elevatorCount', { ...base, elevatorCount: 0 }],
      ['elevatorCapacity', { ...base, elevatorCapacity: 41 }],
      ['secondsPerFloor', { ...base, secondsPerFloor: 0.4 }],
      ['secondsPerFloor', { ...base, secondsPerFloor: 4.25 }],
      ['accelerationAndBrakingSeconds', { ...base, accelerationAndBrakingSeconds: -0.1 }],
      ['doorOperationSeconds', { ...base, doorOperationSeconds: 31 }],
      ['openDoorDwellSeconds', { ...base, openDoorDwellSeconds: 61 }],
      ['passengerTransferSeconds', { ...base, passengerTransferSeconds: 5.1 }],
      ['stairSecondsPerFloor', { ...base, stairSecondsPerFloor: 0 }],
      ['arrivalPrimaryShare', { ...base, arrivalPrimaryShare: 1.01 }],
      ['departurePrimaryShare', { ...base, departurePrimaryShare: -0.01 }],
      ['arrivalInfluenceOnDeparture', { ...base, arrivalInfluenceOnDeparture: 1.01 }],
      ['lunchShare', { ...base, lunchShare: 1.01 }],
      ['meanMeetingsPerEmployee', { ...base, meanMeetingsPerEmployee: 10.1 }],
      ['maxMeetingConcurrentShare', { ...base, maxMeetingConcurrentShare: 1.01 }],
      ['lunchDurationMinutes', { ...base, lunchDurationMinutes: 14 }],
      ['lunchDurationJitterMinutes', { ...base, lunchDurationJitterMinutes: 15.1 }],
      ['lunchWaveMinutes', { ...base, lunchWaveMinutes: 4.9 }],
      ['maxVoluntaryStairFloors', { ...base, maxVoluntaryStairFloors: 7 }],
      ['inconvenientStairFactor', { ...base, inconvenientStairFactor: 1.1 }],
      ['longWaitThresholds', { ...base, longWaitThresholds: [120, 120, 360] }],
      ['longWaitThresholds', { ...base, longWaitThresholds: [120.5, 240, 360] }],
    ]
    for (const [key, values] of cases) {
      expect(validateScenarioForm(values)[key], key).toBeDefined()
      expect(() => runScenarioFromForm(values), key).toThrow('содержат ошибки')
    }
  })

  it('shows invalid nested periods, distributions, floors and parking before simulation', () => {
    const base = distributeEmployees({ ...createDefaultScenarioForm(), totalEmployees: 10, distributionMode: 'equal' })
    const invalid = [
      { key: 'arrival', values: { ...base, arrivalOverallStart: 10 * 60, arrivalPrimaryStart: 9 * 60 } },
      { key: 'departure', values: { ...base, departureOverallEnd: 19 * 60, departurePrimaryEnd: 20 * 60 } },
      { key: 'meeting', values: { ...base, meetingStart: 19 * 60, meetingEnd: 11 * 60 } },
      { key: 'lunch', values: { ...base, lunchStart: 15 * 60, lunchEnd: 14 * 60 } },
      { key: 'meetingDurationShares', values: { ...base, meetingDurationShares: [0.5, 0.5, 0.5] as [number, number, number] } },
      { key: 'meetingRoomFoundSharesByHour', values: { ...base, meetingRoomFoundSharesByHour: [...base.meetingRoomFoundSharesByHour.slice(0, 23), 2] } },
      { key: 'convenientStairProbabilities', values: { ...base, convenientStairProbabilities: [0.5] } },
      { key: 'lunchOverloadStairProbabilities', values: { ...base, lunchOverloadStairProbabilities: [0.01, 0.7, 0.6, 0.45, 0.3, 0.15, 0.05] } },
      { key: 'floors', values: { ...base, floors: base.floors.map((floor) => floor.floor === 2 ? { ...floor, employees: -1 } : floor) } },
      { key: 'cafeteriaFloor', values: { ...base, cafeteriaFloor: 101 } },
      { key: 'parking-0', values: { ...base, parkingByElevator: base.parkingByElevator.map((parking, index) => index === 0 ? { enabled: true, timeoutSeconds: 3601, intervals: [{ startMinute: 60, endMinute: 30, floor: 1 }] } : parking) } },
    ]
    for (const { key, values } of invalid) {
      expect(validateScenarioForm(values)[key], key).toBeDefined()
      expect(() => runScenarioFromForm(values), key).toThrow('содержат ошибки')
    }
  })

  it('runs a scenario when both stair probability scales are disabled with zeros', () => {
    const values = distributeEmployees({
      ...createDefaultScenarioForm(),
      totalEmployees: 1,
      distributionMode: 'equal',
      convenientStairProbabilities: Array(6).fill(0),
      inconvenientStairProbabilities: Array(6).fill(0),
      lunchOverloadStairProbabilities: Array(7).fill(0),
    })

    expect(validateScenarioForm(values).convenientStairProbabilities).toBeUndefined()
    expect(validateScenarioForm(values).inconvenientStairProbabilities).toBeUndefined()
    expect(validateScenarioForm(values).lunchOverloadStairProbabilities).toBeUndefined()
    expect(() => runScenarioFromForm(values)).not.toThrow()
  })
})
