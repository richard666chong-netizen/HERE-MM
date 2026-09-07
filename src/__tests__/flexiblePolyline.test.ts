import { describe, expect, it } from 'vitest'
// 测试代码豁免静态 import public/（src 运行时路径禁止，见 Global Constraints）
import f0011 from '../../public/fixtures/2011_09_26_drive_0011.json'
import { decodeFlexiblePolyline } from '../lib/flexiblePolyline'

// 官方向量（执行时从官方仓库逐字符抄录并手工核对，来源 URL 如下）：
// - encoded:  https://github.com/heremaps/flexible-polyline/blob/master/test/round_half_up/encoded.txt （第 1、8 行）
// - decoded:  https://github.com/heremaps/flexible-polyline/blob/master/test/round_half_up/decoded.txt （第 1、8 行）
// - README 示例: https://github.com/heremaps/flexible-polyline （precision 5, 无第三维）

describe('decodeFlexiblePolyline', () => {
  it('official vector round_half_up #1 (含第三维 level, header 内容 varint 占 3 字符)', () => {
    // decoded.txt 第 1 行: {(0, 15, 1); [(-97.000000000000000, 34.000000000000000, 228.390420353746407), ]}
    // 本应用不消费第三维，只断言 [lat, lng]
    expect(decodeFlexiblePolyline('Bw8BhGkCg-impzk4v21M')).toEqual([[-97, 34]])
  })

  it('official vector round_half_up #8 (纯 2D, 精度 0)', () => {
    // decoded.txt 第 8 行: {(0); [(-76.000000000000000, 74.000000000000000), ]}
    expect(decodeFlexiblePolyline('BA3E0E')).toEqual([[-76, 74]])
  })

  it('official README example (纯 2D, 精度 5, 4 点)', () => {
    expect(decodeFlexiblePolyline('BFoz5xJ67i1B1B7PzIhaxL7Y')).toEqual([
      [50.10228, 8.69821],
      [50.10201, 8.69567],
      [50.10063, 8.6915],
      [50.09878, 8.68752],
    ])
  })

  it('fixture 0011 polyline decodes into Karlsruhe bbox', () => {
    const poly = (f0011 as { response: { routes: { sections: { polyline: string }[] }[] } })
      .response.routes[0].sections[0].polyline
    const pts = decodeFlexiblePolyline(poly)
    expect(pts.length).toBe(7) // 实测（评审验证）：36 字符 = 2 header + 14 varint = 7 点（113m 路线）
    for (const [lat, lng] of pts) {
      expect(lat).toBeGreaterThan(48.9)
      expect(lat).toBeLessThan(49.1)
      expect(lng).toBeGreaterThan(8.3)
      expect(lng).toBeLessThan(8.5)
    }
  })
  it('first decoded point is near the trace start (49.0106, 8.4399)', () => {
    const poly = (f0011 as { response: { routes: { sections: { polyline: string }[] }[] } })
      .response.routes[0].sections[0].polyline
    const [lat, lng] = decodeFlexiblePolyline(poly)[0]
    expect(Math.abs(lat - 49.0106)).toBeLessThan(0.001)
    expect(Math.abs(lng - 8.4399)).toBeLessThan(0.001)
  })
})
