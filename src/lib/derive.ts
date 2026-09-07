import type { DerivedPoint, ImportResponse, TrajPoint } from '../types'
import { decodeFlexiblePolyline } from './flexiblePolyline'
import { nearestOnPolyline, type LatLng } from './geo'

/** 解码全部 section polyline 顺序拼接为匹配路径；逐 trace 点最近投影，heading/speed 原样透传。 */
export function derive(trace: TrajPoint[], response: ImportResponse): DerivedPoint[] {
  const path: LatLng[] = []
  for (const route of response.routes)
    for (const sec of route.sections) path.push(...decodeFlexiblePolyline(sec.polyline))
  return trace.map((p, i) => {
    const { foot, distM } = nearestOnPolyline([p.lat, p.lng], path)
    return { i, matchedLatLng: foot, deviationM: distM, headingDeg: p.headingDeg, speedMps: p.speedMps }
  })
}
