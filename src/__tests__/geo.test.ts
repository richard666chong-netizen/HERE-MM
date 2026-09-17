import { describe, expect, it } from 'vitest'
import { bearingDeg, haversineM, nearestOnPolyline, yawToCompassDeg } from '../lib/geo'

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

describe('yawToCompassDeg', () => {
  it('yaw 0（正东）→ 罗盘 90', () => {
    expect(yawToCompassDeg(0)).toBe(90)
  })
  it('yaw 90（正北）→ 罗盘 0', () => {
    expect(yawToCompassDeg(90)).toBe(0)
  })
  it('yaw -90（正南）→ 罗盘 180（负角归一）', () => {
    expect(yawToCompassDeg(-90)).toBe(180)
  })
  it('yaw 270（正西）→ 罗盘 180（>360 无需、跨零翻转）', () => {
    expect(yawToCompassDeg(270)).toBe(180)
  })
})

// 2026-09-16 航向绑路：车标航向源换轨/位移方位——bearingDeg 是其基础纯函数
describe('bearingDeg：两点位移方位角（从北顺时针）', () => {
  it('正北 → 0；正东 → 90', () => {
    expect(bearingDeg([49, 8.4], [49.001, 8.4])).toBeCloseTo(0, 6)
    expect(bearingDeg([49, 8.4], [49, 8.401])).toBeCloseTo(90, 6)
  })
  it('西南精确对角（dLng·cos49 = dLat）→ 225；同点 → 0（不抛错）', () => {
    // 等距圆柱：0.001°lat 与 0.0015242°lng(×cos49) 等米数 → 精确 45° 对角
    expect(bearingDeg([49.001, 8.4015242], [49, 8.4])).toBeCloseTo(225, 2)
    expect(bearingDeg([49, 8.4], [49, 8.4])).toBe(0)
  })
})
