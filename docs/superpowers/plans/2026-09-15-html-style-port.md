# HTML Teaser 样式移植 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 HTML teaser 的 60fps 子帧插值播放手感与蓝色系视觉样式移植进 React 工程，行为语义零变化。

**Architecture:** 时钟单一来源（`usePlayback`）新增暴露浮点 `pos`；插值算法落为 `playback.ts` 纯函数（位置垂足插值 + 航向最短弧插值）；MapView 内部用 `useMemo` 统一计算 `carState` 供 HERE effect、SVG 兜底、heading-up 旋转三处消费；视觉六项为纯样式改动。

**Tech Stack:** Vite 7 · React 19 · TypeScript · Vitest + @testing-library/react · Recharts（保留）· HERE Maps JS API 3.1

**Spec:** `docs/superpowers/specs/2026-09-15-html-style-port-design.md`

## Global Constraints

- 行为语义四不变：车沿 `derived[].matchedLatLng` 垂足、渐进洒点、车头向上保留、回放条底部通栏
- 不引入新依赖；不移除 Recharts；不改 `SvgFallbackProps` 接口（car 对象由 MapView 组装）
- 样式颜色**不进测试断言**（防脆断言），靠手测验收；既有 131 个测试除本计划明确迁移点外期望不动
- **终点标记严禁挂进 MapView 建图 effect**——`upTo` 是喷洒 effect 的依赖，进建图会随回放逐帧 dispose/重建地图（spec 加粗警告）
- `TrajPoint` 必填 `timestampUtc: string`（测试构造勿漏）
- 测试命令统一 `npm test`（vitest run，工作目录 `D:\here\here-poc`）；单文件可 `npx vitest run src/__tests__/<file>`

---

### Task 1: playback.ts 插值纯函数（TDD）

**Files:**
- Modify: `src/lib/playback.ts`
- Test: `src/__tests__/playback.test.ts`

**Interfaces:**
- Consumes: `TrajPoint`/`DerivedPoint`（`src/types.ts`，已存在）
- Produces:
  - `interpCarPos(pos: number, trace: readonly TrajPoint[], derived: readonly DerivedPoint[]): [number, number]`
  - `interpHeadingDeg(h0: number, h1: number, frac: number): number`

- [ ] **Step 1: 写失败测试**

在 `src/__tests__/playback.test.ts` 顶部 import 区改为：

```ts
import { describe, expect, it } from 'vitest'
import { advancePlayback, interpCarPos, interpHeadingDeg, sliceWindow, sprayPlan } from '../lib/playback'
import type { DerivedPoint, TrajPoint } from '../types'
```

文件末尾追加：

```ts
// ── 子帧插值（HTML teaser 样式移植）：位置垂足插值 + 航向最短弧插值 ──
function tp(lat: number, lng: number): TrajPoint {
  return { lat, lng, timestamp: 0, timestampUtc: '', headingDeg: 0, speedMps: 0, numsats: 6 }
}
function dp(i: number, lat: number, lng: number): DerivedPoint {
  return { i, matchedLatLng: [lat, lng], deviationM: 0, headingDeg: 0, speedMps: 0, linkId: `s${i}` }
}

describe('interpCarPos', () => {
  const trace = [tp(49.0, 8.4), tp(49.001, 8.401), tp(49.002, 8.402)]
  const derived = [dp(0, 49.01, 8.41), dp(1, 49.02, 8.42), dp(2, 49.03, 8.43)]

  it('整数 pos（frac=0）= 该帧垂足——与旧 carIndex 行为逐位一致', () => {
    expect(interpCarPos(1, trace, derived)).toEqual([49.02, 8.42])
  })
  it('中段 pos=0.5 → 两垂足中点', () => {
    expect(interpCarPos(0.5, trace, derived)).toEqual([(49.01 + 49.02) / 2, (8.41 + 8.42) / 2])
  })
  it('越界钳制：负数→首帧、超尾→末帧', () => {
    expect(interpCarPos(-3, trace, derived)).toEqual([49.01, 8.41])
    expect(interpCarPos(99, trace, derived)).toEqual([49.03, 8.43])
  })
  it('末帧整数 pos（i0===i1）不外推', () => {
    expect(interpCarPos(2, trace, derived)).toEqual([49.03, 8.43])
  })
  it('derived 缺帧回退 trace 坐标', () => {
    const partial = [dp(0, 49.01, 8.41)]
    expect(interpCarPos(0.5, trace, partial)).toEqual([(49.01 + 49.001) / 2, (8.41 + 8.401) / 2])
  })
})

describe('interpHeadingDeg', () => {
  it('非环绕线性插值', () => {
    expect(interpHeadingDeg(100, 110, 0.25)).toBeCloseTo(102.5, 10)
  })
  it('跨北向环绕走 20° 短弧（350↔10）', () => {
    expect(interpHeadingDeg(350, 10, 0.5)).toBeCloseTo(360, 10)
    expect(interpHeadingDeg(10, 350, 0.5)).toBeCloseTo(0, 10)
  })
  it('frac 端点：0 取 h0；1 为 370（线性外推端点，与 10 相差整 360°，由调用方 yawToCompassDeg 归一为同一罗盘角）', () => {
    expect(interpHeadingDeg(350, 10, 0)).toBe(350)
    expect(interpHeadingDeg(350, 10, 1)).toBe(370)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/__tests__/playback.test.ts`
