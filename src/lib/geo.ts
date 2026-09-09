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
