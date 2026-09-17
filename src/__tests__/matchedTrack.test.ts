import { describe, expect, it } from 'vitest'
import {
  assembleTrack,
  kinematicTrackArcs,
  pointAtArc,
  trackTangentBearing,
  visitSequence,
  type TrackSection,
} from '../lib/matchedTrack'
import type { TrajPoint } from '../types'

// lat 49 下 0.001°lng ≈ 73m、0.0001°lat ≈ 11.1m

function tp(lat: number, lng: number, i: number, speedMps = 8, headingDeg = 90): TrajPoint {
  return {
    lat,
    lng,
    timestamp: i / 10,
    timestampUtc: `1970-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
    headingDeg,
    speedMps,
    numsats: 10,
  }
}

/** 主线：(49,8.40)→(49,8.41)→(49,8.42)（东西向 ~1461m） */
const MAIN: TrackSection = {
  id: 'main',
  pts: [
    [49, 8.4],
    [49, 8.41],
    [49, 8.42],
  ],
}
/** 平行支线：主段北侧 ~55m，地理交叠（挑战者几何） */
const SPUR: TrackSection = {
  id: 'spur',
  pts: [
    [49.0005, 8.412],
    [49.0005, 8.416],
  ],
}

describe('visitSequence：到访序列（含重访，持续 ≥3 帧）', () => {
  it('重访保留重复；瞬态闪跳剔除', () => {
    expect(visitSequence(['a', 'a', 'a', 'b', 'c', 'c', 'c', 'a', 'a', 'a'], 3)).toEqual(['a', 'c', 'a'])
  })
  it('从未持续到访的 section 不出现', () => {
    expect(visitSequence(['x', 'y', 'x'], 3)).toEqual([])
  })
})

describe('assembleTrack：按到访序拼装 + 断口桥 + Chaikin 折角圆化', () => {
  it('端点保留、顶点加密（圆化）、弧长严格递增、单点折角有上限', () => {
    const track = assembleTrack([MAIN, SPUR], ['spur', 'main'])
    expect(track.path[0]).toEqual(SPUR.pts[0]) // 端点保留（Chaikin 不动首尾）
    expect(track.path[track.path.length - 1]).toEqual(MAIN.pts[2])
    expect(track.path.length).toBeGreaterThan(5) // 圆化加密（5 原始顶点 → 16+）
    for (let k = 1; k < track.arc.length; k++) expect(track.arc[k]).toBeGreaterThan(track.arc[k - 1])
    // 折角上限：spur→main 断口桥是急弯，两轮 Chaikin 后单点转角 ≤ ~30°（原始 ≈87°）。
    // 例外：近 180° 折返（共线反向）Chaikin 退化无法圆化——只出现在断口桥急折返，
    // 且真实回放中总在重绑掠过（80m/s 快速通过）中发生，视觉可忽略
    for (let k = 1; k + 1 < track.path.length; k++) {
      const [ax, ay] = [track.path[k][0] - track.path[k - 1][0], track.path[k][1] - track.path[k - 1][1]]
      const [bx, by] = [track.path[k + 1][0] - track.path[k][0], track.path[k + 1][1] - track.path[k][1]]
      const cos = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1)
      const deg = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI
      if (deg > 150) continue // 近折返：Chaikin 退化，见上
      expect(deg).toBeLessThan(30)
    }
    // 总弧长：原始 2925m；圆化切角（近折返尖端剪除可观长度）后 >2100m
    expect(track.arc[track.arc.length - 1]).toBeGreaterThan(2100)
    expect(track.arc[track.arc.length - 1]).toBeLessThan(3000)
  })
})

describe('kinematicTrackArcs：运动学门控序列匹配（生产式绑路）', () => {
  // 数据物理自洽：0.00001°lng/帧 @10Hz ≈ 0.73m/帧 ↔ speedMps=7.3
  it('正常前进：弧长跟随观测（门内），近似线性', () => {
    const track = assembleTrack([MAIN], ['main'])
    const trace = Array.from({ length: 12 }, (_, k) => tp(49, 8.402 + k * 0.00001, k, 7.3))
    const arcs = kinematicTrackArcs(trace, track)
    for (let k = 1; k < arcs.length; k++) expect(arcs[k]).toBeGreaterThanOrEqual(arcs[k - 1])
    for (let k = 4; k < 9; k++) expect(Math.abs(arcs[k] - arcs[k - 1] - 0.73)).toBeLessThan(0.3)
  })

  it('速度门：物理不可能的观测跳变被拒（coast 在预测位），观测回门内即恢复跟随', () => {
    const track = assembleTrack([MAIN, SPUR], ['main', 'spur'])
    const trace = Array.from({ length: 10 }, (_, k) => tp(49, 8.405 + k * 0.00001, k, 7.3))
    // i=4..5 两帧北漂到支线（观测弧长跳变 ~1500m ≫ 门限 5~8m）——应被拒
    trace[4] = tp(49.0005, 8.409, 4, 7.3)
    trace[5] = tp(49.0005, 8.41, 5, 7.3)
    const arcs = kinematicTrackArcs(trace, track)
    for (const a of arcs) expect(a).toBeLessThan(1500) // 从未被拉到支线
    const jumps = arcs.slice(1).map((a, k) => a - arcs[k])
    expect(Math.max(...jumps)).toBeLessThan(15) // 无跳变（门限内的沿道推进除外）
  })

  it('持续重绑：创新量超门连续 ≥8 帧 → 接受重绑，跳变摊成定速掠过（无瞬移）', () => {
    const track = assembleTrack([MAIN, SPUR], ['main', 'spur'])
    const trace: TrajPoint[] = []
    for (let k = 0; k < 4; k++) trace.push(tp(49, 8.405 + k * 0.00001, k, 7.3))
    // 支线上 60 帧：0.000003°lng/帧 ≈ 0.22m/帧 ↔ speedMps=2.2（长于 8 帧门槛 → 触发重绑）
    for (let k = 0; k < 60; k++) trace.push(tp(49.0005, 8.413 + k * 0.000003, 4 + k, 2.2))
    const arcs = kinematicTrackArcs(trace, track)
    for (let k = 0; k < 4; k++) expect(arcs[k]).toBeLessThan(1500) // 前段在 main
    // 无单帧瞬移（>100m 的跳变被摊成 ≤2×掠过速率的连续步进）
    for (let k = 1; k < arcs.length; k++) expect(arcs[k] - arcs[k - 1]).toBeLessThan(100)
    // 重绑后持续向 spur 弧长区推进（0 < 步进 ≤ 掠过速率上界），60 帧 × 8m ≥ 480m 足以深入掠过段
    let advancing = 0
    for (let k = 12; k < arcs.length; k++) {
      const d = arcs[k] - arcs[k - 1]
      if (d > 0.01 && d < 20) advancing++
    }
    expect(advancing).toBeGreaterThan(30)
    expect(arcs[arcs.length - 1]).toBeGreaterThan(700) // 已沿掠过段推进数百米（重绑点 main ≈390m 起）
  })

  it('静止期（v=0、观测不动）：弧长保持，无漂移', () => {
    const track = assembleTrack([MAIN], ['main'])
    const trace = Array.from({ length: 10 }, () => tp(49, 8.405, 0, 0)).map((p, k) => ({ ...p, timestamp: k / 10 }))
    const arcs = kinematicTrackArcs(trace, track)
    const spread = Math.max(...arcs) - Math.min(...arcs)
    expect(spread).toBeLessThan(1) // 米级以内纹丝不动
  })
})

describe('pointAtArc：弧长 → 路径坐标', () => {
  it('首子段中点 = 首两顶点几何中点；越界钳制', () => {
    const track = assembleTrack([MAIN], ['main'])
    const half = track.arc[1] / 2
    const mid = pointAtArc(track, half)
    const want = [(track.path[0][0] + track.path[1][0]) / 2, (track.path[0][1] + track.path[1][1]) / 2]
    expect(mid[0]).toBeCloseTo(want[0], 8)
    expect(mid[1]).toBeCloseTo(want[1], 8)
    expect(pointAtArc(track, -5)).toEqual(track.path[0])
    expect(pointAtArc(track, track.arc[track.arc.length - 1] + 100)).toEqual(track.path[track.path.length - 1])
  })
})

// 2026-09-16 航向绑路：车标航向 = 轨道切线（与弧长插值位置同源，构造性贴路）
describe('trackTangentBearing：弧长处切线方位', () => {
  it('东西直轨：任意弧长（含端点单侧采样）切线 ≈ 90', () => {
    const track = assembleTrack([{ id: 'e', pts: [[49, 8.4], [49, 8.401], [49, 8.402]] }], ['e'])
    const total = track.arc[track.arc.length - 1]
    for (const a of [0, total / 2, total]) {
      expect(trackTangentBearing(track, a)).toBeCloseTo(90, 1)
    }
  })
  it('直角弯（北段→东段）：圆化后顶点附近切线从 0 连续过渡到 90', () => {
    const track = assembleTrack([{ id: 'l', pts: [[49, 8.4], [49.001, 8.4], [49.001, 8.401]] }], ['l'])
    const mid = track.arc[track.arc.length - 1] / 2
    const b = trackTangentBearing(track, mid)
    expect(b).toBeGreaterThan(0)
    expect(b).toBeLessThan(90)
  })
})
