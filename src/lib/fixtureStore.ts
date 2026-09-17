import { importRoute } from './hereRouterClient'
import type { CacheEntry, TrajPoint } from '../types'

/** 缓存键版本：derive 算法变更（如车标轨道几何圆化）会使缓存里的 trackArcM
 *  与新轨道弧长表错位——升版本强制重派生，旧键成为孤儿（清除缓存按钮可扫尾） */
const CACHE_VERSION = 'v2'

export function cacheKey(driveId: string, variant = ''): string {
  return variant ? `here-mm-cache:${CACHE_VERSION}:${driveId}:${variant}` : `here-mm-cache:${CACHE_VERSION}:${driveId}`
}

export function readCache(driveId: string, variant = ''): CacheEntry | null {
  try {
    const raw = localStorage.getItem(cacheKey(driveId, variant))
    if (raw === null) return null
    return JSON.parse(raw) as CacheEntry
  } catch {
    return null
  }
}

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
