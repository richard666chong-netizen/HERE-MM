import type { DerivedPoint, TrajPoint } from '../types'
import { haversineM } from './geo'

/** 偏差汇总：均值 / p95（最近秩法 sorted[ceil(0.95n)-1]）/ 最大。空输入抛 Error('empty')。 */
export function deviationStats(ds: DerivedPoint[]): { meanM: number; p95M: number; maxM: number } {
  if (ds.length === 0) throw new Error('empty')
  const sorted = ds.map((d) => d.deviationM).sort((a, b) => a - b)
  const meanM = sorted.reduce((sum, v) => sum + v, 0) / sorted.length
  const p95M = sorted[Math.ceil(0.95 * sorted.length) - 1]
  const maxM = sorted[sorted.length - 1]
  return { meanM, p95M, maxM }
}

/**
 * 等宽直方图，值域 0..max。边界约定（计划锁定）：半开区间 fromM ≤ v < toM，
 * 末 bin 右闭（max 值经 clamp 落入末 bin）；max=0 时返回 binCount 个零宽 count=0 bin（无 NaN）。
 */
export function deviationHistogram(
  ds: DerivedPoint[],
  binCount = 20,
): { bins: { fromM: number; toM: number; count: number }[] } {
  const max = ds.reduce((m, d) => Math.max(m, d.deviationM), 0)
  const width = max / binCount
  const bins = Array.from({ length: binCount }, (_, k) => ({
    fromM: k * width,
    toM: (k + 1) * width,
    count: 0,
  }))
  if (max === 0) return { bins } // 守卫：避免 v/width = 0/0 = NaN
  for (const d of ds) {
    const idx = Math.min(Math.floor(d.deviationM / width), binCount - 1)
    bins[idx].count++
  }
  return { bins }
}

/** 偏差-里程曲线：distanceM = 沿 trace 的 haversine 累计里程，与 ds 按下标对齐。 */
export function deviationVsDistance(
  ds: DerivedPoint[],
  trace: TrajPoint[],
): { distanceM: number; deviationM: number }[] {
  const at = (k: number) => [trace[k].lat, trace[k].lng] as [number, number]
  let acc = 0
  const out: { distanceM: number; deviationM: number }[] = []
  for (let k = 0; k < ds.length; k++) {
    if (k > 0) acc += haversineM(at(k - 1), at(k))
    out.push({ distanceM: acc, deviationM: ds[k].deviationM })
  }
  return out
}

/** 逐帧 DR 漂移序列：本地 DR 推算位置 vs OXTS 输出（真值侧）的 haversine。
 *  长度不齐按 Math.min 截断（HTML L608 口径）；切片最大值由调用侧 slice-max（实时切片语义）。 */
export function driftSeries(trace: TrajPoint[], drPositions: [number, number][]): number[] {
  const n = Math.min(trace.length, drPositions.length)
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    out.push(haversineM([trace[i].lat, trace[i].lng], drPositions[i]))
  }
  return out
}
