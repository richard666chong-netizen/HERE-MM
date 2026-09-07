# HERE Map Matching POC — Step0 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 Step0：LBN 仓库搬家清场、Vite + React 19 + TS 脚手架落地、Vitest 测试地基、两条 KITTI demo 轨迹入库——交付 `npm run dev` 空壳可起。

**Architecture:** 纯前端单页应用（Vite 开发服务器 + 静态构建）。Step0 只交付应用空壳与数据/测试地基；地图 SDK loader、MockService、匹配与回放全部留给 Step1–Step3。轨迹 JSON 作为静态资产放 `public/sample/here/`，随仓库分发。

**Tech Stack:** Vite 7、React 19、TypeScript 5.8（strict）、Vitest 3 + jsdom + Testing Library。

**Spec:** `docs/superpowers/specs/2026-09-07-here-map-matching-poc-design.md`

## Global Constraints

- 框架组合固定：Vite + React 19 + TypeScript（spec 技术方案表）
- **零 npm 地图依赖**：HERE Maps API for JavaScript 后续以 script 标签加载，Step0 不安装任何地图库（spec 技术方案表）
- API key 只经 `import.meta.env.VITE_HERE_KEY`（`.env`，已存在且已 gitignore）读取；**key 永远不进 git、不进代码、不进对话**
- `.gitignore` 现状（`node_modules/ dist/ .env data/`）满足 spec 的 `data/raw/` 要求且更严格，**不要放宽**为只忽略 `data/raw/`
- 单人短周期，所有提交直接进 `main`（spec「Git 与目录」）
- 本机为 Windows + Git Bash：Python 一律用 `py`（`python` 是空壳存根）；py 打印非 ASCII 前设 `PYTHONIOENCODING=utf-8`
- 提交信息用 conventional commits（中文描述可）

## 现状（已核实，勿重复排查）

- `D:\LBN_test_platform\data\` 下 `kitti/`、`fetch_kitti_oxts.py`、`analyze_kitti.py` 与 `D:\here-poc\data\` **逐字节一致**（diff -r 验证过）——LBN 侧是多余副本，直接删除即可，无需再搬
- 两条轨迹（`data/kitti/<driveId>/trajectory_light.json`，数组元素含 `lat lng timestamp timestampUtc headingDeg speedMps numsats axMps2 wzDegs pltSeconds pltNanoseconds`）：
  - `2011_09_26_drive_0011`：233 点，58,523 bytes，lat [49.0106, 49.0114]，lng [8.4388, 8.4399]，ts 0–23.2 s 严格递增
  - `2011_09_30_drive_0033`：1594 点，401,792 bytes，lat [48.9675, 48.9726]，lng [8.4756, 8.4821]，ts 0–159.3 s 严格递增
- Node v24.15.0 / npm 可用；仓库当前无 `package.json`（全新脚手架）
- 真实 API fixture 已在 `data/fixtures/`（gitignored，Step3 用，本计划不动它）

## File Structure

```
D:\here-poc\
├── package.json                  # 本计划创建：scripts + deps
├── vite.config.ts                # 本计划创建：react 插件 (+ Task3 加 vitest test 段)
├── tsconfig.json                 # 本计划创建：strict 单配置（不用 project references）
├── index.html                    # 本计划创建
├── src\
│   ├── main.tsx                  # 入口
│   ├── App.tsx                   # Step0 空壳（后续 Step 全部重写内容）
│   ├── index.css                 # 最小 reset
│   ├── vite-env.d.ts             # VITE_HERE_KEY 环境类型
│   ├── App.test.tsx              # Task3：App 冒烟测试
│   └── __tests__\
│       └── trajectories.test.ts  # Task4：入库轨迹契约测试
└── public\sample\here\
    ├── 2011_09_26_drive_0011.json   # Task4：从 data/kitti 复制
    └── 2011_09_30_drive_0033.json   # Task4：从 data/kitti 复制
