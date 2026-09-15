# Demo 模式导航视图设计文档（2026-09-12）

## 背景

Step6 交付后，demo 模式仅有「北向上 + 车标居中」的基础回放。本次迭代实现车机导航风格的双模式切换（北向上 / 车头向上），并解决 HERE SDK 在 WebGL 损坏环境下的渲染限制。

## 目标

1. **北向上模式**：地图不旋转，`setCenter` 跟随车标，车标图标烘焙 `compassDeg` 航向
2. **车头向上模式**：地图旋转使行驶方向朝上，车标固定在下 1/3 处（导航视角）
3. 两种模式都保留 HERE 底图瓦片（不退化到 SvgFallback）

## 技术约束与发现

### HERE SDK `setLookAtData({ heading })` 不可用

- **根因**：HERE Maps JS API 3.1 的 vector 图层依赖 Tangram WebGL 引擎。本机 WebGL 上下文虽存在（`chrome://gpu` 显示 Hardware accelerated），但 Tangram 内部 canvas 的 `gl.getExtension()` 返回 null，导致 `Scene.load()` 失败
- **后果**：`lookAtManipulator` 为 null，`setLookAtData({ heading })` 在 setTimeout 中静默失败（try-catch 无法捕获）
- **影响范围**：`setLookAtData({ heading })`、`getViewPort().setHeading()` 均走 `lookAtManipulator`，全部失效
- **未失效的 API**：`map.setCenter()`、`map.setZoom()` 不依赖 `lookAtManipulator`，正常工作

### HERE Raster Tile API v2 已废弃

- `H.service.MapTileService` 返回 `410 (Gone)`（`https://1.base.maps.ls.hereapi.com/maptile/2.1/maptile/newest/...`）
- 不能用 raster 图层替代 vector 图层

### 0106 轨迹开头静止段

- 0106 前 32 帧车几乎静止（位移 < 1e-8 度），位移方向为噪声
- `headingDeg` 约定与其他轨迹一致（KITTI yaw），通过全量逐帧比对确认：204/226 帧 yaw→compass 转换正确

## 解决方案

### 北向上模式

```
map.setCenter(coord)     // 跟随车标
map.setZoom(17)          // 固定缩放
icon = carIcon(compassDeg) // 图标烘焙航向
CSS: height: 134%, top: 0  // div 比容器高 34%，中心落在容器 67% = 下 1/3
```

### 车头向上模式（CSS transform 旋转）

HERE SDK 无法旋转地图，改用 CSS `transform` 旋转地图容器：

```
map.setCenter(coord)     // 跟随车标（地图内部仍北向上渲染）
map.setZoom(16)          // 降一级缩小比例尺
icon = carIcon(compassDeg) // 图标烘焙航向（与 CSS 旋转叠加 = 朝上）
CSS: height: 134%, top: 0, rotate(360-compassDeg deg) scale(2.3)
```

**原理**：
- `height: 134%`：地图 div 比容器高 34%，中心自然落在容器 67% 处 = 下 1/3（无需 translateY，避免顶部空白）
- `rotate(360-compassDeg)`：CSS 顺时针旋转地图，使行驶方向指向屏幕上方
- `scale(2.3)`：旋转后矩形对角线方向露出空白，需放大填充（16:9 宽屏最坏情况需 ~2.04 倍，2.3 留余量）
- 图标 `compassDeg` + CSS `rotate(360-compassDeg)` = 360° = 朝上（marker 跟随地图 div 旋转）

**scale 的副作用**：车标和 GNSS 散点会被 CSS 放大（56px → ~129px）。SVG 矢量图标不模糊，但视觉偏大。这是 CSS scale 方案的固有限制。

### 车标图标

- SVG 箭头 + 圆环，5° 分桶缓存（≤72 个）
- 支持 `size` 参数（heading-up 可用更小源尺寸补偿 scale 放大，但当前统一用 56px）
- `compassDeg` 计算公式：`yawToCompassDeg(yawDeg) = ((90 - yawDeg) % 360 + 360) % 360`

### 下 1/3 偏移

尝试过的方案及失败原因：
1. `setCenter({ lat: coord.lat + offset })` — 固定纬度偏移在不同轨迹/缩放下表现不一致
2. `getViewPort().getBounds()` — 也走 Tangram 崩溃路径，返回 null
3. CSS `translateY(16.67%)` — 车标位置正确，但北向上模式地图 div 往下推后顶部 16.67% 露出空白（按钮和图例区域无地图渲染）
4. **CSS `height: 134%` + `top: 0`** — 最终方案。地图 div 高度为容器的 134%，`top: 0` 顶部不留空。地图中心自然落在容器 67% 处 = 下 1/3。heading-up 时 `scale(2.3)` 本就放大填满，无需额外偏移

## 涉及文件

| 文件 | 改动 |
|------|------|
| `src/components/MapView.tsx` | heading-up 状态 + CSS transform 旋转 + 切换按钮 + `setCenter`/`setZoom` + `carIcon` size 参数 + `showMm` prop |
| `src/components/SvgFallback.tsx` | `showMm` prop + worldTransform 导航跟随 + HTML 车标叠层 + 100% 填充 |
| `src/App.tsx` | demo 模式隐藏 MM 箭头和 DR 路径（`showMm`/`drPath` 按 mode 传参） |
| `src/__tests__/mapview.test.tsx` | 车标测试改为 HTML overlay 断言 |

## 验收标准

- [x] 北向上：地图 `setCenter` 跟随车标，车标航向与轨迹一致，车标在下 1/3
- [x] 车头向上：地图 CSS 旋转使行驶方向朝上，车标朝上，无白边，车标在下 1/3
- [x] 四条轨迹（0093/0096/0106/0042）均正常
- [x] 切换不破坏对方模式状态
- [x] 131 tests 全绿，typecheck 通过

## 修订记录

- 2026-09-12 初稿。归纳当天所有调试历程：raster 410 Gone → vector WebGL 崩溃 → setLookAtData 失败 → setCenter 成功 → CSS transform 旋转方案 → scale 填白边 → translateY 下 1/3。
- 2026-09-12 修正：`translateY(16.67%)` 导致北向上模式顶部 16.67% 空白（按钮/图例区域无地图）。改为 `height: 134%` + `top: 0`：div 中心自然落在容器 67% = 下 1/3，顶部不留空。
