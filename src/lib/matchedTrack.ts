/** P3 车标轨道：HERE MM 响应 → 可行驶连续轨道 + 运动学门控序列匹配（生产式绑路）。
 *  背景（2026-09-15 车标抖动诊断）：v8 import 在退化轨迹上返回的 section 地理互不相连、
 *  拼接序 ≠ 驾驶序；无记忆的逐帧最近投影会在交叠区闪跳（单帧 5–73m，折算车速数百 m/s）。
 *  生产导航 MM 是带运动模型的时序滤波器——这里补上同样的机制：
 *  预测 arc += v·dt，观测超出门限（物理不可能）则 coast 在预测位，持续超限才重绑（真实换段）。
 *  车标按弧长插值 → 横向位置恒在轨道上（构造性绑路），噪声只进入沿道速率并被门限约束。 */
import { decodeFlexiblePolyline } from './flexiblePolyline'
import { bearingDeg, haversineM, nearestOnPolyline, type LatLng } from './geo'
import type { ImportResponse, TrajPoint } from '../types'

export interface TrackSection {
  id: string
  pts: LatLng[]
}

/** 可行驶轨道：path = 到访序 section 顶点（相邻 section 间断口即直线桥）；arc = 顶点累计弧长 */
export interface MatchedTrack {
  path: LatLng[]
  arc: number[]
}

/** 到访序列（含重访）：逐帧 section 归属压缩成游程，持续 ≥ sustained 帧的游程按出现顺序保留。
 *  重访的 section 以独立轨道段再次出现——弧长沿驾驶时间推进，避免"回到首次到访位置"的跨段回跳。
 *  瞬态闪跳（< sustained 帧）不引入 section；从未持续到访的 section 不上车标轨道。 */
export function visitSequence(sectionPerPoint: string[], sustained = 3): string[] {
  const seq: string[] = []
  let runSec: string | null = null
  let runLen = 0
  const flush = (): void => {
    if (runSec !== null && runLen >= sustained) seq.push(runSec)
  }
  for (const s of sectionPerPoint) {
    if (s === runSec) runLen++
    else {
      flush()
      runSec = s
      runLen = 1
    }
  }
  flush()
  return seq
}

/** 按到访序拼接 section；跨 section 相邻顶点天然形成直线桥（arc 表体现桥长）。
 *  去重共端点/零长段，保证 arc 严格递增。
 *  拼接后做两轮 Chaikin 折角圆化：MM polyline 顶点稀疏（实测 16° 弯道仅 1 个顶点，
 *  车标过顶点方向瞬变 = 相对弯曲路面的横向摆动——2026-09-15 t≈12s 垂直抖动确诊）；
 *  圆化保端点、方向连续，车过弯如真实道路几何。 */
export function assembleTrack(sections: TrackSection[], order: string[]): MatchedTrack {
  const raw: LatLng[] = []
  for (const id of order) {
    const sec = sections.find((s) => s.id === id)
    if (!sec) continue
    for (const p of sec.pts) {
      const last = raw[raw.length - 1]
      if (last && haversineM(last, p) < 0.01) continue // 共端点/重复顶点
      raw.push([...p] as LatLng)
    }
  }
  let path = raw
  for (let round = 0; round < 2 && path.length > 2; round++) {
    const next: LatLng[] = [[...path[0]] as LatLng]
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i]
      const b = path[i + 1]
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25])
      next.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75])
    }
    next.push([...path[path.length - 1]] as LatLng)
    path = next
  }
  const arc: number[] = [0]
  for (let i = 1; i < path.length; i++) arc.push(arc[i - 1] + haversineM(path[i - 1], path[i]))
  return { path, arc }
}

/** 段投影（局部平面）：返回垂足与距离 */
function projectSeg(p: LatLng, path: LatLng[], s: number): { foot: LatLng; distM: number } {
  const o = path[s]
  const b = path[s + 1]
  const latM = 111320
  const cosLat = Math.cos((o[0] * Math.PI) / 180)
  const px = (p[1] - o[1]) * latM * cosLat
  const py = (p[0] - o[0]) * latM
  const bx = (b[1] - o[1]) * latM * cosLat
  const by = (b[0] - o[0]) * latM
  const len2 = bx * bx + by * by
  const t = Math.max(0, Math.min(1, len2 === 0 ? 0 : (px * bx + py * by) / len2))
  return { foot: [o[0] + (b[0] - o[0]) * t, o[1] + (b[1] - o[1]) * t], distM: Math.hypot(px - t * bx, py - t * by) }
}

