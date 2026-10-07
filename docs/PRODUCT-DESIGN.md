# HERE 轨迹匹配 POC — 产品设计方案

> 基于 POC 最终完成状态（2026-10-07，街道名抖动修复）逆向梳理。
> 本文档面向产品/解决方案架构师，描述产品的目标、架构、功能、数据流与演进路径。

---

## 1. 产品定位

**一句话**：用 OEM 验收定位供应商的指标体系，评估 HERE 云端轨迹匹配在 GNSS 退化场景下的纠偏能力与失效边界。

**核心价值主张**：

| 维度 | 价值 |
|------|------|
| **买方视角** | 不是看 HERE 有多少功能，而是用客户自己的验收口径（p95 横向偏差）测出"它能在多大偏差内把车拉回路网" |
| **诚实边界** | 主动暴露"在哪里、为什么停止工作"——60s GNSS 拒止下 DR 漂移 58m，HERE 匹配器跟着漂移轨迹匹配到了旁路。这不是缺陷，是串行 DR→MM 架构的固有上限 |
| **向上销售** | 边界发现直接引出紧耦合 map-aided DR / 车道级定位的产品对话 |
| **出海叙事** | 场景城市卡尔斯鲁厄——中国车企出口欧洲的车要跑的 EU 路网、GDPR 合规环境 |

**目标用户**：
- HERE 销售/解决方案架构师（面向 OEM 客户演示）
- OEM 定位工程师（评估图商能力边界）
- 产品经理（理解云 API vs 车端 SDK 的能力差异与计价梯队）

---

## 2. 技术架构

### 2.1 技术栈

| 层 | 技术 | 选型理由 |
|----|------|----------|
| 构建 | Vite 7 + TypeScript 5.8 | 快速脚手架，类型安全 |
| UI 框架 | React 19 | 组件化，Hooks 状态管理 |
| 地图引擎 | HERE Maps API for JavaScript 3.1 | script 标签加载，自封装 loader，无 npm SDK 依赖 |
| 图表 | Recharts + 自绘 SVG | 偏差曲线用 Recharts；直方图/偏差-里程用自绘 SVG（精确控制样式） |
| 测试 | Vitest（174 tests / 20 files） | 单元 + 契约 + 回归锁定 |
| 截图 | playwright-core（系统 Edge/Chrome） | 无头截图工具 |

### 2.2 数据流水线

```
KITTI oxts trace (10 Hz, WGS-84, OXTS RT3000 GNSS+IMU)
  │
  ├─ buildGnssFeed()        真实失锁(posmode==0) + 仿真隧道窗口 → 退化 GNSS 流
  │                          失锁帧: 位置冻结 + noFix=true
  │
  ├─ deadReckon()           多速率航位推算:
  │                          · 10Hz 惯性递推 (heading + speed 积分)
  │                          · 1Hz GNSS 纠正 (gain=0.3, 双门控: numsats>6 && !noFix)
  │                          · 速度源: GNSS位移速度优先, 方向一致性检查, 三档回退
  │
  ├─ liveTrace              DR 增强后的轨迹 (发给 HERE 的)
  │
  ├─ HERE Routing v8 /import  POST trace → 匹配路线 (flexible polyline)
  │                          降采样 ≈500 点, 6位小数, 结构校验
  │
  ├─ derive()               逐点派生:
  │                          · nearestOnPolyline → 垂足投影 + deviationM
  │                          · buildMatchedTrack → 运动学门控车标轨道
  │                          · kinematicTrackArcs → trackArcM (弧长序列)
  │
  └─ 视图层                  MapView (地图/散点/路线/车标)
                             StatsPanel (chips + 直方图 + 偏差-里程曲线)
                             DeviationReplayChart (回放联动偏差曲线)
                             ReplayBar (播放控制)
```

### 2.3 四层降级策略（演示永不中断）

```
Live API (HERE Routing v8 /import)
  ↓ 失败/无key
localStorage 缓存 (按 driveId × tunnelVariant 分档)
  ↓ 未缓存
仓库 Fixture (用真实 API 预录制, 随仓库分发)
  ↓ 地图瓦片不可达
SVG 无底图兜底 (自绘轨迹/散点/路线/车标, 等距圆柱投影)
```

