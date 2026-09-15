import { describe, expect, it } from 'vitest'
import { createDefaultScenarioForm, distributeEmployees } from './scenarioForm'
import { createScenarioUrl, decodeScenarioHash, encodeScenario } from './scenarioLink'
import { runScenarioFromForm } from './scenarioRunner'

describe('scenario links', () => {
  it('round-trips every setting and the seed', () => {
    const form = { ...createDefaultScenarioForm(), seed: 4_000_000_000, totalEmployees: 12 }
    expect(decodeScenarioHash('#settings=' + encodeScenario(form))).toEqual({ ok: true, scenario: form, migrated: false })
  })

  it('reproduces the same generated day after opening the shared link', () => {
    const form = distributeEmployees({ ...createDefaultScenarioForm(), totalEmployees: 4, distributionMode: 'equal' })
    const decoded = decodeScenarioHash('#settings=' + encodeScenario(form))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(runScenarioFromForm(decoded.scenario).traces).toEqual(runScenarioFromForm(form).traces)
  })

  it('creates a URL without changing its path or query', () => {
    const url = createScenarioUrl(createDefaultScenarioForm(), 'https://example.test/lifts?mode=demo#old')
    const parsed = new URL(url)
    expect(parsed.pathname).toBe('/lifts')
    expect(parsed.search).toBe('?mode=demo')
    expect(parsed.hash.startsWith('#settings=')).toBe(true)
  })

  it('rejects malformed, unsupported and structurally incomplete data', () => {
    expect(decodeScenarioHash('#settings=%%%').ok).toBe(false)
    const unsupported = btoa(JSON.stringify({ version: 99, scenario: {} })).replaceAll('+','-').replaceAll('/','_').replace(/=+$/u,'')
    expect(decodeScenarioHash('#settings=' + unsupported)).toEqual({ ok: false, reason: 'Версия ссылки не поддерживается' })
    const incomplete = btoa(JSON.stringify({ version: 1, scenario: { seed: 42 } })).replaceAll('+','-').replaceAll('/','_').replace(/=+$/u,'')
    expect(decodeScenarioHash('#settings=' + incomplete)).toEqual({ ok: false, reason: 'Настройки в ссылке имеют неверный формат' })
  })

  it('migrates version 1 but rejects an incomplete version 2 payload', () => {
    const current = createDefaultScenarioForm()
    const { meetingRoomFoundSharesByHour: _hourly, ...legacy } = current
    const legacyWithRooms = { ...legacy, meetingGroupShares: [0.8, 0.12, 0.05, 0.02, 0.01], floors: legacy.floors.map((floor) => ({ ...floor, meetingRooms: 1, meetingRoomsAuto: true })) }
    const encodeRaw = (value: unknown) => btoa(JSON.stringify(value)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/u,'')
    const migrated = decodeScenarioHash('#settings=' + encodeRaw({ version: 1, scenario: legacyWithRooms }))
    expect(migrated.ok && migrated.scenario.meetingRoomFoundSharesByHour).toEqual(Array(24).fill(0.8))
    expect(migrated.ok && migrated.migrated).toBe(true)
    expect(decodeScenarioHash('#settings=' + encodeRaw({ version: 2, scenario: legacy })).ok).toBe(false)
  })

  it('opens version 2 links with their former nearest-call strategy', () => {
    const { dispatchStrategy: _strategy, lunchDurationJitterMinutes: _jitter, lunchOverloadStairsEnabled: _overload, lunchOverloadStairProbabilities: _overloadProbabilities, inconvenientStairFactor: _factor, ...versionTwo } = createDefaultScenarioForm()
    const encoded = btoa(JSON.stringify({ version: 2, scenario: versionTwo })).replaceAll('+','-').replaceAll('/','_').replace(/=+$/u,'')
    const decoded = decodeScenarioHash('#settings=' + encoded)
    expect(decoded.ok && decoded.scenario.dispatchStrategy).toBe('nearest')
    expect(decoded.ok && decoded.scenario.lunchDurationJitterMinutes).toBe(0)
    expect(decoded.ok && decoded.scenario.lunchOverloadStairsEnabled).toBe(false)
  })
})
