declare const simulationTickBrand: unique symbol

export type SimulationTick = number & {
  readonly [simulationTickBrand]: 'SimulationTick'
}

export const TICKS_PER_SECOND = 10

export function secondsToTicks(seconds: number): SimulationTick {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new RangeError('Время должно быть конечным неотрицательным числом')
  }

  const ticks = seconds * TICKS_PER_SECOND
  const roundedTicks = Math.round(ticks)

  if (Math.abs(ticks - roundedTicks) > Number.EPSILON * 10) {
    throw new RangeError('Время должно быть задано с точностью до десятой секунды')
  }

  if (!Number.isSafeInteger(roundedTicks)) {
    throw new RangeError('Время выходит за безопасный диапазон расчёта')
  }

  return roundedTicks as SimulationTick
}

export function ticksToSeconds(ticks: SimulationTick): number {
  return ticks / TICKS_PER_SECOND
}

export function addTicks(
  first: SimulationTick,
  second: SimulationTick,
): SimulationTick {
  const result = first + second

  if (!Number.isSafeInteger(result) || result < 0) {
    throw new RangeError('Результат сложения времени выходит за безопасный диапазон')
  }

  return result as SimulationTick
}