**关键设计**：生产构建 keyless（`.env.production` 钉死空 key），API key 只在 dev 模式注入，dist 分享不泄漏凭证。

### 2.4 缓存架构

```
CacheEntry {
  driveId: string
  source: 'live' | 'mock'
  createdAt: ISO-8601
  response: ImportResponse    // HERE 原始响应, 不裁剪
  derived: DerivedPoint[]     // 派生数据, 惰性计算后回填
}

key: here-mm-cache:v4:{driveId}:{variant}
     版本号随算法变更升级 (v1→v4 共 4 次, 强制重派生)
```

---

## 3. 功能设计

### 3.1 双模式架构

#### Analysis 模式（工程分析）

| 元素 | 内容 |
|------|------|
| 地图 | HERE 底图全量静态展示（或 SVG 兜底） |
| 图层 | GNSS 散点（橙/灰）+ DR 路径（紫，仅失锁时渲染）+ HERE 匹配路线（蓝） |
| 交互 | 拖拽/缩放/点击 marker 弹窗 |
| 统计面板 | 4 chips（Mean/P95/Max/DR Drift）+ 直方图 + 偏差-里程曲线 |
| 用途 | 静态对比分析，验收口径出数 |

#### Demo 模式（客户演示）

| 元素 | 内容 |
|------|------|
| 回放 | 1×/2×/5× 倍速，进度条拖动（拖动即暂停，松手续播） |
| 车标 | 播放中：DOM 叠层沿匹配轨道弧长插值（运动学门控序列匹配）；暂停/结束：HERE marker 在真实位置 |
| 相机 | 播放中：锁定跟随车标（北向上/车头向上）；暂停/结束：定位到车标但不锁定，用户可自由平移缩放 |
| 散点 | GNSS 点随播放进度逐个喷洒（增量式，O(n) 非 O(n²)） |
| 统计 | chips 随回放进度实时切片更新（0.5s 量化）；偏差曲线 30s 滑窗滚动 |
| 用途 | 客户演示，动态叙事 |

### 3.2 仿真隧道场景

**设计哲学**：一切数据都是真的——轨迹、航向、速度、加速度全部来自 KITTI raw oxts。唯一的场景参数是"GNSS 被拒止多久"，这正是隧道的物理定义。

| 参数 | 值 | 依据 |
|------|------|------|
| 宿主轨迹 | `2011_10_03_drive_0042` | 高速公路, 79.6 km/h, 60s×79.6km/h=1.3km（真实隧道量级） |
| 拒止起点 | 轨迹总时长 30% | 实测最优：60s 拒止得 59m 横向漂移 + 22s 出隧道纠回余量 |
| 拒止时长 | Off / 30s / 60s / 120s | 30s = 有效纠正（mean 1.19m）；60s = 能力边界（DR 漂 67m，匹配跟到旁路） |

**MM 能力边界实测**：

| 拒止 | DR 漂移 | HERE 匹配 | 真值→匹配路线 |
|------|---------|-----------|---------------|
| 30s | ~12m | 1 段 / 2594m | mean 1.19m / max 6.10m ✓ |
| 60s | 66.9m (58.6m 横向) | 2 段 / 2431m — 跟到旁路 | max 49.85m ⚠️ |
| 60s 冻结流对照 | — | 1 段 / 2536m | 鲁棒 ✓ |

### 3.3 偏差统计体系

| 指标 | A 端 | B 端 | 计算 | 语义 |
|------|------|------|------|------|
| Mean Deviation | 本地 DR 位置 | HERE MM 匹配路线 | sum(deviationM)/n | MM 平均纠偏量 |
| P95 Deviation | 同上 | 同上 | sorted[ceil(0.95n)-1] | OEM 验收口径 |
| Max Deviation | 同上 | 同上 | sorted[n-1] | 最坏工况 |
| DR Max Drift | 本地 DR 位置 | OXTS 输出 | max(haversine) | 两种 DR 算法精度差距 |

