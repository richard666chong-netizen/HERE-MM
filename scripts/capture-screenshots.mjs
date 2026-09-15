// Capture README screenshots against the CURRENT UI (header incl. Tunnel control).
// Runs its own vite dev server on :4199, drives it with system Edge/Chrome (no browser download).
// Usage: npm run shot
import { spawn, execSync } from 'node:child_process'
import { chromium } from 'playwright-core'

const PORT = 4199
const BASE = `http://localhost:${PORT}`

function waitServer(url, timeoutMs = 30000) {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    ;(async function poll() {
      try {
        const r = await fetch(url)
        if (r.ok) return resolve()
      } catch {}
      if (Date.now() - t0 > timeoutMs) return reject(new Error('vite dev server not ready'))
      setTimeout(poll, 500)
    })()
  })
}

// playwright-core ships no browsers; prefer the system Edge/Chrome channels on Windows.
async function launch() {
  const attempts = [
    () => chromium.launch({ channel: 'msedge', headless: true }),
    () => chromium.launch({ channel: 'chrome', headless: true }),
    () => chromium.launch({ headless: true }),
  ]
  let lastErr
  for (const a of attempts) {
    try {
      return await a()
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr
}

const vite = spawn('npm', ['run', 'dev', '--', '--port', String(PORT), '--strictPort'], {
  shell: true,
  stdio: 'ignore',
})

let browser
try {
  await waitServer(`${BASE}/`)
  browser = await launch()
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 2,
  })
  const page = await ctx.newPage()
  let tilesOk = true
  page.on('console', (m) => {
    if (m.text().includes('底图瓦片不可达')) tilesOk = false
  })

  await page.goto(`${BASE}/`, { waitUntil: 'load' })

  // Hero: highway drive 0042 + 30 s simulated GNSS denial, Analysis mode
  await page.selectOption('#drive-select', '2011_10_03_drive_0042')
  await page.selectOption('#tunnel-select', '30')
  await page.waitForFunction(() => /LIVE|MOCK/.test(document.body.innerText), { timeout: 45000 })
  await page.waitForTimeout(4000) // let basemap tiles settle
  await page.screenshot({ path: 'docs/img/analysis-view.png' })

  // Demo mode: replay UI + vehicle marker at start
  await page.getByRole('tab', { name: 'Demo' }).click()
  await page.waitForTimeout(1200)
  await page.screenshot({ path: 'docs/img/demo-mode.png' })

  const badge = await page.evaluate(() => document.body.innerText.match(/LIVE|MOCK/)?.[0] ?? 'none')
  const tunnel = await page.$eval('#tunnel-select', (el) => el.value)
  const drive = await page.$eval('#drive-select', (el) => el.value)
  console.log(`captured: drive=${drive} tunnel=${tunnel}s badge=${badge} tilesOk=${tilesOk}`)
} finally {
  try {
    await browser?.close()
  } catch {}
  try {
    execSync(`taskkill /PID ${vite.pid} /T /F`, { stdio: 'ignore' })
  } catch {}
}
