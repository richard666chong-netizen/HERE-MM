# HERE Map Matching POC — Step3 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 Step3：HERE Routing v8/import live 调用接入 matchService（缓存 miss 且有 key 时走 live，失败自动落回 fixture）+ 顶栏「录制」按钮 + 服务器侧 fixture 录制回写脚本 + Step2 遗留的自适应窗口测试锁定——交付「LIVE 角标亮，断网仍可完整演示」。

**Architecture:** 数据流只改 matchService 一层：`缓存命中 → 返回；miss + 有 key → importRoute(live) → CacheEntry{source:'live'} 写缓存；live 失败/无 key → loadFixture`。App 传入 `{apikey, trace}`；SourceBadge 已预置 LIVE 渲染（Step1 就绪，零改动）。录制回写用独立 Node 脚本（读 .env、不回显 key、写 gitignored 的 data/fixtures/），与仓库内 public/fixtures 只比对不改写。

**Tech Stack:** Step2 地基（零新增 npm 依赖；Node 24 原生 fetch 供脚本用）。

**Spec:** `docs/superpowers/specs/2026-09-07-here-map-matching-poc-design.md`（L37 API 端点、L50 顶栏三件套、L61-62 数据流、L97-99 网络兜底、L122 Step3 判据）

## Global Constraints

- **key 永远不进 git、不进代码、不进对话**：运行时只经 `import.meta.env.VITE_HERE_KEY`；录制脚本读 `.env` 文件到进程变量、任何输出（stdout/stdderr/日志/测试）不得包含 key 明文
- **live 失败必须静默落回 fixture/缓存**（spec L98）——live 不可用时演示全流程照常，角标显示 MOCK
- **src 运行时路径禁 `import ... from '../../public/...'`**；测试代码豁免；`scripts/` 下工具脚本用 fs 读文件是其本职、同样豁免
- Step3 零新增 npm 依赖；strict TS + `verbatimModuleSyntax`；测试显式 import from 'vitest'
- Step1/Step2 既有行为与 64 条测试零破坏（既有 app 测试 stubEnv 空 key → matchService 不带 opts → fixture 路径不变）
- 提交直接进 `main`，conventional commits
- 本机 Windows/Git Bash；Node v24（原生 fetch 可用）；dev 服务器后台起、按进程清理

## 现状（已核实，2026-09-08）

