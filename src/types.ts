/** KITTI 轨迹点（trajectory_light.json 元素，契约测试见 trajectories.test.ts） */
export interface TrajPoint {
  lat: number
  lng: number
  timestamp: number
  timestampUtc: string
  headingDeg: number
  speedMps: number
  numsats: number
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

/** 派生：每轨迹点 → 匹配路径上的垂足与横向偏差（import API 无逐点 linkId/confidence） */
export interface DerivedPoint {
  i: number
  matchedLatLng: [number, number]
  deviationM: number
  headingDeg: number
  speedMps: number
}

/** localStorage 与 fixture 共用 schema；key = `here-mm-cache:{driveId}` */
export interface CacheEntry {
  driveId: string
  source: 'live' | 'mock'
  createdAt: string
  response: ImportResponse
  derived: DerivedPoint[]
}
