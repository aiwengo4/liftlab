import type { ScenarioFormState } from './scenarioForm'

export const SIMULATION_MODEL_VERSION = 'individual-elevator-stops-v1'

export function trafficFingerprint(form: ScenarioFormState): string {
  return fingerprint(['traffic-v2', form.seed, form.floorCount, form.floors.map(({ floor, employees }) => [floor, employees]),
    form.undergroundParkingEnabled, form.undergroundFloorCount, form.undergroundEmployeeShare,
    form.arrivalOverallStart, form.arrivalOverallEnd, form.arrivalPrimaryStart, form.arrivalPrimaryEnd, form.arrivalPrimaryShare,
    form.departureOverallStart, form.departureOverallEnd, form.departurePrimaryStart, form.departurePrimaryEnd, form.departurePrimaryShare,
    form.wholeHourBiasEnabled, form.wholeHourBiasShare,
    form.arrivalInfluenceOnDeparture, form.meetingStart, form.meetingEnd, form.meanMeetingsPerEmployee, form.maxMeetingConcurrentShare,
    form.meetingDurationShares, form.meetingRoomFoundSharesByHour, form.lunchStart, form.lunchEnd, form.lunchPeak, form.lunchShare,
    form.lunchDurationMinutes, form.lunchDurationJitterMinutes, form.lunchWaveMinutes, form.cafeteriaFloor, form.stairSecondsPerFloor, form.stairsConvenient,
    form.lunchOverloadStairsEnabled, form.lunchOverloadStairProbabilities, form.inconvenientStairFactor,
    form.maxVoluntaryStairFloors, form.convenientStairProbabilities, form.inconvenientStairProbabilities])
}

export function reportFingerprint(form: ScenarioFormState): string {
  return fingerprint(['report-v1', form.reportMorningStart, form.reportDayStart, form.reportEveningStart, form.reportEveningEnd, form.longWaitThresholds])
}

function fingerprint(value: unknown): string {
  const text = JSON.stringify(value)
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, '0')
}
