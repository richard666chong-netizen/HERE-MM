import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeBasemap } from '../lib/hereLoader'

describe('probeBasemap（底图瓦片可达性探测）', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('瓦片可达（200）→ true，且请求打到底图矢量瓦片端点、带 apikey', async () => {
    let seen = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        seen = String(input)
        return { ok: true, status: 200 } as Response
      }),
    )
    expect(await probeBasemap('test-key')).toBe(true)
    expect(seen).toContain('vector.hereapi.com/v2/vectortiles/base/mc/') // 端点漂移即红
    expect(seen).toContain('apikey=test-key')
  })

  it('瓦片被拒（403：key 无效或额度用尽）→ false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403 }) as Response))
    expect(await probeBasemap('test-key')).toBe(false)
  })

  it('网络层失败（VPN / DNS 劫持 → 请求 reject）→ false，不抛', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('net::ERR_NAME_NOT_RESOLVED'))),
    )
    expect(await probeBasemap('test-key')).toBe(false)
  })

  it('请求挂起（VPN 黑洞丢包）→ 超时 abort 后 false，不抛', async () => {
    // 桩按真实 fetch 语义响应 signal：不 abort 就永不 settle → 本用例会挂到测试超时
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('AbortError')))
          }),
      ),
    )
    expect(await probeBasemap('test-key', 20)).toBe(false)
  })

  it('空 apikey → false，且不发请求', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    expect(await probeBasemap('')).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })
})
