import { importRoute } from './hereRouterClient'
import type { CacheEntry, TrajPoint } from '../types'

export function cacheKey(driveId: string): string {
  return `here-mm-cache:${driveId}`
}

/** 读缓存：miss / JSON 解析失败 / 存储异常一律静默降级返回 null */
export function readCache(driveId: string): CacheEntry | null {
  try {
    const raw = localStorage.getItem(cacheKey(driveId))
    return raw === null ? null : (JSON.parse(raw) as CacheEntry)
  } catch {
    return null
  }
}

/** 写缓存：超额（QuotaExceededError）等失败静默吞掉——缓存不可用不应打断主流程 */
export function writeCache(entry: CacheEntry): void {
  try {
    localStorage.setItem(cacheKey(entry.driveId), JSON.stringify(entry))
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
export async function matchService(driveId: string, opts?: MatchOptions): Promise<CacheEntry> {
  const cached = readCache(driveId)
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
      writeCache(entry)
      return entry
    } catch {
      /* live 失败 → 落回 fixture */
    }
  }
  return loadFixture(driveId)
}