- Step2 完成（HEAD = e454dac）：13 文件 64 测试全绿、build 干净
- `src/lib/fixtureStore.ts:1` 预留注释 `// Step3: VITE_HERE_KEY 存在时改走 HereRouterClient，失败回落 fixture`；`matchService(driveId)` 现为 cache → fixture
- `src/components/SourceBadge.tsx` 已含 `live: { label: 'LIVE', ... }` 渲染分支（Step1 预置）——本计划零改动
- `.env` 有 VITE_HERE_KEY（存在性已核实，内容未回显）
- 已录制请求形状（data/fixtures/*_import_req.json，2026-09-07）：body 仅 `{"trace":[{lat,lng},...]}`；0011=24 点、0033=319 点（当时手工降采样）；响应 sections[].polyline 为 flexible polyline（解码器已就绪）
- v8/import 端点（spec L37 + 实测录制）：`POST https://router.hereapi.com/v8/import?return=polyline,summary&transportMode=car&apikey=<KEY>`，2–50000 点
- Step2 最终审查遗留 #9：自适应窗口分支（`max(5, total/2)` 生效侧）未测试锁定 → 本计划 T5

## File Structure

```
src/
├── lib/
│   ├── hereRouterClient.ts       # T1: importRoute + buildImportRequest（降采样规则）
│   └── fixtureStore.ts           # T2: matchService 增 opts live 分支 + 失败回落
├── App.tsx                       # T3: 传 opts + 「录制」按钮
└── __tests__/
    ├── hereRouterClient.test.ts  # T1
    └── deviationReplayChart.test.tsx  # T5: 追加自适应窗口锁定用例
scripts/
└── record-fixtures.mjs           # T4: 服务器侧录制回写（读 .env、写 data/fixtures、比对 public/fixtures）
```

---

### Task 1: hereRouterClient.ts（v8/import 客户端）

**Files:**
- Create: `src/lib/hereRouterClient.ts`
- Test: `src/__tests__/hereRouterClient.test.ts`

**Interfaces:**
- Consumes: `TrajPoint`/`ImportResponse`（types.ts）
- Produces:
  - `buildImportRequest(trace: TrajPoint[]): Array<{ lat: number; lng: number }>`——降采样规则：`stride = max(1, ceil(n / 500))`（≤500 点，远低于 API 50000 上限且 payload 小），取 `i = 0, stride, 2×stride, …`，末点不在序列时追加；坐标四舍五入 6 位小数（HERE polyline 精度即 6）
  - `importRoute(apikey: string, trace: TrajPoint[]): Promise<ImportResponse>`——POST `https://router.hereapi.com/v8/import?return=polyline,summary&transportMode=car&apikey=<key>`，body `JSON.stringify({ trace: buildImportRequest(trace) })`；非 2xx 抛 `Error('here import failed: HTTP <status>')`；JSON 解析失败或结构校验失败（`routes[0].sections` 非空数组且每 section `polyline` 非空字符串、`summary.duration/length` 为数）抛 `Error('here import failed: invalid response')`

- [ ] **Step 1: 写失败测试 `src/__tests__/hereRouterClient.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildImportRequest, importRoute } from '../lib/hereRouterClient'
import type { TrajPoint } from '../types'

// 测试代码豁免静态 import public/；polyline 必须取真实 fixture 的可解码串——
// 合成串会被 decodeFlexiblePolyline 拒收（评审 blocker 修正：App 的 derive 链会解码它）
import fixture0033 from '../../public/fixtures/2011_09_30_drive_0033.json'

function tp(i: number): TrajPoint {
  return { lat: 49 + i * 1e-4, lng: 8.4 + i * 1e-4, timestamp: i, timestampUtc: '', headingDeg: 0, speedMps: 0, numsats: 7 }
}

const REAL_POLYLINE = (fixture0033 as unknown as { response: { routes: { sections: { polyline: string }[] }[] } })
  .response.routes[0].sections[0].polyline

const OK_RESPONSE = {
  routes: [
    {
      id: 'route-1',
      sections: [
        { id: 's1', type: 'vehicle', polyline: REAL_POLYLINE, summary: { duration: 60, length: 500 } },
      ],
    },
  ],
  notices: [],
}

function jsonResponse(data: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => data } as Response
}

describe('buildImportRequest', () => {
  it('small trace passes through rounded to 6 decimals', () => {
    const req = buildImportRequest([tp(0), tp(1)])
    expect(req).toEqual([
      { lat: 49, lng: 8.4 },
      { lat: expect.closeTo(49.0001, 8), lng: expect.closeTo(8.4001, 8) },
    ])
  })
  it('long trace downsamples to <=500 points, keeps first and last', () => {
    const trace = Array.from({ length: 1594 }, (_, i) => tp(i))
    const req = buildImportRequest(trace)
    expect(req.length).toBeLessThanOrEqual(500)
    expect(req.length).toBe(400) // stride = ceil(1594/500) = 4 → 0,4,…,1592 (399 点) + 末点 1593
    expect(req[0]!.lat).toBeCloseTo(49, 6)
    expect(req[req.length - 1]!.lng).toBeCloseTo(8.4 + 1593 * 1e-4, 6)
  })
})

describe('importRoute', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        void input
        void init
        return jsonResponse(OK_RESPONSE)
      }),
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  it('POSTs to v8/import with query params and downsampled trace body', async () => {
    await importRoute('test-key', [tp(0), tp(1), tp(2)])
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toBe(
      'https://router.hereapi.com/v8/import?return=polyline,summary&transportMode=car&apikey=test-key',
    )
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ trace: buildImportRequest([tp(0), tp(1), tp(2)]) })
  })

  it('returns validated response', async () => {
    await expect(importRoute('k', [tp(0)])).resolves.toEqual(OK_RESPONSE)
  })

  it('throws on HTTP error status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (): Promise<Response> => jsonResponse({ error: 'x' }, 429)),
    )
    await expect(importRoute('k', [tp(0)])).rejects.toThrow('here import failed: HTTP 429')
  })

  it('throws on structurally invalid response', async () => {
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => jsonResponse({ routes: [] })))
    await expect(importRoute('k', [tp(0)])).rejects.toThrow('here import failed: invalid response')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (): Promise<Response> => jsonResponse({ routes: [{ id: 'r', sections: [{ id: 's', polyline: '', summary: { duration: 1, length: 1 } }] }] })),
    )
    await expect(importRoute('k', [tp(0)])).rejects.toThrow('here import failed: invalid response')
  })
})
```

- [ ] **Step 2: 跑失败**（模块不存在）
- [ ] **Step 3: 实现 `src/lib/hereRouterClient.ts`**

```ts
import type { ImportResponse, TrajPoint } from '../types'

/** 降采样：≤500 点（API 上限 50000，取小 payload），首点天然保留、末点不在序列时追加；6 位小数（HERE polyline 精度） */
export function buildImportRequest(trace: TrajPoint[]): Array<{ lat: number; lng: number }> {
  const stride = Math.max(1, Math.ceil(trace.length / 500))
  const out: Array<{ lat: number; lng: number }> = []
  for (let i = 0; i < trace.length; i += stride) {
    out.push({ lat: round6(trace[i].lat), lng: round6(trace[i].lng) })
  }
  const last = trace[trace.length - 1]
  if (last && (trace.length - 1) % stride !== 0) out.push({ lat: round6(last.lat), lng: round6(last.lng) })
  return out
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6
}

