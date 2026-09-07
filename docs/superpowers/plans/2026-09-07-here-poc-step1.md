# HERE Map Matching POC — Step1 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 Step1：HERE SDK loader + 地图视图（含无底图 SVG 兜底）+ MockService 双层缓存 + derived 派生计算 + 静态双线对比 + 偏差统计面板——交付「MOCK 模式下双线对比 + 偏差图表可见」。

**Architecture:** 纯前端分层：`lib/`（纯函数：解码/几何/派生/统计/存储）→ `components/`（MapView 双渲染路径 + StatsPanel）→ `App.tsx` 编排。数据流：`fetch('/sample/here/<driveId>.json')` 取轨迹 → `matchService.match(driveId)`（localStorage 缓存 → public/fixtures fixture，live 为 Step3 预留接缝）→ `derive()` 逐点投影 → 视图零实时计算。

**Tech Stack:** Step0 地基（Vite 7 + React 19 + TS strict + Vitest 3）+ Recharts（唯一新增 npm 依赖）。

**Spec:** `docs/superpowers/specs/2026-09-07-here-map-matching-poc-design.md`

## Global Constraints

- **应用代码必须运行时 `fetch('/sample/here/<driveId>.json')` 与 `fetch('/fixtures/<driveId>.json')`**——严禁把 `import ... from '../../public/...'` 静态导入写进 src 运行时路径（App / lib / components）；**一切测试代码（`*.test.ts`、`__tests__/`）豁免**——jsdom 无服务器，静态 import 是测试读 public 数据的唯一可行方式（Step0 终审守则的应用面仅限运行时代码）
- 零地图 npm 依赖：HERE Maps JS API 经 script 标签加载（自封装 loader）；**Recharts 除外**（spec 技术方案表明定）
- flexible polyline 解码器**自研**（~50 行纯函数，官方测试向量验证），不引入 `@here/flexible-polyline`——保持零依赖纯度 + 契合「领域深度」叙事；若自研实现两次官方向量验证失败则降级用官方包（记录 ruling）
- `VITE_HERE_KEY` 只经 `import.meta.env.VITE_HERE_KEY` 读取；key 不进 git/代码/对话
- live 调用是 **Step3** 范围：Step1 的 matchService 只走 mock（缓存→fixture），live 分支留接缝（返回类型与错误处理预留）不实现
- 提交直接进 `main`，conventional commits
- Windows/Git Bash：Python 用 `py` + `PYTHONIOENCODING=utf-8`；dev 服务器后台起、按 PID 定点清理
- 所有新代码 `strict` TS；测试显式 `import { describe, it, expect } from 'vitest'`

## 现状（已核实）

- Step0 完成（c76e027/674fc98/1441a9a）：脚手架 + Vitest + `public/sample/here/{2011_09_26_drive_0011,2011_09_30_drive_0033}.json`（URL 实测 200）
- 真实 v8/import 响应已录：`data/fixtures/2011_09_26_drive_0011_import_{req,resp}.json`（1 段 113m）与 `data/fixtures/2011_09_30_drive_0033_import_{req,resp}.json`（319 点 2Hz 请求，1 段 1740m，876 bytes）——均 gitignored
- 响应 section 结构（实测）：`{id, type, polyline: string(flexible), summary: {duration, length, baseDuration}, departure, arrival, transport}`；顶层 `{routes: [{id, sections: []}], notices: []}`
- `.env` 有真实 key（有 key 时地图可用；无 key/断网时必须 SVG 兜底）

## File Structure

```
src/
├── types.ts                    # T1: TrajPoint / ImportResponse / DerivedPoint / CacheEntry
├── lib/
│   ├── flexiblePolyline.ts     # T2: decodeFlexiblePolyline(str) -> [lat,lng][]
│   ├── geo.ts                  # T3: haversineM / nearestOnPolyline
│   ├── stats.ts                # T4: deviationStats / histogram / deviationVsDistance
│   ├── derive.ts               # T5: derive(trace, response) -> DerivedPoint[]
│   ├── fixtureStore.ts         # T6: matchService + localStorage 缓存 + fixture 加载
│   └── hereLoader.ts           # T7: loadHereMaps() script 标签加载 + 超时重试
├── components/
│   ├── MapView.tsx             # T7: HERE 地图 / SvgFallback 双路径
│   ├── SvgFallback.tsx         # T7: 纯 SVG 无底图渲染
│   ├── StatsPanel.tsx          # T8: Recharts 直方图 + 偏差-里程曲线 + 汇总
│   └── SourceBadge.tsx         # T8: MOCK/LIVE 角标
└── App.tsx                     # T8: 重写为 Step1 编排壳
public/fixtures/
├── 2011_09_26_drive_0011.json  # T1: CacheEntry 包装的 fixture（入库）
└── 2011_09_30_drive_0033.json  # T1: 同上
```

