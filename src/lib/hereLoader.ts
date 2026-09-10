/** HERE Maps JS API v3.1 加载器：core → service → mapevents 顺序注入 script 标签。
 *  单例缓存：加载成功后重复调用共享同一 Promise（不重复注入）；
 *  任一脚本失败/超时则清空单例并 reject——后续调用可重试（超时重试入口）。 */

const SCRIPT_URLS = [
  'https://js.api.here.com/v3/3.1/mapsjs-core.js',
  'https://js.api.here.com/v3/3.1/mapsjs-service.js',
  'https://js.api.here.com/v3/3.1/mapsjs-mapevents.js',
]

let cached: Promise<unknown> | null = null

function injectScript(src: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script')
    const timer = window.setTimeout(() => {
      el.remove()
      reject(new Error(`HERE SDK load timeout: ${src}`))
    }, timeoutMs)
    el.src = src
    el.onload = () => {
      window.clearTimeout(timer)
      resolve()
    }
    el.onerror = () => {
      window.clearTimeout(timer)
      el.remove()
      reject(new Error(`HERE SDK load failed: ${src}`))
    }
    document.head.appendChild(el)
  })
}

/** 底图矢量瓦片端点（JS API 3.1 默认 vector 图层同源；2026-09-10 实测 200 + protobuf 数据）。
 *  取低缩放级别：瓦片小、全球必有——探测的是「这条链路通不通」，不是具体区域有没有数据。 */
const TILE_PROBE_URL = 'https://vector.hereapi.com/v2/vectortiles/base/mc/3/4/3/omv'

/** 探测底图链路是否可达。
 *
 *  为什么需要：「SDK 脚本加载成功」≠「瓦片能到达」。企业网/VPN 常只放行 js.api.here.com，
 *  瓦片请求静默失败的表现是**地图区一块白板、控制台零报错**（2026-09-10 用户实测：开 VPN 白板、
 *  关 VPN 正常）——既无兜底也无提示，只能靠猜。故在置 mapStatus='ok' 前显式探测一次，
 *  失败即落已有的 SVG 兜底路径。
 *
 *  探错也不白探：探针与 SDK 默认图层同源同 key，探通而图不通的窗口极窄。
 *  任何异常/超时都归为不可达——本函数不抛。 */
export async function probeBasemap(apikey: string, timeoutMs = 3000): Promise<boolean> {
  if (!apikey) return false
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${TILE_PROBE_URL}?apikey=${encodeURIComponent(apikey)}`, {
      signal: ctrl.signal,
    })
    return res.ok
  } catch {
    return false
  } finally {
    window.clearTimeout(timer)
  }
}

/** 加载 HERE SDK（apikey 在此仅做非空守卫——脚本 URL 本身不携带 key，key 在 H.service.Platform 初始化时使用）。 */
export function loadHereMaps(apikey: string, timeoutMs = 8000): Promise<unknown> {
  if (!apikey) return Promise.reject(new Error('HERE SDK load refused: apikey is empty'))
  if (cached) return cached
  cached = (async () => {
    for (const src of SCRIPT_URLS) await injectScript(src, timeoutMs)
    const H = (window as unknown as { H?: unknown }).H
    if (!H) throw new Error('HERE SDK load failed: window.H missing after scripts loaded')
    return H
  })().catch((err: unknown) => {
    cached = null // 失败清空单例，允许下次调用重试
    throw err
  })
  return cached
}
