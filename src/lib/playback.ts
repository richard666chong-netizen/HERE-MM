/** Step2 回放时钟纯函数：rAF 帧推进 + 滑窗切片（无副作用，独立可测） */

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
