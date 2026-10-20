import { importRoute } from './hereRouterClient'
import type { CacheEntry, TrajPoint } from '../types'

/** 缓存键版本：derive 算法变更（如车标轨道几何圆化、2026-09-17 停滞重访去伪、DR 1Hz 锚定门控余量）会使
 *  缓存里的 trackArcM 与新轨道弧长表错位——升版本强制重派生，旧键成为孤儿（清除缓存按钮可扫尾） */
const CACHE_VERSION = 'v4'

/** mock 缓存 TTL（2026-10-20 锐边修复，用户拍板方案 A）：live 失败落 fixture 的缓存条目超 24h 视为无缓存，
 *  下次加载自动重试 live（成功即转正回 LIVE）。live 源条目永不过期——一次成功永久命中，不再打 API。 */
const MOCK_CACHE_TTL_MS = 24 * 3600 * 1000

/** mock 条目是否已过 TTL。createdAt 非法（空串/坏格式）视为过期——偏向重试 live，而非永远吃存疑缓存。 */
function isMockCacheStale(entry: CacheEntry): boolean {
  const t = new Date(entry.createdAt).getTime()
  if (Number.isNaN(t)) return true
  return Date.now() - t > MOCK_CACHE_TTL_MS
}

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

export async function loadFixture(driveId: string, variant = ''): Promise<CacheEntry> {
  const suffix = variant ? `-${variant}` : ''
  // BASE_URL 前缀（尾随斜杠）：vite base 子路径部署（Pages /HERE-MM/）下运行时 fetch 必须自带
  // base，绝对路径打到域名根即 404（2026-10-20 线上实测）；base 为 '/' 时与旧路径逐字相同
  const base = import.meta.env.BASE_URL
  const urls = suffix
    ? [`${base}fixtures/${driveId}${suffix}.json`, `${base}fixtures/${driveId}.json`]
    : [`${base}fixtures/${driveId}.json`]
  for (const url of urls) {
    try {
      const res = await fetch(url)
      if (!res.ok) continue
      return (await res.json()) as CacheEntry
    } catch {
      // try next url
    }
  }
  throw new Error(`fixture load failed: ${driveId}${suffix}`)
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
  // live 条目：任何年龄都直接命中。mock 条目：24h 内免打扰（不打 API），超期重试 live 自愈
  if (cached && (cached.source === 'live' || !isMockCacheStale(cached))) return cached
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
  return loadFixture(driveId, variant)
}
