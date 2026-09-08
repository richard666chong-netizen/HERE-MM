# HERE Map Matching POC — Step2 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 Step2：双模式 tab（工程分析/客户演示）+ 回放时钟（播放/暂停/倍速/进度拖动）+ 车标沿匹配路线行驶 + GNSS 逐点喷洒 + 偏差曲线滑窗联动——交付「回放流畅，偏差曲线联动」。

**Architecture:** 回放状态机与渲染解耦：`lib/playback.ts`（纯函数：帧推进 + 滑窗切片）→ `hooks/usePlayback.ts`（rAF 时钟，浮点位置 ref，整数下标才 setState）→ `ReplayBar`（控制条）/ `DeviationReplayChart`（30s 滑窗 Recharts）/ `MapView`+`SvgFallback` 扩展（渐进喷洒 + 车标）。App 持有 playback 与 mode 状态；分析模式 = `upToIndex` 传全量下标（同一渲染路径，HERE 地图实例跨 tab 切换不重建）；切回分析模式自动暂停。

**Tech Stack:** Step1 地基（Vite 7 + React 19 + TS strict + Vitest 3 + Recharts 3.10.1 已装），**零新增 npm 依赖**。

**Spec:** `docs/superpowers/specs/2026-09-07-here-map-matching-poc-design.md`（L48 回放需求、L121 Step2 判据）

## Global Constraints

- **Step2 零新增 npm 依赖**（recharts 已在 Step1 装入）
- **回放层零实时计算**（spec L63-66）：逐帧渲染只消费 `derived`/`trace` 预计算字段，严禁在回放路径调用 `derive`/`nearestOnPolyline`/`haversineM`
- **运行时 `fetch` 约束沿用 Step1**：src 运行时路径（App/lib/components/hooks）禁 `import ... from '../../public/...'`；一切测试代码（`*.test.ts(x)`、`__tests__/`）豁免
- `VITE_HERE_KEY` 只经 `import.meta.env.VITE_HERE_KEY` 读取；key 不进 git/代码/对话
- **Step1 既有行为零破坏**：不传 `upToIndex`/`carIndex` 时 MapView/SvgFallback 渲染与 Step1 完全一致（既有 37 条测试不改一行仍全绿）
- strict TS + `verbatimModuleSyntax`（类型导入用 `import type`）；测试显式 `import { describe, it, expect } from 'vitest'`
- 提交直接进 `main`，conventional commits（中文描述可）
- HERE 3.1 运行时 API 以真实 key 手动验收为准（Step1 errata 模式）：计划内 HERE 调用若运行时签名不符，实现期实证修正并在计划 Errata 节留痕
- Windows/Git Bash：dev 服务器后台起、按进程定点清理（Step1 模式）

## 现状（已核实，2026-09-08）

- 基线全绿：`npm run build` 零错误；`npm run test` 9 文件 37 条全过（HEAD = a32e526）
- Step1 产出接口（本计划直接消费，签名勿重造）：
  - `MapViewProps { trace; derived; mapStatus: 'ok'|'fallback'; apikey }`（`src/components/MapView.tsx`）——HERE 路径散点为「每 2 点 1 个 Circle、建图 effect 内一次加完」
  - `SvgFallbackProps { trace; derived; width; height }`——投影 `xy()` 以 bbox 中心为原点、SVG y 向下取负；散点抽稀 `thinIndices(n)`（每 ⌈n/800⌉ 取 1 保留首尾）；测试钩子 `gnss-dot`/`matched-path`/`endpoint-marker`/`scale-bar`
  - `StatsPanelProps { trace; derived }`（不改动）；`SourceBadge`（不改动）
  - `App.tsx`：driveId 切换/清除缓存重载时先 `setData(null)` → MapView 随之卸载重建（本计划依赖此行为，内部 ref 状态随卸载重置）
  - `types.ts`：`TrajPoint.headingDeg`（IMU yaw）、`DerivedPoint.matchedLatLng: [lat, lng]`
- 轨迹时间戳：0033 = 1594 点、ts 0–159.3 s；0011 = 233 点、ts 0–23.2 s（契约测试保证严格递增，10 Hz）
- `@testing-library/react` 16.3：`renderHook`/`act` 内置可用
- jsdom 提供 `requestAnimationFrame`，但本计划测试一律**手动泵 rAF**（确定性时间戳），App 测试则**桩掉 rAF 不放帧**（防真实帧在断言外推进）

## File Structure

```
src/
├── lib/
│   └── playback.ts               # T1: advancePlayback + sliceWindow（纯函数）
├── hooks/                        # 新目录（tsconfig include:["src"] 已覆盖）
│   └── usePlayback.ts            # T2: rAF 回放时钟 hook
├── components/
│   ├── ReplayBar.tsx             # T3: 播放/暂停 + 倍速 1x/2x/5x + 进度拖动 + 时间读数
│   ├── DeviationReplayChart.tsx  # T4: 30s 滑窗偏差-时间曲线 + 当前偏差读数
│   ├── MapView.tsx               # T5: 扩展 upToIndex/carIndex（HERE 增量喷洒 + 车标）
│   └── SvgFallback.tsx           # T5: 扩展 upToIndex/car（切片散点 + 旋转车标）
└── App.tsx                       # T6: 双模式 tab + 回放接线 + 切 tab 暂停
```

**渲染路径统一决策**：MapView 的 `upToIndex` 归一化为 `upToIndex ?? trace.length - 1`——分析模式传全量下标，走与回放完全相同的喷洒路径（HERE 地图实例在 tab 切换间复用，不重建）；`carIndex` 仅演示模式传入（undefined = 无车标，分析模式无车标）。

---

### Task 1: playback.ts 纯函数（帧推进 + 滑窗切片）

**Files:**
- Create: `src/lib/playback.ts`
- Test: `src/__tests__/playback.test.ts`

**Interfaces:**
- Produces:
  - `advancePlayback(pos: number, dtMs: number, speed: number, pps: number, lastIndex: number): number`——一帧推进 `pos += dt/1000 × pps × speed`，clamp 到 `[0, lastIndex]`；`dtMs ≤ 0` 原样返回（首帧基线防御）
  - `sliceWindow<T extends { t: number }>(series: readonly T[], tCur: number, windowSec: number): T[]`——取 `t ∈ [tCur - windowSec, tCur]`（双端闭）；结果为空退回 `series.slice(-1)`（防越界白屏）
  - `sprayPlan(sprayed: readonly number[], upTo: number, stride: number): { removeIdx: number[]; addIdx: number[] }`——HERE 路径喷洒增量（评审 blocker 修正产物）：`removeIdx` = 已洒中超过 upTo 的下标（回退回收），`addIdx` = 缺失的 stride 对齐下标（前进补洒）。纯函数可单测，MapView 喷洒 effect 退化为薄适配层

- [ ] **Step 1: 写失败测试 `src/__tests__/playback.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { advancePlayback, sliceWindow, sprayPlan } from '../lib/playback'

describe('advancePlayback', () => {
  it('100ms @ 1x 10pps advances exactly one point', () => {
    expect(advancePlayback(0, 100, 1, 10, 9)).toBeCloseTo(1, 10)
  })
  it('scales with speed', () => {
    expect(advancePlayback(1, 100, 5, 10, 100)).toBeCloseTo(6, 10)
  })
  it('clamps at lastIndex', () => {
    expect(advancePlayback(8.7, 1000, 5, 10, 9)).toBe(9)
  })
  it('non-positive dt is a no-op (first-frame baseline guard)', () => {
    expect(advancePlayback(3.3, 0, 5, 10, 9)).toBe(3.3)
    expect(advancePlayback(3.3, -50, 5, 10, 9)).toBe(3.3)
  })
})

describe('sliceWindow', () => {
  const series = Array.from({ length: 1001 }, (_, i) => ({ t: i * 0.1, v: i })) // t: 0..100s
  it('early: full history up to tCur, future points excluded', () => {
    const w = sliceWindow(series, 5, 30)
    expect(w.length).toBe(51) // t ∈ [0, 5] 步长 0.1
    expect(w[0].t).toBe(0)
    expect(w[w.length - 1].t).toBeCloseTo(5, 6)
  })
  it('sliding: points within [tCur-30, tCur], boundaries inclusive', () => {
    const w = sliceWindow(series, 100, 30)
    expect(w.length).toBe(301) // t ∈ [70, 100]
    expect(w[0].t).toBeCloseTo(70, 6)
    expect(w[w.length - 1].t).toBeCloseTo(100, 6)
  })
  it('empty result falls back to the last point', () => {
    const w = sliceWindow(series, -1, 30) // 无 t ≤ -1 的点
    expect(w).toEqual([{ t: 100, v: 1000 }])
  })
})

describe('sprayPlan', () => {
  it('initial: sprays stride-aligned indices from 0', () => {
    expect(sprayPlan([], 5, 2)).toEqual({ removeIdx: [], addIdx: [0, 2, 4] })
  })
  it('forward: only missing stride indices', () => {
    expect(sprayPlan([0, 2], 7, 2)).toEqual({ removeIdx: [], addIdx: [4, 6] })
  })
  it('backward: recovers indices beyond upTo', () => {
    expect(sprayPlan([0, 2, 4, 6], 3, 2)).toEqual({ removeIdx: [4, 6], addIdx: [] })
  })
  it('no-op when in sync', () => {
    expect(sprayPlan([0, 2, 4], 4, 2)).toEqual({ removeIdx: [], addIdx: [] })
    expect(sprayPlan([0, 2, 4], 2, 2)).toEqual({ removeIdx: [4], addIdx: [] })
  })
})
```

