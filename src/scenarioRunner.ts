import { generateDaySchedule } from './engine/daySchedule'
import type { Elevator, Employee } from './engine/domain'
import { runFullDayScenario, type FullDayResult } from './engine/fullDayRunner'
import { generateLunchSchedule, DEFAULT_LUNCH_SETTINGS } from './engine/lunchSchedule'
import { DEFAULT_MEETING_SETTINGS, generateMeetingSchedule, meetingBusyIntervals } from './engine/meetingSchedule'
import { DEFAULT_LUNCH_OVERLOAD_STAIR_SETTINGS, DEFAULT_STAIR_CHOICE_SETTINGS } from './engine/routeChoice'
import { createSimulationState } from './engine/state'
import { validateScenarioForm, type ScenarioFormState } from './scenarioForm'

export function runScenarioFromForm(form: ScenarioFormState): FullDayResult {
  const errors = validateScenarioForm(form)
  if (Object.keys(errors).length > 0) throw new Error(`Настройки сценария содержат ошибки: ${Object.values(errors)[0]}`)
  const day = generateDaySchedule({
    seed: form.seed, floorCount: form.floorCount,
    floors: form.floors.map(({ floor, employees }) => ({ floor, employees })),
    arrival: { overall: { startMinute: form.arrivalOverallStart, endMinute: form.arrivalOverallEnd }, primary: { startMinute: form.arrivalPrimaryStart, endMinute: form.arrivalPrimaryEnd }, primaryShare: form.arrivalPrimaryShare },
    departure: { overall: { startMinute: form.departureOverallStart, endMinute: form.departureOverallEnd }, primary: { startMinute: form.departurePrimaryStart, endMinute: form.departurePrimaryEnd }, primaryShare: form.departurePrimaryShare },
    arrivalInfluenceOnDeparture: form.arrivalInfluenceOnDeparture,
    undergroundParking: {
      enabled: form.undergroundParkingEnabled,
      floorCount: form.undergroundFloorCount,
      employeeShare: form.undergroundEmployeeShare,
    },
  })
  const meetings = generateMeetingSchedule(day, { ...DEFAULT_MEETING_SETTINGS, seed: form.seed, startMinute: form.meetingStart, endMinute: form.meetingEnd, meanVisitsPerEmployee: form.meanMeetingsPerEmployee, maxConcurrentShare: form.maxMeetingConcurrentShare, durations: ([30, 45, 60] as const).map((value, index) => ({ value, weight: form.meetingDurationShares[index] })), hourlyRoomFoundShares: form.meetingRoomFoundSharesByHour })
  const lunches = generateLunchSchedule(day, { ...DEFAULT_LUNCH_SETTINGS, seed: form.seed, cafeteriaFloor: form.cafeteriaFloor, startMinute: form.lunchStart, endMinute: form.lunchEnd, peakMinute: form.lunchPeak, participationShare: form.lunchShare, durationMinutes: form.lunchDurationMinutes, durationJitterMinutes: form.lunchDurationJitterMinutes, waveWidthMinutes: form.lunchWaveMinutes }, meetingBusyIntervals(meetings))
  const employees: Employee[] = day.employees.map(({ id, homeFloor, arrivalFloor }) => ({ id, homeFloor, currentFloor: arrivalFloor ?? 1, targetFloor: arrivalFloor ?? 1, state: 'arrived', activeCallId: null, elevatorId: null }))
  const elevators: Elevator[] = form.initialElevatorFloors.map((currentFloor, index) => ({ id: index + 1, capacity: form.elevatorCapacity, currentFloor, direction: 'idle', state: 'idle-closed', passengerIds: [], assignedCallIds: [], scheduledStops: [], mandatoryCallId: null, movement: null, pendingBoardingEmployeeIds: [], doorServiceEndsAt: null, parkingFloor: null, parkingTimeoutAt: null }))
  return runFullDayScenario(
    createSimulationState({ elevators, employees }), day, meetings, lunches,
    {
      seed: form.seed, floorCount: form.floorCount,
      dispatchStrategy: form.dispatchStrategy,
      minFloor: form.undergroundParkingEnabled ? -form.undergroundFloorCount : 1,
      servedFloors: [...new Set(form.servedFloorsByElevator.flat())].sort((a, b) => a - b),
      servedFloorsByElevator: form.servedFloorsByElevator.map((floors, index) => ({ elevatorId: index + 1, floors })),
      elevatorTiming: { secondsPerFloor: form.secondsPerFloor, accelerationAndBrakingSeconds: form.accelerationAndBrakingSeconds, doorOperationSeconds: form.doorOperationSeconds, openDoorDwellSeconds: form.openDoorDwellSeconds, passengerTransferSeconds: form.passengerTransferSeconds },
      stairSettings: { ...DEFAULT_STAIR_CHOICE_SETTINGS, secondsPerFloor: form.stairSecondsPerFloor, convenient: form.stairsConvenient, maxVoluntaryFloors: form.maxVoluntaryStairFloors, convenientProbabilities: form.convenientStairProbabilities, inconvenientProbabilities: form.inconvenientStairProbabilities },
      lunchOverloadStairs: { ...DEFAULT_LUNCH_OVERLOAD_STAIR_SETTINGS, enabled: form.lunchOverloadStairsEnabled, probabilities: form.lunchOverloadStairProbabilities, inconvenientFactor: form.inconvenientStairFactor },
      metrics: { periods: { morning: { startMinute: form.reportMorningStart, endMinute: form.reportDayStart }, day: { startMinute: form.reportDayStart, endMinute: form.reportEveningStart }, evening: { startMinute: form.reportEveningStart, endMinute: form.reportEveningEnd } }, longWaitThresholdSeconds: form.longWaitThresholds },
      parking: form.parkingByElevator.flatMap((parking, index) => parking.enabled ? [{ elevatorId: index + 1, timeoutSeconds: parking.timeoutSeconds, intervals: parking.intervals }] : []),
    },
  )
}