**关键区分**：前三个指标是"DR→HERE 的纠偏量"（横向偏差），第四个是"DR→OXTS 的算法精度差距"——两个数放一起，"DR 漂 67m、MM 绑路后 6m"这句话才成立。

### 3.4 车标绑路系统（运动学门控序列匹配）

生产导航 MM 是带运动模型的时序滤波器。本 POC 补上同样的机制：

```
MM 响应 (地理不相连碎片, 拼接序≠驾驶序)
  │
  ├─ visitSequence()        到访序列压缩 (≥3帧持续, 重访复制为独立段)
  ├─ dropStalledRevisits()  停滞伪重访去伪 (段内跨度 < max(8m, 5%×段长) 不复制)
  ├─ assembleTrack()        到访序拼装 + 断口直线桥 + 两轮 Chaikin 折角圆化
  │
  └─ kinematicTrackArcs()   逐帧弧长输出:
      · 预测: arc += v×dt
      · 门控: |obs-pred| ≤ max(1.5×v×dt, 5m, 0.5×v) → 跟随(弱锚定 g=0.08)
      · 超门: coast 在预测位 (拒绝物理不可能跳变)
      · 持续超门 8 帧 → 重绑 (真实换段) + 锁定 50 帧
      · 重绑跳变 → 8m/帧掠过 (消瞬移)
      · 5 点中值平滑
```

### 3.5 航位推算（DR）算法

| 特性 | 实现 |
|------|------|
| 递推频率 | 10Hz（每帧） |
| 纠正频率 | 1Hz（每 10 帧） |
| 纠正增益 | 0.3（`pos += 0.3 × (gnss - pos)`） |
| 速度源 | GNSS 位移速度优先 → IMU 轮速回退 → 上一帧合理速度 |
| 方向检查 | 位移方位 vs IMU 航向偏差 >45° = 多径跳变, 不可信 |
| 更新门控 | `numsats > 6 && !noFix`（双门控：卫星数 + 有无定位解） |
| 帧 0 | 无条件 GNSS 播种 |

**刻意简化**：站在 OXTS 已处理输出上递推，目的是测 MM 行为而非 DR 精度。ESKF/捷联积分是记录在案的升级路径。

### 3.6 地图引擎适配

| 问题 | 解决方案 |
|------|----------|
| HERE SDK 加载 | 自封装 loader：script 标签顺序注入 + 单例缓存 + 超时重试 |
| 底图瓦片探测 | SDK 脚本加载成功 ≠ 瓦片可达（企业网/VPN 静默拦截）→ 显式探测 vector tile 端点 |
| 引擎 heading 语义 | 实测定律 R=180°−h（传 h → 内容旋转 180−h）→ 北向上传 180, 车头向上传 (compass+180)%360 |
| WebGL 不可用 | SVG 无底图兜底：等距圆柱投影自绘全部图层 |
| 车标抖动 | 播放中：DOM 叠层钉在相机中心（不用引擎 marker），结构性消灭引擎内外双路径相位差 |
| 车标暂停态 | 暂停/结束：切换为 HERE marker 在真实位置，相机定位但不锁定——用户可自由平移缩放 |
| 街道名抖动 | 播放中：134% 宿主高使相机中心天然在容器 67%，单步 setLookAtData 即达导航布局——避免两步调用致双重重定位 |

---

## 4. HERE 技术栈与 API 选型历程

### 4.1 POC 中实际使用的 HERE 技术清单

| HERE 产品 | 用途 | 调用方式 | 计划层 |
|----------|------|----------|--------|
| **Routing API v8 — `/import`** | 轨迹匹配：POST GNSS+DR 增强轨迹 → 匹配路线（flexible polyline） | `https://router.hereapi.com/v8/import?return=polyline,summary&transportMode=car` | Base Plan |
| **Maps API for JavaScript 3.1** | 地图渲染：底图瓦片 + DOM marker + polyline + 相机控制 | script 标签加载 `js.api.here.com/v3/3.1/mapsjs-*.js` | Base Plan |
| **Vector Tile Service v2** | 底图矢量瓦片 | `vector.hereapi.com/v2/vectortiles/base/mc/` | Base Plan |

