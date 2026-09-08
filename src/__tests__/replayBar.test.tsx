import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import ReplayBar from '../components/ReplayBar'

function makeProps() {
  return {
    index: 25,
    lastIndex: 232,
    tSec: 2.5,
    totalSec: 23.2,
    playing: false,
    speed: 1 as const,
    onToggle: vi.fn(),
    onSeek: vi.fn(),
    onSpeed: vi.fn(),
    onScrubStart: vi.fn(),
    onScrubEnd: vi.fn(),
  }
}

describe('ReplayBar', () => {
  it('renders controls: toggle button, speed group, controlled slider, time readout', () => {
    render(<ReplayBar {...makeProps()} />)
    expect(screen.getByRole('button', { name: '播放' })).toBeTruthy()
    const slider = screen.getByRole('slider') as HTMLInputElement
    expect(Number(slider.min)).toBe(0)
    expect(Number(slider.max)).toBe(232)
    expect(slider.value).toBe('25')
    expect(screen.getByTestId('replay-time').textContent).toBe('2.5s / 23.2s')
  })

  it('playing flips the toggle button label to 暂停', () => {
    render(<ReplayBar {...makeProps()} playing={true} />)
    expect(screen.getByRole('button', { name: '暂停' })).toBeTruthy()
  })

  it('fires onToggle / onSeek / onSpeed with plain numbers', () => {
    const props = makeProps()
    render(<ReplayBar {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    expect(props.onToggle).toHaveBeenCalledTimes(1)
    fireEvent.change(screen.getByRole('slider'), { target: { value: '120' } })
    expect(props.onSeek).toHaveBeenCalledWith(120)
    fireEvent.click(screen.getByRole('button', { name: '2x' }))
    expect(props.onSpeed).toHaveBeenCalledWith(2)
  })

  it('marks active speed with aria-pressed', () => {
    render(<ReplayBar {...makeProps()} speed={2} />)
    expect(screen.getByRole('button', { name: '1x' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByRole('button', { name: '2x' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '5x' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('scrub lifecycle: pointerDown/Up fire onScrubStart/End around seek', () => {
    const props = makeProps()
    render(<ReplayBar {...props} />)
    const slider = screen.getByRole('slider')
    fireEvent.pointerDown(slider)
    expect(props.onScrubStart).toHaveBeenCalledTimes(1)
    fireEvent.change(slider, { target: { value: '120' } })
    expect(props.onSeek).toHaveBeenCalledWith(120)
    fireEvent.pointerUp(slider)
    expect(props.onScrubEnd).toHaveBeenCalledTimes(1)
  })
})