---

### Task 1: types.ts + fixture 入库 + 响应契约测试

**Files:**
- Create: `src/types.ts`、`public/fixtures/2011_09_26_drive_0011.json`、`public/fixtures/2011_09_30_drive_0033.json`
- Test: `src/__tests__/fixtures.test.ts`

**Interfaces:**
- Produces（后续所有任务消费）:
  - `TrajPoint { lat: number; lng: number; timestamp: number; timestampUtc: string; headingDeg: number; speedMps: number; numsats: number }`
  - `ImportSection { id: string; type: string; polyline: string; summary: { duration: number; length: number; baseDuration?: number } }`
  - `ImportResponse { routes: { id: string; sections: ImportSection[] }[]; notices?: unknown[] }`
  - `DerivedPoint { i: number; matchedLatLng: [number, number]; deviationM: number; headingDeg: number; speedMps: number }`
  - `CacheEntry { driveId: string; source: 'live' | 'mock'; createdAt: string; response: ImportResponse; derived: DerivedPoint[] }`

- [ ] **Step 1: 写 `src/types.ts`**

```ts
/** KITTI 轨迹点（trajectory_light.json 元素，契约测试见 trajectories.test.ts） */
export interface TrajPoint {
  lat: number
  lng: number
  timestamp: number
  timestampUtc: string
  headingDeg: number
  speedMps: number
  numsats: number
}

/** HERE Routing v8 /import 响应（本应用实际消费的子集；response 字段整体入库不裁剪） */
export interface ImportSection {
  id: string
  type: string
  polyline: string
  summary: { duration: number; length: number; baseDuration?: number }
}

export interface ImportResponse {
  routes: { id: string; sections: ImportSection[] }[]
  notices?: unknown[]
}

/** 派生：每轨迹点 → 匹配路径上的垂足与横向偏差（import API 无逐点 linkId/confidence） */
export interface DerivedPoint {
  i: number
  matchedLatLng: [number, number]
  deviationM: number
  headingDeg: number
  speedMps: number
}

/** localStorage 与 fixture 共用 schema；key = `here-mm-cache:{driveId}` */
export interface CacheEntry {
  driveId: string
  source: 'live' | 'mock'
  createdAt: string
  response: ImportResponse
  derived: DerivedPoint[]
}
```

- [ ] **Step 2: 用 py 把两份录制响应包装成 CacheEntry fixture 入库**

```bash
cd D:/here-poc && mkdir -p public/fixtures && PYTHONIOENCODING=utf-8 py -c "
import json
for d in ['2011_09_26_drive_0011', '2011_09_30_drive_0033']:
    resp = json.load(open(f'data/fixtures/{d}_import_resp.json'))
    entry = {'driveId': d, 'source': 'mock', 'createdAt': '2026-09-07T00:00:00.000Z', 'response': resp, 'derived': []}
    json.dump(entry, open(f'public/fixtures/{d}.json', 'w'), ensure_ascii=False)
    print(d, 'sections:', len(resp['routes'][0]['sections']))
"
```

Expected: 两行 sections: 1。fixture 的 `derived` 置空——运行时由 `derive()` 计算并回写缓存，fixture 只担保 `response`。

- [ ] **Step 3: 先写失败测试 `src/__tests__/fixtures.test.ts`（TDD——先在 Step 2 之前写并跑失败，再入库后转绿；执行顺序按 1→3→2→3 视为实现细节，失败证据必须留档）**