> **未使用但调研过的 HERE 技术**：Route Matching API v8（`/v8/match/routelinks`）——Enterprise Plan 独占，详见 4.2。

### 4.2 API 选型历程：从 Route Matching 到 Routing /import

#### 原始方案（设计阶段）

POC 设计之初（2026-09-07），计划调用 **HERE Route Matching API v8**（`routematching.hereapi.com/v8/match/routelinks`）：

- 输入：CSV 格式 GNSS 轨迹点（lat,lng,timestamp）
- 输出：逐点匹配结果——每个轨迹点对应一个 `linkId`（路网 segment ID）+ `confidence`（匹配置信度）+ matched coordinates
- 语义：这是 HERE 正式的"地图匹配"产品，直接回答"每个点在哪条路上、有多确定"

#### 发现问题（2026-09-07 实测）

用 Base Plan freemium key 实际调用时发现：

```
HTTP 403 / 429
X-RateLimit-Limit: 0
```

**根因**：HERE 平台自 **2025-03-15** 起将 Route Matching API v8 调整为 **Enterprise Plan 独占**。Base Plan key 的配额直接为 0——不是限流，是功能门控。

这是 HERE 产品线的一次计价策略调整：将"逐点路网匹配 + 置信度"这一高价值能力从免费层移至企业付费层。

#### 替代方案：Routing API v8 `/import`

调研后找到 Base Plan 内的等价能力：**Routing API v8 的 `/import` 端点**。

| 对比 | Route Matching v8（Enterprise） | Routing v8 `/import`（Base Plan） |
|------|-------------------------------|----------------------------------|
| 端点 | `routematching.hereapi.com/v8/match/routelinks` | `router.hereapi.com/v8/import` |
| 输入 | CSV（lat,lng,timestamp） | JSON body `{"trace":[{lat,lng},...]}`（2–50,000 点） |
| 输出 | **逐点** linkId + confidence + matchedCoords | **路线级** sections[].polyline + summary |
| 匹配语义 | 每个轨迹点独立匹配到路网 link | 整条轨迹 → 最优连续路线 |
| 逐点偏差 | API 直接返回 | **需客户端自算**（垂足投影） |
| linkId | 每点返回 | 仅 section 级 |
| 计划层 | Enterprise only | Base Plan |

**关键差异**：`/import` 返回的是"匹配路线"而非"逐点匹配结果"。要得到每个轨迹点的横向偏差，需要在客户端对 HERE 返回的 flexible polyline 做几何投影——这正是本 POC `derive.ts` 所做的（`nearestOnPolyline` 逐点垂足投影 → `deviationM`）。

#### 选型决策

```
原计划:  GNSS+DR trace → HERE Route Matching v8 → 逐点 linkId + confidence + matchedCoords
                                    ↓ 403/429 (Enterprise only since 2025-03-15)
实际方案: GNSS+DR trace → HERE Routing v8 /import → 路线 polyline
                         ↓ 客户端 decodeFlexiblePolyline + nearestOnPolyline
                         → 逐点 deviationM + matchedLatLng + linkId(section级)
```

### 4.3 这个发现的产品/商业意义

| 维度 | 意义 |
|------|------|
| **PoC 可行性** | Base Plan freemium key 即可完成 POC——无需 Enterprise 权限申请，降低了客户评估 HERE 的门槛 |
| **能力差异 = 销售杠杆** | `v8/match` 的逐点 linkId + confidence 是 Enterprise tier 的核心卖点：客户在 PoC 阶段用 `/import` 测出匹配质量，量产需要逐点置信度时自然升级 |
| **方案架构师踩的坑 = 客户会踩的坑** | 任何 OEM 在 PoC 阶段拿 Base Plan key 试 HERE MM 都会撞到这个 429。提前知道这个坑，就是方案架构师的价值 |
| **客户端偏差计算** | `/import` 不给逐点偏差，所以 POC 自建了完整的投影 + 统计管线——这恰恰证明了"评估方法论"的可移植性：不依赖供应商的指标输出，而是用自己的验收口径量 |

