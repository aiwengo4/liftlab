import { describe, expect, it } from 'vitest'
import type { MeetingExecutionResult } from './engine/meetingJourneyRunner'
import { minuteToSimulationTick } from './engine/journeyRunner'
import { buildHistogram, duration, histogramLabel, summarizeMeetingRooms } from './ResultsView'

describe('results histogram', () => {
  it('returns no bins for an empty sample', () => {
    expect(buildHistogram([])).toEqual([])
  })

  it('keeps one-value samples and exact boundaries in one bin each', () => {
    expect(buildHistogram([0])).toEqual([{ from: 0, to: 1, count: 1 }])
    const bins = buildHistogram([0, 1, 2], 2)
    expect(bins.map((bin) => bin.count)).toEqual([1, 1, 1])
    expect(bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(3)
  })

  it('keeps an outlier in a final non-overlapping bin', () => {
    const bins = buildHistogram([1, 2, 999], 10)
    expect(bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(3)
    expect(bins.at(-1)?.count).toBe(1)
    expect(bins.every((bin, index) => index === 0 || bins[index - 1].to === bin.from)).toBe(true)
  })

  it('formats minute boundaries without producing 60 seconds', () => {
    expect(duration(59.95)).toBe('1 мин')
    expect(duration(119.9)).toBe('2 мин')
    expect(duration(120)).toBe('2 мин')
    expect(duration(null)).toBe('—')
  })

  it('labels exact histogram boundaries as half-open intervals', () => {
    expect(histogramLabel({ from: 1, to: 2, count: 3 })).toBe('1–<2 с')
  })

  it('reconciles meeting-room outcomes and splits planned starts by hour', () => {
    const meeting = (id: number, minute: number, kind?: 'room-acquired' | 'fallback-origin' | 'fallback-stay'): MeetingExecutionResult => ({
      meetingId: id, plannedStartMinute: minute, roomFound: kind === 'room-acquired', returnAfterFailedSearch: kind === 'fallback-origin',
      decisions: kind === undefined ? [] : kind === 'room-acquired'
        ? [{ kind, meetingId: id, booking: { roomId: `r${id}`, floor: 2, meetingId: id, startMinute: minute, endMinute: minute + 30, actualStartAt: minuteToSimulationTick(minute) } }]
        : [{ kind, meetingId: id, floor: 2 }],
      booking: null, finalFloor: 2, participants: [],
    })
    const rows = summarizeMeetingRooms([
      meeting(1, 11 * 60 + 59, 'room-acquired'), meeting(2, 12 * 60, 'fallback-origin'),
      meeting(3, 12 * 60 + 1, 'fallback-stay'), meeting(4, 12 * 60 + 2),
    ])
    expect(rows[0]).toMatchObject({ planned: 4, found: 1, returnedImmediately: 1, stayedUntilEnd: 1, notCompleted: 1 })
    expect(rows.slice(1).map(({ hour, planned }) => [hour, planned])).toEqual([[11, 1], [12, 3]])
    expect(rows[0].planned).toBe(rows[0].found + rows[0].returnedImmediately + rows[0].stayedUntilEnd + rows[0].notCompleted)
  })
})
