import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { usePlayback } from '../hooks/usePlayback'

let rafQueue: Array<(t: number) => void> = []

beforeEach(() => {
  rafQueue = []
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    rafQueue.push(cb)
    return rafQueue.length
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

afterEach(() => vi.unstubAllGlobals())

/** 放一帧：先换出当前队列再执行（tick 内排的下一帧落进新队列） */
function flushFrame(tMs: number): void {
  const cbs = rafQueue
  rafQueue = []
  for (const cb of cbs) cb(tMs)
}

describe('usePlayback', () => {
  it('advances by dt × pps × speed; integer index surfaces', () => {
    const { result } = renderHook(() => usePlayback(9)) // lastIndex=9, pps=10
    expect(result.current.index).toBe(0)
    expect(result.current.playing).toBe(false)

    act(() => result.current.play())
    expect(result.current.playing).toBe(true)
    act(() => flushFrame(0)) // 首帧定基线，不推进
    act(() => flushFrame(100)) // +1
    expect(result.current.index).toBe(1)
    act(() => result.current.setSpeed(5))
    act(() => flushFrame(200)) // +5
    expect(result.current.index).toBe(6)
  })

  it('clamps at lastIndex, auto-pauses, stops scheduling frames', () => {
    const { result } = renderHook(() => usePlayback(9))
    act(() => result.current.play())
    act(() => flushFrame(0))
    act(() => flushFrame(10000)) // 远超终点
    expect(result.current.index).toBe(9)
    expect(result.current.playing).toBe(false)
    expect(rafQueue.length).toBe(0) // 终点不再排帧
  })

  it('seek jumps position; play-at-end restarts from 0', () => {
    const { result } = renderHook(() => usePlayback(9))
    act(() => result.current.seek(3))
    expect(result.current.index).toBe(3)
    act(() => result.current.play())
    act(() => flushFrame(0))
    act(() => flushFrame(100)) // 3 → 4
    expect(result.current.index).toBe(4)
    act(() => result.current.seek(9))
    act(() => result.current.play()) // 终点播放 → 从头
    expect(result.current.index).toBe(0)
    expect(result.current.playing).toBe(true)
  })

  it('pause halts advancement even if a stale frame leaks', () => {
    const { result } = renderHook(() => usePlayback(9))
    act(() => result.current.play())
    act(() => flushFrame(0)) // 已排下一帧（仍在队列中）
    act(() => result.current.pause())
    act(() => flushFrame(1000)) // 残留帧：playingRef 守卫直接 return
    expect(result.current.index).toBe(0)
  })

  it('lastIndex change (drive switch / data arrival) resets to 0', () => {
    const { result, rerender } = renderHook(({ n }: { n: number }) => usePlayback(n), {
      initialProps: { n: 9 },
    })
    act(() => result.current.play())
    act(() => flushFrame(0))
    act(() => flushFrame(300)) // +3
    expect(result.current.index).toBe(3)
    rerender({ n: 232 })
    expect(result.current.index).toBe(0)
    expect(result.current.playing).toBe(false)
  })
})