/** 全轨最近投影 → 弧长 */
function nearestArc(p: LatLng, track: MatchedTrack): number {
  let best = Infinity
  let seg = 0
  for (let s = 0; s < track.path.length - 1; s++) {
    const d = projectSeg(p, track.path, s).distM
    if (d < best) {
      best = d
      seg = s
    }
  }
  return track.arc[seg] + segArcT(track, seg, p)
}

/** 段内参数 t → 弧长（线性插值） */
function segArcT(track: MatchedTrack, seg: number, p: LatLng): number {
  const o = track.path[seg]
  const b = track.path[seg + 1]
  const latM = 111320
  const cosLat = Math.cos((o[0] * Math.PI) / 180)
  const px = (p[1] - o[1]) * latM * cosLat
  const py = (p[0] - o[0]) * latM
  const bx = (b[1] - o[1]) * latM * cosLat
  const by = (b[0] - o[0]) * latM
  const len2 = bx * bx + by * by
  const t = Math.max(0, Math.min(1, len2 === 0 ? 0 : (px * bx + py * by) / len2))
  return t * (track.arc[seg + 1] - track.arc[seg])
}

const REBIND_FRAMES = 8 // 创新量持续超门帧数（0.8s）才重绑——短暂歧义期车标 coast 在预测位
const REBIND_DWELL = 50 // 重绑落定后的锁定帧数（5s）——换路成本，抑制碎片间 ~1Hz 扇动（生产 MM 的转移代价同款）
const SPEED_MARGIN = 1.5 // 拒绝门 = max(速度余量, 最小门)：门外观测物理不可能 → coast/重绑计数
const MIN_GATE_M = 5
const ANCHOR_GAIN = 0.08 // 门内弱锚定：arc = pred + innov×g——速率 = IMU 速度 + g×innov，
// 位置误差 ~12 帧（1.2s）指数收敛；DR 步伐游走（dispSpeed 门控切换）不再直接变成车速脉动
const SWEEP_M_PER_FRAME = 8 // 重绑跳变摊成的掠过速率（80m/s）：车标+相机连续移动，无瞬移、无瓦片空白

/** 运动学门控序列匹配：逐帧输出车标弧长（米）。
 *  预测 pred = arc + v·dt（沿轨道前进）；观测 = 全轨最近投影弧长。
 *  |obs − pred| ≤ gate → 跟随观测；超门 → coast 在 pred（拒绝物理不可能的跳变），
 *  连续 REBIND_FRAMES 帧超门 → 接受一次干净重绑（真实换段/重访）。 */