- [ ] **Step 2: 跑失败**

```bash
npx vitest run src/__tests__/playback.test.ts
```

Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现 `src/lib/playback.ts`**

```ts
/** Step2 回放时钟纯函数：rAF 帧推进 + 滑窗切片（无副作用，独立可测） */

/** 一帧推进：pos += dt × pps × speed，clamp 到 [0, lastIndex]。dt ≤ 0 不动（首帧基线防御）。 */
export function advancePlayback(
  pos: number,
  dtMs: number,
  speed: number,
  pps: number,
  lastIndex: number,
): number {
  if (dtMs <= 0) return pos
  const next = pos + (dtMs / 1000) * pps * speed
  return Math.min(Math.max(next, 0), lastIndex)
}

/** 滑动时间窗：取 series 中 t ∈ [tCur - windowSec, tCur] 的点（双端闭，绝不含未来点）；
 *  结果为空（tCur 早于首点）退回最后一个点，防图表空数据。 */
export function sliceWindow<T extends { t: number }>(
  series: readonly T[],
  tCur: number,
  windowSec: number,
): T[] {
  const from = tCur - windowSec
  const out = series.filter((p) => p.t >= from && p.t <= tCur)
  return out.length > 0 ? out : series.slice(-1)
}

/** 喷洒计划（HERE 路径）：已洒下标 → 相对 upTo 的增量。
 *  removeIdx = 已洒中超过 upTo 的（进度回拖 → 回收）；addIdx = 缺失的 stride 对齐下标（前进 → 补洒）。 */
export function sprayPlan(
  sprayed: readonly number[],
  upTo: number,
  stride: number,
): { removeIdx: number[]; addIdx: number[] } {
  const step = Math.max(1, Math.round(stride))
  const kept = new Set(sprayed.filter((i) => i <= upTo))
  const removeIdx = sprayed.filter((i) => i > upTo)
  const addIdx: number[] = []
  for (let i = 0; i <= upTo; i += step) if (!kept.has(i)) addIdx.push(i)
  return { removeIdx, addIdx }
}
```

- [ ] **Step 4: 跑绿**

```bash
npx vitest run src/__tests__/playback.test.ts
```

Expected: 11 passed（advancePlayback 4 + sliceWindow 3 + sprayPlan 4）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/playback.ts src/__tests__/playback.test.ts
git commit -m "feat: playback clock math, window slicing and spray planning"
```

---

### Task 2: usePlayback rAF 时钟 hook

**Files:**
- Create: `src/hooks/usePlayback.ts`
- Test: `src/__tests__/usePlayback.test.ts`

**Interfaces:**
- Consumes: `advancePlayback`（T1）
- Produces:
  - `type PlaybackSpeed = 1 | 2 | 5`
  - `interface Playback { index: number; playing: boolean; speed: PlaybackSpeed; play(): void; pause(): void; toggle(): void; setSpeed(s: PlaybackSpeed): void; seek(i: number): void }`
  - `usePlayback(lastIndex: number, pps = 10): Playback`——rAF 时间戳驱动浮点位置（ref），**仅整数下标变化才 setState**（≤10×speed 次/秒，控件不刷 60Hz）；到终点自动暂停；终点 `play()` 从头重播；`lastIndex` 变化（换轨迹/数据就位）自动复位；`pause()` 后残留帧被 `playingRef` 守卫拦下（cancel 桩下同样安全）

- [ ] **Step 1: 写失败测试 `src/__tests__/usePlayback.test.ts`**（rAF 手动泵：收集回调、按需注入时间戳）

```ts
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
```

- [ ] **Step 2: 跑失败**

```bash
npx vitest run src/__tests__/usePlayback.test.ts
```

Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现 `src/hooks/usePlayback.ts`**

```ts
import { useCallback, useEffect, useRef, useState } from 'react'
import { advancePlayback } from '../lib/playback'

export type PlaybackSpeed = 1 | 2 | 5

export interface Playback {
  /** 当前整数下标（0..lastIndex）；仅整数变化才触发重渲染 */
  index: number
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
    setPlaying(false)
  }, [lastIndex])

  const play = useCallback((): void => {
    if (lastIndex <= 0) return
    if (posRef.current >= lastIndex) {
      posRef.current = 0 // 终点重播
      setIndex(0)
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
    },
    [lastIndex],
  )

  return { index, playing, speed, play, pause, toggle, setSpeed, seek }
}
```

- [ ] **Step 4: 跑绿**

```bash
npx vitest run src/__tests__/usePlayback.test.ts
```

Expected: 5 passed。

- [ ] **Step 5: Commit**

```bash
git add src/hooks/usePlayback.ts src/__tests__/usePlayback.test.ts
git commit -m "feat: usePlayback rAF clock hook"
```

---

### Task 3: ReplayBar 回放控制条

**Files:**
- Create: `src/components/ReplayBar.tsx`
- Test: `src/__tests__/replayBar.test.tsx`

**Interfaces:**
- Produces:
  - `ReplayBarProps { index: number; lastIndex: number; tSec: number; totalSec: number; playing: boolean; speed: 1 | 2 | 5; onToggle(): void; onSeek(i: number): void; onSpeed(s: 1 | 2 | 5): void; onScrubStart(): void; onScrubEnd(): void }`
  - 受控组件：播放/暂停单按钮（aria-label 播放/暂停）；倍速 group（1x/2x/5x，aria-pressed）；`input[type=range]` aria-label="进度"（min 0 / max lastIndex / value index）；时间读数 `data-testid="replay-time"`：`{tSec.toFixed(1)}s / {totalSec.toFixed(1)}s`（时间取 trace 时间戳，App 传入，非 index 换算）
  - **拖动即暂停（评审 minor 采纳）**：slider 的 `onPointerDown` → `onScrubStart`、`onPointerUp` → `onScrubEnd`——App 侧据此暂停/续播，防播放中拖动被 rAF 时钟持续前推（5x 下松手落点漂移 ~50 点/秒）

- [ ] **Step 1: 写失败测试 `src/__tests__/replayBar.test.tsx`**

```tsx
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
```

- [ ] **Step 2: 跑失败**

```bash
npx vitest run src/__tests__/replayBar.test.tsx
```

Expected: FAIL——组件不存在。

- [ ] **Step 3: 实现 `src/components/ReplayBar.tsx`**

```tsx
export interface ReplayBarProps {
  index: number
  lastIndex: number
  tSec: number
  totalSec: number
  playing: boolean
  speed: 1 | 2 | 5
  onToggle(): void
  onSeek(i: number): void
  onSpeed(s: 1 | 2 | 5): void
  /** 拖动起止：App 据此暂停/续播（防播放中拖动被 rAF 前推漂移） */
  onScrubStart(): void
  onScrubEnd(): void
}

const SPEEDS: ReadonlyArray<1 | 2 | 5> = [1, 2, 5]