```

---

### Task 1: LBN 搬家清场

**Files:**
- Delete: `D:\LBN_test_platform\data\kitti\`（整目录）
- Delete: `D:\LBN_test_platform\data\fetch_kitti_oxts.py`
- Delete: `D:\LBN_test_platform\data\analyze_kitti.py`

**Interfaces:**
- Consumes: 无
- Produces: 无（纯清理，here-poc 侧 `data/` 已有等价内容且 gitignored）

**背景：** 这些文件在 LBN 均为未跟踪文件，spec L113 明确"搬走即净，无需回滚"。两边内容已验证逐字节一致，删除 LBN 副本零风险。

- [ ] **Step 1: 删除 LBN 侧 HERE 文件**

```bash
rm -rf "D:/LBN_test_platform/data/kitti" \
       "D:/LBN_test_platform/data/fetch_kitti_oxts.py" \
       "D:/LBN_test_platform/data/analyze_kitti.py"
```

- [ ] **Step 2: 验收 LBN 干净**

```bash
ls "D:/LBN_test_platform/data" | grep -i -E 'kitti|here|oxts' && echo "FAIL: 还有残留" || echo "PASS: data 目录无 HERE 条目"
git -C "D:/LBN_test_platform" status --porcelain | grep -i -E 'kitti|here|oxts' && echo "FAIL: git status 有 HERE 条目" || echo "PASS: git status 无 HERE 条目"
```

Expected: 两行都输出 `PASS`。

- [ ] **Step 3: 验收 here-poc 侧数据完好**

```bash
ls D:/here-poc/data/kitti/2011_09_26_drive_0011/trajectory_light.json D:/here-poc/data/kitti/2011_09_30_drive_0033/trajectory_light.json
```

Expected: 两个文件都存在。无 commit（here-poc 侧 `data/` 被 gitignore）。

---

### Task 2: Vite + React 19 + TS 脚手架（手写，非交互式）

**Files:**
- Create: `package.json`、`vite.config.ts`、`tsconfig.json`、`index.html`、`src/main.tsx`、`src/App.tsx`、`src/index.css`、`src/vite-env.d.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `App`：React 组件默认导出（`export default function App()`）
  - `ImportMetaEnv.VITE_HERE_KEY?: string`——Step1 起读取 HERE key 的唯一途径
  - npm scripts：`dev` / `build` / `preview`（`test` 在 Task 3 加）

**为什么手写而不是 `npm create vite`：** create-vite 在非空目录会交互式询问，agent 执行不可控；手写文件内容完全确定。

- [ ] **Step 1: 写 `package.json`**

```json
{
  "name": "here-poc",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.1.0",
    "react-dom": "^19.1.0"
  },
  "devDependencies": {
    "@types/react": "^19.1.0",
    "@types/react-dom": "^19.1.0",
    "@vitejs/plugin-react": "^5.0.0",
    "typescript": "~5.8.3",
    "vite": "^7.0.0"
  }
}
```

- [ ] **Step 2: 写 `vite.config.ts`**

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})
```

- [ ] **Step 3: 写 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true,
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

- [ ] **Step 4: 写 `index.html`**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>HERE Map Matching POC</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: 写 `src/main.tsx`**

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

- [ ] **Step 6: 写 `src/App.tsx`（Step0 空壳）**

```tsx
export default function App() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <h1>HERE Map Matching POC</h1>
      <p>Step0 scaffold — 地图、匹配与回放将在 Step1–Step3 落地。</p>
    </main>
  )
}
```

- [ ] **Step 7: 写 `src/index.css`**

```css
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; }
```

- [ ] **Step 8: 写 `src/vite-env.d.ts`**

```ts
/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** HERE Platform API key（Base Plan），.env 提供，可缺省（缺省走 Mock） */
  readonly VITE_HERE_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