Expected: FAIL — `interpCarPos`/`interpHeadingDeg` 未导出（import 报错）

- [ ] **Step 3: 最小实现**

`src/lib/playback.ts` 顶部加 import，末尾追加两个函数：

```ts
import type { DerivedPoint, TrajPoint } from '../types'
```

```ts
/** 子帧插值（HTML teaser 同款算法）：pos 浮点 → 相邻两帧匹配垂足线性插值。
 *  越界钳制到 [0, last]；derived[i] 缺失回退 trace[i] 坐标；i0===i1（末帧/单点）不外推。 */
export function interpCarPos(
  pos: number,
  trace: readonly TrajPoint[],
  derived: readonly DerivedPoint[],
): [number, number] {
  const last = trace.length - 1
  if (last < 0) return [0, 0]
  const clamped = Math.max(0, Math.min(pos, last))
  const i0 = Math.floor(clamped)
  const i1 = Math.min(i0 + 1, last)
  const frac = i0 === i1 ? 0 : clamped - i0
  const a = derived[i0]?.matchedLatLng ?? [trace[i0].lat, trace[i0].lng]
  const b = derived[i1]?.matchedLatLng ?? [trace[i1].lat, trace[i1].lng]
  return [a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac]
}

/** 航向最短弧插值：±180° 环绕处理后线性过渡。不取模——由调用方 yawToCompassDeg 归一。 */
export function interpHeadingDeg(h0: number, h1: number, frac: number): number {
  let d = h1 - h0
  if (d > 180) d -= 360
  if (d < -180) d += 360
  return h0 + d * frac
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/__tests__/playback.test.ts`
Expected: PASS（既有 + 新增 8 用例全绿）

- [ ] **Step 5: Commit**

```bash
git add src/lib/playback.ts src/__tests__/playback.test.ts
git commit -m "feat(playback): sub-frame car position and shortest-arc heading interpolation"
```

---

### Task 2: usePlayback 暴露浮点 pos（TDD）

**Files:**
- Modify: `src/hooks/usePlayback.ts`
- Test: `src/__tests__/usePlayback.test.ts`

**Interfaces:**
- Consumes: 无（纯 hook 内部改造）
- Produces: `Playback` 接口新增 `pos: number`（浮点，rAF 每帧更新；`index` 语义不变）

- [ ] **Step 1: 写失败测试**

`src/__tests__/usePlayback.test.ts` 末尾追加：

```ts
describe('usePlayback pos（子帧浮点暴露）', () => {
  it('pos 每帧浮点更新；index 保持整数（pos − index ∈ [0,1)）', () => {
    const { result } = renderHook(() => usePlayback(9))
    act(() => result.current.play())
    act(() => flushFrame(0)) // 基线
    act(() => flushFrame(50)) // dt=50ms → +0.5
    expect(result.current.pos).toBeCloseTo(0.5, 10)
    expect(result.current.index).toBe(0)
    act(() => flushFrame(100)) // dt=50ms → +0.5 → 1.0（rAF 时间戳为绝对时间，须递增）
    expect(result.current.pos).toBeCloseTo(1, 10)
    expect(result.current.index).toBe(1)
  })

  it('seek 同步 pos；终点 pos === lastIndex；终点重播归零；lastIndex 复位归零', () => {
    const { result } = renderHook(() => usePlayback(9))
    act(() => result.current.seek(3))
    expect(result.current.pos).toBe(3)
    act(() => result.current.play())
    act(() => flushFrame(0))
    act(() => flushFrame(10000)) // 远超终点 → 钳制
    expect(result.current.pos).toBe(9)
    act(() => result.current.play()) // 终点重播
    expect(result.current.pos).toBe(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/__tests__/usePlayback.test.ts`
