import { importRoute } from './hereRouterClient'
import type { CacheEntry, TrajPoint } from '../types'

/** `variant` 用于按「仿真隧道时长」分档（`t60` 等）：请求体随隧道变化，共用一档会让旋钮改了仍命中旧缓存。
 *  缺省空串 = 无隧道，键与 Step5 完全一致（既有轨迹零回归）。 */
export function cacheKey(driveId: string, variant = ''): string {
  return variant ? `here-mm-cache:${driveId}:${variant}` : `here-mm-cache:${driveId}`
}

/** 读缓存：miss / JSON 解析失败 / 存储异常一律静默降级返回 null */
export function readCache(driveId: string, variant = ''): CacheEntry | null {
  try {
    const raw = localStorage.getItem(cacheKey(driveId, variant))
    return raw === null ? null : (JSON.parse(raw) as CacheEntry)
  } catch {
    return null
  }
}

/** 写缓存：超额（QuotaExceededError）等失败静默吞掉——缓存不可用不应打断主流程 */
export function writeCache(entry: CacheEntry, variant = ''): void {
  try {
    localStorage.setItem(cacheKey(entry.driveId, variant), JSON.stringify(entry))
  } catch {
    /* 静默降级 */
  }
}

export async function loadFixture(driveId: string): Promise<CacheEntry> {
  try {
    const res = await fetch(`/fixtures/${driveId}.json`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as CacheEntry
  } catch {
    throw new Error(`fixture load failed: ${driveId}`)
  }
}

export interface MatchOptions {
  apikey: string
  trace: TrajPoint[]
}

/**
 * 双层缓存取数：localStorage 命中直接返回；未命中时有 opts（apikey+trace）先走 live（spec L61-62），
 * live 失败静默落回 fixture（spec L98：live 不可用不打断演示）；derive 不在本层做——App 层组合回填。
 */
export async function matchService(
  driveId: string,
  opts?: MatchOptions,
  variant = '',
): Promise<CacheEntry> {
  const cached = readCache(driveId, variant)
  if (cached) return cached
  if (opts) {
    try {
      const response = await importRoute(opts.apikey, opts.trace)
      const entry: CacheEntry = {
        driveId,
        source: 'live',
        createdAt: new Date().toISOString(),
        response,
        derived: [],
      }
      writeCache(entry, variant)
      return entry
    } catch {
      /* live 失败 → 落回 fixture */
    }
  }
  return loadFixture(driveId)
}
