import { describe, expect, it } from 'vitest'
import {
  assembleTrack,
  dropStalledRevisits,
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

describe('dropStalledRevisits：停滞重访去伪（2026-09-17 0042-t60 乱跑根因）', () => {
  /** 主段尾部的桩段（~511m；0042-t60 的 307m 桩段贴主段尾端 ~40m） */
  const TAIL: TrackSection = {
    id: 'tail',
    pts: [
      [49, 8.413],
      [49, 8.416],
      [49, 8.42],
    ],
  }
  /** 按 labels 造 trace：每帧 lng = start + (i - from)×step（lat 恒 49） */
  function traceAt(frames: { from: number; n: number; lng0: number; dLng: number }[]): TrajPoint[] {
    const total = frames.reduce((s, f) => Math.max(s, f.from + f.n), 0)
    const out: TrajPoint[] = []
    for (let i = 0; i < total; i++) {
      const f = frames.find((x) => i >= x.from && i < x.from + x.n)!
      out.push(tp(49, f.lng0 + (i - f.from) * f.dLng, i))
    }
    return out
  }

  it('0042-t60 形态：主段全程 → 桩段停滞闪跳 → 主段尾微动伪重访 → 桩段真重驾 → [main, tail]', () => {
    // 主段 8.400→8.412（~876m 全程）；桩段 10 帧原地（span 0）；主段重访漂 58m（<5%×1463=73m → 弃）；
    // 桩段终段 8.4135→8.4195（~440m > 5%×511 → 留）
    const trace = traceAt([
      { from: 0, n: 31, lng0: 8.4, dLng: 0.0004 },
      { from: 31, n: 10, lng0: 8.4165, dLng: 0 },
      { from: 41, n: 10, lng0: 8.4165, dLng: 0.00008 },
      { from: 51, n: 40, lng0: 8.4135, dLng: 0.00015 },
    ])
    const labels = [
      ...Array(31).fill('main'),
      ...Array(10).fill('tail'),
      ...Array(10).fill('main'),
      ...Array(40).fill('tail'),
    ]
    expect(dropStalledRevisits(trace, [MAIN, TAIL], labels)).toEqual(['main', 'tail'])
  })
  it('真重驾保留：重访段内跨度 > max(8m, 5%×段长) → 重复出现（0093 语义）', () => {
    const trace = traceAt([
      { from: 0, n: 21, lng0: 8.4, dLng: 0.0005 },
      { from: 21, n: 10, lng0: 49.0005, dLng: 0 }, // 停在支线（SPUR 标签）
      { from: 31, n: 20, lng0: 8.41, dLng: 0.0007 }, // 主段重驾 ~102m > 73m
    ])
    const labels = [...Array(21).fill('main'), ...Array(10).fill('spur'), ...Array(20).fill('main')]
    expect(dropStalledRevisits(trace, [MAIN, SPUR], labels)).toEqual(['main', 'spur', 'main'])
  })
  it('0093 形态：原地停滞的重访（span 0）→ 丢弃', () => {
    const trace = traceAt([
      { from: 0, n: 21, lng0: 8.4, dLng: 0.0005 },
      { from: 21, n: 5, lng0: 49.0005, dLng: 0 },
      { from: 26, n: 10, lng0: 8.4105, dLng: 0 }, // 主段上原地不动
    ])
    const labels = [...Array(21).fill('main'), ...Array(5).fill('spur'), ...Array(10).fill('main')]
    expect(dropStalledRevisits(trace, [MAIN, SPUR], labels)).toEqual(['main', 'spur'])
  })
  it('相邻重复合并（丢弃后产生 main,main）', () => {
    const trace = traceAt([
      { from: 0, n: 21, lng0: 8.4, dLng: 0.0005 },
      { from: 21, n: 5, lng0: 49.0005, dLng: 0 },
      { from: 26, n: 10, lng0: 8.4105, dLng: 0 },
      { from: 36, n: 10, lng0: 49.0006, dLng: 0.0002 },
    ])
    const labels = [...Array(21).fill('main'), ...Array(5).fill('spur'), ...Array(10).fill('main'), ...Array(10).fill('spur')]
    expect(dropStalledRevisits(trace, [MAIN, SPUR], labels)).toEqual(['main', 'spur'])
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
  it('DR 1Hz 锚定锯齿被观测预平滑吸收（2026-09-17 0042 t≈34s 顿挫根因）：无猛跳无长停滞', () => {
    const track = assembleTrack([MAIN], ['main'])
    // 25.6m/s = 2.56m/帧；DR 1Hz 锚定锯齿：9 帧走 1.56m + 每 10 帧跳 +10m（均值守恒）。
    // 12.8m 级单帧跳变 > 5m 门 → 拒绝→重绑循环 → 弧长 ~1Hz「平滑-猛跳」（用户实测一顿一顿，
    // 与 zoom/speed 无关、0096 8m/s 锯齿 <3m 不触发）
    const FRAME = 0.0000351 // ≈2.56m/帧
    const SAW = 0.000137 // ≈10m
    const trace: TrajPoint[] = []
    let lng = 8.402
    for (let i = 0; i < 60; i++) {
      lng += i % 10 === 0 && i > 0 ? SAW : (FRAME * 9) / 10
      trace.push(tp(49, lng, i, 25.6))
    }
    const arcs = kinematicTrackArcs(trace, track)
    const steps: number[] = []
    for (let i = 13; i < 57; i++) steps.push(arcs[i] - arcs[i - 1])
    expect(Math.max(...steps)).toBeLessThan(4.2) // 无重绑级猛跳
    expect(Math.min(...steps)).toBeGreaterThan(1.2) // 无拒绝期长停滞
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
