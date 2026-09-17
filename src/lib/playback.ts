/** Step2 回放时钟纯函数：rAF 帧推进 + 滑窗切片（无副作用，独立可测） */
import type { TrajPoint } from '../types'

/** 一帧推进：pos += dt × pps × speed，clamp 到 [0, lastIndex]。dt ≤ 0 不动（首帧基线防御）。 */
export function advancePlayback(
  pos: number,
  dtMs: number,
  speed: number,
  pps: number,
  lastIndex: number,
): number {
  if (dtMs <= 0) return pos
  const next = pos + (dtMs / 1000) * pps * speed
  return Math.min(Math.max(next, 0), lastIndex)
}

/** 滑动时间窗：取 series 中 t ∈ [tCur - windowSec, tCur] 的点（双端闭，绝不含未来点）；
 *  结果为空（tCur 早于首点）退回最后一个点，防图表空数据。 */
export function sliceWindow<T extends { t: number }>(
  series: readonly T[],
  tCur: number,
  windowSec: number,
): T[] {
  const from = tCur - windowSec
  const out = series.filter((p) => p.t >= from && p.t <= tCur)
  return out.length > 0 ? out : series.slice(-1)
}

/** 喷洒计划（HERE 路径）：已洒下标 → 相对 upTo 的增量。
 *  removeIdx = 已洒中超过 upTo 的（进度回拖 → 回收）；addIdx = 缺失的 stride 对齐下标（前进 → 补洒）。 */
export function sprayPlan(
  sprayed: readonly number[],
  upTo: number,
  stride: number,
): { removeIdx: number[]; addIdx: number[] } {
  const step = Math.max(1, Math.round(stride))
  const kept = new Set(sprayed.filter((i) => i <= upTo))
  const removeIdx = sprayed.filter((i) => i > upTo)
  const addIdx: number[] = []
  for (let i = 0; i <= upTo; i += step) if (!kept.has(i)) addIdx.push(i)
  return { removeIdx, addIdx }
}

/** 子帧插值（HTML teaser 同款算法）：pos 浮点 → 相邻两帧坐标线性插值。
 *  车标走传感器路径（demo 传 DR 增强轨迹）——matched 垂足序列在 MM 碎片化输出上会逐帧闪跳
 *  （2026-09-15 车标抖动诊断：0093 返回 4 个地理不相连 section，交叠区垂足 5–73m 摆动），
 *  匹配绑定由蓝线与偏差统计呈现。越界钳制到 [0, last]；i0===i1（末帧/单点）不外推。 */
export function interpCarPos(pos: number, trace: readonly TrajPoint[]): [number, number] {
  const last = trace.length - 1
  if (last < 0) return [0, 0]
  const clamped = Math.max(0, Math.min(pos, last))
  const i0 = Math.floor(clamped)
  const i1 = Math.min(i0 + 1, last)
  const frac = i0 === i1 ? 0 : clamped - i0
  return [
    trace[i0].lat + (trace[i1].lat - trace[i0].lat) * frac,
    trace[i0].lng + (trace[i1].lng - trace[i0].lng) * frac,
  ]
}

/** 航向最短弧插值：±180° 环绕处理后线性过渡。不取模——由调用方 yawToCompassDeg 归一。 */
export function interpHeadingDeg(h0: number, h1: number, frac: number): number {
  let d = h1 - h0
  if (d > 180) d -= 360
  if (d < -180) d += 360
  return h0 + d * frac
}