/** 回放控制条（spec L48）：播放/暂停 + 倍速 1x/2x/5x + 进度拖动（拖动即暂停） + 时间读数 */
export default function ReplayBar({
  index,
  lastIndex,
  tSec,
  totalSec,
  playing,
  speed,
  onToggle,
  onSeek,
  onSpeed,
  onScrubStart,
  onScrubEnd,
}: ReplayBarProps) {
  return (
    <div
      data-testid="replay-bar"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        padding: '0.5rem 1.5rem',
        borderTop: '1px solid #e5e7eb',
      }}
    >
      <button
        type="button"
        aria-label={playing ? '暂停' : '播放'}
        onClick={onToggle}
        style={{ fontSize: 16, padding: '0.3rem 0.9rem', cursor: 'pointer' }}
      >
        {playing ? '⏸' : '▶'}
      </button>
      <div role="group" aria-label="倍速" style={{ display: 'flex', gap: 4 }}>
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={speed === s}
            onClick={() => onSpeed(s)}
            style={{
              padding: '0.3rem 0.6rem',
              cursor: 'pointer',
              fontWeight: speed === s ? 700 : 400,
              border: '1px solid #e5e7eb',
              borderRadius: 6,
              background: speed === s ? '#eff6ff' : '#ffffff',
            }}
          >
            {s}x
          </button>
        ))}
      </div>
      <input
        type="range"
        aria-label="进度"
        min={0}
        max={lastIndex}
        value={index}
        onPointerDown={onScrubStart}
        onPointerUp={onScrubEnd}
        onChange={(e) => onSeek(Number(e.target.value))}
        style={{ flex: 1 }}
      />
      <span
        data-testid="replay-time"
        style={{ fontSize: 13, color: '#374151', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
      >
        {tSec.toFixed(1)}s / {totalSec.toFixed(1)}s
      </span>
    </div>
  )
}
```

- [ ] **Step 4: 跑绿**

```bash
npx vitest run src/__tests__/replayBar.test.tsx
```

Expected: 5 passed。

- [ ] **Step 5: Commit**

```bash
git add src/components/ReplayBar.tsx src/__tests__/replayBar.test.tsx
git commit -m "feat: replay control bar (play/pause, speed, seek)"
```

---

### Task 4: DeviationReplayChart 滑窗联动曲线

**Files:**
- Create: `src/components/DeviationReplayChart.tsx`
- Test: `src/__tests__/deviationReplayChart.test.tsx`

**Interfaces:**
- Consumes: `sliceWindow`（T1）、`TrajPoint`/`DerivedPoint`（types.ts）
- Produces: `DeviationReplayChartProps { trace: TrajPoint[]; derived: DerivedPoint[]; index: number; windowSec?: number }`（默认 30）
  - **自适应窗口（评审 minor 采纳）**：`win = min(windowSec, max(5, 全程秒数/2))`——0011（23.2s）得到 ~11.6s 滚动窗口，「随时间滚动联动」在困难场景 demo 上同样成立
  - **图表量化 + memo 子组件（评审 major 采纳）**：切片与 XAxis domain 量化到 0.5s 档（`tQ = floor(tCur×2)/2`），数据经 `useMemo`、图表经 `memo` 子组件（props 为稳定引用 + 两个 number）——5x=50Hz 父级重渲染下 AreaChart 只随 tQ 重渲（≤10 次/秒）；当前值大字读数仍全速跟随 index
  - `series` 经 `useMemo` 预计算一次（`{t: timestamp, deviationM}`）；读数 `data-testid="replay-deviation"`；aside 暴露 `data-length={data.length}`（窗口点数测试钩子，锁定 tCur=时间戳 + 切片接线）；Recharts 固定尺寸（jsdom 无 ResizeObserver，沿用 StatsPanel 约定）+ `isAnimationActive={false}`；`derived`/`trace` 为空渲染「暂无偏差数据」占位

- [ ] **Step 1: 写失败测试 `src/__tests__/deviationReplayChart.test.tsx`**

```tsx
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
```

- [ ] **Step 2: 跑失败**

```bash
npx vitest run src/__tests__/deviationReplayChart.test.tsx
```

Expected: FAIL——组件不存在。

- [ ] **Step 3: 实现 `src/components/DeviationReplayChart.tsx`**

```tsx
import { memo, useMemo } from 'react'
import { Area, AreaChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts'
import { sliceWindow } from '../lib/playback'
import type { DerivedPoint, TrajPoint } from '../types'

export interface DeviationReplayChartProps {
  trace: TrajPoint[]
  derived: DerivedPoint[]
  index: number
  windowSec?: number
}

// 固定尺寸（jsdom 无 ResizeObserver，沿用 StatsPanel 约定）；isAnimationActive=false 防逐帧动画卡顿
const CHART_W = 340
const CHART_H = 150

interface WindowPoint {
  t: number
  deviationM: number
}

/** memo 子组件：props 均为稳定引用/原始值——父级 50Hz 重渲染下 AreaChart 只随 tQ/win 变化重渲（评审 major 修法） */
const ReplayAreaChart = memo(function ReplayAreaChart({
  data,
  from,
  to,
}: {
  data: WindowPoint[]
  from: number
  to: number
}) {
  return (
    <AreaChart width={CHART_W} height={CHART_H} data={data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
      <XAxis dataKey="t" type="number" domain={[from, to]} tickFormatter={(v: number) => `${v.toFixed(0)}s`} />
      <YAxis width={28} />
      <Tooltip formatter={(v) => `${Number(v).toFixed(2)} m`} />
      <Area
        dataKey="deviationM"
        name="横向偏差"
        stroke="#f59e0b"
        fill="#f59e0b"
        fillOpacity={0.25}
        strokeWidth={1.5}
        dot={false}
        isAnimationActive={false}
      />
    </AreaChart>
  )
})

/** 回放联动偏差曲线（spec L48「偏差曲线随时间滚动联动」）：自适应滑窗 + 0.5s 量化 + 当前值读数全速跟随 */
export default function DeviationReplayChart({ trace, derived, index, windowSec = 30 }: DeviationReplayChartProps) {
  const series = useMemo(
    () => trace.map((p, i) => ({ t: p.timestamp, deviationM: derived[i]?.deviationM ?? 0 })),
    [trace, derived],
  )
  const total = trace.length > 0 ? trace[trace.length - 1].timestamp : 0
  // 自适应窗口：短轨迹取半程滑窗（0011 全长 23.2s → ~11.6s），保证「滚动」语义
  const win = Math.min(windowSec, Math.max(5, total / 2))
  const lastIdx = Math.min(trace.length, derived.length) - 1
  const i = lastIdx >= 0 ? Math.min(index, lastIdx) : 0
  const tCur = trace.length > 0 ? trace[Math.min(i, trace.length - 1)].timestamp : 0
  const tQ = Math.floor(tCur * 2) / 2 // 0.5s 档量化：图表重渲 ≤10 次/秒（5x），读数仍全速
  const data = useMemo(() => sliceWindow(series, tQ, win), [series, tQ, win])

  if (derived.length === 0 || trace.length === 0) {
    return <p style={{ fontSize: 13, color: '#6b7280' }}>暂无偏差数据</p>
  }

  return (
    <aside
      data-length={data.length}
      style={{ width: '100%', padding: '0.75rem', border: '1px solid #e5e7eb', borderRadius: 8 }}
    >
      <h2 style={{ fontSize: 13, fontWeight: 600, color: '#374151', margin: '0 0 0.25rem' }}>
        偏差 – 时间（回放联动）
      </h2>
      <div data-testid="replay-deviation" style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>
        {derived[i].deviationM.toFixed(1)} m
      </div>
      <ReplayAreaChart data={data} from={Math.max(0, tQ - win)} to={Math.max(tQ, win)} />
    </aside>
  )
}
```

- [ ] **Step 4: 跑绿**

```bash
npx vitest run src/__tests__/deviationReplayChart.test.tsx
```

Expected: 3 passed。

- [ ] **Step 5: Commit**

```bash
git add src/components/DeviationReplayChart.tsx src/__tests__/deviationReplayChart.test.tsx
git commit -m "feat: sliding-window deviation chart for replay"
```

---

### Task 5: MapView + SvgFallback 回放渲染（渐进喷洒 + 车标）

**Files:**
- Modify: `src/components/MapView.tsx`（整体重写——HERE 路径增量喷洒 + 车标）
- Modify: `src/components/SvgFallback.tsx`（props 扩展 + 切片散点 + 旋转车标）
- Test: `src/__tests__/mapview.test.tsx`（新增 2 条，既有 2 条不改）

**Interfaces:**
- Consumes: `TrajPoint`/`DerivedPoint`（types.ts）
- Produces:
  - `MapViewProps` 新增（可选，缺省 = Step1 静态行为）：
    - `upToIndex?: number`——GNSS 散点洒到该下标（含）。内部归一 `upTo = upToIndex ?? trace.length - 1`（分析模式传全量下标 → 走同一喷洒路径，HERE 地图实例跨 tab 复用）
    - `carIndex?: number`——车标下标：位置 = `derived[carIndex].matchedLatLng`，航向 = `trace[carIndex].headingDeg`（IMU yaw）；undefined = 无车标
  - `SvgFallbackProps` 新增：`upToIndex?: number`（同上语义，缺省全量）、`car?: { lat: number; lng: number; headingDeg: number }`（车标由 MapView 归一后传入；新测试钩子 `data-testid="car-marker"`）
  - HERE 路径行为：散点改为**增量喷洒 effect**——`sprayPlan`（T1）算增量、effect 做对象映射，**无 cleanup**（评审 blocker 修正：cleanup 回滚在每次依赖变化时先跑，会让增量退化成每步全量重洒），stale-map 守卫自愈换图窗口；车标 = `H.map.Marker`（**`volatility: true`**，评审 major 修正）+ `H.map.Icon`（SVG 箭头**烘焙航向角**，5° 分桶缓存 ≤72 个 icon，首次建车标时全量预热——HERE 3.1 marker 无原生 rotation，运行时实证修正点见 Errata 预案）
  - **匹配路径折线在回放模式下仍全量显示**（静态对比叙事保留：路网先知、车在路上走）

- [ ] **Step 1: 先在 `src/__tests__/mapview.test.tsx` 追加失败测试**（既有 2 条用例与 `tp`/`dp` 助手保留；`tp` 增加第三参 `headingDeg = 0`——既有调用不传仍有效）

追加的测试代码（放在既有 describe 内或新 describe 均可，助手改造后追加）：

```tsx
// tp 助手改造（dp 不变）：
function tp(lat: number, lng: number, headingDeg = 0): TrajPoint {
  return { lat, lng, timestamp: 0, timestampUtc: '2026-09-07T00:00:00Z', headingDeg, speedMps: 0, numsats: 6 }
}
```

```tsx
describe('MapView replay（SvgFallback 路径）', () => {
  const trace = [tp(49.0, 8.4, 0), tp(49.01, 8.405, 90), tp(49.02, 8.41, 180)]
  // derived 与 trace 坐标故意错开（评审修正，防假绿）：车标必须取 matchedLatLng（匹配路线）
  // 而非 GNSS 原始点——测试数据重合时两种实现都过，错开后可判别
  const derived = [dp(0, 49.001, 8.401), dp(1, 49.015, 8.406), dp(2, 49.019, 8.409)]

  it('upToIndex limits spray to 2 dots + start marker only; car renders with heading rotation', () => {
    const { container } = render(
      <MapView trace={trace} derived={derived} mapStatus="fallback" apikey="" upToIndex={1} carIndex={1} />,
    )
    expect(container.querySelectorAll('[data-testid="gnss-dot"]').length).toBe(2) // 下标 0、1
    expect(container.querySelectorAll('[data-testid="endpoint-marker"]').length).toBe(1) // 仅起点，终点未到
    const car = container.querySelector('[data-testid="car-marker"]')
    expect(car).toBeTruthy()
    expect(car!.getAttribute('transform')).toMatch(/translate/)
    expect(car!.getAttribute('transform')).toMatch(/rotate\(90/) // IMU yaw 90°
    // 车标位置 = 匹配路线垂足 ≠ GNSS 原始点（gnss-dot 即 trace 位置的现成探针）
    const m = car!.getAttribute('transform')!.match(/translate\(([-\d.]+) ([-\d.]+)\)/)!
    const dot1 = container.querySelectorAll('[data-testid="gnss-dot"]')[1]
    expect(Number(m[1])).not.toBeCloseTo(Number(dot1.getAttribute('cx')), 1)
    expect(Number(m[2])).not.toBeCloseTo(Number(dot1.getAttribute('cy')), 1)
  })

  it('upToIndex = last restores full static render; no car marker without carIndex', () => {
    const { container } = render(
      <MapView trace={trace} derived={derived} mapStatus="fallback" apikey="" upToIndex={2} />,
    )
    expect(container.querySelectorAll('[data-testid="gnss-dot"]').length).toBe(3)
    expect(container.querySelectorAll('[data-testid="endpoint-marker"]').length).toBe(2) // 终点出现
    expect(container.querySelector('[data-testid="car-marker"]')).toBeNull()
  })
})
```

- [ ] **Step 2: 跑失败**

```bash
npx vitest run src/__tests__/mapview.test.tsx
```

Expected: 新 2 条 FAIL（`car-marker` 不存在 / `upToIndex` 不生效），既有 2 条仍 PASS。

- [ ] **Step 3: 重写 `src/components/MapView.tsx`（整文件替换为）**

```tsx
import { useEffect, useRef } from 'react'
import SvgFallback from './SvgFallback'
import { sprayPlan } from '../lib/playback'
import type { DerivedPoint, TrajPoint } from '../types'

export interface MapViewProps {
  trace: TrajPoint[]
  derived: DerivedPoint[]
  mapStatus: 'ok' | 'fallback'
  apikey: string
  /** 回放：GNSS 散点洒到该下标（含）。缺省 = 全量（静态模式） */
  upToIndex?: number
  /** 回放：车标下标——位置取 derived[carIndex].matchedLatLng，航向取 trace[carIndex].headingDeg（IMU yaw）。缺省 = 无车标 */
  carIndex?: number
}

/** HERE Maps JS API 3.1 命名空间的最小结构声明——script 标签加载、无官方 npm 类型。
 *  'ok' 路径仅在真实浏览器执行（手动验收覆盖），jsdom 测试只覆盖 fallback 路径。 */
interface HereDefaultLayers {
  vector: { normal: { map: unknown } }
}

interface HereMarker {
  setGeometry(coord: { lat: number; lng: number }): void
  setIcon(icon: unknown): void
}

interface HereMap {
  addObject(obj: unknown): void
  removeObject(obj: unknown): void
  /** 3.1 视野适配入口（Step1 运行时源码核实：无 setViewBounds，经 ViewModel.setLookAtData({bounds})） */
  getViewModel(): { setLookAtData(data: { bounds?: unknown; zoom?: number; tilt?: number; heading?: number }): void }
  dispose(): void
}

interface HereNS {
  /** 地图实例本体是顶层 H.Map（Step1 实证），H.map.* 是地图对象命名空间 */
  Map: new (
    el: HTMLElement,
    layer: unknown,
    opts?: { zoom?: number; center?: { lat: number; lng: number } },
  ) => HereMap
  service: {
    Platform: new (opts: { apikey: string }) => { createDefaultLayers: () => HereDefaultLayers }
  }
  map: {
    Polyline: new (
      lineString: unknown,
      opts?: { style?: { strokeColor?: string; lineWidth?: number } },
    ) => unknown
    Circle: new (
      center: { lat: number; lng: number },
      radiusM: number,
      opts?: { style?: { fillColor?: string; strokeColor?: string; lineWidth?: number } },
    ) => unknown
    Marker: new (
      coord: { lat: number; lng: number },
      opts?: { icon?: unknown; volatility?: boolean },
    ) => HereMarker
    Icon: new (svg: string, opts?: { anchor?: { x: number; y: number } }) => unknown
  }
  geo: {
    LineString: new () => { pushLatLngAlt: (lat: number, lng: number, alt?: number) => void }
    Rect: new (top: number, left: number, bottom: number, right: number) => unknown
  }
  mapevents: {
    MapEvents: new (map: HereMap) => unknown
    Behavior: new (events: unknown) => { dispose(): void }
  }
}

function getHere(): HereNS | null {
  if (typeof window === 'undefined') return null
  return (window as unknown as { H?: HereNS }).H ?? null
}

/** 车标图标：SVG 箭头烘焙航向（HERE 3.1 marker 无原生 rotation），5° 分桶缓存（≤72 个）。
 *  评审已实证 opts.anchor 平面对象可行（官方 3.1 文档示例即用字面量），无需兜底；
 *  运行时预案（Errata 模式）仅剩：若 marker.setGeometry/setIcon 不存在，退化为每帧 removeObject + addObject 重建车标。 */
function carIcon(here: HereNS, cache: Map<number, unknown>, headingDeg: number): unknown {
  const bucket = ((Math.round(headingDeg / 5) * 5) % 360 + 360) % 360
  let icon = cache.get(bucket)
  if (!icon) {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">` +
      `<polygon points="14,4 8,24 14,19 20,24" fill="#1d4ed8" stroke="#ffffff" stroke-width="1.5" ` +
      `transform="rotate(${bucket} 14 14)"/></svg>`
    icon = new here.map.Icon(svg, { anchor: { x: 14, y: 14 } })
    cache.set(bucket, icon)
  }
  return icon
}

/** 地图视图：mapStatus='ok' 初始化 HERE 地图（App 层保证此时 window.H 已就绪）；否则渲染无底图 SVG 兜底。
 *  Step2：upToIndex 归一为 upTo（缺省全量）→ HERE 散点走增量喷洒 effect；carIndex 驱动车标。 */
export default function MapView({ trace, derived, mapStatus, apikey, upToIndex, carIndex }: MapViewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const here = mapStatus === 'ok' ? getHere() : null // 'ok' 但 H 缺席时兜底走 SVG，防白屏
  const upTo = upToIndex ?? trace.length - 1

  // HERE 路径回放状态（随组件卸载/建图重建重置；App 换轨迹时先 setData(null) 卸载本组件）
  const mapRef = useRef<HereMap | null>(null)
  const sprayedRef = useRef<number[]>([]) // 已洒下标（升序）
  const objRef = useRef<unknown[]>([]) // 与 sprayedRef 平行的 Circle 对象
  const sprayedMapRef = useRef<HereMap | null>(null) // 账本所属地图实例（stale-map 守卫）
  const carRef = useRef<HereMarker | null>(null)
  const iconCacheRef = useRef(new Map<number, unknown>())

  // 建图 + 匹配路径（全量）+ 视野适配。声明顺序保证本 effect 先于喷洒/车标 effect 运行。
  useEffect(() => {
    if (!here || !hostRef.current) return
    const platform = new here.service.Platform({ apikey })
    const layers = platform.createDefaultLayers()
    const map = new here.Map(hostRef.current, layers.vector.normal.map, {
      zoom: 14,
      center: { lat: trace[0]?.lat ?? 49.01, lng: trace[0]?.lng ?? 8.44 },
    })
    // 拖拽/滚轮缩放交互（navigator 缩放）
    const behavior = new here.mapevents.Behavior(new here.mapevents.MapEvents(map))
    mapRef.current = map
    sprayedRef.current = []
    objRef.current = []
    sprayedMapRef.current = null
    carRef.current = null

    // 匹配路径（蓝）——回放下仍全量显示：路网先知，车在路上走
    if (derived.length > 1) {
      const ls = new here.geo.LineString()
      for (const d of derived) ls.pushLatLngAlt(d.matchedLatLng[0], d.matchedLatLng[1])
      map.addObject(
        new here.map.Polyline(ls, { style: { strokeColor: '#2563eb', lineWidth: 3 } }),
      )
    }

    // 视野适配：H.geo.Rect 构造参数顺序 = (top, left, bottom, right)，即 (north, west, south, east)
    let north = -Infinity
    let south = Infinity
    let west = Infinity
    let east = -Infinity
    for (const p of [
      ...trace.map((t) => [t.lat, t.lng] as [number, number]),
      ...derived.map((d) => [d.matchedLatLng[0], d.matchedLatLng[1]] as [number, number]),
    ]) {
      if (p[0] > north) north = p[0]
      if (p[0] < south) south = p[0]
      if (p[1] < west) west = p[1]
      if (p[1] > east) east = p[1]
    }
    if (Number.isFinite(north))
      map.getViewModel().setLookAtData({ bounds: new here.geo.Rect(north, west, south, east) })

    return () => {
      behavior.dispose()
      map.dispose() // HERE 3.1 的正确清理入口（连同引擎资源一并释放）
      mapRef.current = null
      sprayedRef.current = []
      objRef.current = []
      sprayedMapRef.current = null
      carRef.current = null
    }
  }, [here, apikey, trace, derived])

  // GNSS 喷洒：sprayPlan 纯函数算增量（前进补洒/回退回收），本 effect 只做对象映射。
  // ⚠ 无 cleanup（评审 blocker 修正）：React 在每次依赖变化时都先跑上一轮 cleanup，
  // 回滚式 cleanup 会让每步 upTo 变化退化为「全删全重洒」（O(n²)，5x 尾段 ~8 万次引擎操作/秒必卡）。
  // 安全性：卸载/换图由建图 effect 的 dispose+账本重置兜底（声明序先行）；
  // stale-map 守卫自愈「地图重建而本 effect 未重跑」的理论窗口（App 数据流必经卸载，纯防御）。
  useEffect(() => {
    const map = mapRef.current
    if (!here || !map) return
    if (sprayedMapRef.current !== map) {
      sprayedMapRef.current = map
      sprayedRef.current = [] // 旧图对象已随 dispose 死亡，账本清零全量重洒
      objRef.current = []
    }
    const { removeIdx, addIdx } = sprayPlan(sprayedRef.current, Math.min(upTo, trace.length - 1), 2)
    for (const i of removeIdx) {
      const k = sprayedRef.current.indexOf(i)
      map.removeObject(objRef.current.splice(k, 1)[0])
      sprayedRef.current.splice(k, 1)
    }
    for (const i of addIdx) {
      const obj = new here.map.Circle({ lat: trace[i].lat, lng: trace[i].lng }, 3, {
        style: { fillColor: 'rgba(245, 158, 11, 0.9)', strokeColor: '#f59e0b', lineWidth: 1 },
      })
      map.addObject(obj)
      sprayedRef.current.push(i)
      objRef.current.push(obj)
    }
  }, [here, upTo, trace])

  // 车标：位置沿匹配路径垂足，航向烘焙进分桶图标。
  // volatility: true（评审 major 修正）：HERE 3.1 非易失对象的 setGeometry 走引擎 100ms debounce
  // 路径，50 次/秒更新会步进/冻结；易失对象即时 flush（官方 draggable-marker 示例同款配置）。
  useEffect(() => {
    const map = mapRef.current
    if (!here || !map) return
    if (carIndex === undefined || !trace[carIndex]) {
      if (carRef.current) {
        map.removeObject(carRef.current)
        carRef.current = null
      }
      return
    }
    if (iconCacheRef.current.size === 0) {
      // 预热全部 72 个航向桶（评审 minor 采纳）：data-URI SVG icon 异步 LOADING，
      // 惰性创建会在弯道换桶瞬间闪空 1–2 帧；预热后 setIcon 恒命中 READY 态
      for (let h = 0; h < 360; h += 5) carIcon(here, iconCacheRef.current, h)
    }
    const d = derived[carIndex]
    const coord = d
      ? { lat: d.matchedLatLng[0], lng: d.matchedLatLng[1] }
      : { lat: trace[carIndex].lat, lng: trace[carIndex].lng }
    const icon = carIcon(here, iconCacheRef.current, trace[carIndex].headingDeg)
    if (!carRef.current) {
      carRef.current = new here.map.Marker(coord, { icon, volatility: true })
      map.addObject(carRef.current)
    } else {
      carRef.current.setGeometry(coord)
      carRef.current.setIcon(icon)
    }
  }, [here, carIndex, trace, derived])

  if (!here) {
    const car =
      carIndex !== undefined && trace[carIndex]
        ? {
            lat: derived[carIndex]?.matchedLatLng[0] ?? trace[carIndex].lat,
            lng: derived[carIndex]?.matchedLatLng[1] ?? trace[carIndex].lng,
            headingDeg: trace[carIndex].headingDeg,
          }
        : undefined
    return (
      <div style={{ width: '100%', height: '100%' }}>
        <SvgFallback trace={trace} derived={derived} width={960} height={540} upToIndex={upTo} car={car} />
      </div>
    )
  }
  return <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
}
```

- [ ] **Step 4: 修改 `src/components/SvgFallback.tsx`**（props 扩展 + 计算提入 useMemo + 三处渲染变化）

props 与组件签名替换为：

```tsx
export interface SvgFallbackProps {
  trace: TrajPoint[]
  derived: DerivedPoint[]
  width: number
  height: number
  /** 回放：散点/终点标记只画到该下标（含）。缺省 = 全量 */
  upToIndex?: number
  /** 回放车标（undefined = 无）。位置/航向由 MapView 归一后传入 */
  car?: { lat: number; lng: number; headingDeg: number }
}
```

组件体重构（评审 major 修法）：原渲染期内的 all/bbox/project/xy/xyStr/thinIndices/比例尺计算对 `[trace, derived]` 完全稳定——整体提入 `useMemo`（顶部 `import { useMemo } from 'react'`），回放 50 次/秒重渲染下每帧只剩 filter+map 的 DOM diff 与车标变换。骨架（计算体逐行沿用现有实现，包裹位置如下）：

```tsx
export default function SvgFallback({ trace, derived, width, height, upToIndex, car }: SvgFallbackProps) {
  const geo = useMemo(() => {
    const all: LatLng[] = [
      ...trace.map((t) => [t.lat, t.lng] as LatLng),
      ...derived.map((d) => [d.matchedLatLng[0], d.matchedLatLng[1]] as LatLng),
    ]
    if (all.length === 0) return null
    // ↓↓↓ 以下与现文件 L31-93 逐行相同（bbox 循环 / center / project / viewBox 边距 /
    // ↓↓↓ unitsPerMeter 归一化 / xy / xyStr / 比例尺 barM/barUnits/barLabel/barX/barY），不改算法
    // ...（原计算体原样搬入）...
    return {
      vw, vh, xy, xyStr,
      thin: thinIndices(trace.length),
      barX, barY, barUnits, barLabel,
    }
  }, [trace, derived])
  if (!geo) return null
  const { vw, vh, xy, xyStr, thin, barX, barY, barUnits, barLabel } = geo
  // 仍以全量 trace+derived 定 bbox——回放期间画幅稳定不跳变（upTo/car 不进 useMemo 依赖）
  const upTo = upToIndex ?? trace.length - 1
```

GNSS 散点段替换为（抽稀规则不变，只是过滤已洒下标——stride 由全量长度决定，与静态模式完全一致）：

```tsx
      {/* GNSS 散点（橙，抽稀；回放下只画已洒到的下标——filter 是每帧仅有的全量遍历） */}
      {thin
        .filter((i) => i <= upTo)
        .map((i) => {
          const [cx, cy] = xy([trace[i].lat, trace[i].lng])
          return <circle key={i} data-testid="gnss-dot" cx={cx} cy={cy} r={1.5} fill="#f59e0b" />
        })}
```

起点/终点标记段替换为（起点恒显；**终点行进到才出现**——`upTo >= trace.length - 1`）：

```tsx
      {/* 起点（绿）恒显；终点（红）行进到才出现 */}
      {trace.length > 0 && (
        <>
          <circle
            data-testid="endpoint-marker"
            cx={xy([trace[0].lat, trace[0].lng])[0]}
            cy={xy([trace[0].lat, trace[0].lng])[1]}
            r={4.5}
            fill="#16a34a"
            stroke="#ffffff"
            strokeWidth={1}
          >
            <title>起点</title>
          </circle>
          {upTo >= trace.length - 1 && (
            <circle
              data-testid="endpoint-marker"
              cx={xy([trace[trace.length - 1].lat, trace[trace.length - 1].lng])[0]}
              cy={xy([trace[trace.length - 1].lat, trace[trace.length - 1].lng])[1]}
              r={4.5}
              fill="#dc2626"
              stroke="#ffffff"
              strokeWidth={1}
            >
              <title>终点</title>
            </circle>
          )}
        </>
      )}
```

比例尺段之前插入车标（箭头指向正北 = −y，`rotate(heading)` 顺时针 = 罗盘航向；SVG rotate 与 y 向下正好同向）：

```tsx
      {/* 回放车标：位置沿匹配路径，航向 = IMU yaw */}
      {car && (
        <polygon
          data-testid="car-marker"
          points="0,-6 4.5,5 0,2.5 -4.5,5"
          transform={`translate(${xy([car.lat, car.lng]).join(' ')}) rotate(${car.headingDeg})`}
          fill="#1d4ed8"
          stroke="#ffffff"
          strokeWidth={1}
        />
      )}
```

- [ ] **Step 5: 跑绿（含既有 2 条不改动）**

```bash
npx vitest run src/__tests__/mapview.test.tsx
```

Expected: 4 passed（既有 2 条 + 新 2 条）。

- [ ] **Step 6: Commit**

```bash
git add src/components/MapView.tsx src/components/SvgFallback.tsx src/__tests__/mapview.test.tsx
git commit -m "feat: replay rendering in map view (progressive spray, car marker)"
```

---

### Task 6: App 双模式 tab + 回放接线

**Files:**
- Modify: `src/App.tsx`（整体重写为 Step2 编排壳）
- Test: `src/__tests__/app.test.tsx`（既有 3 条不改，追加 1 条）

**Interfaces:**
- Consumes: `usePlayback`（T2）、`ReplayBar`（T3）、`DeviationReplayChart`（T4）、`MapView` 新 props（T5）、Step1 全部既有产物
- Produces: Step2 完整页面——header 增加双模式 tablist（`role="tablist"`；`工程分析模式`/`客户演示模式`，`aria-selected` 标当前）；分析模式 = Step1 行为（`upToIndex = trace.length - 1` 全量 + StatsPanel）；演示模式 = `upToIndex = pb.index` + `carIndex = pb.index` + DeviationReplayChart + ReplayBar（main 与 footer 之间）；**切回分析模式自动暂停**（`pb.pause()`，进度保留）

- [ ] **Step 1: 在 `src/__tests__/app.test.tsx` 追加失败测试**（既有 beforeEach/afterEach 桩沿用；本条测试内额外**桩掉 rAF 不放帧**——播放态翻转是同步 setState，不依赖帧推进）

```tsx
  it('demo tab: replay bar + linked chart + car marker; switching back pauses', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)) // 不放帧：断言与时间解耦
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    render(<App />)
    await screen.findByText('MOCK')

    // 默认工程分析模式：tab 选中态 + 无回放条 + StatsPanel 在
    expect(screen.getByRole('tab', { name: '工程分析模式' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByRole('slider')).toBeNull()
    expect(screen.getByText('偏差分布直方图')).toBeTruthy()

    // 切到客户演示模式
    fireEvent.click(screen.getByRole('tab', { name: '客户演示模式' }))
    expect(screen.getByRole('tab', { name: '客户演示模式' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByText('偏差分布直方图')).toBeNull() // 侧栏换成回放曲线
    const trace = trace0033 as unknown as TrajPoint[]
    const slider = screen.getByRole('slider') as HTMLInputElement
    expect(Number(slider.max)).toBe(trace.length - 1) // 1593
    const totalSec = trace[trace.length - 1].timestamp
    expect(screen.getByTestId('replay-time').textContent).toContain(`${totalSec.toFixed(1)}s`)
    expect(screen.getByTestId('replay-deviation').textContent).toContain('m')
    expect(screen.getByTestId('car-marker')).toBeTruthy() // SVG 兜底路径车标在

    // 播放按钮同步翻转；倍速按钮 aria-pressed
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    expect(screen.getByRole('button', { name: '暂停' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '2x' }))
    expect(screen.getByRole('button', { name: '2x' }).getAttribute('aria-pressed')).toBe('true')

    // 播放中拖动进度条：pointerdown 即暂停（防 rAF 前推漂移）、松手自动续播；
    // 拖动后时间读数联动（期望值取自导入数据，不硬编码）
    fireEvent.pointerDown(slider)
    expect(screen.getByRole('button', { name: '播放' })).toBeTruthy() // 已暂停
    fireEvent.change(slider, { target: { value: '100' } })
    const t100 = trace[100].timestamp
    expect(screen.getByTestId('replay-time').textContent).toContain(`${t100.toFixed(1)}s`)
    fireEvent.pointerUp(slider)
    expect(screen.getByRole('button', { name: '暂停' })).toBeTruthy() // 拖动前在播放 → 续播

    // 切回工程分析：回放条消失并已暂停；再切回来按钮为「播放」（进度保留在 100）
    fireEvent.click(screen.getByRole('tab', { name: '工程分析模式' }))
    expect(screen.queryByRole('slider')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: '客户演示模式' }))
    expect(screen.getByRole('button', { name: '播放' })).toBeTruthy()
    expect((screen.getByRole('slider') as HTMLInputElement).value).toBe('100')
  })
```

- [ ] **Step 2: 跑失败**

```bash
npx vitest run src/__tests__/app.test.tsx
```

Expected: 新 1 条 FAIL（无 tab role），既有 3 条仍 PASS。

- [ ] **Step 3: 重写 `src/App.tsx`（整文件替换为）**

```tsx
import { useEffect, useRef, useState } from 'react'
import DeviationReplayChart from './components/DeviationReplayChart'
import MapView from './components/MapView'
import ReplayBar from './components/ReplayBar'
import SourceBadge from './components/SourceBadge'
import StatsPanel from './components/StatsPanel'
import { usePlayback } from './hooks/usePlayback'
import { derive } from './lib/derive'
import { matchService, writeCache } from './lib/fixtureStore'
import { loadHereMaps } from './lib/hereLoader'
import type { CacheEntry, DerivedPoint, TrajPoint } from './types'

const DRIVE_IDS = ['2011_09_30_drive_0033', '2011_09_26_drive_0011'] // 顶栏下拉顺序 0033/0011

// spec L45 双模式：工程分析（静态对比）/ 客户演示（回放）
const MODES = [
  { id: 'analysis', label: '工程分析模式' },
  { id: 'demo', label: '客户演示模式' },
] as const
type Mode = (typeof MODES)[number]['id']

interface DriveData {
  trace: TrajPoint[]
  derived: DerivedPoint[]
  entry: CacheEntry
}

/** mapStatus（Step1 生命周期约定）：空 key 同步 fallback 不调 loader；非空异步定夺，pending 渲染加载占位 */
type MapStatus = 'pending' | 'ok' | 'fallback'

/** Step2 编排壳：Step1 数据流不动 + 双模式 tab + 回放时钟接线 */
export default function App() {
  // 渲染期读取（非模块顶层 const）：保证测试可经 vi.stubEnv 注入空 key，防 .env 真 key 固化
  const apikey = import.meta.env.VITE_HERE_KEY ?? ''

  const [driveId, setDriveId] = useState(DRIVE_IDS[0])
  const [reloadToken, setReloadToken] = useState(0) // 「清除缓存」后重载当前 driveId
  const [data, setData] = useState<DriveData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [mapStatus, setMapStatus] = useState<MapStatus>(apikey ? 'pending' : 'fallback')
  const [mode, setMode] = useState<Mode>('analysis')

  const lastIndex = data && data.trace.length > 0 ? data.trace.length - 1 : 0
  const pb = usePlayback(lastIndex) // 回放状态住在 App：tab 切换保留进度，换轨迹自动复位
  const scrubWasPlayingRef = useRef(false) // 拖动前是否在播放（松手据此续播）

  useEffect(() => {
    if (!apikey) return // 空 key：同步 fallback，loader 永不被调
    let cancelled = false
    loadHereMaps(apikey)
      .then(() => {
        if (!cancelled) setMapStatus('ok')
      })
      .catch(() => {
        if (!cancelled) setMapStatus('fallback') // 加载失败/超时/断网 → SVG 兜底
      })
    return () => {
      cancelled = true
    }
  }, [apikey])

  useEffect(() => {
    let cancelled = false
    setData(null)
    setError(null)
    setLoading(true)
    async function load(): Promise<void> {
      try {
        const traceRes = await fetch(`/sample/here/${driveId}.json`)
        if (!traceRes.ok) throw new Error(`trace load failed: ${driveId}`)
        const trace = (await traceRes.json()) as TrajPoint[]
        const entry = await matchService(driveId)
        if (cancelled) return
        // 未缓存（fixture 的 derived 为空）→ 派生并回填缓存
        let derived = entry.derived
        if (derived.length === 0) {
          derived = derive(trace, entry.response)
          writeCache({ ...entry, derived })
        }
        setData({ trace, derived, entry: { ...entry, derived } })
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [driveId, reloadToken])

  /** 遍历 localStorage 删除 here-mm-cache:* 前缀键后重载当前 driveId */
  function handleClearCache(): void {
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k !== null && k.startsWith('here-mm-cache:')) doomed.push(k)
    }
    for (const k of doomed) localStorage.removeItem(k)
    setReloadToken((t) => t + 1)
  }

  /** 切回工程分析即暂停（静态分析态不该有后台播放）；进度与倍速保留 */
  function switchMode(m: Mode): void {
    if (m === 'analysis') pb.pause()
    setMode(m)
  }

  /** 拖动即暂停（评审 minor 采纳）：防播放中拖动被 rAF 时钟持续前推（5x 下松手落点漂移 ~50 点/秒）；
   *  松手时若拖动前在播放则续播——play() 会重置基线时间戳，续播无跳帧 */
  function handleScrubStart(): void {
    scrubWasPlayingRef.current = pb.playing
    pb.pause()
  }
  function handleScrubEnd(): void {
    if (scrubWasPlayingRef.current) pb.play()
  }

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          padding: '0.6rem 1.5rem',
          borderBottom: '1px solid #e5e7eb',
        }}
      >
        <h1 style={{ fontSize: '1.05rem', margin: 0 }}>HERE Map Matching POC</h1>
        <label htmlFor="drive-select" style={{ fontSize: 13, color: '#374151' }}>
          轨迹
        </label>
        <select
          id="drive-select"
          value={driveId}
          onChange={(e) => setDriveId(e.target.value)}
          style={{ padding: '0.25rem 0.5rem' }}
        >
          {DRIVE_IDS.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        {data && <SourceBadge source={data.entry.source} />}
        <div role="tablist" aria-label="查看模式" style={{ display: 'flex', gap: 4, marginLeft: '0.75rem' }}>
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={mode === m.id}
              onClick={() => switchMode(m.id)}
              style={{
                padding: '0.3rem 0.9rem',
                cursor: 'pointer',
                borderRadius: 6,
                border: '1px solid #e5e7eb',
                background: mode === m.id ? '#eff6ff' : '#ffffff',
                fontWeight: mode === m.id ? 700 : 400,
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={handleClearCache}
          style={{ marginLeft: 'auto', padding: '0.3rem 0.9rem', cursor: 'pointer' }}
        >
          清除缓存
        </button>
      </header>

      <main style={{ flex: 1, display: 'flex', gap: '1rem', padding: '1rem 1.5rem', alignItems: 'stretch' }}>
        <section
          style={{
            flex: 1,
            minHeight: 520,
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            overflow: 'hidden',
            background: '#f9fafb',
          }}
        >
          {error ? (
            <p style={{ color: '#dc2626', padding: '1rem' }}>加载失败: {error}</p>
          ) : loading && !data ? (
            <p style={{ color: '#6b7280', padding: '1rem' }}>加载中…</p>
          ) : mapStatus === 'pending' ? (
            <p style={{ color: '#6b7280', padding: '1rem' }}>正在加载 HERE 地图…</p>
          ) : data ? (
            <MapView
              trace={data.trace}
              derived={data.derived}
              mapStatus={mapStatus === 'ok' ? 'ok' : 'fallback'}
              apikey={apikey}
              /* 分析模式传全量下标 → 同一喷洒路径一次洒满，HERE 地图实例跨 tab 复用不重建 */
              upToIndex={mode === 'demo' ? pb.index : data.trace.length - 1}
              carIndex={mode === 'demo' ? pb.index : undefined}
            />
          ) : null}
        </section>
        <aside style={{ width: 380, flexShrink: 0 }}>
          {mode === 'analysis' ? (
            <StatsPanel trace={data?.trace ?? []} derived={data?.derived ?? []} />
          ) : data ? (
            <DeviationReplayChart trace={data.trace} derived={data.derived} index={pb.index} />
          ) : null}
        </aside>
      </main>

      {mode === 'demo' && data && data.trace.length > 0 && (
        <ReplayBar
          index={pb.index}
          lastIndex={lastIndex}
          tSec={data.trace[Math.min(pb.index, lastIndex)].timestamp}
          totalSec={data.trace[lastIndex].timestamp}
          playing={pb.playing}
          speed={pb.speed}
          onToggle={pb.toggle}
          onSeek={pb.seek}
          onSpeed={pb.setSpeed}
          onScrubStart={handleScrubStart}
          onScrubEnd={handleScrubEnd}
        />
      )}

      <footer style={{ padding: '0.5rem 1.5rem', borderTop: '1px solid #e5e7eb', fontSize: 12, color: '#6b7280' }}>
        Data: KITTI (Geiger et al., 2013), CC BY-NC-SA · Map: HERE
      </footer>
    </div>
  )
}
```

- [ ] **Step 4: 全量跑绿**

```bash
npx vitest run
```

Expected: 全部 passed（既有 37 条不改一行仍绿 + 新增用例全绿）。

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/__tests__/app.test.tsx
git commit -m "feat: Step2 dual-mode tabs with linked replay"
```

---

### Task 7: Step2 验收

**Files:** 无新文件；验证 + 手动验收。

- [ ] **Step 1: 全量绿**

```bash
npm run build && npm run test
```

Expected: build 零错误；测试全过（含 Step1 既有 37 条）。

- [ ] **Step 2: spec 交付判据逐条核对（真实浏览器手动验收，`.env` 有 key）**

后台起 `npm run dev`，浏览器逐项核对 0033：

| 判据（spec L48/L121） | 操作 | 期望 |
|---|---|---|
| 播放/暂停 | 点「客户演示模式」→ ▶ / ⏸ | 车标沿蓝色匹配路线行驶、暂停即停 |
| 倍速 1x/2x/5x | **先播放至 ≥100s 再切 5x 快进到终点**（评审修正：尾段 ~800 点是最重负载，快速手测前几十秒发现不了退化） | 5x 下无肉眼卡顿（「回放流畅」判据）；车标移动连续、无步进/无冻结 |
| 进度条拖动 | 播放中前拖 / 回拖；暂停态拖动 | 播放中拖动即暂停、松手自动续播且落点=松手位置；前拖补洒橙点；回拖已洒橙点消失（HERE 与 SVG 两路径一致） |
| 车标航向 | 观察弯道 | 车头方向与行驶方向一致（IMU yaw），非固定朝向 |
| GNSS 逐点喷洒 | 播放中观察 | 橙点随播放逐个出现，城市峡谷段（0011）偏离路网可见——叙事素材 |
| 偏差曲线联动（0033） | 播放中看右栏 | 30s 滑窗曲线滚动 + 当前偏差读数变化 |
| 偏差曲线联动（0011） | 播放 0011 看右栏 | ~11.6s 自适应滑窗照常滚动；城市峡谷段读数跳变与车标/散点偏离同步 |
| 终点行为 | 播放到头 | 自动暂停；再点 ▶ 从头重播 |
| 模式切换 | 来回切 tab | 分析=全量散点+StatsPanel；演示=回放；切回自动暂停、进度保留 |
| 换轨迹 | 切 0011 | 回放复位到 0，全流程可走通 |

- [ ] **Step 3: 无 key 兜底验收**

```bash
mv .env .env.bak
```

重启 dev 服务器 → 客户演示模式全流程（SVG 路径：散点切片 + 车标旋转 + 曲线联动）仍可用，**并在 SVG 路径下重复 5x 流畅度核对**（评审 major 修正：~800 圆 React diff 是兜底路径的最重负载）→ 恢复 `.env` 并重启。

- [ ] **Step 4: 收尾**

```bash
git status --porcelain
git log --oneline -8
```

Expected: 工作区干净；Step2 六个 commit 在列。验收截图/文字记录存 `.superpowers/sdd/2026-09-08-here-poc-step2/`（可选）。

---

## Self-Review 记录

- **Spec 覆盖**：spec L48 客户演示模式逐项——播放/暂停（T3）、倍速 1x/2x/5x（T3）、进度条拖动（T3 slider + T2 seek）、车图标沿匹配路线行驶（T5 derived.matchedLatLng）、航向取 IMU yaw（T5 trace.headingDeg）、GNSS 原始点逐个洒出（T5 喷洒）、偏差曲线随时间滚动联动（T4 滑窗）✓；L45 顶部双模式 tab（T6）✓；L121 判据「回放流畅，偏差曲线联动」→ T7 手动验收表逐项核对 ✓。缓存管理「录制」明确归 Step3（spec L50）；地图跟随车标平移非 spec 要求，明确不做。
- **回放层零实时计算（spec L63-66）**：逐帧路径只消费 derived/trace 字段 + sliceWindow 切片 + 5° 分桶 icon 缓存；无 derive/haversine/nearestOnPolyline 调用 ✓
- **占位符扫描**：无 TBD/TODO；T5 Step 4 的「其余行保持不动」是对既有文件的精确增量描述（给出了全部替换段），非省略实现。
- **类型一致性**：`Playback`/`PlaybackSpeed`（T2 产出 / T6 消费）✓；`ReplayBarProps`（T3 产出 / T6 消费）✓；`DeviationReplayChartProps`（T4/T6）✓；`MapViewProps.upToIndex/carIndex`、`SvgFallbackProps.car`（T5 内部成对）✓；`advancePlayback`/`sliceWindow` 签名 T1 定义、T2/T4 消费一致 ✓。
- **测试策略**：rAF 一律不依赖真实定时——hook 测试手动泵帧（确定性时间戳），App 测试桩掉 rAF 不放帧（播放态是同步 setState）；jsdom 只覆盖 fallback 渲染路径，HERE 路径归 T7 真实 key 手动验收（Step1 惯例）。
- **已知运行时待验证项（Errata 预案已写入 T5）**：`H.map.Marker` 的 `setGeometry`/`setIcon`——若真实运行时签名不符，按 Step1 errata 模式实证修正留痕。（`opts.anchor` 平面对象已在评审中经官方文档 + 运行时源码双证可行，不再列为风险；`volatility: true` 已逆向运行时源码证实为逐帧 marker 的必要配置，T7 验收表含「车标无步进/冻结」观察点）

## 修订记录

- 2026-09-08 对抗评审（workflow `step2-plan-review`：4 视角找缺陷 → 每条 3 视角驳斥、≥2 票存活；11 条原始发现，4 确认 / 1 驳回 / 5 minor 越权未验证按 Step1「minor 全收」惯例全收，另 1 条因评审代理网络故障缺法定票但事实核查完全成立、修法 3 行，采纳）后修订：
  - **T5 喷洒 effect 整体重写（blocker，双视角独立发现）**：原「cleanup 回滚 + StrictMode 防御」设计误解了 React 语义——cleanup 在**每次**依赖变化时先于 body 执行（非仅挂载/卸载），回滚账本后每步 upTo 变化都退化为「全删 + 从 0 全量重洒」（0033 全程 ~64 万次引擎对象操作，5x 尾段 ~8 万次/秒必卡）。增量逻辑抽为 lib 纯函数 `sprayPlan`（T1 新增，前进/回退/同步三路径单测），effect 改为无 cleanup + stale-map 守卫；T7 验收表「倍速」行补验收方法（先播至 ≥100s 再切 5x——尾段才是最重负载，快速手测有盲区）
  - **T5 车标 `volatility: true`（major）**：评审者逆向 HERE 3.1 运行时源码证实非易失对象 setGeometry 走引擎 100ms debounce 路径（volatile 对象走伴生数据源即时 flush），50 次/秒更新会步进甚至冻结；官方 draggable-marker 示例同款配置佐证。HereNS Marker opts 补类型；T7 补「车标无步进/冻结」观察点
  - **T4 图表量化 + 自适应窗口（major + minor）**：图表数据 slice 与 XAxis domain 量化到 0.5s 档（`tQ`），经 `useMemo` + `memo` 子组件（稳定引用 props）阻断 50Hz 父级重渲染向 Recharts 传导（读数仍全速跟随 index）；窗口自适应 `min(30, max(5, 全程/2))`——0011（23.2s）得到 ~11.6s 滚动窗口，spec「随时间滚动联动」在困难场景 demo 上同样成立；T7 补 0011 曲线联动验收行
  - **T5 SvgFallback 计算提入 useMemo（major 修法之一）**：bbox/投影/抽稀对 `[trace, derived]` 稳定，挡掉回放 50 次/秒重渲染下每帧数千次 `toLocalM`；每帧仅剩 filter+map 的 keyed DOM diff
  - **T3/T6 拖动即暂停（pause-on-scrub，minor）**：播放中拖进度条 rAF 时钟持续前推拖动位置（5x 松手落点漂移 ~50 点/秒、拇指打滑）——ReplayBar 增 `onScrubStart`/`onScrubEnd`（pointer 生命周期），App 记 wasPlaying、松手 `play()` 续播（重置基线无跳帧）
  - **T5 测试判别力（缺法定票，事实成立，采纳）**：新用例 derived 与 trace 坐标错开 + 断言车标 xy ≠ 对应 gnss-dot xy——「车标沿匹配路线垂足而非 GNSS 原始点」从假绿（改坏实现测试仍绿）变可判别
  - **T5 icon 72 桶预热（minor）**：data-URI SVG icon 异步 LOADING，惰性建桶在弯道换桶瞬间闪空 1–2 帧；首次建车标时全量预热
  - **T5 Errata 预案修正（minor）**：`opts.anchor` 平面对象经官方文档 + 运行时源码双证可行，删除原 anchor 兜底（其引用的 `here.math.Point` 在计划 HereNS 类型中不存在，照抄会编译失败）；预案仅保留 setGeometry/setIcon 退化路径
  - 驳回 1 条：「T4 组件测试只断言 svg 存在、滑窗接线无自动化锁定」——范围裁决：滑窗本体 T1 已穷尽单测 + T7 验收点名「30s 滑窗滚动」；但采纳其廉价加固（aside 暴露 `data-length` + 窗口点数断言，兼锁 tCur=时间戳接线）

## Errata（实现期运行时实证修正）

（执行期追加）