### 4.4 其他 HERE 技术适配要点

| HERE 技术 | 适配挑战 | 解决方案 |
|-----------|----------|----------|
| Maps JS API 3.1 加载 | 企业网/VPN 可能只放行 `js.api.here.com` 而静默拦截瓦片域名 | 底图瓦片探测（`probeBasemap`：fetch vector tile 端点，失败即落 SVG 兜底） |
| Maps JS API 3.1 heading 语义 | 文档写"相机朝向"，实测传 h → 内容旋转 R=180°−h（"后视镜"约定） | geoToScreen 数值探针测定传递函数；北向上传 180，车头向上传 (compass+180)%360 |
| Maps JS API 3.1 DOM marker | 逐帧 setCenter + marker.setGeometry 走不同更新路径 → 相位差抖动 | 车标改 DOM 叠层钉在相机中心，不用引擎 marker |
| Flexible Polyline 编码 | HERE 自定义编码格式，无官方 npm 解码器 | 自实现 `decodeFlexiblePolyline`（varint + zigzag + 精度因子），契约测试锁定 |
| Routing v8 /import 降采样 | API 单次接受 2–50,000 点，长轨迹需降采样 | `buildImportRequest`：≈500 点降采样，首末点保留，6 位小数精度 |

---

## 5. 数据资产

### 5.1 轨迹数据集

| Drive | 场景 | 点数 | 特征 | 用途 |
|-------|------|------|------|------|
| 0093 | 城市道路 | 232 | pos_accuracy ±21m（真值不可信） | 压力用例 |
| 0096 | 林荫道 | 386 | 真实失锁 34.3s, 横向漂移 12.4m | 真实退化对照 |
| 0106 | 城市峡谷 | 227 | 全程失锁 22.7s, 横向仅 0.9m | 漂移方向 > 漂移大小 |
| 0042 | 高速公路 | 1170 | 79.6 km/h, 仿真隧道宿主 | 主演示轨迹 |

### 5.2 数据诚实声明

- **数据源**：KITTI raw dataset, oxts 通道, OXTS RT3000 GNSS+IMU, 10Hz, WGS-84, 卡尔斯鲁厄
- **无隧道**：156 条 KITTI 全量扫描（posmode==0 + 相机帧验证），无隧道——最长真实失锁 34.3s（0096, 树冠遮挡）
- **仿真诚实**：轨迹/航向/速度/加速度全真，唯一仿真是"GNSS 被拒止多久"——UI 界面显式标注
- **OXTS 非独立真值**：失锁期是 INS 桥接解, 非 RTK。DR 漂移指标是"同一套传感器上两种算法对比"

---

## 6. 测试体系

| 类型 | 数量 | 内容 |
|------|------|------|
| 单元测试 | 174 / 20 files | 数据管线全纯函数 + 车标轨道运动学门控 + 回放时钟 + fixture variant |
| 契约测试 | — | HERE 响应 schema 变更即红 |
| 回归锁定 | — | 实测漂移值锁定（0042@60s = 66.86m, 0042@30s mean = 1.19m） |
| 引擎定律 | — | R=180−h 用判别性取值（yaw=180）锁定 |
| 离线管线 | — | 全管线可离线复刻（fixture + derive 全纯函数） |

---

## 7. 从 POC 到产品的演进路径

### 7.1 云 API vs 车端 SDK

| 维度 | 云端 API（本 POC） | 车端 SDK（产品方向） |
|------|-------------------|---------------------|
| 适用场景 | 车队分析/后处理 | 实时导航 |
| 离线能力 | 无 | 有 |
| 时延 | 秒级 | 毫秒级 |
| 单次成本 | API 调用计费 | 一次性授权 |
| 隐私 | 数据上传云端 | 本地处理 |

### 7.2 计价梯队发现

| API | 计划层 | 能力 |
|-----|--------|------|
| Route Matching v8 (`/match/routelinks`) | Enterprise only（2025-03-15 起） | 逐点 linkId + confidence |
| Routing v8 `/import` | Base Plan | trace → matched route polyline, 偏差客户端自算 |

