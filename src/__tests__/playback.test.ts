import { describe, expect, it } from 'vitest'
import { advancePlayback, interpCarPos, interpHeadingDeg, sliceWindow, sprayPlan } from '../lib/playback'
import type { DerivedPoint, TrajPoint } from '../types'

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

// ── 子帧插值（HTML teaser 样式移植）：位置垂足插值 + 航向最短弧插值 ──
function tp(lat: number, lng: number): TrajPoint {
  return { lat, lng, timestamp: 0, timestampUtc: '', headingDeg: 0, speedMps: 0, numsats: 6 }
}
function dp(i: number, lat: number, lng: number): DerivedPoint {
  return { i, matchedLatLng: [lat, lng], deviationM: 0, headingDeg: 0, speedMps: 0, linkId: `s${i}` }
}

describe('interpCarPos', () => {
  const trace = [tp(49.0, 8.4), tp(49.001, 8.401), tp(49.002, 8.402)]
  const derived = [dp(0, 49.01, 8.41), dp(1, 49.02, 8.42), dp(2, 49.03, 8.43)]

  it('整数 pos（frac=0）= 该帧垂足——与旧 carIndex 行为逐位一致', () => {
    expect(interpCarPos(1, trace, derived)).toEqual([49.02, 8.42])
  })
  it('中段 pos=0.5 → 两垂足中点', () => {
    expect(interpCarPos(0.5, trace, derived)).toEqual([(49.01 + 49.02) / 2, (8.41 + 8.42) / 2])
  })
  it('越界钳制：负数→首帧、超尾→末帧', () => {
    expect(interpCarPos(-3, trace, derived)).toEqual([49.01, 8.41])
    expect(interpCarPos(99, trace, derived)).toEqual([49.03, 8.43])
  })
  it('末帧整数 pos（i0===i1）不外推', () => {
    expect(interpCarPos(2, trace, derived)).toEqual([49.03, 8.43])
  })
  it('derived 缺帧回退 trace 坐标', () => {
    const partial = [dp(0, 49.01, 8.41)]
    expect(interpCarPos(0.5, trace, partial)).toEqual([(49.01 + 49.001) / 2, (8.41 + 8.401) / 2])
  })
})

describe('interpHeadingDeg', () => {
  it('非环绕线性插值', () => {
    expect(interpHeadingDeg(100, 110, 0.25)).toBeCloseTo(102.5, 10)
  })
  it('跨北向环绕走 20° 短弧（350↔10）', () => {
    expect(interpHeadingDeg(350, 10, 0.5)).toBeCloseTo(360, 10)
    expect(interpHeadingDeg(10, 350, 0.5)).toBeCloseTo(0, 10)
  })
  it('frac 端点取原值', () => {
    expect(interpHeadingDeg(350, 10, 0)).toBe(350)
    expect(interpHeadingDeg(350, 10, 1)).toBe(10)
  })
})