```

- [ ] **Step 9: 安装依赖**

```bash
npm install
```

Expected: 正常结束（lock 文件 `package-lock.json` 生成）。

- [ ] **Step 10: 构建验证（类型检查 + 打包）**

```bash
npm run build
```

Expected: `tsc --noEmit` 零错误，vite build 产出 `dist/`。

- [ ] **Step 11: dev 服务器冒烟**

用 Bash 工具的 `run_in_background` 启动：`npm run dev`，等 3–5 秒后：

```bash
curl -s http://localhost:5173/ | grep -o '<title>[^<]*</title>'
```

Expected: 输出 `<title>HERE Map Matching POC</title>`。然后 TaskStop 停掉 dev 服务器。

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json vite.config.ts tsconfig.json index.html src/
git commit -m "chore: scaffold Vite + React 19 + TS app shell (Step0)"
```

---

### Task 3: Vitest 测试地基

**Files:**
- Modify: `package.json`（devDependencies + scripts.test）、`vite.config.ts`（加 `test` 段）
- Create: `src/App.test.tsx`

**Interfaces:**
- Consumes: Task 2 的 `App` 默认导出
- Produces: `npm run test`（单次运行）；`vite.config.ts` 的 `test.environment: 'jsdom'` + `test.globals: true`——Step1 起所有测试文件的运行基座

- [ ] **Step 1: 先写失败测试 `src/App.test.tsx`**

```tsx
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from './App'

describe('App skeleton (Step0)', () => {
  it('renders the POC title', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'HERE Map Matching POC' })).toBeTruthy()
  })

  it('mentions Step0 placeholder copy', () => {
    render(<App />)
    expect(screen.getByText(/Step0 scaffold/)).toBeTruthy()
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
npx vitest run
```

Expected: FAIL——`Cannot find module 'vitest'`（runner 尚未安装）。

- [ ] **Step 3: 安装测试依赖**

```bash
npm install -D vitest@^3.2.0 jsdom@^26.1.0 @testing-library/react@^16.3.0 @testing-library/dom@^10.4.0
```

- [ ] **Step 4: 配置 `vite.config.ts`（整文件替换为）**

```ts
/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
  },
})
```

- [ ] **Step 5: `package.json` scripts 加 test**

在 `scripts` 中加一行（放在 `preview` 之后）：

```json
"test": "vitest run"
```

- [ ] **Step 6: 运行确认通过**

```bash
npm run test
```

Expected: 2 passed（App 两条用例）。

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json vite.config.ts src/App.test.tsx
git commit -m "test: add Vitest + Testing Library harness with App smoke test"
```

---

### Task 4: 轨迹入库 + 契约测试

**Files:**
- Create: `public/sample/here/2011_09_26_drive_0011.json`（复制自 `data/kitti/2011_09_26_drive_0011/trajectory_light.json`）
- Create: `public/sample/here/2011_09_30_drive_0033.json`（复制自 `data/kitti/2011_09_30_drive_0033/trajectory_light.json`）
- Test: `src/__tests__/trajectories.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `public/sample/here/{driveId}.json`——Step1 前端 `fetch('/sample/here/<driveId>.json')` 的固定 URL 约定；元素结构即 `TrajPoint`（见测试内 interface，后续 `types.ts` 会正式化）