export function kinematicTrackArcs(trace: readonly TrajPoint[], track: MatchedTrack): number[] {
  const lastSeg = track.path.length - 2
  if (lastSeg < 0) return trace.map(() => 0)
  const out: number[] = []
  let arc = -1
  let rebind = 0
  let dwell = 0 // 重绑后的锁定倒计时
  for (let i = 0; i < trace.length; i++) {
    const p: LatLng = [trace[i].lat, trace[i].lng]
    const dt = i > 0 ? Math.max(0, trace[i].timestamp - trace[i - 1].timestamp) : 0
    const v = Math.min(Math.max(trace[i].speedMps, 0), 40)
    // DR 1Hz 锚定余量（2026-09-17，0042 t≈34s 车标一顿一顿根因）：DR 是 10Hz 预测/1Hz 锚定，
    // 高速下 1s 积分误差累积成单帧 12.8m 级锚定跳变（0042 25.6m/s；0096 8m/s 仅 ~3m 不可见）。
    // 跳变超窄门 → 拒绝→重绑循环 → 弧长以 ~1Hz「平滑-猛跳」推进（米级、与 zoom/倍速无关，
    // 用户实测放大到最大仍顿）。0.5×v = 1s 锚定流积分误差当量：0096（4m<5m）与 0093
    // （5-7.5m≈原 5m）不受影响，67m 级真实换段仍被拒绝走重绑。
    // 注意：中值预平滑对此无效——锯齿是周期性台阶（单调斜坡），中值只延迟透传（实测证伪）。
    const gate = Math.max(SPEED_MARGIN * v * dt, MIN_GATE_M, v * 0.5)
    const obs = nearestArc(p, track)
    if (arc < 0) {
      arc = obs // 首帧初始化
    } else {
      const pred = arc + v * dt
      const innov = obs - pred
      if (Math.abs(innov) <= gate) {
        arc = pred + innov * ANCHOR_GAIN // 门内：步伐跟随 IMU 速度，观测弱锚定纠位置误差
        rebind = 0
      } else if (dwell > 0) {
        arc = pred // 驻留锁定：coast，等待落定（换路成本期）
      } else {
        rebind++
        if (rebind >= REBIND_FRAMES) {
          arc = obs // 持续超门且不在驻留期：真实换段，接受重绑
          rebind = 0
          dwell = REBIND_DWELL
        } else {
          arc = pred // coast：拒绝物理不可能的观测
        }
      }
    }
    if (dwell > 0) dwell--
    out.push(arc)
  }
  // 5 点中值平滑：消单帧沿道离群；边缘帧用原值（端点精确）。
  // 试过中心化均值窗与 IIR 指数跟随压速率脉动：前者短序列边缘伪影，后者对秒级
  // 低频速度漂移无效（CV 45→42%）且与掠过后处理互相干扰产生杂步——均已回退
  const med = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b)
    return s[Math.floor(s.length / 2)]
  }
  const smoothed = out.map((v, i) => (i < 2 || i > out.length - 3 ? v : med(out.slice(i - 2, i + 3))))
  // 重绑跳变 → 定速掠过（SWEEP_M_PER_FRAME）：瞬移会让车标/相机/瓦片三者失配（闪烁），
  // 摊成连续移动后三者同步；dwell(50帧) > 任何掠过时长，不会与下一次重绑重叠
  for (let i = 1; i < smoothed.length; i++) {
    const jump = smoothed[i] - smoothed[i - 1]
    if (Math.abs(jump) <= SWEEP_M_PER_FRAME) continue // 正常行驶步长 ≤ ~1m，重绑/中值过渡杂步 >8m 才需要摊
    const n = Math.ceil(Math.abs(jump) / SWEEP_M_PER_FRAME)
    for (let k = 0; k < n && i + k < smoothed.length; k++) {
      smoothed[i + k] = smoothed[i - 1] + (jump * (k + 1)) / n
    }
    i += n - 1 // 掠过期内不再检测
  }
  return smoothed
}

/** 弧长 → 轨道坐标（线性插值；越界钳制到端点） */
export function pointAtArc(track: MatchedTrack, arcM: number): LatLng {
  const { path, arc } = track
  const t = Math.max(0, Math.min(arcM, arc[arc.length - 1]))
  let i = 1
  while (i < arc.length - 1 && arc[i] < t) i++
  const span = arc[i] - arc[i - 1]
  const f = span === 0 ? 0 : (t - arc[i - 1]) / span
  return [path[i - 1][0] + (path[i][0] - path[i - 1][0]) * f, path[i - 1][1] + (path[i][1] - path[i - 1][1]) * f]
}

/** 弧长处切线方位（从北顺时针）：取 a±ε 两点连线方位，端点钳制后单侧采样仍指前进方向。
 *  ε = max(0.5m, 总弧长×1e-4)：亚帧尺度，平滑过 Chaikin 圆化弯道。
 *  2026-09-16 航向绑路：车标位置走 pointAtArc、航向走本函数——同源构造性贴路，
 *  不再采信退化数据集（0093）漂移 4→180° 的 IMU headingDeg。 */
export function trackTangentBearing(track: MatchedTrack, arcM: number): number {
  const total = track.arc[track.arc.length - 1]
  const eps = Math.max(0.5, total * 1e-4)
  const p1 = pointAtArc(track, Math.max(0, arcM - eps))
  const p2 = pointAtArc(track, Math.min(total, arcM + eps))
  return bearingDeg(p1, p2)
}

