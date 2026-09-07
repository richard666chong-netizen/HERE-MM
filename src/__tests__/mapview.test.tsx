import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import MapView from '../components/MapView'
import type { DerivedPoint, TrajPoint } from '../types'

// mapStatus='ok' 路径不在本层测：HERE SDK 需真实浏览器环境（jsdom 不加载外部脚本），
// 由 T8 Step 5 真实 key 手动验收覆盖（计划 Task 7 Step 1 注明）。

function tp(lat: number, lng: number): TrajPoint {
  return { lat, lng, timestamp: 0, timestampUtc: '2026-09-07T00:00:00Z', headingDeg: 0, speedMps: 0, numsats: 6 }
}

function dp(i: number, lat: number, lng: number): DerivedPoint {
  return { i, matchedLatLng: [lat, lng], deviationM: 0, headingDeg: 0, speedMps: 0 }
}

describe('MapView fallback（SvgFallback）路径', () => {
  it("mapStatus='fallback'：svg 存在、matched-path 非空、gnss-dot=3（不触发抽稀）、endpoint-marker=2", () => {
    const trace = [tp(49.0, 8.4), tp(49.01, 8.405), tp(49.02, 8.41)]
    const derived = [dp(0, 49.0, 8.4), dp(1, 49.01, 8.405), dp(2, 49.02, 8.41)]
    const { container } = render(<MapView trace={trace} derived={derived} mapStatus="fallback" apikey="" />)

    expect(container.querySelector('svg')).toBeTruthy()

    const path = container.querySelector('[data-testid="matched-path"]')
    expect(path).toBeTruthy()
    expect(path?.getAttribute('points')).toMatch(/\S/) // 非空折线

    expect(container.querySelectorAll('[data-testid="gnss-dot"]').length).toBe(3) // 3 点不触发抽稀
    expect(container.querySelectorAll('[data-testid="endpoint-marker"]').length).toBe(2)
  })

  it('viewBox 宽高比符合等距圆柱投影（x 乘 cos(midLat)），±5%', () => {
    // 已知 bbox 的 2 点 trace：Δlat = 0.1、Δlng = 0.01、midLat = 49.05°
    const trace = [tp(49.0, 8.4), tp(49.1, 8.41)]
    const { container } = render(<MapView trace={trace} derived={[]} mapStatus="fallback" apikey="" />)

    const viewBox = container.querySelector('svg')?.getAttribute('viewBox')
    expect(viewBox).toBeTruthy()
    const parts = (viewBox as string).trim().split(/\s+/).map(Number)
    const w = parts[2]
    const h = parts[3]

    const midLatRad = ((49.0 + 49.1) / 2) * (Math.PI / 180)
    const expected = (0.01 * Math.cos(midLatRad)) / 0.1
    expect(w / h).toBeGreaterThan(expected * 0.95)
    expect(w / h).toBeLessThan(expected * 1.05)
  })
})
