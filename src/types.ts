/** KITTI 轨迹点（lat/lng/heading/speed/timestamp + GNSS 质量） */
export interface TrajPoint {
  lat: number
  lng: number
  timestamp: number
  timestampUtc: string
  headingDeg: number
  speedMps: number
  numsats: number
  posmode?: number
  noFix?: boolean
}

/** HERE Routing v8 /import 响应（本应用实际消费的子集；response 字段整体入库不裁剪） */
export interface ImportSection {
  id: string
  type: string
  polyline: string
  summary: { duration: number; length: number; baseDuration?: number }
}

export interface ImportResponse {
  routes: { id: string; sections: ImportSection[] }[]
  notices?: unknown[]
}

/** 派生：每轨迹点 → 匹配路径上的垂足与横向偏差 */
export interface DerivedPoint {
  i: number
  matchedLatLng: [number, number]
  deviationM: number
  headingDeg: number
  speedMps: number
  /** 该点投影所在 section 的 id（import API 返回的 route section id） */
  linkId: string
}

/** localStorage 与 fixture 共用 schema；key = `here-mm-cache:{driveId}` */
export interface CacheEntry {
  driveId: string
  source: 'live' | 'mock'
  createdAt: string
  response: ImportResponse
  derived: DerivedPoint[]
}
