export interface ElevatorTiming {
  secondsPerFloor: number
  accelerationAndBrakingSeconds: number
  doorOperationSeconds: number
  openDoorDwellSeconds: number
  passengerTransferSeconds: number
}

export const DEFAULT_ELEVATOR_TIMING: Readonly<ElevatorTiming> = {
  secondsPerFloor: 4,
  accelerationAndBrakingSeconds: 2,
  doorOperationSeconds: 1,
  openDoorDwellSeconds: 2,
  passengerTransferSeconds: 0.2,
}

export function movementTime(
  floors: number,
  timing: ElevatorTiming,
): number {
  if (!Number.isInteger(floors) || floors <= 0) {
    throw new RangeError('Количество пройденных этажей должно быть положительным целым числом')
  }

  return floors * timing.secondsPerFloor + timing.accelerationAndBrakingSeconds
}

export function stopTime(
  exitingPassengers: number,
  enteringPassengers: number,
  timing: ElevatorTiming,
): number {
  if (
    !Number.isInteger(exitingPassengers) ||
    exitingPassengers < 0 ||
    !Number.isInteger(enteringPassengers) ||
    enteringPassengers < 0
  ) {
    throw new RangeError('Количество входящих и выходящих пассажиров должно быть неотрицательным целым числом')
  }

  const transferredPassengers = exitingPassengers + enteringPassengers

  return (
    timing.doorOperationSeconds +
    transferredPassengers * timing.passengerTransferSeconds +
    timing.openDoorDwellSeconds +
    timing.doorOperationSeconds
  )
}
