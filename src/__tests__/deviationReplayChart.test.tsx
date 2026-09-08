import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import DeviationReplayChart from '../components/DeviationReplayChart'
import type { DerivedPoint, TrajPoint } from '../types'

function tp(t: number): TrajPoint {
  return {
    lat: 49 + t * 1e-4,
    lng: 8.4 + t * 1e-4,
    timestamp: t,
    timestampUtc: '2026-09-07T00:00:00Z',
    headingDeg: 0,
    speedMps: 5,
    numsats: 7,
  }
}
function dp(i: number, dev: number): DerivedPoint {
  return { i, matchedLatLng: [49, 8.4], deviationM: dev, headingDeg: 0, speedMps: 5 }
}

describe('DeviationReplayChart', () => {
  it('renders chart svg + current deviation readout tracking index', () => {
    const trace = [tp(0), tp(0.1), tp(0.2), tp(0.3), tp(0.4)]
    const derived = [dp(0, 1.1), dp(1, 2.2), dp(2, 3.3), dp(3, 4.4), dp(4, 5.5)]
    const { container, rerender } = render(<DeviationReplayChart trace={trace} derived={derived} index={2} />)
    expect(container.querySelector('svg')).toBeTruthy()
    expect(container.querySelector('[data-testid="replay-deviation"]')!.textContent).toContain('3.3')
    rerender(<DeviationReplayChart trace={trace} derived={derived} index={4} />)
    expect(container.querySelector('[data-testid="replay-deviation"]')!.textContent).toContain('5.5')
  })

  it('locks sliding-window wiring via data-length (tCur = trace timestamp, sliced, quantized)', () => {
    // 41 点、t=0..4.0s；windowSec=0.5（< max(5, total/2)=5 → win=0.5）
    const trace = Array.from({ length: 41 }, (_, i) => tp(i * 0.1))
    const derived = trace.map((_, i) => dp(i, 1))
    const { container, rerender } = render(
      <DeviationReplayChart trace={trace} derived={derived} index={40} windowSec={0.5} />,
    )
    // tCur=4.0 → tQ=4.0 → 窗口 [3.5, 4.0] = 6 点（双端闭、步长 0.1）
    expect(container.querySelector('[data-testid="replay-deviation"]')!.closest('aside')!.getAttribute('data-length')).toBe('6')
    rerender(<DeviationReplayChart trace={trace} derived={derived} index={39} windowSec={0.5} />)
    // tCur=3.9 → tQ=3.5 → 窗口 [3.0, 3.5] = 6 点（量化生效）
    expect(container.querySelector('[data-testid="replay-deviation"]')!.closest('aside')!.getAttribute('data-length')).toBe('6')
  })

  it('empty derived renders placeholder without chart', () => {
    const { container } = render(<DeviationReplayChart trace={[]} derived={[]} index={0} />)
    expect(container.querySelector('svg')).toBeNull()
    expect(container.textContent).toContain('暂无偏差数据')
  })
})
