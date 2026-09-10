import { describe, expect, it } from 'vitest'
import trace0033 from '../../public/sample/here/2011_09_30_drive_0033.json'
import trace0093 from '../../public/sample/here/2011_09_26_drive_0093.json'
import drArtifact from '../../public/sample/here/2011_09_26_drive_0093.dr.json'
import { deadReckon, detectOutages } from '../lib/deadReckoning'
import { haversineM } from '../lib/geo'
import type { TrajPoint } from '../types'

/**
 * 度↔米换算与算法本体严格一致：dLat = m/111320、dLng = m/(111320·cos(49°))，
 * 故直线/圆弧真值按同一式构造时预测与 GNSS 几何自洽（V1 偏差 ~1e-9 m）。
 * haversineM（R=6371008.8 → 111194.9 m/deg lat）读这些度偏移比 111320 制约小 0.11%：
 * 40m 实读 39.955、5m 实读 4.994 —— 因此米制断言用 1 位小数容差（±0.05m）。
 */
const DEG = Math.PI / 180
const ORIGIN: [number, number] = [49.0, 8.4] // [lat, lng]
const M_PER_DEG_LAT = 111320

const toLatLng = (eastM: number, northM: number): [number, number] => [
  ORIGIN[0] + northM / M_PER_DEG_LAT,
  ORIGIN[1] + eastM / (M_PER_DEG_LAT * Math.cos(ORIGIN[0] * DEG)),
]

interface Frame {
  eastM: number
  northM: number // 真值位置（米，相对 ORIGIN）
  gnssEastM?: number
  gnssNorthM?: number // GNSS 位置（缺省 = 真值）
  yawDeg: number // KITTI yaw：0=东、逆时针
  speedMps: number
  numsats: number
}

const buildTrace = (frames: Frame[]): TrajPoint[] =>
  frames.map((f, i) => {
    const g = toLatLng(f.gnssEastM ?? f.eastM, f.gnssNorthM ?? f.northM)
    return {
      lat: g[0],
      lng: g[1],
      timestamp: i * 0.1,
      timestampUtc: new Date(i * 100).toISOString(),
      headingDeg: f.yawDeg,
      speedMps: f.speedMps,
      numsats: f.numsats,
    }
  })

const basePoint: TrajPoint = {
  lat: 49, lng: 8.4, timestamp: 0, timestampUtc: '', headingDeg: 0, speedMps: 0, numsats: 0,
}