```ts
import { describe, expect, it } from 'vitest'
import type { ImportResponse } from '../types'

// 测试代码豁免静态 import public/（src 运行时路径禁止，见 Global Constraints）
import f0011 from '../../public/fixtures/2011_09_26_drive_0011.json'
import f0033 from '../../public/fixtures/2011_09_30_drive_0033.json'

function checkFixture(f: unknown, driveId: string, minSections: number, minRouteLenM: number) {
  const e = f as { driveId: string; source: string; createdAt: string; response: ImportResponse; derived: unknown[] }
  expect(e.driveId).toBe(driveId)
  expect(e.source).toBe('mock')
  expect(typeof e.createdAt).toBe('string')
  expect(Array.isArray(e.derived)).toBe(true)
  const secs = e.response.routes[0].sections
  expect(secs.length).toBeGreaterThanOrEqual(minSections)
  for (const s of secs) {
    expect(typeof s.id).toBe('string')
    expect(typeof s.polyline).toBe('string')
    expect(s.polyline.length).toBeGreaterThan(20)
    expect(typeof s.summary.duration).toBe('number')
    expect(typeof s.summary.length).toBe('number')
    expect(s.summary.length).toBeGreaterThanOrEqual(minRouteLenM)
  }
}

describe('bundled match fixtures (contract, v8/import schema)', () => {
  it('2011_09_26_drive_0011: 1 section, >=100m route', () => {
    checkFixture(f0011, '2011_09_26_drive_0011', 1, 100)
  })
  it('2011_09_30_drive_0033: 1 section, >=1500m route', () => {
    checkFixture(f0033, '2011_09_30_drive_0033', 1, 1500)
  })
})
```

- [ ] **Step 4: `npm run test` 全绿（6 条 = Step0 的 4 + 新 2）**
- [ ] **Step 5: Commit** `feat: add v8/import types and bundled match fixtures with contract tests`

---

### Task 2: flexible polyline 解码器

**Files:**
- Create: `src/lib/flexiblePolyline.ts`
- Test: `src/__tests__/flexiblePolyline.test.ts`

**Interfaces:**
- Produces: `decodeFlexiblePolyline(encoded: string): Array<[number, number]>`（[lat, lng]，普通数组；z 维度本应用不消费，忽略）

**背景（算法，实现者必读——已经过 2026-09-07 对抗评审用真实 fixture 逐字符验证）：** HERE flexible polyline（权威规范：`https://github.com/heremaps/flexible-polyline` README + 其 `test/` 目录官方测试向量；here.com 文档页作辅助）。charset `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_`（值=索引，共 64）。串结构 = `[header 版本 varint][header 内容 varint][数据 varint…]`：

1. **header 版本**：一个 varint，v1 恒为 `'B'`（值 1）。**header 两个 varint 均不做 zigzag**。
2. **header 内容**：一个 varint（含第三维精度时占 2 个字符，**不能固定跳 2 字符**），按位拆分：`bits[3:0]`=lat/lng 小数精度、`bits[6:4]`=第三维类型（0=无,1=level,2=altitude,3=elevation）、`bits[10:7]`=第三维精度。
3. **数据区 varint**：每字符贡献**低 5 位数据**（`c & 0b11111`），**最高位 `0x20` 是延续位**（置 1 表示下一字符仍属同一 varint）；块间小端拼接（首块在最低位）。数据 varint 做 zigzag 还原：`dec = (v >>> 1) ^ -(v & 1)`。
4. 坐标累加：第一个值是**绝对坐标**，其后是差值；`coord = 前值 + dec`，最终除以 `10^精度`。第三维存在时每坐标 3 个 varint（lat,lng,z），本应用忽略 z。

仓库两份 fixture 实测：polyline 均以 `'BG'` 开头 → 版本 1、content 6 → 精度 6、无第三维；0011 解出 **7 点**（首点 (49.010637, 8.439888) 与响应 departure 吻合 1e-6，路径 112.9m ≈ summary 113m），0033 解出 **72 点**。首 varint `'68rv9C'` 手算：payload 26|28<<5|11<<10|15<<15|29<<20|2<<25 = 98021274，zigzag → +49010637 → 49.010637。

- [ ] **Step 1: 从 `https://github.com/heremaps/flexible-polyline` 的 README 示例与 `test/round_half_*/`（encoded/decoded 成对文件）抄录至少 2 组官方向量进测试（执行时打开核对，不得凭记忆硬编码——向量抄进测试文件并在注释标注来源 URL；优先选含第三维的向量一组 + 纯 2D 一组）**

- [ ] **Step 2: 写失败测试 `src/__tests__/flexiblePolyline.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import f0011 from '../../public/fixtures/2011_09_26_drive_0011.json'
import { decodeFlexiblePolyline } from '../lib/flexiblePolyline'

describe('decodeFlexiblePolyline', () => {
  it('official example vector #1 (SOURCE: <执行时从官方文档抄录并填入>)', () => {
    // expect(decodeFlexiblePolyline('<官方示例串>')).toEqual([[<lat>, <lng>], ...])
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
```

- [ ] **Step 3: 跑出失败**（函数不存在）
- [ ] **Step 4: 实现 `src/lib/flexiblePolyline.ts`**

