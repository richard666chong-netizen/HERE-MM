// Step3: VITE_HERE_KEY 存在时改走 HereRouterClient，失败回落 fixture
import type { CacheEntry } from '../types'

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

/**
 * 双层缓存取数：localStorage 命中直接返回；未命中回落 public/fixtures。
 * derive(trace, response) 不在本层做——由 App 层组合并 writeCache 回填，避免反向依赖 trace 加载。
 */
export async function matchService(driveId: string): Promise<CacheEntry> {
  const cached = readCache(driveId)
  if (cached) return cached
  return loadFixture(driveId)
}