Expected: FAIL — `result.current.pos` 为 `undefined`

- [ ] **Step 3: 最小实现**

`src/hooks/usePlayback.ts` 改动四处：

(a) 接口与状态（`index` 声明后加一行；接口注释同步）：

```ts
export interface Playback {
  /** 当前整数下标（0..lastIndex）；仅整数变化才触发重渲染 */
  index: number
  /** 当前浮点位置（0..lastIndex，rAF 每帧更新）——子帧插值的时钟源 */
  pos: number
  playing: boolean
  // ...其余不变
}
```

```ts
const [index, setIndex] = useState(0)
const [pos, setPos] = useState(0)
```

(b) rAF tick 内，`posRef.current = next` 之后加：

```ts
setPos(next)
```

(c) 两个复位点：`lastIndex` 复位 effect 里 `setIndex(0)` 后加 `setPos(0)`；`play()` 终点重播分支 `setIndex(0)` 后加 `setPos(0)`。

(d) `seek` 内 `setIndex(clamped)` 后加 `setPos(clamped)`；返回对象加 `pos`：

```ts
return { index, pos, playing, speed, play, pause, toggle, setSpeed, seek }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/__tests__/usePlayback.test.ts`
Expected: PASS（既有 5 用例 + 新增 2 用例）

- [ ] **Step 5: Commit**

```bash
git add src/hooks/usePlayback.ts src/__tests__/usePlayback.test.ts
git commit -m "feat(playback): expose float pos for sub-frame rendering"
```

---

### Task 3: MapView/App 消费浮点 carPos

**Files:**
- Modify: `src/components/MapView.tsx`（props 重命名 + carState 统一计算）
- Modify: `src/App.tsx:301`（`carIndex` → `carPos`）
- Test: `src/__tests__/mapview.test.tsx:62-74`（一处 prop 迁移）

**Interfaces:**
- Consumes: `interpCarPos`/`interpHeadingDeg`（Task 1）、`pb.pos`（Task 2）
- Produces: `MapViewProps.carPos?: number`（浮点；取代 `carIndex`）；`SvgFallbackProps` **零改动**

- [ ] **Step 1: 迁移测试断言**

`src/__tests__/mapview.test.tsx` 第 62-74 行用例：

```tsx
it('upToIndex limits spray to 1 dot + start marker only; car marker present as HTML overlay', () => {
  const { container } = render(
    <MapView trace={trace} derived={derived} mapStatus="fallback" apikey="" upToIndex={1} carPos={1} />,
  )
  // ...断言原样不动（carPos=1 整数 frac=0，渲染结果与 carIndex=1 逐位一致）
```

