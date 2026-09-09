import type { ImportResponse, TrajPoint } from '../types'

/** 降采样：≤500 点（API 上限 50000，取小 payload），首点天然保留、末点不在序列时追加；6 位小数（HERE polyline 精度） */
export function buildImportRequest(trace: TrajPoint[]): Array<{ lat: number; lng: number }> {
  const stride = Math.max(1, Math.ceil(trace.length / 500))
  const out: Array<{ lat: number; lng: number }> = []
  for (let i = 0; i < trace.length; i += stride) {
    out.push({ lat: round6(trace[i].lat), lng: round6(trace[i].lng) })
  }
  const last = trace[trace.length - 1]
  if (last && (trace.length - 1) % stride !== 0) out.push({ lat: round6(last.lat), lng: round6(last.lng) })
  return out
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6
}

/** 结构校验：routes[0].sections 非空且每段 polyline 非空、summary 数值在 */
function isValidImportResponse(r: unknown): r is ImportResponse {
  const sections = (r as ImportResponse)?.routes?.[0]?.sections
  if (!Array.isArray(sections) || sections.length === 0) return false
  return sections.every(
    (s) => typeof s?.polyline === 'string' && s.polyline.length > 0 && typeof s?.summary?.duration === 'number' && typeof s?.summary?.length === 'number',
  )
}

/** HERE Routing v8 /import：POST trace → 匹配路线（flexible polyline）。失败抛错，由 matchService 落回 fixture。 */
export async function importRoute(apikey: string, trace: TrajPoint[]): Promise<ImportResponse> {
  const url = `https://router.hereapi.com/v8/import?return=polyline,summary&transportMode=car&apikey=${encodeURIComponent(apikey)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trace: buildImportRequest(trace) }),
  })
  if (!res.ok) throw new Error(`here import failed: HTTP ${res.status}`)
  let parsed: unknown
  try {
    parsed = await res.json()
  } catch {
    throw new Error('here import failed: invalid response')
  }
  if (!isValidImportResponse(parsed)) throw new Error('here import failed: invalid response')
  return parsed
}
