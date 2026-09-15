# HTML teaser 样式移植 → React 工程 设计文档

## 概述

把单文件 HTML teaser（`HERE-POC-MapMatching-CHANG-Zhen.html`）迭代出的**播放手感与视觉样式**移植回 React 主工程，**不改变任何行为语义**。核心交付两件事：

1. 回放从 10Hz 整数帧跳变升级为 **60fps 子帧插值**（位置 + 航向最短弧插值，算法照搬 HTML 版）
2. 视觉对齐 HTML：蓝色大数值统计 chip、极简坐标轴图表、Tab 蓝底白字激活态、Analysis 态 MM 连续蓝线、HERE 路径补起终点标记

## 背景

- HTML teaser 上确立的满意点（用户 2026-09-15 确认）：浮点时钟 + 子帧插值的平滑播放、蓝底 chip、紧凑图表
- React 工程已有（无需移植）：方向性图标 + 5° 分桶缓存、点按弹窗、四 chip 带 tooltip、滚动窗口偏差曲线、渐进洒点、SVG 无底图兜底
- 用户拍板保留现状的四项：**车标沿匹配路线**（不换 DR 轨迹）、**渐进洒点**（不换全量一次显示）、**保留 Recharts 只调样式**（不换手绘 SVG）、**车头向上保留**（含现状镜头与 CSS 旋转）

## 非目标

- 不改车标语义路径（仍为 `derived[i].matchedLatLng` 垂足）
- 不改散点渐进策略、车头向上、回放条底部通栏位置、弹窗固定左上位置
- 不替换 / 移除 Recharts 依赖
- 不动镜头参数（zoom 17/16、host 134% 高度偏移、车头向上 scale(2.3)——其瑕疵为已知接受项）

## 技术方案

### 1. 回放插值（核心）

**`src/lib/playback.ts` 新增两个纯函数**（与 HTML 版算法逐条对应）：

| 函数 | 行为 |
|---|---|
| `interpCarPos(pos, trace, derived)` | `i0 = floor(clamp(pos))`，`i1 = min(i0+1, last)`，`frac = i0===i1 ? 0 : pos−i0`；在 `derived[i0].matchedLatLng` 与 `derived[i1].matchedLatLng` 间线性插值；`derived[i]` 缺失时回退 `trace[i]` 坐标；返回 `[lat, lng]` |
| `interpHeadingDeg(h0, h1, frac)` | 最短弧：`d = h1−h0`；`d>180 → d−=360`；`d<−180 → d+=360`；返回 `h0 + d×frac`（不取模，由调用方 `yawToCompassDeg` 归一） |

**`src/hooks/usePlayback.ts`**：

- 新增暴露 `pos: number`（浮点）。rAF tick 里 `setPos(next)` 每帧更新；`index` 语义不变（仅整数变化 setState，现有实现保持）
- `seek()` 同步 `setPos(clamped)`；`lastIndex` 复位 effect 与终点重播处 `setPos(0)`
- 暂停/终点/倍速逻辑零改动（React 版本无 HTML 曾有的末帧渲染 bug，无需移植该修复）

**消费链**：

- `App.tsx`：`carIndex={pb.index}` → `carPos={pb.pos}`（仅 demo 态传入；Analysis 仍无车标）
- `MapView.tsx`：`carIndex?: number` → `carPos?: number`；车标 effect 内调 `interpCarPos` + `interpHeadingDeg(trace[i0].headingDeg, trace[i1].headingDeg, frac)` → 现有 `carIcon` 分桶 / `volatility: true` setGeometry+setIcon 通道不变
- **`SvgFallback` 接口零改动**：MapView 的 fallback 分支已自行组装 `car = {lat,lng,compassDeg}` 对象，改为传插值结果即可

### 2. 视觉样式（不改语义）