**POC 策略**：Base Plan 上用 `/import` 等效实现；Enterprise tier 的逐点置信度是向上销售卖点。

### 7.3 紧耦合升级

60s 边界是技术论证：串行 DR→MM 架构在 DR 漂移 >车道间距时失效。量产方案：
- Map-aided dead reckoning（路网几何约束 DR）
- Lane-level positioning（车道级定位 + 高精地图）
- 紧耦合 GNSS/IMU/Map 融合（ESKF/UKF）

---

## 8. 仓库结构

```
here-poc/
├── src/
│   ├── lib/                  数据管线（纯函数）
│   │   ├── gnssFeed.ts        退化 GNSS 流构建
│   │   ├── deadReckoning.ts   多速率航位推算
│   │   ├── hereRouterClient.ts HERE API 客户端
│   │   ├── hereLoader.ts      SDK 加载器 + 底图探测
│   │   ├── flexiblePolyline.ts Flexible Polyline 解码
│   │   ├── fixtureStore.ts    缓存 + Fixture 管理
│   │   ├── derive.ts          派生计算（偏差 + 车标轨道）
│   │   ├── matchedTrack.ts    运动学门控车标轨道
│   │   ├── geo.ts             地理计算（haversine/投影/方位）
│   │   ├── stats.ts           偏差统计
│   │   ├── playback.ts        回放时钟纯函数
│   │   └── markerInfo.ts       Marker 弹窗信息
│   ├── components/            UI 组件
│   │   ├── MapView.tsx         地图视图（HERE + SVG 兜底）
│   │   ├── SvgFallback.tsx     无底图 SVG 渲染
│   │   ├── StatsPanel.tsx      偏差统计面板
│   │   ├── StatsCharts.tsx     自绘 SVG 图表
│   │   ├── DeviationReplayChart.tsx  回放联动偏差曲线
│   │   ├── ReplayBar.tsx       回放控制条
│   │   └── SourceBadge.tsx     数据来源角标
│   ├── hooks/
│   │   └── usePlayback.ts      rAF 回放时钟 Hook
│   ├── __tests__/             171 个测试
│   ├── types.ts                类型定义
│   └── App.tsx                 主应用
├── public/
│   ├── sample/here/            KITTI 轨迹 JSON
│   └── fixtures/               HERE API 预录制响应
├── scripts/                    录制/截图脚本
├── docs/                       设计文档 + 截图 + 经验档案
└── data/                       KITTI 原始数据 + 分析脚本
```

---

## 9. 关键设计决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 匹配 API | Routing v8 `/import` 而非 Route Matching v8 | 后者 Enterprise-only, Base Plan 返回 429 |
| 偏差计算 | 客户端垂足投影 | `/import` 不返回逐点 linkId/confidence |
| 车标位置 | 匹配轨道弧长插值 | 垂足序列在 MM 碎片上逐帧闪跳 5-73m |
| 车标航向 | 轨道切线 | IMU heading 在退化数据集漂移 4→180° |
| 车标渲染 | DOM 叠层（播放中）/ HERE marker（暂停） | 播放时叠层消抖动，暂停时 marker 让用户自由操作 |
| 导航布局 | 134% 宿主高 + 单步 setLookAtData | 相机中心天然在容器 67%，避免两步调用致街道名抖动 |
| 地图旋转 | 引擎原生 `setLookAtData` | CSS 旋转放大引擎整像素重定位噪声 |
| 北向上 heading | 180（非 0） | 引擎定律 R=180−h, h=0 渲染南向上 |
| DR 速度源 | GNSS 位移速度 | 多普勒速度低卫星数时偏低/负值 |
| 更新门控 | numsats>6 && !noFix | 仿真隧道里卫星数照样高, 只看卫星数不漂移 |
| 缓存版本 | v4（随算法升级） | trackArcM 与旧轨道弧长表错位 → 强制重派生 |
| 生产构建 | keyless | Vite 把 VITE_* 烘进 JS bundle, 真 key 会泄漏到 dist |
