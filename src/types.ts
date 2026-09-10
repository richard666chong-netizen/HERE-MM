/** KITTI 轨迹点（trajectory_light.json 元素，契约测试见 trajectories.test.ts） */
export interface TrajPoint {
  lat: number
  lng: number
  timestamp: number
  timestampUtc: string
  headingDeg: number
  speedMps: number
  numsats: number
  /** KITTI oxts posmode：0 = 接收机无定位解（失锁硬判据）。0011/0033/0093 的既有样本无此列。 */
  posmode?: number
  /** 该帧接收机无定位解（真实 posmode==0 或仿真隧道窗口内）——由 buildGnssFeed 标记。
   *  渲染层据此不画 GNSS 散点；deadReckon 据此跳过 1Hz 更新。 */
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
