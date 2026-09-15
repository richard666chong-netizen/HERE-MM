import { useCallback, useEffect, useRef, useState } from 'react'
import { advancePlayback } from '../lib/playback'

export type PlaybackSpeed = 1 | 2 | 5

export interface Playback {
  /** 当前整数下标（0..lastIndex）；仅整数变化才触发重渲染 */
  index: number
  /** 当前浮点位置（0..lastIndex，rAF 每帧更新）——子帧插值的时钟源 */
  pos: number
  playing: boolean
  speed: PlaybackSpeed
  play(): void
  pause(): void
  toggle(): void
  setSpeed(s: PlaybackSpeed): void
  seek(i: number): void
}

/** 回放时钟：rAF 时间戳驱动浮点位置 ref，整数下标才 setState（≤10×speed 次/秒）。
 *  到达终点自动暂停；终点 play() 从头重播（demo 友好）；lastIndex 变化自动复位。 */
export function usePlayback(lastIndex: number, pps = 10): Playback {
  const [index, setIndex] = useState(0)
  const [pos, setPos] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeedState] = useState<PlaybackSpeed>(1)
  const posRef = useRef(0)
  const playingRef = useRef(false)
  const speedRef = useRef<PlaybackSpeed>(1)
  const lastTsRef = useRef<number | null>(null)

  useEffect(() => {
    if (!playing) return
    let rafId = 0
    const tick = (now: number): void => {
      if (!playingRef.current) return // pause 后残留帧防御（cancelAnimationFrame 为桩时同样安全）
      if (lastTsRef.current === null) {
        lastTsRef.current = now // 首帧只定基线，不推进
      } else {
        const next = advancePlayback(posRef.current, now - lastTsRef.current, speedRef.current, pps, lastIndex)
        lastTsRef.current = now
        posRef.current = next
        setPos(next)
        const i = Math.floor(next)
        setIndex((prev) => (prev === i ? prev : i))
        if (next >= lastIndex) {
          playingRef.current = false
          setPlaying(false)
          return // 终点停帧（不再排下一帧）
        }
      }
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(rafId)
      lastTsRef.current = null // 下次播放重新定基线
    }
  }, [playing, lastIndex, pps])

  // lastIndex 变化（数据就位/切换轨迹）→ 复位到起点
  useEffect(() => {
    posRef.current = 0
    playingRef.current = false
    setIndex(0)
    setPos(0)
    setPlaying(false)
  }, [lastIndex])

  const play = useCallback((): void => {
    if (lastIndex <= 0) return
    if (posRef.current >= lastIndex) {
      posRef.current = 0 // 终点重播
      setIndex(0)
      setPos(0)
    }
    playingRef.current = true
    lastTsRef.current = null
    setPlaying(true)
  }, [lastIndex])

  const pause = useCallback((): void => {
    playingRef.current = false
    setPlaying(false)
  }, [])

  const toggle = useCallback((): void => {
    if (playingRef.current) pause()
    else play()
  }, [play, pause])

  const setSpeed = useCallback((s: PlaybackSpeed): void => {
    speedRef.current = s
    setSpeedState(s)
  }, [])

  const seek = useCallback(
    (i: number): void => {
      const clamped = Math.max(0, Math.min(Math.round(i), lastIndex))
      posRef.current = clamped
      setIndex(clamped)
      setPos(clamped)
    },
    [lastIndex],
  )

  return { index, pos, playing, speed, play, pause, toggle, setSpeed, seek }
}
