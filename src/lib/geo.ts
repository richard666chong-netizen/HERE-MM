export type LatLng = [number, number] // [lat, lng]

const R_EARTH_M = 6371008.8
const DEG = Math.PI / 180

export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = (b[0] - a[0]) * DEG
  const dLng = (b[1] - a[1]) * DEG
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * DEG) * Math.cos(b[0] * DEG) * Math.sin(dLng / 2) ** 2
  return 2 * R_EARTH_M * Math.asin(Math.sqrt(s))
}

/** 局部平面近似（origin 为原点的等距圆柱投影）——城市尺度段长(<100m)误差毫米级。
 *  Task 7 起导出：SvgFallback 以 bbox 中心为原点复用同一投影，避免两套实现分叉。 */
export function toLocalM(p: LatLng, origin: LatLng): [number, number] {
  const mPerDegLat = 111132.92 - 559.82 * Math.cos(2 * origin[0] * DEG)
  const mPerDegLng = 111412.84 * Math.cos(origin[0] * DEG)
  return [(p[1] - origin[1]) * mPerDegLng, (p[0] - origin[0]) * mPerDegLat]
}

function toLatLng(p: [number, number], origin: LatLng): LatLng {
  const mPerDegLat = 111132.92 - 559.82 * Math.cos(2 * origin[0] * DEG)
  const mPerDegLng = 111412.84 * Math.cos(origin[0] * DEG)
  return [origin[0] + p[1] / mPerDegLat, origin[1] + p[0] / mPerDegLng]
}

/** KITTI oxts yaw（deg：0=东、逆时针）→ 罗盘航向（deg：0=北、顺时针）。车标渲染专用。 */
export function yawToCompassDeg(yawDeg: number): number {
  return ((90 - yawDeg) % 360 + 360) % 360
}

/** 两点位移方位角（从北顺时针，0..360）：等距圆柱局部平面投影。
 *  同点（零位移）返回 0 不抛错——调用方（车标航向回退）保证相邻帧一般非零。
 *  2026-09-16 航向绑路：车标航向源 = 轨道切线 / carTrace 位移方位，替代漂移可达 180° 的退化 IMU。 */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const latM = 111320
  const cosLat = Math.cos(((a[0] + b[0]) / 2) * (Math.PI / 180))
  const x = (b[1] - a[1]) * latM * cosLat
  const y = (b[0] - a[0]) * latM
  if (x === 0 && y === 0) return 0
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360
}

export function nearestOnPolyline(p: LatLng, path: LatLng[]): { foot: LatLng; distM: number; segIndex: number } {
  if (path.length === 0) throw new Error('empty path')
  if (path.length === 1) return { foot: [...path[0]] as LatLng, distM: haversineM(p, path[0]), segIndex: 0 }
  let best = { foot: [...path[0]] as LatLng, distM: Infinity, segIndex: 0 }
  for (let i = 0; i + 1 < path.length; i++) {
    const origin = path[i]
    const [px, py] = toLocalM(p, origin)
    const [ax, ay] = [0, 0]
    const [bx, by] = toLocalM(path[i + 1], origin)
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy
    let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2
    t = Math.max(0, Math.min(1, t))
    const fx = ax + t * dx, fy = ay + t * dy
    const distM = Math.hypot(px - fx, py - fy)
    if (distM < best.distM) best = { foot: toLatLng([fx, fy], origin), distM, segIndex: i }
  }
  return best
}

/** 基于实际时间戳的抽稀：按 intervalS 秒间隔取首个到达/超过目标时刻的点。
 *  轨迹总时长不足 intervalS 时退化为 Math.ceil(n/maxPoints) 的等间隔 stride，
 *  保证小数据集仍有多点。始终保留首尾点。 */
export function thinByTimestamp(timestamps: number[], intervalS: number, maxPoints = 200): number[] {
  if (timestamps.length === 0) return []
  const out: number[] = [0]
  const t0 = timestamps[0]
  const totalS = timestamps[timestamps.length - 1] - t0
  if (totalS <= 0) {
    const stride = Math.max(1, Math.ceil(timestamps.length / maxPoints))
    for (let i = stride; i < timestamps.length; i += stride) out.push(i)
    if (out[out.length - 1] !== timestamps.length - 1) out.push(timestamps.length - 1)
    return out
  }
  const stride = Math.max(intervalS, totalS / maxPoints)
  let nextTarget = t0 + stride
  for (let i = 1; i < timestamps.length; i++) {
    if (timestamps[i] >= nextTarget - 1e-9) {
      out.push(i)
      nextTarget += stride
    }
  }
  if (out[out.length - 1] !== timestamps.length - 1) out.push(timestamps.length - 1)
  return out
}
