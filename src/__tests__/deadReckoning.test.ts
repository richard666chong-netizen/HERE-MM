import { describe, expect, it } from 'vitest'
import trace0033 from '../../public/sample/here/2011_09_30_drive_0033.json'
import trace0093 from '../../public/sample/here/2011_09_26_drive_0093.json'
import trace0096 from '../../public/sample/here/2011_09_26_drive_0096.json'
import trace0106 from '../../public/sample/here/2011_09_26_drive_0106.json'
import trace0042 from '../../public/sample/here/2011_10_03_drive_0042.json'
import drArtifact from '../../public/sample/here/2011_09_26_drive_0093.dr.json'
import { deadReckon, detectOutages } from '../lib/deadReckoning'
import { buildGnssFeed, TUNNEL_START_FRACTION } from '../lib/gnssFeed'
import { haversineM, nearestOnPolyline } from '../lib/geo'
import type { LatLng } from '../lib/geo'
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

  // Step5 修正：GNSS 冻结（位移≈0）与 GNSS 跳变（多径毛刺）必须分开回退——
  // 前者回退「当前」IMU/轮速（speedMps），后者才沿用上一帧合理速度。
  // 原实现两支都用 lastGoodSpeed，失锁期车速变化时 DR 会保持旧速度（0106 全程失锁会原地不动）。
  it('V7 冻结期速度回退：GNSS 冻结时用当前 IMU 轮速（3 m/s → 12m），非最后一次位移速度（10 m/s → 40m）', () => {
    const trace = buildTrace(
      Array.from({ length: 60 }, (_, i) => ({
        eastM: Math.min(i, 19), // 帧 20–59 GNSS 冻结在帧 19 位置
        northM: 0,
        yawDeg: 0,
        speedMps: i < 20 ? 10 : 3, // 冻结期真实车速降到 3 m/s（惯导/轮速仍有效）
        numsats: i < 20 ? 10 : 3,
      })),
    )
    const { positions, corrected } = deadReckon(trace)
    expect(haversineM(positions[19], [trace[19].lat, trace[19].lng])).toBeCloseTo(0, 6) // 失锁前锁步
    // 帧 20–59：40 帧 × 0.1s × 3 m/s = 12m（旧实现沿用 lastGoodSpeed=10 → 40m）
    expect(haversineM(positions[59], positions[19])).toBeCloseTo(12, 1)
    for (const i of [20, 30, 40, 50]) expect(corrected[i]).toBe(false)
  })

  it('V8 冻结期静止：IMU 轮速 ≈0（−0.03 静止噪声）→ DR 原地不动（旧实现沿用 10 m/s → 推进 40m）', () => {
    const trace = buildTrace(
      Array.from({ length: 60 }, (_, i) => ({
        eastM: Math.min(i, 19),
        northM: 0,
        yawDeg: 0,
        speedMps: i < 20 ? 10 : -0.03, // KITTI 静止段 GPS 测速噪声（实测最小 −0.03）
        numsats: i < 20 ? 10 : 3,
      })),
    )
    const { positions } = deadReckon(trace)
    expect(haversineM(positions[59], positions[19])).toBeCloseTo(0, 1)
  })

  // Step6：仿真隧道里接收机**没有定位解但卫星数照样高**（0042 是高速轨迹，卫星 8+ 常态）。
  // 只按 numsats 判可信度会让 1Hz 更新把 DR 反复拉回冻结位置——隧道根本不漂移。
  it('V9 noFix 纪元跳过更新：卫星 10 颗但无定位解 → corrected=false，DR 继续递推 40m', () => {
    const base = buildTrace(
      Array.from({ length: 60 }, (_, i) => ({
        eastM: Math.min(i, 19), // 帧 20 起 GNSS 冻结
        northM: 0,
        yawDeg: 0,
        speedMps: 10,
        numsats: 10, // 卫星数恒高——旧门控（numsats>6）会放行
      })),
    )
    const trace = base.map((p, i) => (i < 20 ? p : { ...p, noFix: true }))
    const { positions, corrected } = deadReckon(trace)
    for (const i of [20, 30, 40, 50]) expect(corrected[i]).toBe(false) // 旧实现此处为 true
    expect(haversineM(positions[59], positions[19])).toBeCloseTo(40, 1) // 10 m/s × 4s
    for (const i of [20, 30, 40, 50]) expect(positions[i].every(Number.isFinite)).toBe(true)
  })

  it('V10 门控对照（为什么必须改）：标 noFix → DR 跟住真值；不标 → 被摁在隧道口，落后真值 >10m', () => {
    const mk = (noFix: boolean) =>
      buildTrace(
        Array.from({ length: 60 }, (_, i) => ({
          eastM: Math.min(i, 19), // GNSS 帧 20 起冻结（车实际继续走到 59m）
          northM: 0,
          yawDeg: 0,
          speedMps: 10,
          numsats: 10,
        })),
      ).map((p, i) => (i < 20 || !noFix ? p : { ...p, noFix: true }))
    const errVsTruth = (trace: ReturnType<typeof mk>) => {
      const { positions } = deadReckon(trace)
      return haversineM(positions[59], toLatLng(59, 0))
    }
    // 1Hz 更新对冻结位置的平衡态是有界振荡（~24m 分离），并非"压回原处"——
    // 所以对照口径必须对着真值：DR 跟不住车，才是隧道失效的真正表现
    expect(errVsTruth(mk(true))).toBeLessThanOrEqual(1) // 自由递推，10 m/s × 4s 正好走到 59m
    expect(errVsTruth(mk(false))).toBeGreaterThan(10) // 被更新拽住，落后真值 ~15m
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

  // Step5 DR 精度回归：对着**可信真值**量 DR 误差。
  // 0096/0106 的失锁期 pos_accuracy ≤1.8m（INS 桥接保持可信）——这正是它们与 0093 的区别：
  // 0093 失锁期真值自身 ±21m（max 44.3m），DR 误差与真值误差无法分离，故 0093 不做精度断言。
  it('DR 精度 0096：失锁 35s/218m 自由递推误差 ≤13m，GNSS 恢复后 1Hz 更新纠回 ≤3m', () => {
    const t = trace0096 as unknown as TrajPoint[]
    const { positions, corrected } = deadReckon(buildGnssFeed(t))
    const err = t.map((p, i) => haversineM(positions[i], [p.lat, p.lng]))
    expect(Math.max(...err)).toBeLessThanOrEqual(13) // 实测 12.37 m @ t≈41s（线性漂移，占失锁里程 5.7%）
    expect(err[err.length - 1]).toBeLessThanOrEqual(3) // 实测 2.25 m（恢复后 5s 内纠回）
    expect(corrected.filter(Boolean).length).toBeGreaterThan(0) // 恢复段有可信历元
    expect(corrected[0]).toBe(false) // 帧 0 无定位解 → 播种但不更新
  })

  it('DR 精度 0106：全程无定位解 22.7s/114m（含 3 转弯）纯递推误差 ≤5m，且一次更新都没有', () => {
    const t = trace0106 as unknown as TrajPoint[]
    const { positions, corrected } = deadReckon(buildGnssFeed(t))
    const err = t.map((p, i) => haversineM(positions[i], [p.lat, p.lng]))
    expect(Math.max(...err)).toBeLessThanOrEqual(5) // 实测 4.39 m
    expect(corrected.some(Boolean)).toBe(false) // 全程 numsats=2 → 无可信历元
  })

  it('DR 空转反证：直接喂原始 OXTS（不冻结）时 DR 只复读真值——这是建 gnssFeed 的原因', () => {
    const t = trace0096 as unknown as TrajPoint[]
    const { positions } = deadReckon(t)
    const err = t.map((p, i) => haversineM(positions[i], [p.lat, p.lng]))
    expect(Math.max(...err)).toBeLessThanOrEqual(3) // 实测 2.51 m：失锁期 OXTS 是 INS 桥接解 ≈ 真值
  })

  // Step6 仿真隧道精度：宿主 0042（高速），60s 拒止 @30% 起点。
  // 度量用 nearestOnPolyline（DR 点 → 真值折线的最近距离 = 横向偏移，与渲染同源）——
  // 不能用 haversine：沿轨误差（里程标定偏差）看着也很大，但 DR 线其实还压在路上，MM 无事可做。
  it('DR 精度 0042（仿真隧道 60s）：横向漂出高速 ~59m，出隧道后回到路上', () => {
    const t = trace0042 as unknown as TrajPoint[]
    const { positions } = deadReckon(buildGnssFeed(t, { tunnelDurationS: 60 }))
    const truth: LatLng[] = t.map((p) => [p.lat, p.lng])
    const start = TUNNEL_START_FRACTION * t[t.length - 1].timestamp
    const end = start + 60
    let maxCross = 0
    for (let i = 0; i < t.length; i++) {
      if (t[i].timestamp < start || t[i].timestamp >= end) continue
      maxCross = Math.max(maxCross, nearestOnPolyline(positions[i] as LatLng, truth).distM)
    }
    const lastCross = nearestOnPolyline(positions[t.length - 1] as LatLng, truth).distM
    console.log(
      `[tunnel 0042] 隧道 ${start.toFixed(1)}–${end.toFixed(1)}s | 横向漂移 max=${maxCross.toFixed(1)}m | 末帧=${lastCross.toFixed(2)}m`,
    )
    expect(maxCross).toBeGreaterThanOrEqual(55) // 实测 59.x m —— 低于此说明门控/冻结之一失效
    expect(maxCross).toBeLessThanOrEqual(62) // 高于此说明 DR 数学被改动
    expect(lastCross).toBeLessThanOrEqual(2) // 出隧道 22s 内被 1Hz 更新纠回
  })

  // 隧道时长是场景参数：漂移随拒止时长增长，且**存在一个 MM 能力边界**——
  // 30s（横向 11m）仍在车道间距量级内，HERE 能绑对主路（fixture 即按 30s 录，见 fixtures.test）；
  // 60s（横向 59m）超出后 HERE 会跟着漂移匹配到旁路（实测 2 段 / max 49.85m）——这是量产里
  // MM 必须与 DR 紧耦合（map-aided）而非串行的直接证据。
  it('隧道时长可调：0042 @30s 横向 ≈11m（MM 边界内）vs @60s ≈59m（越界）', () => {
    const t = trace0042 as unknown as TrajPoint[]
    const start = TUNNEL_START_FRACTION * t[t.length - 1].timestamp
    const truth: LatLng[] = t.map((p) => [p.lat, p.lng])
    const maxCrossAt = (d: number) => {
      const { positions } = deadReckon(buildGnssFeed(t, { tunnelDurationS: d }))
      let m = 0
      for (let i = 0; i < t.length; i++) {
        if (t[i].timestamp < start || t[i].timestamp >= start + d) continue
        m = Math.max(m, nearestOnPolyline(positions[i] as LatLng, truth).distM)
      }
      return m
    }
    expect(maxCrossAt(30)).toBeGreaterThanOrEqual(8) // 实测 ~11m
    expect(maxCrossAt(30)).toBeLessThanOrEqual(15)
    expect(maxCrossAt(60)).toBeGreaterThanOrEqual(55) // 实测 58.6m
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