- [ ] **Step 1: 先写失败测试 `src/__tests__/trajectories.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import d0011 from '../../public/sample/here/2011_09_26_drive_0011.json'
import d0033 from '../../public/sample/here/2011_09_30_drive_0033.json'

interface TrajPoint {
  lat: number
  lng: number
  timestamp: number
  timestampUtc: string
  headingDeg: number
  speedMps: number
  numsats: number
}

const REQUIRED_FIELDS = [
  'lat', 'lng', 'timestamp', 'timestampUtc', 'headingDeg', 'speedMps', 'numsats',
] as const

// Karlsruhe 城区包围盒（宽于实测范围，仅拦截 swapped-coord / 截断 / 错文件类损坏）
const KA_BOX = { latMin: 48.95, latMax: 49.05, lngMin: 8.40, lngMax: 8.50 }

describe('bundled demo trajectories (contract)', () => {
  it.each([
    ['2011_09_26_drive_0011', d0011 as unknown as TrajPoint[], 233],
    ['2011_09_30_drive_0033', d0033 as unknown as TrajPoint[], 1594],
  ])('%s', (_driveId, pts, expectedCount) => {
    expect(pts).toHaveLength(expectedCount)
    for (const p of pts) {
      for (const f of REQUIRED_FIELDS) expect(p).toHaveProperty(f)
      expect(p.lat).toBeGreaterThanOrEqual(KA_BOX.latMin)
      expect(p.lat).toBeLessThanOrEqual(KA_BOX.latMax)
      expect(p.lng).toBeGreaterThanOrEqual(KA_BOX.lngMin)
      expect(p.lng).toBeLessThanOrEqual(KA_BOX.lngMax)
      expect(Number.isFinite(p.headingDeg)).toBe(true)
      expect(p.speedMps).toBeGreaterThanOrEqual(0)
    }
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i].timestamp).toBeGreaterThan(pts[i - 1].timestamp)
    }
  })
})
```

- [ ] **Step 2: 运行确认失败**

```bash
npm run test
```

Expected: FAIL——两个 JSON 模块找不到（文件尚未入库）。

- [ ] **Step 3: 复制轨迹入库**

```bash
mkdir -p public/sample/here
cp data/kitti/2011_09_26_drive_0011/trajectory_light.json public/sample/here/2011_09_26_drive_0011.json
cp data/kitti/2011_09_30_drive_0033/trajectory_light.json public/sample/here/2011_09_30_drive_0033.json
ls -la public/sample/here/
```

Expected: 两个文件分别约 58 KB 和 402 KB。

- [ ] **Step 4: 运行确认通过**

```bash
npm run test
```

Expected: 全部 passed（App 2 条 + 轨迹 2 条）。

- [ ] **Step 5: Commit**

```bash
git add public/sample/here/ src/__tests__/trajectories.test.ts
git commit -m "feat: bundle KITTI demo trajectories with contract tests"
```

---

### Task 5: Step0 验收（对照 spec 交付判据）

**Files:** 无新文件；只验证。

**Interfaces:**
- Consumes: Task 1–4 全部产出
- Produces: Step0 完成状态，可启动 Step1

- [ ] **Step 1: 全量绿**

```bash
npm run build && npm run test
```

Expected: build 零错误 + 测试全过。

- [ ] **Step 2: spec 交付判据逐条核对**

| spec 判据 | 验证命令 | 期望 |
|---|---|---|
| LBN `git status` 无 HERE 相关条目 | `git -C "D:/LBN_test_platform" status --porcelain \| grep -iE 'kitti\|here\|oxts'` | 无输出 |
| `npm run dev` 空壳可起 | 后台起 dev + `curl -s http://localhost:5173/ \| grep -o '<title>[^<]*</title>'` | `<title>HERE Map Matching POC</title>` |

- [ ] **Step 3: 仓库状态收尾检查**

```bash
git status --porcelain
git log --oneline -5
```

Expected: 工作区干净（`data/`、`.env`、`application/` 被 ignore 不出现）；Step0 三个 commit 在列。

---

## Self-Review 记录

- **Spec 覆盖**：spec L119 Step0 =「搬家清场 + Vite 脚手架 + .gitignore + 轨迹入库」→ Task 1 / Task 2 / Task 5（.gitignore 已满足，验证不改）/ Task 4。测试地基（Task 3）不在 Step0 字面范围但为 spec L104–106 的 Vitest 要求打底，且让 Task 4 有真实测试周期。
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码。
- **类型一致性**：`App` 默认导出（Task 2 产出 / Task 3 消费）✓；`VITE_HERE_KEY?: string`（Task 2 产出 / Step1 消费）✓；`TrajPoint` 仅在 Task 4 测试内定义并注明后续正式化 ✓。