```ts
const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** HERE flexible polyline 解码（忽略可选第三维）。纯函数、无依赖。 */
export function decodeFlexiblePolyline(encoded: string): Array<[number, number]> {
  const charIdx = (c: string) => {
    const i = CHARSET.indexOf(c)
    if (i < 0) throw new Error(`invalid char: ${c}`)
    return i
  }

  let i = 0
  /** 裸 varint：低 5 位数据 + 0x20 延续位，小端拼接。不做 zigzag。 */
  const readVarintRaw = (): number => {
    let value = 0n, shift = 0n
    for (;;) {
      if (i >= encoded.length) throw new Error('truncated varint')
      const c = charIdx(encoded[i++])
      value |= BigInt(c & 0b11111) << shift
      if ((c & 0b100000) === 0) break
      shift += 5n
    }
    return Number(value)
  }
  const zigzag = (v: number) => (v >>> 1) ^ -(v & 1)

  const version = readVarintRaw()          // header 版本（v1 = 'B'），无 zigzag
  if (version !== 1) throw new Error(`unsupported version: ${version}`)
  const content = readVarintRaw()          // header 内容，varint（可能占 2 字符），无 zigzag
  const precision = content & 0xf
  const thirdDimType = (content >> 4) & 0b111
  const step = thirdDimType === 0 ? 2 : 3  // 有第三维时每坐标 3 个 varint

  const deltas: number[] = []
  while (i < encoded.length) deltas.push(zigzag(readVarintRaw()))

  const scale = 10 ** precision
  const out: Array<[number, number]> = []
  let lat = 0, lng = 0
  for (let k = 0; k + step - 1 < deltas.length; k += step) {
    lat += deltas[k]
    lng += deltas[k + 1]
    out.push([lat / scale, lng / scale])
  }
  return out
}
```

- [ ] **Step 5: 跑绿（含官方向量；若官方向量两次修正后仍不过，按 Global Constraints 降级官方 npm 包并记 ruling）**
- [ ] **Step 6: Commit** `feat: self-implemented HERE flexible polyline decoder with official vectors`

---

### Task 3: geo.ts 几何库

**Files:**
- Create: `src/lib/geo.ts`
- Test: `src/__tests__/geo.test.ts`

**Interfaces:**
- Produces:
  - `haversineM(a: LatLng, b: LatLng): number`（LatLng = `[number, number]` 即 [lat, lng]）
  - `nearestOnPolyline(p: LatLng, path: LatLng[]): { foot: LatLng; distM: number; segIndex: number }`——空路径抛 `Error('empty path')`

- [ ] **Step 1: 写失败测试（手算向量：1° lat ≈ 111195m；Karlsruhe 1° lng ≈ 111195×cos(49°) ≈ 72950m——注意不是 73080，评审实算纠正）**

```ts
import { describe, expect, it } from 'vitest'
import { haversineM, nearestOnPolyline } from '../lib/geo'

describe('haversineM', () => {
  it('1 degree of latitude is ~111.2km', () => {
    expect(haversineM([49, 8.4], [50, 8.4])).toBeCloseTo(111195, -2)
  })
  it('1 degree of longitude at lat 49 is ~72.95km', () => {
    // 111195×cos(49°) ≈ 72950（评审实测：R=6371008.8 球面 haversine 精确值 72950.0）
    expect(haversineM([49, 8.4], [49, 9.4])).toBeCloseTo(72950, -2)
  })
  it('zero distance', () => {
    expect(haversineM([49.01, 8.44], [49.01, 8.44])).toBe(0)
  })
})

describe('nearestOnPolyline', () => {
  // 东西向直线段：从 (49, 8.40) 到 (49, 8.42)，每段 ~72.95m
  const path: Array<[number, number]> = [[49, 8.4], [49, 8.41], [49, 8.42]]
  it('perpendicular projection mid-segment', () => {
    const r = nearestOnPolyline([49.0001, 8.415], path) // 段1中点正北 ~11.12m
    expect(r.segIndex).toBe(1)
    expect(r.distM).toBeCloseTo(11.12, -1)
    expect(r.foot[0]).toBeCloseTo(49, 5)
    expect(r.foot[1]).toBeCloseTo(8.415, 5)
  })
  it('beyond endpoints clamps to vertex', () => {
    const r = nearestOnPolyline([49, 8.39], path)
    expect(r.segIndex).toBe(0)
    expect(r.foot).toEqual([49, 8.4])
    expect(r.distM).toBeCloseTo(72950 * 0.01, -2)
  })
  it('empty path throws', () => {
    expect(() => nearestOnPolyline([49, 8.4], [])).toThrow('empty path')
  })
})
```

