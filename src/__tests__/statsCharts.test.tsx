import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DistanceDeviationSvg, HistogramSvg } from '../components/StatsCharts'

describe('HistogramSvg', () => {
  it('renders 20 bars + y ticks (max/mid/0×2) + x ticks (0/mid/max)', () => {
    // counts 1,2,3 → maxCount=3、mid=round(3/2)=2；末桶 toM=20 → x 轴 '10.0m'/'20.0m'
    const bins = Array.from({ length: 20 }, (_, i) => ({ fromM: i, toM: i + 1, count: i < 3 ? i + 1 : 0 }))
    const { container, getByText, getAllByText } = render(<HistogramSvg bins={bins} />)
    expect(container.querySelectorAll('rect[data-testid="hist-bar"]')).toHaveLength(20)
    expect(getByText('3')).toBeTruthy() // y 最大刻度 = maxCount
    expect(getByText('2')).toBeTruthy() // y 中刻度 = round(maxCount/2)
    expect(getAllByText('0')).toHaveLength(2) // y 原点 + x 原点
    expect(getByText('10.0m')).toBeTruthy()
    expect(getByText('20.0m')).toBeTruthy()
  })
})

describe('DistanceDeviationSvg', () => {
  it('single point: guarded path, no NaN, closed with Z (HTML L652 maxDist≥1)', () => {
    const { container } = render(<DistanceDeviationSvg points={[{ distanceM: 0, deviationM: 0 }]} />)
    const d = container.querySelector('path[data-testid="dist-area"]')!.getAttribute('d')!
    expect(d).not.toContain('NaN')
    expect(d).toContain('Z')
  })
  it('km/m adaptive x labels (≥1000m → km, mid = maxDist/2000 km)', () => {
    const { getByText } = render(
      <DistanceDeviationSvg points={[{ distanceM: 0, deviationM: 1 }, { distanceM: 1000, deviationM: 2 }]} />,
    )
    expect(getByText('1.0km')).toBeTruthy() // x 最大
    expect(getByText('0.5km')).toBeTruthy() // x 中 = 1000/2000 km
    expect(getByText('2.0m')).toBeTruthy() // y 最大 = maxDev
    expect(getByText('1.0m')).toBeTruthy() // y 中 = maxDev/2
  })
})
