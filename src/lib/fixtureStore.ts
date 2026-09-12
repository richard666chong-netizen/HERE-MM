import { importRoute } from './hereRouterClient'
import type { CacheEntry, TrajPoint } from '../types'

export function cacheKey(driveId: string, variant = ''): string {
  return variant ? `here-mm-cache:${driveId}:${variant}` : `here-mm-cache:${driveId}`
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