- [ ] **Step 2: 跑失败**
- [ ] **Step 3: 实现 `src/lib/geo.ts`**

```ts
export type LatLng = [number, number] // [lat, lng]

const R_EARTH_M = 6371008.8
const DEG = Math.PI / 180

export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = (b[0] - a[0]) * DEG
  const dLng = (b[1] - a[1]) * DEG
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * DEG) * Math.cos(b[0] * DEG) * Math.sin(dLng / 2) ** 2
  return 2 * R_EARTH_M * Math.asin(Math.sqrt(s))
}

/** 局部平面近似（段中点为原点的等距圆柱投影）——城市尺度段长(<100m)误差毫米级 */
function toLocalM(p: LatLng, origin: LatLng): [number, number] {
  const mPerDegLat = 111132.92 - 559.82 * Math.cos(2 * origin[0] * DEG)
  const mPerDegLng = 111412.84 * Math.cos(origin[0] * DEG)
  return [(p[1] - origin[1]) * mPerDegLng, (p[0] - origin[0]) * mPerDegLat]
}

function toLatLng(p: [number, number], origin: LatLng): LatLng {
  const mPerDegLat = 111132.92 - 559.82 * Math.cos(2 * origin[0] * DEG)
  const mPerDegLng = 111412.84 * Math.cos(origin[0] * DEG)
  return [origin[0] + p[1] / mPerDegLat, origin[1] + p[0] / mPerDegLng]
}

export function nearestOnPolyline(p: LatLng, path: LatLng[]): { foot: LatLng; distM: number; segIndex: number } {
  if (path.length === 0) throw new Error('empty path')
  if (path.length === 1) return { foot: [...path[0]] as LatLng, distM: haversineM(p, path[0]), segIndex: 0 }
  let best = { foot: [...path[0]] as LatLng, distM: Infinity, segIndex: 0 }
  for (let i = 0; i + 1 < path.length; i++) {
    const origin = path[i]
    const [px, py] = toLocalM(p, origin)
    const [ax, ay] = [0, 0]
    const [bx, by] = toLocalM(path[i + 1], origin)
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy
    let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2
    t = Math.max(0, Math.min(1, t))
    const fx = ax + t * dx, fy = ay + t * dy
    const distM = Math.hypot(px - fx, py - fy)
    if (distM < best.distM) best = { foot: toLatLng([fx, fy], origin), distM, segIndex: i }
  }
  return best
}
```

- [ ] **Step 4: 跑绿 → Commit** `feat: geo primitives (haversine, nearest-on-polyline projection)`

---

### Task 4: stats.ts 统计库

**Files:**
- Create: `src/lib/stats.ts`
- Test: `src/__tests__/stats.test.ts`

**Interfaces:**
- Consumes: `DerivedPoint`（T1）
- Produces:
  - `deviationStats(ds: DerivedPoint[]): { meanM: number; p95M: number; maxM: number }`（空数组抛 `Error('empty')`；p95 用最近秩法 `sorted[ceil(0.95*n)-1]`）
  - `deviationHistogram(ds: DerivedPoint[], binCount = 20): { bins: { fromM: number; toM: number; count: number }[] }`（等宽 0..max；**边界约定：`fromM ≤ v < toM` 半开区间，末 bin 右闭、max 值 clamp 进末 bin**；max=0 时返回 binCount 个 count=0 的零宽 bin，不得产出 NaN）
  - `deviationVsDistance(ds: DerivedPoint[], trace: TrajPoint[]): { distanceM: number; deviationM: number }[]`（距离 = 沿 trace 的 haversine 累计里程）

- [ ] **Step 1: 写失败测试**（构造已知序列：deviations `[0, 10, 19, 30, 38]` → mean 19.4、p95 38、max 38；直方图 2 bins（宽 19）→ counts [3,2]——数据避开 bin 边界值，杜绝边界归属歧义；max=0 全零序列 → 无 NaN；vs-distance 用三点共线 trace 手算累计里程）
- [ ] **Step 2: 跑失败 → Step 3: 实现（纯函数，消费 haversineM）→ Step 4: 跑绿**
- [ ] **Step 5: Commit** `feat: deviation statistics (mean/p95/max, histogram, vs-distance)`

---

### Task 5: derive.ts 派生计算

**Files:**
- Create: `src/lib/derive.ts`
- Test: `src/__tests__/derive.test.ts`

