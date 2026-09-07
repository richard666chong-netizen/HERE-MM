import { describe, expect, it } from 'vitest'
import type { ImportResponse, TrajPoint } from '../types'
import { derive } from '../lib/derive'

// 测试代码豁免静态 import public/（src 运行时路径禁止，见 Global Constraints）
import f0011 from '../../public/fixtures/2011_09_26_drive_0011.json'
import trace0011 from '../../public/sample/here/2011_09_26_drive_0011.json'

// 东西向 3 点路径（纬度 49 恒定）：(49, 8.40) → (49, 8.41) → (49, 8.42)。
// 编码串按 flexible polyline 规范以精度 6 生成（'BG' 头与真实 fixture 同构），
// 并经独立 Python 解码器回验坐标无误（BGgk3u9Cgo2gQAgxTAgxT → 上述 3 点）。
const POLY_3PT = 'BGgk3u9Cgo2gQAgxTAgxT'
// 拆两段：S1 = (49, 8.40) → (49, 8.41)，S2 = (49, 8.41) → (49, 8.42)
const POLY_S1 = 'BGgk3u9Cgo2gQAgxT'
const POLY_S2 = 'BGgk3u9Cg5phQAgxT'

function resp(polylines: string[]): ImportResponse {
  return {
    routes: [{
      id: 'r0',
      sections: polylines.map((polyline, k) => ({
        id: `s${k}`, type: 'vehicle', polyline, summary: { duration: 60, length: 1460 },
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
  // 1° lng @ lat49 ≈ 72950m（haversine 口径，见 geo.test.ts）→ 每段 0.01° ≈ 729.5m
  const trace = [
    tp(49, 8.4, 0),        // 恰在路径起点顶点上
    tp(49.0001, 8.415, 1), // 段 1 中点正北 ~11.12m（与 geo.test.ts 手算向量同款）
    tp(49, 8.39, 2),       // 越过西端点 → 夹到顶点 (49, 8.40)
  ]

  it('per-point projection: deviation ≈ offset, foot on path, i aligned, pass-through', () => {
    const ds = derive(trace, resp([POLY_3PT]))
    expect(ds).toHaveLength(3)
    expect(ds.map((d) => d.i)).toEqual([0, 1, 2]) // i 与 trace 下标严格对齐
    // T0：顶点上 → 偏差 0、垂足即自身
    expect(ds[0].deviationM).toBeCloseTo(0, 6)
    expect(ds[0].matchedLatLng[0]).toBeCloseTo(49, 6)
    expect(ds[0].matchedLatLng[1]).toBeCloseTo(8.4, 6)
    // T1：正北偏移 0.0001° ≈ 11.12m，垂足为段中点 (49, 8.415)
    expect(ds[1].deviationM).toBeCloseTo(11.12, 1)
    expect(ds[1].matchedLatLng[0]).toBeCloseTo(49, 5)
    expect(ds[1].matchedLatLng[1]).toBeCloseTo(8.415, 5)
    // T2：端点外 → 夹回顶点，偏差 ≈ 0.01° lng（局部平面口径 730.9m，haversine 729.5m）
    expect(ds[2].deviationM).toBeCloseTo(729.5, -1)
    expect(ds[2].matchedLatLng[0]).toBeCloseTo(49, 6)
    expect(ds[2].matchedLatLng[1]).toBeCloseTo(8.4, 6)
    // headingDeg / speedMps 原样透传
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
})

describe('derive (e2e: real fixture 0011 + real trace)', () => {
  it('233 points, all deviationM < 50m (regression bound; pre-measured max 2.43m)', () => {
    const trace = trace0011 as unknown as TrajPoint[]
    const response = (f0011 as { response: ImportResponse }).response
    const ds = derive(trace, response)
    expect(ds).toHaveLength(233)
    for (let k = 0; k < ds.length; k++) {
      expect(ds[k].i).toBe(k) // i 与 trace 下标严格对齐
      expect(ds[k].deviationM).toBeGreaterThanOrEqual(0)
      expect(ds[k].deviationM).toBeLessThan(50)
      expect(ds[k].headingDeg).toBe(trace[k].headingDeg)
      expect(ds[k].speedMps).toBe(trace[k].speedMps)
    }
  })
})
