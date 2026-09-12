import { describe, expect, it } from 'vitest'
import type { DerivedPoint, TrajPoint } from '../types'
import { deviationHistogram, deviationStats, deviationVsDistance } from '../lib/stats'

/** 构造只有 deviationM 不同的最小 DerivedPoint 序列（其余字段与本统计库无关） */
function mkDs(deviations: number[]): DerivedPoint[] {
  return deviations.map((deviationM, i) => ({
    i,
    matchedLatLng: [49.01, 8.44] as [number, number],
    deviationM,
    headingDeg: 90,
    speedMps: 1,
    linkId: `s${i}`,
  }))
}

describe('deviationStats', () => {
  it('mean/p95/max of [0, 10, 19, 30, 38] → 19.4 / 38 / 38', () => {
    const s = deviationStats(mkDs([0, 10, 19, 30, 38]))
    expect(s.meanM).toBeCloseTo(19.4, 10)
    expect(s.p95M).toBe(38) // 最近秩法：sorted[ceil(0.95*5)-1] = sorted[4]
    expect(s.maxM).toBe(38)
  })
  it('empty input throws', () => {
    expect(() => deviationStats([])).toThrow('empty')
  })
})

describe('deviationHistogram', () => {
  // 计划期望 counts [3,2]（宽 19：bins [0,19) / [19,38]）；数据取 [0,10,18,30,38]
  // 避开内部边界值 19（修订记录裁定"测试数据避开边界值，杜绝边界归属歧义"——
  // 计划括号里的序列 [0,10,19,30,38] 中 19 恰落在边界上，与其自身期望 [3,2] 矛盾）
  it('2 bins over boundary-avoiding data → counts [3,2]', () => {
    const { bins } = deviationHistogram(mkDs([0, 10, 18, 30, 38]), 2)
    expect(bins).toHaveLength(2)
    expect(bins[0].fromM).toBe(0)
    expect(bins[0].toM).toBeCloseTo(19, 10)
    expect(bins[1].fromM).toBeCloseTo(19, 10)
    expect(bins[1].toM).toBeCloseTo(38, 10)
    expect(bins.map((b) => b.count)).toEqual([3, 2])
  })
  it('all-zero deviations → binCount zero-width bins, no NaN', () => {
    const { bins } = deviationHistogram(mkDs([0, 0, 0]))
    expect(bins).toHaveLength(20) // 默认 binCount = 20
    for (const b of bins) {
      expect(b.fromM).toBe(0)
      expect(b.toM).toBe(0)
      expect(b.count).toBe(0)
      expect(Number.isNaN(b.fromM)).toBe(false)
      expect(Number.isNaN(b.toM)).toBe(false)
    }
  })
})

describe('deviationVsDistance', () => {
  // 三点共线 trace（沿经度，lat=49）：0.01° lng ≈ 729.505m/段（py 按 R=6371008.8 实算，
  // 与 geo.test.ts 的 1° ≈ 72950m 同口径）；累计里程 [0, ~729.5, ~1459.0]
  const trace: TrajPoint[] = [
    { lat: 49, lng: 8.4, timestamp: 0, timestampUtc: '', headingDeg: 90, speedMps: 1, numsats: 8 },
    { lat: 49, lng: 8.41, timestamp: 1, timestampUtc: '', headingDeg: 90, speedMps: 1, numsats: 8 },
    { lat: 49, lng: 8.42, timestamp: 2, timestampUtc: '', headingDeg: 90, speedMps: 1, numsats: 8 },
  ]
  it('distance is cumulative haversine mileage along trace, deviation aligned by index', () => {
    const r = deviationVsDistance(mkDs([1, 2, 3]), trace)
    expect(r).toHaveLength(3)
    expect(r[0].distanceM).toBe(0)
    expect(r[1].distanceM).toBeCloseTo(729.5, 0)
    expect(r[2].distanceM).toBeCloseTo(1459.0, 0)
    expect(r.map((p) => p.deviationM)).toEqual([1, 2, 3])
  })
})
