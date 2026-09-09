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