/** 结构校验：routes[0].sections 非空且每段 polyline 非空、summary 数值在 */
function isValidImportResponse(r: unknown): r is ImportResponse {
  const sections = (r as ImportResponse)?.routes?.[0]?.sections
  if (!Array.isArray(sections) || sections.length === 0) return false
  return sections.every(
    (s) => typeof s?.polyline === 'string' && s.polyline.length > 0 && typeof s?.summary?.duration === 'number' && typeof s?.summary?.length === 'number',
  )
}

/** HERE Routing v8 /import：POST trace → 匹配路线（flexible polyline）。失败抛错，由 matchService 落回 fixture。 */
export async function importRoute(apikey: string, trace: TrajPoint[]): Promise<ImportResponse> {
  const url = `https://router.hereapi.com/v8/import?return=polyline,summary&transportMode=car&apikey=${encodeURIComponent(apikey)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trace: buildImportRequest(trace) }),
  })
  if (!res.ok) throw new Error(`here import failed: HTTP ${res.status}`)
  let parsed: unknown
  try {
    parsed = await res.json()
  } catch {
    throw new Error('here import failed: invalid response')
  }
  if (!isValidImportResponse(parsed)) throw new Error('here import failed: invalid response')
  return parsed
}
```

- [ ] **Step 4: 跑绿（6 条：buildImportRequest 2 + importRoute 4）**
- [ ] **Step 5: Commit** `feat: HERE v8/import live client with downsampling and validation`

---

### Task 2: matchService live 分支 + 失败回落

**Files:**
- Modify: `src/lib/fixtureStore.ts`
- Modify: `src/lib/fixtureStore.test.ts`（追加用例）

**Interfaces:**
- Consumes: `importRoute`（T1）
- Produces:
  - `interface MatchOptions { apikey: string; trace: TrajPoint[] }`
  - `matchService(driveId: string, opts?: MatchOptions): Promise<CacheEntry>`——缓存命中直接返回（不触发任何网络）；miss 且有 opts → `importRoute` → `CacheEntry { driveId, source: 'live', createdAt: new Date().toISOString(), response, derived: [] }` 并 `writeCache`；live 抛错（网络/HTTP/结构）→ **静默落回** `loadFixture`（spec L98）；无 opts → `loadFixture`（Step2 行为不变）。删除文件顶部的 Step3 预留注释（已兑现）
  - App 层后续照旧：entry.derived 为空 → derive + writeCache 回填（source 原样透传 → SourceBadge 自动亮 LIVE）

- [ ] **Step 1: 追加失败测试到 `src/lib/fixtureStore.test.ts`**（沿用该文件既有的 beforeEach `localStorage.clear()` + afterEach `vi.unstubAllGlobals()` 惯例；如无则补上）

```ts
import { matchService, cacheKey } from './fixtureStore' // 文件内已有 import 按现状合并，勿重复声明
// 文件顶部另加（测试豁免 public/ 导入）：import fixture0033Fixture from '../../public/fixtures/2011_09_30_drive_0033.json'

describe('matchService live 分支', () => {
  const TRACE = /* 用测试内合成 TrajPoint[]，3 点即可 */ [
    { lat: 49.0, lng: 8.4, timestamp: 0, timestampUtc: '', headingDeg: 0, speedMps: 0, numsats: 7 },
    { lat: 49.001, lng: 8.401, timestamp: 0.1, timestampUtc: '', headingDeg: 0, speedMps: 0, numsats: 7 },
    { lat: 49.002, lng: 8.402, timestamp: 0.2, timestampUtc: '', headingDeg: 0, speedMps: 0, numsats: 7 },
  ]
  // polyline 取真实 fixture 可解码串（评审修正：防合成串被复制进触发 decode 的路径）
  const LIVE_RESPONSE = {
    routes: [
      { id: 'r', sections: [{ id: 's', type: 'vehicle', polyline: (fixture0033Fixture as unknown as { response: { routes: { sections: { polyline: string }[] }[] } }).response.routes[0].sections[0].polyline, summary: { duration: 9, length: 44 } }] },
    ],
  }

  function stubFetch(routes: Record<string, unknown>): ReturnType<typeof vi.fn> {
    const fn = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      for (const [prefix, data] of Object.entries(routes)) {
        if (url.startsWith(prefix)) return { ok: true, status: 200, json: async () => data } as Response
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fn)
    return fn
  }

  it('cache miss + opts: live success → source live + 写缓存', async () => {
    const fn = stubFetch({ 'https://router.hereapi.com/v8/import': LIVE_RESPONSE })
    const entry = await matchService('2011_09_26_drive_0011', { apikey: 'k', trace: TRACE })
    expect(entry.source).toBe('live')
    expect(entry.response).toEqual(LIVE_RESPONSE)
    expect(String(fn.mock.calls[0]![0])).toContain('router.hereapi.com/v8/import')
    const stored = JSON.parse(localStorage.getItem(cacheKey('2011_09_26_drive_0011'))!)
    expect(stored.source).toBe('live')
  })

  it('live failure → silent fallback to fixture (source mock)', async () => {
    const fixtureEntry = { driveId: '2011_09_26_drive_0011', source: 'mock', createdAt: '', response: LIVE_RESPONSE, derived: [] }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        if (String(input).startsWith('/fixtures/')) {
          return { ok: true, status: 200, json: async () => fixtureEntry } as Response
        }
        return { ok: false, status: 503, json: async () => ({}) } as Response // live 端点 503
      }),
    )
    const entry = await matchService('2011_09_26_drive_0011', { apikey: 'k', trace: TRACE })
    expect(entry.source).toBe('mock')
  })

  it('cache hit: live fetch never called', async () => {
    const fn = stubFetch({ 'https://router.hereapi.com': LIVE_RESPONSE })
    writeCache({ driveId: '2011_09_26_drive_0011', source: 'live', createdAt: '', response: LIVE_RESPONSE as never, derived: [] })
    const entry = await matchService('2011_09_26_drive_0011', { apikey: 'k', trace: TRACE })
    expect(entry.source).toBe('live')
    expect(fn).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑失败**（opts 参数不被接受/行为不符）
- [ ] **Step 3: 实现**——matchService 替换为：

```ts
export interface MatchOptions {
  apikey: string
  trace: TrajPoint[]
}

/**
 * 双层缓存取数：localStorage 命中直接返回；未命中时有 opts（apikey+trace）先走 live（spec L61-62），
 * live 失败静默落回 fixture（spec L98：live 不可用不打断演示）；derive 不在本层做——App 层组合回填。
 */
export async function matchService(driveId: string, opts?: MatchOptions): Promise<CacheEntry> {
  const cached = readCache(driveId)
  if (cached) return cached
  if (opts) {
    try {
      const response = await importRoute(opts.apikey, opts.trace)
      const entry: CacheEntry = {
        driveId,
        source: 'live',
        createdAt: new Date().toISOString(),
        response,
        derived: [],
      }
      writeCache(entry)
      return entry
    } catch {
      /* live 失败 → 落回 fixture */
    }
  }
  return loadFixture(driveId)
}
```

（`importRoute` 加 import；`TrajPoint` 类型加 import type；顶部 Step3 预留注释删除。）

- [ ] **Step 4: 跑绿（文件内既有 9 条 + 新 3 条）**
- [ ] **Step 5: Commit** `feat: matchService live branch with fixture fallback`

---

### Task 3: App 接线 + LIVE 角标 + 「录制」按钮

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/__tests__/app.test.tsx`（追加 1 条；既有 4 条不改）

**Interfaces:**
- Consumes: `matchService(driveId, opts?)`（T2）、`cacheKey`（fixtureStore）
- Produces:
  - App 加载 effect 调用改为 `matchService(driveId, apikey ? { apikey, trace } : undefined)`（空 key 不带 opts → 既有测试零破坏）
  - 顶栏「录制」按钮（spec L50 三件套的「录制」落点）：**仅 apikey 非空时渲染**，点击 = 删当前 driveId 缓存键 + `setReloadToken(+1)`（强制重取 → 走 live；live 失败自动 fixture）——浏览器内「录制」即「重新拉取 live」；仓库文件级回写归 T4 脚本

- [ ] **Step 1: 追加失败测试**（文件顶部加 `vi.mock('../lib/hereLoader', () => ({ loadHereMaps: vi.fn(() => Promise.resolve({})) }))`——有 key 时 App 会调 loader，mock 掉防 script 注入/8s 超时；既有 4 条空 key 用例不受影响）

```tsx
  it('with key: live path lights LIVE badge; record button clears cache and reloads', async () => {
    vi.stubEnv('VITE_HERE_KEY', 'test-key')
    const liveResponse = {
      routes: [
        { id: 'r', sections: [{ id: 's', type: 'vehicle', polyline: (fixture0033 as unknown as CacheEntry).response.routes[0].sections[0].polyline, summary: { duration: 1740, length: 1740 } }] },
      ],
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      if (url.startsWith('https://router.hereapi.com/v8/import')) {
        return { ok: true, status: 200, json: async () => liveResponse } as Response
      }
      const mTrace = url.match(/^\/sample\/here\/(.+)\.json$/)
      if (mTrace) return jsonResponse(TRACES[mTrace[1]])
      const mFixture = url.match(/^\/fixtures\/(.+)\.json$/)
      if (mFixture) return jsonResponse(FIXTURES[mFixture[1]])
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    expect(await screen.findByText('LIVE')).toBeTruthy() // live 调用成功 → 角标 LIVE
    const stored = JSON.parse(localStorage.getItem(cacheKey('2011_09_30_drive_0033'))!)
    expect(stored.source).toBe('live')

    // 录制按钮：清当前缓存 → 重载（再次 live）
    fireEvent.click(screen.getByRole('button', { name: '录制' }))
    expect(localStorage.getItem(cacheKey('2011_09_30_drive_0033'))).toBeNull() // 重载完成前键已消失
    expect(await screen.findByText('LIVE')).toBeTruthy() // 重载后复亮
    // 重载确实发生（评审修正，防「只删缓存不重载」假绿）：键经 live 回填恢复 + live 端点共调 2 次
    expect(localStorage.getItem(cacheKey('2011_09_30_drive_0033'))).not.toBeNull()
    const liveCalls = fetchMock.mock.calls.filter(([u]) => String(u).startsWith('https://router.hereapi.com/v8/import')).length
    expect(liveCalls).toBe(2)
  })

  it('record button hidden without key (existing mock path unaffected)', async () => {
    render(<App />)
    await screen.findByText('MOCK')
    expect(screen.queryByRole('button', { name: '录制' })).toBeNull()
  })
```

（`jsonResponse`/`TRACES`/`FIXTURES`/`cacheKey` 用文件内既有定义。）

- [ ] **Step 2: 跑失败**（无录制按钮 / 无 LIVE）
- [ ] **Step 3: 实现**——App 改两处：

import 增：`import { cacheKey, matchService, writeCache } from './lib/fixtureStore'`（原 import 行合并）。

加载 effect 内一行改：

```tsx
        const entry = await matchService(driveId, apikey ? { apikey, trace } : undefined)
```

`handleClearCache` 之后加：

```tsx
  /** 「录制」（spec L50 顶栏三件套落点）：删当前 driveId 缓存并重载 → 缓存 miss 后走 live；
   *  live 失败自动落回 fixture（演示不中断）。仓库文件级回写归 scripts/record-fixtures.mjs。 */
  function handleRecord(): void {
    localStorage.removeItem(cacheKey(driveId))
    setReloadToken((t) => t + 1)
  }
```

顶栏「清除缓存」按钮前插入：

```tsx
        {apikey && (
          <button
            type="button"
            onClick={handleRecord}
            style={{ marginLeft: 'auto', padding: '0.3rem 0.9rem', cursor: 'pointer' }}
          >
            录制
          </button>
        )}
```

（「清除缓存」按钮原有的 `marginLeft: 'auto'` 移除——录制按钮接管右推；无 key 时布局回到 Step2 形态，需在录制按钮上保留 `marginLeft: 'auto'` 且清除按钮不再带。实现时保证无 key 布局不回归：无 key 时录制不渲染、清除按钮自身仍 `marginLeft: 'auto'`——即两按钮都带 `marginLeft:'auto'` 不可行，改为容器 `<div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem' }}>` 包住录制+清除两钮。）

- [ ] **Step 4: 跑绿（app 6 条：既有 4 + 新 2；全套 64+8=72 条左右，全绿即可）**
- [ ] **Step 5: Commit** `feat: wire live matching with record button in app`

---

### Task 4: 服务器侧录制回写脚本

**Files:**
- Create: `scripts/record-fixtures.mjs`（git 不忽略——工具入库）

**Interfaces:**
- Consumes: `.env` 的 `VITE_HERE_KEY`（进程内读取，**任何输出不回显 key**）、`public/sample/here/<driveId>.json`（fs 读取，工具脚本豁免）
- Produces: `data/fixtures/<driveId>_import_{req,resp}.json` 刷新（gitignored）；stdout 报告每条：点数/段数/summary.length、与 `public/fixtures/<driveId>.json` 已提交 fixture 的 length 差异（>2% 打 WARN——是否更新已提交 fixture 留人工决策）；网络/HTTP 失败退出码 1（不覆盖旧录制）

- [ ] **Step 1: 写 `scripts/record-fixtures.mjs`**

```js
#!/usr/bin/env node
/** Step3 服务器侧录制回写（spec L122）：读 .env key（不回显），对两条轨迹各发一次 v8/import，
 *  刷新 data/fixtures/<driveId>_import_{req,resp}.json（gitignored），并与 public/fixtures 已提交 fixture 比对。
 *  降采样规则与 src/lib/hereRouterClient.ts 的 buildImportRequest 保持一致（改动需两处同步）。 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DRIVES = ['2011_09_26_drive_0011', '2011_09_30_drive_0033']

function readKey() {
  const env = readFileSync(join(ROOT, '.env'), 'utf8')
  const m = env.match(/^VITE_HERE_KEY=(.*)$/m)
  if (!m || !m[1].trim()) throw new Error('VITE_HERE_KEY missing in .env')
  return m[1].trim()
}

function round6(v) {
  return Math.round(v * 1e6) / 1e6
}

function buildImportRequest(trace) {
  const stride = Math.max(1, Math.ceil(trace.length / 500))
  const out = []
  for (let i = 0; i < trace.length; i += stride) out.push({ lat: round6(trace[i].lat), lng: round6(trace[i].lng) })
  const last = trace[trace.length - 1]
  if (last && (trace.length - 1) % stride !== 0) out.push({ lat: round6(last.lat), lng: round6(last.lng) })
  return out
}

const key = readKey()
mkdirSync(join(ROOT, 'data/fixtures'), { recursive: true })
let failed = 0

for (const driveId of DRIVES) {
  const trace = JSON.parse(readFileSync(join(ROOT, `public/sample/here/${driveId}.json`), 'utf8'))
  const body = { trace: buildImportRequest(trace) }
  const url = `https://router.hereapi.com/v8/import?return=polyline,summary&transportMode=car&apikey=${encodeURIComponent(key)}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const resp = await res.json()
    const sections = resp?.routes?.[0]?.sections
    if (!Array.isArray(sections) || sections.length === 0) throw new Error('invalid response shape')
    writeFileSync(join(ROOT, `data/fixtures/${driveId}_import_req.json`), JSON.stringify(body))
    writeFileSync(join(ROOT, `data/fixtures/${driveId}_import_resp.json`), JSON.stringify(resp))
    const liveLen = sections.reduce((a, s) => a + (s?.summary?.length ?? 0), 0)
    let committedLen = null
    try {
      const committed = JSON.parse(readFileSync(join(ROOT, `public/fixtures/${driveId}.json`), 'utf8'))
      committedLen = committed?.response?.routes?.[0]?.sections?.reduce((a, s) => a + (s?.summary?.length ?? 0), 0) ?? null
    } catch {
      /* 无已提交 fixture 则跳过比对 */
    }
    const drift = committedLen ? `committed ${committedLen} m (${(((liveLen - committedLen) / committedLen) * 100).toFixed(1)}%)` : 'no committed fixture'
    const warn = committedLen && Math.abs(liveLen - committedLen) / committedLen > 0.02 ? ' [WARN >2%]' : ''
    console.log(`${driveId}: req ${body.trace.length} pts, ${sections.length} section(s), live ${liveLen} m | ${drift}${warn}`)
  } catch (e) {
    failed++
    console.error(`${driveId}: FAILED (${e.message}) — 旧录制保留，未覆盖`)
  }
}