**Interfaces:**
- Consumes: `decodeFlexiblePolyline`（T2）、`nearestOnPolyline`（T3）、`TrajPoint/ImportResponse/DerivedPoint`（T1）
- Produces: `derive(trace: TrajPoint[], response: ImportResponse): DerivedPoint[]`——解码全部 section polyline 顺序拼接为匹配路径；逐 trace 点最近投影；`headingDeg/speedMps` 原样透传；`i` 与 trace 下标严格对齐

- [ ] **Step 1: 写失败测试**
  - 合成用例：构造 3 点 response（polyline 用编码器手头已有的 0011 fixture 串或测试内联一个已知短串），trace 取路径上偏移点，断言 `deviationM` ≈ 偏移量、`matchedLatLng` 在路径上、`i` 连续对齐
  - 真实 e2e：`f0011` fixture response + `public/sample/here/2011_09_26_drive_0011.json` trace → `derive` 结果 233 条、全部 `deviationM < 50`（回归上界；评审者已用真实数据预演算：**实测 max 2.43m**，正常应远低于上界，超界说明解码或投影有 bug）
- [ ] **Step 2: 跑失败 → Step 3: 实现（<25 行）→ Step 4: 跑绿（e2e 断言是解码器+几何库的集成防线）**
- [ ] **Step 5: Commit** `feat: derive per-point matched projections and lateral deviations`

---

### Task 6: fixtureStore.ts（matchService + 双层缓存）

**Files:**
- Create: `src/lib/fixtureStore.ts`
- Test: `src/lib/fixtureStore.test.ts`（放 lib 下，避免与纯数据契约测试混淆）

**Interfaces:**
- Produces:
  - `cacheKey(driveId: string): string` → `` `here-mm-cache:${driveId}` ``
  - `readCache(driveId): CacheEntry | null` / `writeCache(entry: CacheEntry): void`（localStorage，JSON 解析失败/超额 try-catch 静默降级返回 null）
  - `loadFixture(driveId): Promise<CacheEntry>`——`fetch('/fixtures/<driveId>.json')`，非 200/解析失败抛 `Error('fixture load failed: <driveId>')`
  - `matchService(driveId): Promise<CacheEntry>`——缓存命中直接返回；未命中 loadFixture → `derive(trace…)` **不在本层做**（App 层组合，避免本层反向依赖 trace 加载）；此处仅返回 entry
  - live 接缝：文件顶部注释 `// Step3: VITE_HERE_KEY 存在时改走 HereRouterClient，失败回落 fixture`——不实现

- [ ] **Step 1: 写失败测试**（jsdom 自带 localStorage：`writeCache`→`readCache` 往返；损坏 JSON → null；`matchService` 未命中用 `vi.stubGlobal('fetch', vi.fn(...))` 桩返回 fixture JSON → 返回 entry；命中路径不触发 fetch。**测试隔离（评审补充）**：`beforeEach(() => localStorage.clear())` + `afterEach(() => vi.unstubAllGlobals())`——jsdom localStorage 跨测试持久，「命中」用例显式先 writeCache 唯一 driveId，否则红绿取决于执行顺序）
- [ ] **Step 2: 跑失败 → Step 3: 实现 → Step 4: 跑绿 → Step 5: Commit** `feat: match service with localStorage cache and fixture fallback`

---

### Task 7: hereLoader.ts + SvgFallback + MapView

**Files:**
- Create: `src/lib/hereLoader.ts`、`src/components/SvgFallback.tsx`、`src/components/MapView.tsx`
- Test: `src/__tests__/mapview.test.tsx`

