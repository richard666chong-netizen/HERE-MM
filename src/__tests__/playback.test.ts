import { describe, expect, it } from 'vitest'
import { advancePlayback, sliceWindow, sprayPlan } from '../lib/playback'

describe('advancePlayback', () => {
  it('100ms @ 1x 10pps advances exactly one point', () => {
    expect(advancePlayback(0, 100, 1, 10, 9)).toBeCloseTo(1, 10)
  })
  it('scales with speed', () => {
    expect(advancePlayback(1, 100, 5, 10, 100)).toBeCloseTo(6, 10)
  })
  it('clamps at lastIndex', () => {
    expect(advancePlayback(8.7, 1000, 5, 10, 9)).toBe(9)
  })
  it('non-positive dt is a no-op (first-frame baseline guard)', () => {
    expect(advancePlayback(3.3, 0, 5, 10, 9)).toBe(3.3)
    expect(advancePlayback(3.3, -50, 5, 10, 9)).toBe(3.3)
  })
})

describe('sliceWindow', () => {
  const series = Array.from({ length: 1001 }, (_, i) => ({ t: i * 0.1, v: i })) // t: 0..100s
  it('early: full history up to tCur, future points excluded', () => {
    const w = sliceWindow(series, 5, 30)
    expect(w.length).toBe(51) // t ∈ [0, 5] 步长 0.1
    expect(w[0].t).toBe(0)
    expect(w[w.length - 1].t).toBeCloseTo(5, 6)
  })
  it('sliding: points within [tCur-30, tCur], boundaries inclusive', () => {
    const w = sliceWindow(series, 100, 30)
    expect(w.length).toBe(301) // t ∈ [70, 100]
    expect(w[0].t).toBeCloseTo(70, 6)
    expect(w[w.length - 1].t).toBeCloseTo(100, 6)
  })
  it('empty result falls back to the last point', () => {
    const w = sliceWindow(series, -1, 30) // 无 t ≤ -1 的点
    expect(w).toEqual([{ t: 100, v: 1000 }])
  })
})

describe('sprayPlan', () => {
  it('initial: sprays stride-aligned indices from 0', () => {
    expect(sprayPlan([], 5, 2)).toEqual({ removeIdx: [], addIdx: [0, 2, 4] })
  })
  it('forward: only missing stride indices', () => {
    expect(sprayPlan([0, 2], 7, 2)).toEqual({ removeIdx: [], addIdx: [4, 6] })
  })
  it('backward: recovers indices beyond upTo', () => {
    expect(sprayPlan([0, 2, 4, 6], 3, 2)).toEqual({ removeIdx: [4, 6], addIdx: [] })
  })
  it('no-op when in sync', () => {
    expect(sprayPlan([0, 2, 4], 4, 2)).toEqual({ removeIdx: [], addIdx: [] })
    expect(sprayPlan([0, 2, 4], 2, 2)).toEqual({ removeIdx: [4], addIdx: [] })
  })
})