if (failed) process.exit(1)
```

- [ ] **Step 2: 运行**：`node scripts/record-fixtures.mjs`——Expected: 两行成功报告（live 联调健康检查即此步；若网络劫持/限流失败，报错退出且旧录制保留，属可接受降级——记录到 Errata）
- [ ] **Step 3: 验证产出**：`ls -la data/fixtures/*_import_{req,resp}.json` 四个文件 mtime 刷新；`package.json` scripts 增 `"record": "node scripts/record-fixtures.mjs"`
- [ ] **Step 4: Commit** `feat: server-side fixture recorder script (key stays in .env)`

---

### Task 5: 自适应窗口测试锁定（Step2 最终审查遗留 #9）

**Files:**
- Modify: `src/__tests__/deviationReplayChart.test.tsx`（追加 1 条）

- [ ] **Step 1: 追加失败…… 直接追加锁定用例（该分支已实现，本条是补锁不是 TDD）：**

```tsx
  it('locks adaptive window for short traces (0011-like: total 23.2s → win ≈ 11.6s)', () => {
    const trace = Array.from({ length: 233 }, (_, i) => tp(i * 0.1)) // 0..23.2s
    const derived = trace.map((_, i) => dp(i, 1))
    const { container } = render(
      <DeviationReplayChart trace={trace} derived={derived} index={232} />,
    )
    // windowSec 默认 30，但 total/2 = 11.6 → win = 11.6；tCur=23.2 → tQ=23.0 → 窗口 [11.4, 23.0] = 117 点
    expect(container.querySelector('[data-testid="replay-deviation"]')!.closest('aside')!.getAttribute('data-length')).toBe('117')
  })
```

- [ ] **Step 2: 跑绿（若 FP 导致 ±1，改用 toBeGreaterThan(115)/toBeLessThan(119) 并注明）**
- [ ] **Step 3: Commit** `test: lock adaptive sliding window for short traces`

---

### Task 6: Step3 验收

- [ ] **Step 1: 全量绿**：`npm run build && npm run test`
- [ ] **Step 2: live 联调健康**：`npm run record`（即 T4 脚本）两行成功、无 WARN（或 WARN 已知原因）
- [ ] **Step 3: dev 冒烟**：后台 `npm run dev` + curl title/sample/fixture 200 + 停止
- [ ] **Step 4: 手动验收清单（用户浏览器，spec L122 判据）**——写入 `.superpowers/sdd/<plan>/manual-acceptance.md`：
  - 有 key：清缓存（清除缓存按钮）→ 选 0033 → **LIVE 角标亮**；点「录制」→ 角标复亮；回放/静态双模式全流程正常
  - **断网判据（spec L122，靠缓存+SVG 兜底）**：在线先加载过轨迹（localStorage 已回填）→ DevTools Offline → 刷新/重选轨迹 → 缓存命中 → 角标照常 + 无底图 SVG 模式 + 全功能（**不要清缓存**——冷缓存+全断网时轨迹 fetch 本身会失败进错误态，那是设计内行为非缺陷）
  - **live 回落判据（spec L98，仅封 HERE 路由域）**：DevTools Request blocking 封 `*router.hereapi.com*`（页面保持在线）→ 清除缓存 → 重选轨迹 → live 失败静默落回 fixture → **MOCK 角标 + 全功能可用**
  - `mv .env .env.bak` 重启 → 全流程 MOCK 可用 → 恢复
  - 屏录：完整 demo 录一份存档（spec L100 最终兜底）——用户操作
- [ ] **Step 5: 收尾**：`git status` 干净；Step3 各 commit 在列；Errata 补记运行时实证

---

## Self-Review 记录

- **Spec 覆盖**：L122「apikey 后 live 联调」（T1/T2/T3/T4）+「fixture 录制回写」（T4，data/fixtures 刷新；public/fixtures 比对不盲改）+「屏录」（T6 Step 4 用户项）✓；判据「LIVE 角标亮」（T3 测试 + 手动）与「断网仍可完整演示」（T2 静默回落 + T6 断网演练）✓；L50 顶栏「录制」落点（T3）✓；L61-62 数据流（缓存→live→fixture）✓；L97-99 兜底（live 失败回落是硬约束）✓。
- **占位符扫描**：无 TBD/TODO；T2 失败回落用例使用显式单一 stub（live 503 + fixture 200 双路由）。
- **类型一致性**：`MatchOptions`（T2 定义 / T3 消费）；`importRoute(apikey, trace)`（T1/T2/T4 脚本镜像实现）；`buildImportRequest`（T1 导出、T4 脚本内联同规则 + 同步注释）；CacheEntry.source 'live' → SourceBadge（现状已支持，零改动）✓。
- **安全性**：key 只在 .env ↔ 进程变量 ↔ URL query 间流动；测试用 'test-key' 假 key；脚本输出不含 key；URL 含 key 属 HERE apikey 认证的正常形态（浏览器 Network 面板同样可见，非泄露面扩大）。
- **已知风险**：v8/import Base Plan 配额（2 次/驱动的录制脚本 + 开发期偶发 live——用量极低）；ISP HTTPS 劫持（脚本失败即退出、旧录制保留，应用层自动回落 fixture——双兜底）。

## 修订记录

- 2026-09-09 精简对抗评审（workflow `step3-plan-review`：3 视角找缺陷，controller 直接裁决；3 条发现全采纳）后修订：
  - **[blocker] T1/T2/T3 测试的合成 polyline 不可解码**：评审者用仓库解码器实测 `'BlBoz5xJq6K9CmC7'` 抛 `truncated varint`——T3 的 App 用例会经 derive 链解码它 → 错误态 → LIVE 角标永不渲染，按计划写法必红。修正：三处测试的 polyline 全部改取已提交 fixture0033 的真实可解码串（T1/T2 虽不触发解码，一并替换防未来复制）。
  - **[major] T6 断网演练序列不可能通过**：全断网 + 清缓存时轨迹 fetch（加载链第一环）本身失败 → 错误态而非 MOCK——把 L98（live 回落）与 L122（断网可演示）两个判据混进了必然失败场景。修正：拆为两条可执行演练——断网判据 = 在线预热缓存后 Offline（缓存命中 + SVG 兜底）；回落判据 = Request blocking 仅封 `*router.hereapi.com*` 后清缓存（live 503 → 静默 fixture → MOCK）。
  - **[major] T3 录制按钮用例不验证重载**：漏写 `setReloadToken` 的实现仍全绿（角标残留在旧 data 上）。修正：用例末尾补「缓存键经重载回填恢复」+「live 端点共调 2 次」双断言（镜像既有清除缓存用例的回填断言模式）。

## Errata（实现期运行时实证修正）

- 2026-09-09 手动验收实证（用户浏览器，真实 key）：
  - **「HERE 地图无法加载」定性为非缺陷**：控制台 Tangram `Scene.load ... 'getExtension' of null` / `'lookAtManipulator' of null` 系 **dev 模式 StrictMode 双挂载的 dispose 竞态噪声**（第一份地图已 dispose、其异步场景仍完成后落入已销毁的 WebGL 上下文；第二份地图正常）。生产构建（`npm run preview`）控制台干净、底图+轨迹正常——**面试演示建议用 preview 模式**。「轨迹先出、底图 1-2s 后到」为 HERE 矢量底图正常暖机；「正在加载 5-6s」为 SDK ~1MB 的 CDN 下载时长（本机实测 CDN 可达）。残余提示：FiraGO 地图字体 [Intervention] 为浏览器对慢网络的降级提示，无功能影响；favicon 404 已补内联 SVG 图标。
  - **车标航向恒错（Bug B）**：`TrajPoint.headingDeg` 实为 KITTI oxts yaw（0=东、逆时针），车标按罗盘航向（0=北、顺时针）消费导致恒偏（0033 均偏 15.6°、0011 均偏 59.5°；坐标反算真航向对照：`compass=(90−yaw)%360` 下两轨迹 100% 点位误差 ≤5°、圆均值 ≈0°）。修复 `e1e9a88`：`geo.yawToCompassDeg` 纯函数，MapView 归一处统一转换、SVG/HERE 两渲染路径共用；数据与 derive 不动。HERE 真实路径人工验证通过。