**Interfaces:**
- Produces:
  - `loadHereMaps(apikey: string, timeoutMs = 8000): Promise<unknown>`——顺序注入 `https://js.api.here.com/v3/3.1/mapsjs-core.js`、`mapsjs-service.js`、`mapsjs-mapevents.js`；成功 resolve `window.H`；任一失败/超时 reject（内部单例缓存，不重复注入）
  - `<SvgFallback trace derived width height />`：投影公式（评审修正，防 49° 纬度图形变形 1.52×）——**`x = (lng - minLng) × cos(midLat 弧度)`、`y = lat`**（等距圆柱，标准纬线取 bbox 中点纬度；建议直接复用 `geo.ts` 的 `toLocalM` 以 bbox 中心为原点，避免两套投影实现分叉），bbox 加 5% 边距映射到 viewBox。GNSS 散点（橙 `#f59e0b`，r=1.5，**抽稀规则：每 ⌈n/800⌉ 取 1、始终保留首尾点**）+ 匹配路径折线（蓝 `#2563eb`，stroke 1.5）+ 起点/终点标记 + 左下角比例尺（按米标定）。**元素加 `data-testid`：`gnss-dot` / `matched-path` / `endpoint-marker`**（测试按此计数，不按元素类型混数）
  - `<MapView trace derived mapStatus apikey />`：`mapStatus: 'ok' | 'fallback'`；ok → 初始化 `H.Map`（`navigator` 缩放、`H.map.Polyline` 匹配线 + 散点每 2 点抽稀的 `H.map.Circle`），**视野适配用 `map.setViewBounds(new H.geo.Rect(north, west, south, east))`——HERE 3.1 无 fitBounds（那是 Leaflet 词汇），且 H.geo.Rect 构造参数顺序是 (top, left, bottom, right)**；fallback → 渲染 `<SvgFallback>`；**卸载清理：`map.dispose()`（含 mapevents Behavior 实例一并清理）**——这是 HERE 3.1 的正确清理入口
  - **mapStatus 生命周期（评审补充，App 层在 T8 落实）**：App 持有状态，`apikey` 为空 → 同步 `'fallback'`（不调 loader）；非空 → `loadHereMaps(key).then(→'ok').catch(→'fallback')`，pending 期渲染加载占位（不闪 SvgFallback 报错）；MapView 'ok' 路径假定 window.H 已就绪，在 useEffect 内同步建图
- [ ] **Step 1: 写失败测试**（RTL：`mapStatus='fallback'` + 3 点 trace → 断言 svg 存在、`matched-path` 非空、`gnss-dot` 数 = 3（3 点不触发抽稀）、`endpoint-marker` 数 = 2；**加一条 viewBox 宽高比断言**：构造已知 bbox 的 2 点 trace，断言渲染宽度/高度 ≈ (Δlng×cos(midLat))/Δlat（±5%）；`mapStatus='ok'` 不在本层测——HERE SDK 无 jsdom 环境，以 T8 Step 5 真实 key 手动验收覆盖并注明）
- [ ] **Step 2: 跑失败 → Step 3: 实现三文件 → Step 4: 跑绿 → Step 5: Commit** `feat: HERE map loader, map view and offline SVG fallback`

---

### Task 8: StatsPanel + SourceBadge + App 编排

**Files:**
- Create: `src/components/StatsPanel.tsx`、`src/components/SourceBadge.tsx`
- Modify: `src/App.tsx`（整体重写）
- Test: `src/__tests__/app.test.tsx`（旧的 App 冒烟测试同步更新）

**Interfaces:**
- Consumes: 全部前置产物
- Produces: Step1 完整页面——顶栏（轨迹选择 `<select>` 0033/0011 + `<SourceBadge source>` + **「清除缓存」按钮**：遍历 localStorage 删除 `here-mm-cache:*` 前缀键后重载当前 driveId——spec L50 顶栏三件套的「清除」在此落点，「录制」归 Step3）+ 主区（MapView + StatsPanel 侧栏）+ 页脚 `Data: KITTI (Geiger et al., 2013), CC BY-NC-SA · Map: HERE`
  - App 流程：选 driveId → `fetch('/sample/here/<id>.json')` 取 trace + `matchService(id)` 取 entry → 未缓存则 `derive(trace, entry.response)` 并 `writeCache` 回填 → `{trace, derived, entry}` 进状态；加载/错误态有占位
  - **mapStatus（落实 T7 生命周期约定）**：`apikey = import.meta.env.VITE_HERE_KEY` 为空 → 同步 `'fallback'` 不调 loader；非空 → loader 异步定夺，pending 渲染加载占位
  - `npm install recharts` 在本任务（唯一新增依赖）
- [ ] **Step 1: 更新 App 测试**（**测试机制（评审修正，防 jsdom 挂死）**：`vi.stubEnv('VITE_HERE_KEY', '')` 使 apikey 为空 → App 同步走 fallback 路径，loader 永不被调——否则共享 vite.config.ts 会把 `.env` 真 key 泄入 Vitest，`<script>` 注入又不受 fetch 桩拦截，jsdom 不加载外部脚本只能等 8s 超时撞 Vitest 默认 5s testTimeout；另加 `beforeEach(() => localStorage.clear())`。桩 `fetch` 返回 trace + fixture；断言：轨迹选择器渲染、`MOCK` 角标出现、StatsPanel 的汇总数字出现、SvgFallback 挂载、清除缓存按钮点击后 localStorage 对应键消失）
- [ ] **Step 2: 跑失败 → Step 3: 实现（StatsPanel 用 Recharts `BarChart` 直方图 + `AreaChart` 偏差-里程 + 汇总 chips：均值/95分位/最大）→ Step 4: 跑绿**
- [ ] **Step 5: 手动验收（对照 spec）**：`npm run dev` → 选择 0033 → HERE 底图 + 双线对比可见 + 偏差图表可见 + `MOCK` 角标亮；`mv .env .env.bak` 重启 → SVG 兜底 + 全功能仍可用 → 恢复 `.env`
- [ ] **Step 6: Commit** `feat: Step1 static comparison view with deviation stats panel`