describe('deadReckoning（多速率 1:10 航位推算）', () => {
  it('V1 直线可信段：输出与 GNSS 逐点锁步 ≤0.5m，历元 innovation=0 且 corrected', () => {
    const trace = buildTrace(
      Array.from({ length: 60 }, (_, i) => ({ eastM: i, northM: 0, yawDeg: 0, speedMps: 10, numsats: 10 })),
    )
    const { positions, corrected, innovations } = deadReckon(trace)
    for (let i = 0; i < 60; i++) {
      expect(haversineM(positions[i], [trace[i].lat, trace[i].lng])).toBeLessThanOrEqual(0.5)
    }
    for (const i of [0, 10, 20, 30, 40, 50]) {
      expect(corrected[i]).toBe(true)
      expect(innovations[i]).toBeCloseTo(0, 6)
    }
    for (const i of [1, 15, 59]) {
      expect(corrected[i]).toBe(false)
      expect(innovations[i]).toBe(0)
    }
  })

  it('V2 失锁外推：GNSS 冻结后输出继续东向推进 40 帧×0.1s×10m/s = 40m±1m', () => {
    const trace = buildTrace(
      Array.from({ length: 60 }, (_, i) => ({
        eastM: Math.min(i, 19), // 帧 20–59 GNSS 冻结在帧 19 位置
        northM: 0,
        yawDeg: 0,
        speedMps: 10,
        numsats: i < 20 ? 10 : 3,
      })),
    )
    const { positions, corrected, innovations } = deadReckon(trace)
    expect(haversineM(positions[59], positions[19])).toBeCloseTo(40, 1)
    expect(haversineM(positions[59], [trace[59].lat, trace[59].lng])).toBeCloseTo(40, 1)
    expect(haversineM(positions[19], [trace[19].lat, trace[19].lng])).toBeCloseTo(0, 6) // 失锁前锁步
    for (const i of [20, 30, 40, 50]) expect(corrected[i]).toBe(false)
    for (let i = 20; i < 60; i++) expect(innovations[i]).toBe(0) // 不可信历元 = 跳过
  })

  it('V3 1Hz 纠回：5m 北偏阶跃 → 残差 5·0.7=3.5m、5·0.7²=2.45m（残差 = 更新后与带偏 GNSS 的距离 = 剩余 innovation）', () => {
    const trace = buildTrace(
      Array.from({ length: 60 }, (_, i) => ({
        eastM: i,
        northM: 0,
        gnssNorthM: i < 10 ? 0 : 5, // 帧 10 起 GNSS = 真值 + 5m 恒定北偏（阶跃，非恒定——恒定会被帧 0 初始化吸收）
        yawDeg: 0,
        speedMps: 10,
        numsats: 10,
      })),
    )
    const { positions, corrected, innovations } = deadReckon(trace)
    expect(innovations[10]).toBeCloseTo(5, 1) // 第 1 历元更新前 |gnss−p|
    expect(haversineM(positions[10], [trace[10].lat, trace[10].lng])).toBeCloseTo(3.5, 1)
    expect(innovations[20]).toBeCloseTo(3.5, 1)
    expect(haversineM(positions[20], [trace[20].lat, trace[20].lng])).toBeCloseTo(2.45, 1)
    expect(corrected[10]).toBe(true)
    expect(corrected[20]).toBe(true)
    expect(corrected[15]).toBe(false)
  })

  it('V4 圆周外推：ω=36°/s 恒角速度、失锁 30 帧，终点与手算圆弧终点差 ≤2% 弧长（30m）', () => {
    const W = 36 // deg/s：0.1s/帧 → 3.6°/帧，10s=100 帧整圈
    const V = 10
    const DT = 0.1
    // 真值 = 恒角速度圆的离散弦多边形（每帧 1m、方向 = 该帧切向 ψ_k）——GNSS 与 DR 预测步同构，历元 innovation=0
    const poly: Array<[number, number]> = [[0, 0]]
    for (let k = 1; k < 50; k++) {
      const a = W * DT * k * DEG
      poly.push([poly[k - 1][0] + V * DT * Math.cos(a), poly[k - 1][1] + V * DT * Math.sin(a)])
    }
    const trace = buildTrace(
      Array.from({ length: 50 }, (_, i) => ({
        eastM: i < 20 ? poly[i][0] : poly[19][0],
        northM: i < 20 ? poly[i][1] : poly[19][1],
        yawDeg: W * DT * i,
        speedMps: V,
        numsats: i < 20 ? 10 : 3,
      })),
    )
    const { positions, corrected } = deadReckon(trace)
    // 手算圆弧终点（闭式几何级数，独立于实现的逐步累加）：Σ_{k=1}^{49} 1m·e^{iδk}
    //   = e^{iδ·25}·sin(49δ/2)/sin(δ/2)，δ = 3.6°
    const d = W * DT * DEG
    const arcLen = V * DT * 30 // 失锁段弧长 30m
    const mag = Math.sin((49 * d) / 2) / Math.sin(d / 2)
    const hand = toLatLng(Math.cos(25 * d) * mag, Math.sin(25 * d) * mag)
    expect(haversineM(positions[49], hand)).toBeLessThanOrEqual(0.02 * arcLen) // 实测 ~7e-5 m
    // 几何旁证：与连续解析圆弧终点（自失锁起点、heading 68.4°、转 108°、R=v/ω）差 0.81m=2.70% 弧长
    // —— 预测取端点航向 ψ_k（钉死规则）对连续圆有 δ/2 系统偏差，2% 在该读法下不可达；见任务报告
    const R = V / (W * DEG)
    const a19 = W * DT * 19 * DEG
    const a49 = W * DT * 49 * DEG
    const analytic = toLatLng(
      poly[19][0] + R * (Math.sin(a49) - Math.sin(a19)),
      poly[19][1] + R * (Math.cos(a19) - Math.cos(a49)),
    )
    expect(haversineM(positions[49], analytic)).toBeLessThanOrEqual(1.05) // 实测 0.808 m
    expect(corrected.filter((c, i) => i % 10 === 0 && c)).toEqual([true, true]) // 历元 0/10 可信，20/30/40 失锁
  })

  it('V5 detectOutages：numsats ≤ 阈值逐点判定 + 真实轨迹负向锁定', () => {
    const mk = (numsats: number): TrajPoint => ({ ...basePoint, numsats })
    expect(detectOutages([10, 10, 3, 3, 10].map(mk))).toEqual([false, false, true, true, false])
    expect(detectOutages([5, 4].map(mk))).toEqual([false, true]) // 边界：≤4 失锁
    const t33 = trace0033 as unknown as TrajPoint[]
    const t93 = trace0093 as unknown as TrajPoint[]
    expect(detectOutages(t33).every((o) => !o)).toBe(true) // 0033 全程 min 5 星 → 全 false
    expect(detectOutages(t93).filter(Boolean).length).toBeGreaterThanOrEqual(100) // 实测 206/433
  })

  it('V6 前导失锁：帧 0 GNSS 播种后纯递推（非 GNSS 透传），帧 30 起可信历元被 gain 纠回', () => {
    const trace = buildTrace(
      Array.from({ length: 60 }, (_, i) => ({
        eastM: i,
        northM: 0,
        gnssNorthM: i < 30 ? 1 + (2 * i) / 29 : 0, // GNSS 北偏漂移 1m→3m；帧 30 起无偏
        yawDeg: 0,
        speedMps: 10,
        numsats: i < 30 ? 3 : 10,
      })),
    )
    const { positions, corrected, innovations } = deadReckon(trace)
    // 帧 0–29：输出 = 播种位置（真值+1m 北偏）的平滑预测 —— 与真值恒差 1m，不透传漂移中的 GNSS
    for (const i of [0, 15, 29]) {
      expect(haversineM(positions[i], toLatLng(i, 0))).toBeCloseTo(1, 1)
    }
    // 与 GNSS 分离随漂移单调增长；帧 15–29 逐点 ≥1m（1.03→2.00m；平滑 0→3m 漂移下帧 1 分离必 <1m，见报告）
    let prev = -Infinity
    for (let i = 1; i < 30; i++) {
      const sep = haversineM(positions[i], [trace[i].lat, trace[i].lng])
      expect(sep).toBeGreaterThanOrEqual(prev)
      if (i >= 15) expect(sep).toBeGreaterThanOrEqual(1)
      prev = sep
    }
    for (const i of [0, 10, 20]) {
      expect(corrected[i]).toBe(false)
      expect(innovations[i]).toBe(0)
    }
    // 帧 30 起可信历元纠回：北偏 1m → 0.7 → 0.49 → 0.343
    expect(corrected[30]).toBe(true)
    expect(innovations[30]).toBeCloseTo(1, 1)
    expect(haversineM(positions[30], toLatLng(30, 0))).toBeCloseTo(0.7, 1)
    expect(haversineM(positions[40], toLatLng(40, 0))).toBeCloseTo(0.49, 1)
    expect(haversineM(positions[50], toLatLng(50, 0))).toBeCloseTo(0.343, 1)
  })

  it('SMOKE 真实 0093：无 NaN，失锁段内 DR−GNSS 分离 >5m（最大分离落在长失锁段末尾，人审指标）', () => {
    const t93 = trace0093 as unknown as TrajPoint[]
    const { positions } = deadReckon(t93)
    expect(positions.flat().every(Number.isFinite)).toBe(true)
    const outages = detectOutages(t93)
    let maxIn = -1
    let maxAll = -1
    let argAll = -1
    for (let i = 0; i < t93.length; i++) {
      const s = haversineM(positions[i], [t93[i].lat, t93[i].lng])
      if (outages[i]) maxIn = Math.max(maxIn, s)
      if (s > maxAll) {
        maxAll = s
        argAll = i
      }
    }
    expect(maxIn).toBeGreaterThan(5)
    // 人审：全局最大分离 131m @ idx239（7 星）——紧随帧 0–238 全程 ≤6 星（44 历元仅 4 次可信）的长失锁段
    console.log(
      `[smoke 0093] maxSep=${maxAll.toFixed(1)}m @ idx ${argAll} (numsats=${t93[argAll].numsats}), maxSep within outage=${maxIn.toFixed(1)}m`,
    )
  })

  // Step4 T4: py/TS 同步验证——scripts/rerecord-0093-dr.py 复刻 deadReckon 落盘 artifact，
  // TS 逐点 haversine ≤0.1m 比对。py 复刻参数漂移即红。
  it('py artifact 同步：TS deadReckon(0093).positions 与 artifact 逐点 haversine ≤0.1m', () => {
    const t93 = trace0093 as unknown as TrajPoint[]
    const { positions } = deadReckon(t93)
    const artifact = drArtifact as unknown as Array<[number, number]>
    expect(artifact.length).toBe(positions.length)
    let maxDev = 0
    for (let i = 0; i < positions.length; i++) {
      const d = haversineM(positions[i], artifact[i])
      if (d > maxDev) maxDev = d
    }
    expect(maxDev).toBeLessThanOrEqual(0.1)
    console.log(`[py-sync 0093] maxDev=${maxDev.toFixed(6)}m (≤0.1m threshold)`)
  })
})