| 项 | 文件 | 改动 |
|---|---|---|
| Tab 激活态 | App.tsx | `#eff6ff` 浅蓝底 → **`#2563eb` 蓝底白字加粗**（HTML 同款） |
| 统计 chip | StatsPanel.tsx | 底 `#f9fafb`/灰边 → **`#eff6ff` 底 + `#dbeafe` 边**；数值 15px → **20px `#1e40af` 加粗**；标签 11px `#6b7280`；2×2 grid（HTML 同款） |
| 直方图 | StatsPanel.tsx | 去 `CartesianGrid` 网格线；坐标轴 tick 极简化；柱色保持 `#2563eb` |
| 偏差-里程 / 回放偏差曲线 | StatsPanel.tsx、DeviationReplayChart.tsx | 线/填充 `#f59e0b` 琥珀 → **`#2563eb` + `fillOpacity 0.15~0.25` 淡蓝填充**（HTML 同款）；`CartesianGrid` 去除；Tooltip 组件保留（悬停有用，默认不可见不构成样式冲突） |
| MM 匹配路线连续蓝线 | MapView.tsx、SvgFallback.tsx | Analysis 态（`showMm`）在箭头层之下新增 polyline：**连接 `derived[].matchedLatLng` 垂足**（抽稀 ≤2000 点），`rgba(37,99,235,0.7)` / 宽 4（SVG 路径 strokeWidth 等比）。不加新 prop——垂足连线即实际匹配路线的子集，零接口变化 |
| 起点/终点标记 | MapView.tsx（HERE 路径） | 补绿/红圆点 SVG marker：起点恒画；终点 `upTo >= trace.length−1` 时画（与 SVG 兜底路径现有语义、HTML 行为一致）。**实现位置约束：终点标记的增删由喷洒 effect 承载（`upTo` 已是其依赖），严禁挂进建图 effect**——否则 upTo 逐帧变化会触发地图 dispose/重建 |

## 测试策略

- **新增单测（TDD）** `playback.test.ts`：`interpCarPos`（首帧/中段/末帧/单点轨迹/derived 缺失回退 trace）；`interpHeadingDeg`（跨 0/360 环绕双向、非环绕、frac=0/1 端点）
- **更新** `usePlayback.test.ts`：`pos` 暴露断言（`pos − index ∈ [0,1)`、seek 后 pos 同步、终点 pos === lastIndex）
- **更新** `mapview.test.tsx`：car prop 由整数 index 改传 pos（`pos=25` 的 frac=0 结果与原 index=25 完全一致，断言可平滑迁移）
- 样式改动**不新增强制断言**（颜色不进测试，避免脆断言），靠手测验收
- 既有 131 个测试除上述迁移点外期望不动，全量保持绿

## 手测验收清单

1. `npm run dev`（有 key）0093 / 0042 + Demo 1x：车 60fps 平滑、车头连续转向无甩头；2x/5x 同验
2. 拖动进度条前进/回拖：车位置即时正确；暂停定格；播放到终点停帧
3. Analysis：MM 连续蓝线出现（箭头之下）、起点绿点/终点红点；chip 蓝底大数值；两图表蓝色无网格
4. 清空 `.env`（fixture 模式）重复 1-3：SVG 兜底路径同等平滑（插值由 MapView 统一供给）
5. `npm run build` 通过；`npm test` 全绿（131 + 新增）

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 60fps App 重渲染（播放中） | 重渲染面收敛：MapView 吃浮点（effect 命中 setGeometry/setIcon），ReplayBar/DeviationReplayChart 吃整数与 0.5s 量化 memo；若实测 SVG 兜底路径（~200 元素协调）卡顿 → 兜底方案：fallback 分支 car 量化到 0.1 帧（视觉差异不可感知） |
| 垂足连线在极端偏离段（0093 尾段 26m）近似路线而非精确路线 | 接受：垂足恒在匹配 polyline 上，连线为其子集；精确路线需新 prop 传解码 polyline，收益不抵接口膨胀 |
| Recharts 去网格后轴刻度拥挤 | 直方图 X 轴本就 `tick={false}`；偏差曲线 X 轴保留刻度但 interval 收敛，手测确认 |

## 实施顺序

| 步骤 | 内容 | 交付判据 |
|---|---|---|
| T1 | `playback.ts` 两个纯函数 + 单测（TDD 先行） | 新增测试绿 |
| T2 | `usePlayback` 暴露 `pos` + 测试更新 | 套件全绿 |
| T3 | MapView/SvgFallback/App 消费插值 | 手测清单 1/2/4 过 |
| T4 | 视觉样式六项（tab/chip/两图表/MM 线/起终点） | 手测清单 3 过 |
| T5 | 全量回归 + build | 手测清单 5 过 |
