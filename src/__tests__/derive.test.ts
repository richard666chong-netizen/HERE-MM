import { describe, expect, it } from 'vitest'
import type { ImportResponse, TrajPoint } from '../types'
import { derive } from '../lib/derive'

// 测试代码豁免静态 import public/（src 运行时路径禁止，见 Global Constraints）
import f0093 from '../../public/fixtures/2011_09_26_drive_0093.json'
import trace0093 from '../../public/sample/here/2011_09_26_drive_0093.json'

// 东西向 3 点路径（纬度 49 恒定）：(49, 8.40) → (49, 8.41) → (49, 8.42)。
const POLY_3PT = 'BGgk3u9Cgo2gQAgxTAgxT'
const POLY_S1 = 'BGgk3u9Cgo2gQAgxT'
const POLY_S2 = 'BGgk3u9Cg5phQAgxT'

function resp(polylines: string[]): ImportResponse {
  return {
    routes: [{
      id: 'r0',
      sections: polylines.map((polyline, k) => ({
        id: `s${k}`,
        type: 'vehicle',
        polyline,
        summary: { duration: 60, length: 1460 },
      })),
    }],
  }
}

function tp(lat: number, lng: number, i: number): TrajPoint {
  return {
    lat, lng,
    timestamp: i, timestampUtc: `1970-01-01T00:00:0${i}.000Z`,
    headingDeg: 90 + i, speedMps: 5 + i, numsats: 10,
  }
}

describe('derive (synthetic, 3-point east-west path at lat 49)', () => {
  const trace = [
    tp(49, 8.4, 0),
    tp(49.0001, 8.415, 1),
    tp(49, 8.39, 2),
  ]

  it('per-point projection: deviation ≈ offset, foot on path, i aligned, pass-through', () => {
    const ds = derive(trace, resp([POLY_3PT]))
    expect(ds).toHaveLength(3)
    expect(ds.map((d) => d.i)).toEqual([0, 1, 2])
    expect(ds[0].deviationM).toBeCloseTo(0, 6)
    expect(ds[0].matchedLatLng[0]).toBeCloseTo(49, 6)
    expect(ds[0].matchedLatLng[1]).toBeCloseTo(8.4, 6)
    expect(ds[1].deviationM).toBeCloseTo(11.12, 1)
    expect(ds[1].matchedLatLng[0]).toBeCloseTo(49, 5)
    expect(ds[1].matchedLatLng[1]).toBeCloseTo(8.415, 5)
    expect(ds[2].deviationM).toBeCloseTo(729.5, -1)
    expect(ds[2].matchedLatLng[0]).toBeCloseTo(49, 6)
    expect(ds[2].matchedLatLng[1]).toBeCloseTo(8.4, 6)
    for (let k = 0; k < 3; k++) {
      expect(ds[k].headingDeg).toBe(trace[k].headingDeg)
      expect(ds[k].speedMps).toBe(trace[k].speedMps)
    }
  })

  it('decodes and concatenates ALL sections in order', () => {
    // 投影点落在 S2 覆盖的半段 (8.41→8.42)：拼接正确 → 偏差 ~11.12m；
    // 若只解码了首个 section，会夹到 (49, 8.41) → 偏差 ~365m，断言必红
    const ds = derive([tp(49.0001, 8.415, 0)], resp([POLY_S1, POLY_S2]))
    expect(ds).toHaveLength(1)
    expect(ds[0].deviationM).toBeCloseTo(11.12, 1)
    expect(ds[0].matchedLatLng[1]).toBeCloseTo(8.415, 5)
  })

  it('linkId tracks which section each projection falls on', () => {
    // S1 = (49, 8.40) → (49, 8.41), S2 = (49, 8.41) → (49, 8.42)
    const ds = derive(
      [tp(49, 8.405, 0), tp(49, 8.415, 1)],
      resp([POLY_S1, POLY_S2]),
    )
    expect(ds[0].linkId).toBe('s0') // 落在 S1
    expect(ds[1].linkId).toBe('s1') // 落在 S2
  })

  it('trackArcM：运动学轨道弧长逐帧给出，起点 ≈0、静止帧不漂移', () => {
    // 从路径原点出发匀速前进：0.00001°lng/帧 ≈ 0.73m ↔ speedMps 7.3
    const trace = Array.from({ length: 6 }, (_, k) => tp(49, 8.4 + k * 0.00001, k)).map((p, k) => ({
      ...p,
      timestamp: k / 10,
      speedMps: 7.3,
    }))
    const ds = derive(trace, resp([POLY_3PT]))
    for (const d of ds) {
      expect(Number.isFinite(d.trackArcM)).toBe(true)
      expect(d.trackArcM).toBeGreaterThanOrEqual(0)
    }
    expect(ds[0].trackArcM).toBeLessThan(1)
    for (let k = 1; k < ds.length; k++) expect(ds[k].trackArcM).toBeGreaterThanOrEqual(ds[k - 1].trackArcM!)
    expect(ds[5].trackArcM!).toBeGreaterThan(3) // 至少推进 0.73×5≈3.7m
  })
})

describe('derive (e2e: real fixture 0093 + real trace)', () => {
  it('points, all deviationM < 100m (regression bound)', () => {
    const trace = trace0093 as unknown as TrajPoint[]
    const response = (f0093 as unknown as { response: ImportResponse }).response
    const ds = derive(trace, response)
    expect(ds).toHaveLength(trace.length)
    for (let k = 0; k < ds.length; k++) {
      expect(ds[k].i).toBe(k)
      expect(ds[k].deviationM).toBeGreaterThanOrEqual(0)
      expect(ds[k].deviationM).toBeLessThan(100)
      expect(ds[k].headingDeg).toBe(trace[k].headingDeg)
      expect(ds[k].speedMps).toBe(trace[k].speedMps)
    }
  })
})