---

### Task 9: Step1 验收

- [ ] **Step 1: 全量绿**：`npm run build && npm run test`
- [ ] **Step 2: spec 交付判据**：MOCK 模式下双线对比 + 偏差图表可见（截图存 `.superpowers/sdd/<plan>/acceptance.png` 或文字记录）；无 key 冷启动 SVG 兜底可用
- [ ] **Step 3: 收尾**：`git status` 干净；Step1 各 commit 在列

---

## Self-Review 记录

- **Spec 覆盖**：spec L120 Step1 = SDK loader（T7）+ HereMapView（T7）+ MockService（T6）+ 静态对比（T7/T8）+ 统计（T4/T8）✓；缓存双层（T6）与 derived（T5）为数据流图 L59-66 的必经层 ✓；无底图模式（spec L99）落为 SvgFallback（T7）✓；页脚标注（L52）落 T8 ✓；回放/双 tab 是 Step2 不做 ✓；live 是 Step3 只留接缝（T6 注释）✓
- **占位符扫描**：T2 官方向量留"执行时抄录"是刻意的（禁止凭记忆硬编码坐标），附来源要求；T4/T5 测试以行为描述+具体数值给出；其余代码完整
- **类型一致性**：LatLng 元组贯穿 T3/T5/T7；DerivedPoint 从 T1 定义、T4/T5/T8 消费一致；CacheEntry 在 T1 定义、T6 读写、T8 回填 ✓

## 修订记录

- 2026-09-07 对抗评审（workflow `step1-plan-review`：4 视角找缺陷 → 每条 3 票驳斥，10 确认 / 1 驳回 / 9 minor 全收）后修订：
  - **T2 解码器整体重写**：header 布局（版本 varint + 内容 varint 位域，内容可为 2 字符）与数据区位约定（低 5 位载荷 0x1F + 延续位 0x20，数据区才 zigzag）此前三处全错——评审者用仓库真实 fixture 逐字符验证正确算法（'BG'→精度 6；0011→7 点；首点与 departure 吻合 1e-6）；测试点数断言 `>10`→`toBe(7)`
  - **T3 经度期望值 73080→72950**（R=6371008.8 实算，原值差 130m 超 ±50 容差必红）
  - **T4 直方图边界约定写死**（半开 [from,to) 末 bin 闭 + max=0 守卫）+ 测试数据避开边界值
  - **T5 e2e 基准记录**：实测 max 偏差 2.43m（回归上界 50m 保留）
  - **T6 测试隔离**：beforeEach 清 localStorage + afterEach unstubAllGlobals
  - **T7 SvgFallback 投影公式写死**（x 乘 cos(midLat)，防 1.52× 变形）+ 抽稀规则/data-testid/宽高比断言 + setViewBounds(H.geo.Rect(top,left,bottom,right)) 替换 fitBounds + map.dispose() 清理 + mapStatus 生命周期归属 App
  - **T8 测试机制**：vi.stubEnv 空 key 走同步 fallback（防 .env 真 key 泄入 + script 注入绕过 fetch 桩 + 8s>5s 超时）+ 清除缓存按钮落点（spec 顶栏三件套）
  - **fetch 豁免边界放宽**：一切测试代码豁免静态 import public/（原「契约测试唯一豁免」与 T2/T5 单测自相矛盾）
  - 驳回 1 条：「SDK 重试按钮无落点」——loader 已有超时重试，重试按钮 UI 非 Step1 字面范围

## Errata（实现期运行时实证修正）

- **setViewBounds 在 HERE 3.1 运行时不存在**（计划修订版 T7 写错了）：实现者 grep 实证后改用 `map.getViewModel().setLookAtData({ bounds: H.geo.Rect })`；另有 `H.Map` 构造签名微调。两处修正有运行时像素级验收背书（task-8-report.md 留痕）。
- T4 直方图测试数据括号序列 `[0,10,19,30,38]` 与期望 `[3,2]` 在计划内自相矛盾（19 落在 bin 边界）——实现侧裁决为 `[0,10,18,30,38]`，独立手算验证正确。