/** 点在 section polyline 上的弧长位置（米）；空/单点段守卫返回 0 */
function arcOnSection(p: LatLng, pts: LatLng[]): number {
  if (pts.length < 2) return 0
  const { segIndex, foot } = nearestOnPolyline(p, pts)
  let s = 0
  for (let i = 0; i < segIndex; i++) s += haversineM(pts[i], pts[i + 1])
  return s + haversineM(pts[segIndex], foot)
}

function sectionLenM(pts: LatLng[]): number {
  let s = 0
  for (let i = 0; i + 1 < pts.length; i++) s += haversineM(pts[i], pts[i + 1])
  return s
}

/** 停滞重访去伪（2026-09-17，0042-t60/t120 车标乱跑根因）：
 *  MM 响应相邻 section 地理贴近（桩段贴主段尾端 ~40m）时，隧道恢复期 DR 抖动使
 *  逐帧投影在两段 polyline 间闪跳 → 到访序列出现伪重访 → assembleTrack 把主段
 *  复制两遍织出 2.7× 弧长的幻影轨道，车标锚错副本（帧 0 落在弧 4488 而非 ~0）
 *  倒行、横穿幻影断桥（实测横向 1514m，t=0.7s 起）。
 *  判据 = 「重访游程的段内跨度」：游程首末帧投影在该 section 上的弧长差。
 *  伪重访实测跨度 0-73m（车原地/微动，0093 五个重访 ≤15m）；真重驾 96%/295m
 *  （0042 末段 307m 桩段的完整再行驶）。阈值 max(8m, 5%×段长) 居中隔离两侧。
 *  跨度可忽略的重访不复制几何——其帧投影回落到已有弧段，滤波门自然吸收。 */
export function dropStalledRevisits(
  trace: readonly TrajPoint[],
  sections: TrackSection[],
  sectionPerPoint: string[],
  sustained = 3,
): string[] {
  const runs: { id: string; from: number; to: number }[] = []
  let cur: string | null = null
  let start = 0
  for (let i = 0; i <= sectionPerPoint.length; i++) {
    if (sectionPerPoint[i] !== cur) {
      if (cur !== null && i - start >= sustained) runs.push({ id: cur, from: start, to: i - 1 })
      cur = sectionPerPoint[i]
      start = i
    }
  }
  const seen = new Set<string>()
  const order: string[] = []
  for (const r of runs) {
    const sec = sections.find((s) => s.id === r.id)
    if (!sec) continue
    if (seen.has(r.id)) {
      const span = Math.abs(
        arcOnSection([trace[r.to].lat, trace[r.to].lng], sec.pts) -
          arcOnSection([trace[r.from].lat, trace[r.from].lng], sec.pts),
      )
      if (span < Math.max(8, 0.05 * sectionLenM(sec.pts))) continue // 停滞伪重访：不复制几何
    }
    seen.add(r.id)
    if (order[order.length - 1] !== r.id) order.push(r.id)
  }
  return order
}

/** 响应 + 轨迹 → 车标轨道：解码全部 section，按驾驶到访序（含重访）拼装。 */
export function buildMatchedTrack(trace: readonly TrajPoint[], response: ImportResponse): MatchedTrack | null {
  const sections: TrackSection[] = []
  const path: LatLng[] = []
  const segSection: string[] = []
  for (const route of response.routes)
    for (const sec of route.sections) {
      const pts = decodeFlexiblePolyline(sec.polyline) as LatLng[]
      sections.push({ id: sec.id, pts })
      for (const c of pts) {
        path.push(c)
        segSection.push(sec.id)
      }
    }
  if (path.length < 2) return null
  const sectionPerPoint = trace.map((p) => {
    try {
      return segSection[nearestOnPolyline([p.lat, p.lng], path).segIndex]
    } catch {
      return ''
    }
  })
  const order = dropStalledRevisits(trace, sections, sectionPerPoint, 3)
  if (order.length === 0) return null
  return assembleTrack(sections, order)
}
