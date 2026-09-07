import { describe, expect, it } from 'vitest'
import { haversineM, nearestOnPolyline } from '../lib/geo'

describe('haversineM', () => {
  it('1 degree of latitude is ~111.2km', () => {
    expect(haversineM([49, 8.4], [50, 8.4])).toBeCloseTo(111195, -2)
  })
  it('1 degree of longitude at lat 49 is ~72.95km', () => {
    // 111195×cos(49°) ≈ 72950（评审实测：R=6371008.8 球面 haversine 精确值 72950.0）
    expect(haversineM([49, 8.4], [49, 9.4])).toBeCloseTo(72950, -2)
  })
  it('zero distance', () => {
    expect(haversineM([49.01, 8.44], [49.01, 8.44])).toBe(0)
  })
})

describe('nearestOnPolyline', () => {
  // 东西向直线段：从 (49, 8.40) 到 (49, 8.42)，每段 ~72.95m
  const path: Array<[number, number]> = [[49, 8.4], [49, 8.41], [49, 8.42]]
  it('perpendicular projection mid-segment', () => {
    const r = nearestOnPolyline([49.0001, 8.415], path) // 段1中点正北 ~11.12m
    expect(r.segIndex).toBe(1)
    expect(r.distM).toBeCloseTo(11.12, -1)
    expect(r.foot[0]).toBeCloseTo(49, 5)
    expect(r.foot[1]).toBeCloseTo(8.415, 5)
  })
  it('beyond endpoints clamps to vertex', () => {
    const r = nearestOnPolyline([49, 8.39], path)
    expect(r.segIndex).toBe(0)
    expect(r.foot).toEqual([49, 8.4])
    expect(r.distM).toBeCloseTo(72950 * 0.01, -2)
  })
  it('empty path throws', () => {
    expect(() => nearestOnPolyline([49, 8.4], [])).toThrow('empty path')
  })
})