仅改 `carIndex={1}` → `carPos={1}`；第 76 行用例名 `no car marker without carIndex` 改为 `no car marker without carPos`（该用例不传该 prop，无代码改动）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/__tests__/mapview.test.tsx`
Expected: FAIL — `carPos` 不是 MapView 的 prop（TS 报错或行为不生效，car-marker 断言失败）

- [ ] **Step 3: 改 MapView**

(a) import 区加：

```ts
import { interpCarPos, interpHeadingDeg } from '../lib/playback'
```

(b) props 接口：`carIndex?: number` 改名 `carPos?: number`，注释改为：

```ts
/** 回放：车标浮点位置——位置取相邻垂足插值（interpCarPos），航向取 IMU yaw 最短弧插值（interpHeadingDeg）。缺省 = 无车标 */
carPos?: number
```

(c) 删除组件顶部的 `const compassDeg = ...`（原 173-175 行），替换为统一计算点（放在 `gnssSampleIdx` 的 useMemo 之后）：

```tsx
/** 车标状态（子帧插值唯一计算点）：HERE effect、SVG 兜底分支、heading-up 旋转三处共用 */
const carState = useMemo(() => {
  if (carPos === undefined || trace.length === 0) return undefined
  const last = trace.length - 1
  const clamped = Math.max(0, Math.min(carPos, last))
  const i0 = Math.floor(clamped)
  const i1 = Math.min(i0 + 1, last)
  const frac = i0 === i1 ? 0 : clamped - i0
  const [lat, lng] = interpCarPos(clamped, trace, derived)
  return {
    lat,
    lng,
    compassDeg: yawToCompassDeg(interpHeadingDeg(trace[i0].headingDeg, trace[i1].headingDeg, frac)),
  }
}, [carPos, trace, derived])
```

(d) 车标 effect（原 336-373 行）：守卫与取值改为消费 `carState`，效果通道（icon 预热、setCenter/setZoom、volatility marker 增改）原样保留：

```tsx
useEffect(() => {
  const map = mapRef.current
  if (!here || !map) return
  if (!carState) {
    if (carRef.current) {
      map.removeObject(carRef.current)
      carRef.current = null
    }
    return
  }
  if (iconCacheRef.current.size === 0) {
    for (let h = 0; h < 360; h += 5) carIcon(here, iconCacheRef.current, h)
  }
  const coord = { lat: carState.lat, lng: carState.lng }
  try {
    map.setCenter(coord)
    map.setZoom(headingUp ? 16 : 17)
  } catch {
    // 静默
  }
  const icon = carIcon(here, iconCacheRef.current, carState.compassDeg, 56)
  if (!carRef.current) {
    carRef.current = new here.map.Marker(coord, { icon, volatility: true })
    map.addObject(carRef.current)
  } else {
    carRef.current.setGeometry(coord)
    carRef.current.setIcon(icon)
  }
}, [here, carState, headingUp])
```

(e) fallback 分支的 car 组装（原 377-383 行）替换为 `const car = carState`；heading-up 旋转用 `const compassDeg = carState?.compassDeg ?? 0`（transform 处原引用不变）；`{carIndex !== undefined && (` 的 Heading Up 按钮条件改 `{carPos !== undefined && (`。

- [ ] **Step 4: 改 App.tsx**

第 301 行：

```tsx
carPos={mode === 'demo' ? pb.pos : undefined}
```

（`carIndex` 全仓仅此一处消费，见 grep；`ReplayBar`/`DeviationReplayChart` 继续吃 `pb.index`。）

- [ ] **Step 5: 跑全量测试**

Run: `npm test`
Expected: 全绿（含 app.test.tsx——App 走 fallback 路径，carPos 断言无涉）

- [ ] **Step 6: 手测（有 key）**

Run: `npm run dev` → 0042 + Tunnel 30s + Demo 1x 播放
Expected: 车标 60fps 平滑移动、车头连续转向无逐帧甩动；2x/5x 同验；拖进度条前后正确；清空 `.env` 重启后 SVG 兜底路径同等平滑

- [ ] **Step 7: Commit**

```bash
git add src/components/MapView.tsx src/App.tsx src/__tests__/mapview.test.tsx
git commit -m "feat(demo): 60fps sub-frame car interpolation on matched route"
```

---

### Task 4: 视觉样式六项（纯样式，不进测试）

**Files:**
- Modify: `src/App.tsx`（Tab 激活态）
- Modify: `src/components/StatsPanel.tsx`（chip + 两图表）
- Modify: `src/components/DeviationReplayChart.tsx`（回放图表）
- Modify: `src/components/MapView.tsx`（MM 连续蓝线 + 起终点标记）
- Modify: `src/components/SvgFallback.tsx`（MM 连续蓝线）

**Interfaces:**
- Consumes: 无新接口
- Produces: 无接口变化（纯渲染）

- [ ] **Step 1: Tab 激活态（App.tsx）**

MODES 按钮 style 中：

```tsx
background: mode === m.id ? '#2563eb' : '#ffffff',
color: mode === m.id ? '#ffffff' : 'inherit',
fontWeight: mode === m.id ? 700 : 400,
border: `1px solid ${mode === m.id ? '#2563eb' : '#e5e7eb'}`,
```

- [ ] **Step 2: 统计 chip（StatsPanel.tsx）**

`chipStyle` 常量替换为：

```ts
const chipStyle: CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 2,
  padding: '0.5rem 0.6rem',
  border: '1px solid #dbeafe',
  borderRadius: 8,
  background: '#eff6ff',
  flex: 1,
}
```

`InfoChip` 内：label span `fontSize: 12 → 11`；`<strong style={{ fontSize: 15 }}>` → `fontSize: 20, color: '#1e40af'`。chips 容器从 `display:'flex'` 改 2×2 grid：

```tsx
<div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
```

- [ ] **Step 3: 图表去网格 + 蓝色系**

`StatsPanel.tsx`：import 去掉 `CartesianGrid`；两处 `<CartesianGrid ... />` JSX 删除；偏差-里程 Area 的 `stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.25}` → `stroke="#2563eb" fill="#2563eb" fillOpacity={0.2}`（直方图 Bar 已是 #2563eb 不动）。
`DeviationReplayChart.tsx`：同样去 `CartesianGrid`（import + JSX）；Area 同上改蓝色。

- [ ] **Step 4: MM 连续蓝线**

`MapView.tsx` 建图 effect 的 `if (showMm && derived.length > 0)` 分支内、箭头循环**之前**加：

```tsx
const mmLs = new here.geo.LineString()
for (const i of thinByTimestamp(trace.map((p) => p.timestamp), 0.1, 2000)) {
  if (!derived[i]) continue
  mmLs.pushPoint({ lat: derived[i].matchedLatLng[0], lng: derived[i].matchedLatLng[1] })
}
map.addObject(
  new here.map.Polyline(mmLs, { style: { strokeColor: 'rgba(37,99,235,0.7)', lineWidth: 4 } }),
)
```

`SvgFallback.tsx` 的 `matchedEl` 内、箭头 map **之前**加（在 `<g data-testid="matched-path">` 首子元素位置）：

```tsx
<polyline
  points={derived.map((d) => xy(d.matchedLatLng as LatLng).join(',')).join(' ')}
  fill="none"
  stroke="rgba(37,99,235,0.7)"
  strokeWidth={2}
/>
```

- [ ] **Step 5: 起终点标记（MapView HERE 路径）**

(a) 组件顶部 refs 加 `const endMarkerRef = useRef<HereMarker | null>(null)`；建图 effect 开头重置 `endMarkerRef.current = null`，cleanup 同步置 null。

(b) 建图 effect（起点恒画，放视野适配代码之前）：

```tsx
if (trace.length > 0) {
  map.addObject(
    new here.map.Marker(
      { lat: trace[0].lat, lng: trace[0].lng },
      { icon: new here.map.Icon(
        '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7" fill="#16a34a" stroke="#fff" stroke-width="2"/></svg>',
        { anchor: { x: 10, y: 10 } },
      ) },
    ),
  )
}
```

(c) **喷洒 effect**（终点增删——严禁挂建图 effect，见 Global Constraints）末尾追加：

```tsx
const finished = trace.length > 0 && upToClamped >= trace.length - 1
if (finished && !endMarkerRef.current) {
  endMarkerRef.current = new here.map.Marker(
    { lat: trace[trace.length - 1].lat, lng: trace[trace.length - 1].lng },
    { icon: new here.map.Icon(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7" fill="#dc2626" stroke="#fff" stroke-width="2"/></svg>',
      { anchor: { x: 10, y: 10 } },
    ) },
  )
  map.addObject(endMarkerRef.current)
} else if (!finished && endMarkerRef.current) {
  map.removeObject(endMarkerRef.current)
  endMarkerRef.current = null
}
```

- [ ] **Step 6: 跑全量测试**

Run: `npm test`
Expected: 全绿（matched-path 子元素 +1 不破坏 `length > 0` 断言；颜色不进断言）

- [ ] **Step 7: 手测验收**

Run: `npm run dev`
Expected: Tab 蓝底白字；chip 蓝底 20px 蓝数值；两图表蓝色无网格；Analysis 出现 MM 连续蓝线（箭头之下）+ 起点绿点；Demo 播至末帧终点红点出现、回拖消失

- [ ] **Step 8: Commit**

```bash
git add src/App.tsx src/components/StatsPanel.tsx src/components/DeviationReplayChart.tsx src/components/MapView.tsx src/components/SvgFallback.tsx
git commit -m "style: port HTML teaser visual identity (chips, charts, tab, MM polyline, endpoints)"
```

---

### Task 5: 全量回归 + 构建 + 截图刷新

**Files:**
- 无源码改动；产物：`docs/img/analysis-view.png`、`docs/img/demo-mode.png` 刷新

**Interfaces:**
- Consumes: Task 1-4 全部
- Produces: 可发布状态

- [ ] **Step 1: 全量测试**

Run: `npm test`
Expected: 141 个测试左右全绿（131 既有 + Task 1 的 8 + Task 2 的 2）

- [ ] **Step 2: 构建**

Run: `npm run build`
Expected: tsc --noEmit 零错误；vite build 成功；产物无 VITE_HERE_KEY（.env.production 钉空，见 README）

- [ ] **Step 3: 刷新 README 截图**

Run: `npm run shot`
Expected: 输出 `captured: drive=2011_10_03_drive_0042 tunnel=30s badge=LIVE tilesOk=true`；`docs/img/analysis-view.png` 呈现新样式（蓝色 chip/蓝线/蓝图表）

- [ ] **Step 4: Commit**

```bash
git add docs/img/analysis-view.png docs/img/demo-mode.png
git commit -m "docs: refresh README screenshots after style port"
```

- [ ] **Step 5: 手测清单终验（对照 spec 手测验收清单 1-5 全项）**

Expected: 五项全过
