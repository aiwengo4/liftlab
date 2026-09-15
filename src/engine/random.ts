export class SeededRandom {
  private state: number

  constructor(seed: number) {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
      throw new RangeError('Seed должен быть целым числом от 0 до 4294967295')
    }

    this.state = seed === 0 ? 0x6d2b79f5 : seed >>> 0
  }

  next(): number {
    let value = this.state
    value ^= value << 13
    value ^= value >>> 17
    value ^= value << 5
    this.state = value >>> 0
    return this.state / 0x1_0000_0000
  }

  choose<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new RangeError('Нельзя выбрать значение из пустого списка')
    }

    return items[Math.floor(this.next() * items.length)]
  }
}
