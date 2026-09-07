import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CacheEntry } from '../types'
// 测试代码豁免静态 import public/（src 运行时路径禁止，见 Global Constraints）
import f0011 from '../../public/fixtures/2011_09_26_drive_0011.json'
import { cacheKey, loadFixture, matchService, readCache, writeCache } from './fixtureStore'

const entry0011 = f0011 as CacheEntry

// 测试隔离（计划评审补充）：jsdom localStorage 跨测试持久，逐例清空；fetch 桩逐例拆除
beforeEach(() => localStorage.clear())
afterEach(() => vi.unstubAllGlobals())

describe('cacheKey', () => {
  it('is `here-mm-cache:{driveId}`', () => {
    expect(cacheKey('2011_09_26_drive_0011')).toBe('here-mm-cache:2011_09_26_drive_0011')
  })
})

describe('localStorage cache layer', () => {
  it('writeCache → readCache roundtrip', () => {
    writeCache(entry0011)
    expect(readCache('2011_09_26_drive_0011')).toEqual(entry0011)
  })
  it('readCache miss returns null', () => {
    expect(readCache('2011_09_26_drive_0011')).toBeNull()
  })
  it('corrupted JSON silently degrades to null', () => {
    localStorage.setItem(cacheKey('2011_09_26_drive_0011'), '{not-json')
    expect(readCache('2011_09_26_drive_0011')).toBeNull()
  })
})

describe('loadFixture', () => {
  it('fetches /fixtures/<driveId>.json and returns the entry', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => entry0011 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(loadFixture('2011_09_26_drive_0011')).resolves.toEqual(entry0011)
    expect(fetchMock).toHaveBeenCalledWith('/fixtures/2011_09_26_drive_0011.json')
  })
  it('non-200 throws `fixture load failed: <driveId>`', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })))
    await expect(loadFixture('missing_drive')).rejects.toThrow('fixture load failed: missing_drive')
  })
  it('JSON parse failure throws `fixture load failed: <driveId>`', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token')
        },
      })),
    )
    await expect(loadFixture('bad_drive')).rejects.toThrow('fixture load failed: bad_drive')
  })
})

describe('matchService', () => {
  it('cache hit returns entry without touching fetch', async () => {
    writeCache(entry0011) // 显式先写唯一 driveId，红绿不依赖用例执行顺序
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(matchService('2011_09_26_drive_0011')).resolves.toEqual(entry0011)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('cache miss falls back to fixture fetch and returns entry', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => entry0011 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(matchService('2011_09_26_drive_0011')).resolves.toEqual(entry0011)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/fixtures/2011_09_26_drive_0011.json')
  })
})
