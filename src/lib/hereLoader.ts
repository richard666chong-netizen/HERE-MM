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
