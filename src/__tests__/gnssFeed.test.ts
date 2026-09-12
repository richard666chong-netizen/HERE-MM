import { describe, expect, it } from 'vitest'
import { buildGnssFeed, TUNNEL_START_FRACTION } from '../lib/gnssFeed'
import type { TrajPoint } from '../types'

/** posmode === 0 表示接收机无定位解；缺省字段 = 未带该列的旧数据（0093） */
const pt = (lat: number, posmode: number | undefined, extra: Partial<TrajPoint> = {}): TrajPoint => ({
  lat,
  lng: 8.4,
  timestamp: 0,
  timestampUtc: '',
  headingDeg: 45,
  speedMps: 5,
  numsats: 2,
  ...(posmode === undefined ? {} : { posmode }),
  ...extra,
})

describe('buildGnssFeed（退化 GNSS 流）', () => {
  it('G1 失锁期冻结在最后一帧有效定位，恢复后回到实时位置', () => {
    const trace = [pt(1, 1), pt(2, 1), pt(3, 0), pt(4, 0), pt(5, 1), pt(6, 1)]
    expect(buildGnssFeed(trace).map((p) => p.lat)).toEqual([1, 2, 2, 2, 5, 6])
  })

  it('G2 帧 0 即失锁：按「帧 0 无条件播种」冻在帧 0 位置（不产生 undefined/NaN）', () => {
    const trace = [pt(1, 0), pt(2, 0), pt(3, 1)]
    const feed = buildGnssFeed(trace)
    expect(feed.map((p) => p.lat)).toEqual([1, 1, 3]) // 帧 0/1 冻在播种位置；帧 2 有解 → 回到实时
    expect(feed.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))).toBe(true)
  })

  it('G3 无 posmode 列的旧数据原样返回（0093 零回归）', () => {
    const trace = [pt(1, undefined), pt(2, undefined), pt(3, undefined)]
    expect(buildGnssFeed(trace)).toBe(trace)
  })

  it('G4 冻结只改位置：headingDeg/speedMps/numsats 逐帧透传（DR 的失锁期速度源在此）', () => {
    const trace = [pt(1, 1), pt(2, 0, { speedMps: 3.5, headingDeg: 12, numsats: 2 })]
    const feed = buildGnssFeed(trace)
    expect([feed[1].speedMps, feed[1].headingDeg, feed[1].numsats]).toEqual([3.5, 12, 2])
  })

  it('G5 全部失锁：全程冻在帧 0（0106 型「全程纯递推」输入）', () => {
    const trace = [pt(1, 0), pt(2, 0), pt(3, 0), pt(4, 0)]
    expect(buildGnssFeed(trace).map((p) => p.lat)).toEqual([1, 1, 1, 1])
  })

  // ── Step6 仿真隧道：GNSS 拒止时长 = 场景参数（轨迹/IMU 全真）──────────────
  // 10Hz 合成轨迹：lat = 帧号，便于逐帧断言冻结位置。
  const line = (n: number, posmode: number | undefined) =>
    Array.from({ length: n }, (_, i) => pt(i, posmode, { timestamp: i / 10 }))

  it('G6 窗口内冻结在窗口前最后一帧，窗口外原值（T=9.9s，窗口 [2.97, 4.97) → 帧 30–49 冻在帧 29）', () => {
    const trace = line(100, 1) // 全程有解，失锁完全来自仿真
    const feed = buildGnssFeed(trace, { tunnelDurationS: 2 })
    expect(feed[29].lat).toBe(29) // 窗口前最后一帧有效定位
    expect(feed[30].lat).toBe(29)
    expect(feed[49].lat).toBe(29)
    expect(feed[50].lat).toBe(50) // 窗口外原值
    expect(feed[0].lat).toBe(0)
  })

  it('G7 窗口起点 = 0.3·T（TUNNEL_START_FRACTION 钉死，跨实现不得漂移）', () => {
    const trace = line(100, 1)
    const feed = buildGnssFeed(trace, { tunnelDurationS: 1 })
    expect(TUNNEL_START_FRACTION).toBe(0.3)
    expect(feed[29].noFix).toBeUndefined() // 帧 29 = 2.9s < 2.97
    expect(feed[30].noFix).toBe(true) // 帧 30 = 3.0s ≥ 2.97
  })

  it('G8 超尾截断：时长超出剩余 → 冻结到末帧，不抛错', () => {
    const trace = line(100, 1)
    const feed = buildGnssFeed(trace, { tunnelDurationS: 100 })
    expect(feed[99].lat).toBe(29)
    expect(feed[99].noFix).toBe(true)
  })

  it('G9 真实失锁与仿真窗口叠加：窗口外的 posmode===0 照样冻结，窗口内的非失锁帧也被冻结', () => {
    const trace = line(100, 1)
    trace[10] = pt(10, 0, { timestamp: 1.0 }) // 窗口外的真实失锁
    const feed = buildGnssFeed(trace, { tunnelDurationS: 2 })
    expect(feed[10].noFix).toBe(true)
    expect(feed[10].lat).toBe(9) // 冻在帧 9
    expect(feed[30].noFix).toBe(true) // 窗口内 posmode=1 也被冻
    expect(feed[30].lat).toBe(29)
  })

  it('G10 noFix 覆盖两类失锁（仿真窗口 + 真实 posmode==0）；无 posmode 的旧轨迹原引用返回', () => {
    const withTunnel = buildGnssFeed(line(100, 1), { tunnelDurationS: 2 })
    expect(withTunnel.filter((p) => p.noFix).length).toBe(20) // 帧 30–49

    // 隧道关闭时真实失锁照样标记——0096/0106 的散点在失锁期消失就靠它
    const real = line(100, 1)
    real[5] = pt(5, 0, { timestamp: 0.5 })
    const realFeed = buildGnssFeed(real)
    expect(realFeed[5].noFix).toBe(true)
    expect(realFeed.filter((p) => p.noFix).length).toBe(1)

    // 0093 无 posmode 列且隧道关闭 → 原引用（零回归的硬保证）
    const legacy = line(20, undefined)
    expect(buildGnssFeed(legacy)).toBe(legacy)
  })
})
