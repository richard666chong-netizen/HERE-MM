import type { DerivedPoint, ImportResponse, TrajPoint } from '../types'
import { decodeFlexiblePolyline } from './flexiblePolyline'
import { nearestOnPolyline, type LatLng } from './geo'
import { buildMatchedTrack, kinematicTrackArcs } from './matchedTrack'

/** 解码全部 section polyline 顺序拼接为匹配路径；逐 trace 点最近投影，heading/speed 原样透传。
 *  segIndex 回查 vertexSectionId 得到该投影所在 section 的 id（linkId）。
 *  另建车标轨道并做运动学门控序列匹配（trackArcM）——垂足序列在 MM 碎片交叠区逐帧闪跳
 *  （2026-09-15 车标抖动诊断），轨道弧长是物理连续的，供回放层做"绑路"车标插值。 */
export function derive(trace: TrajPoint[], response: ImportResponse): DerivedPoint[] {
  const path: LatLng[] = []
  const vertexSectionId: string[] = []
  for (const route of response.routes)
    for (const sec of route.sections) {
      const coords = decodeFlexiblePolyline(sec.polyline)
      for (const c of coords) {
        vertexSectionId.push(sec.id)
        path.push(c)
      }
    }
  const track = buildMatchedTrack(trace, response)
  const arcs = track ? kinematicTrackArcs(trace, track) : []
  return trace.map((p, i) => {
    const { foot, distM, segIndex } = nearestOnPolyline([p.lat, p.lng], path)
    return {
      i,
      matchedLatLng: foot,
      deviationM: distM,
      headingDeg: p.headingDeg,
      speedMps: p.speedMps,
      linkId: vertexSectionId[segIndex],
      trackArcM: arcs[i],
    }
  })
}
