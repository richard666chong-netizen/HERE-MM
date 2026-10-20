// Publish dist/ to the gh-pages branch for GitHub Pages ("Deploy from a branch").
// Usage: node scripts/deploy-pages.mjs [--no-push]   (--no-push: build + commit only)
import { execSync } from 'node:child_process'
import { rmSync, cpSync, readdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const WT = join(ROOT, '.gh-pages-worktree')
const noPush = process.argv.includes('--no-push')

const run = (cmd, opts = {}) => {
  console.log('> ' + cmd)
  execSync(cmd, { stdio: 'inherit', shell: 'bash', cwd: ROOT, ...opts })
}

// Safety-pin guard（2026-10-20 事故）：.env.production 里非空的 VITE_HERE_KEY 会被 vite
// 烘进公开 bundle——正是该文件头部注释警告过的泄露路径（当日实测泄露并轮换）。部署前硬拦；
// 若确要部署可公开的 demo key（新建 + platform.here.com 域名限制），须显式 ALLOW_PUBLIC_KEY=1。
{
  const prod = readFileSync(join(ROOT, '.env.production'), 'utf8')
  const m = prod.match(/^VITE_HERE_KEY=(.*)$/m)
  if (m && m[1].trim() && !process.env.ALLOW_PUBLIC_KEY) {
    console.error(
      'REFUSING TO DEPLOY: .env.production pins a non-empty VITE_HERE_KEY — vite would bake it into the public bundle. ' +
        'Empty the value (fixture-mode deploy), or knowingly set ALLOW_PUBLIC_KEY=1 for a domain-restricted demo key.',
    )
    process.exit(1)
  }
}

// Always rebuild — a stale dist/ must never be deployed
run('npm run build')

// Fresh worktree — keeps the main working tree untouched.
if (existsSync(WT)) run(`git worktree remove --force "${WT}"`)
try { run('git worktree prune') } catch { /* ignore */ }
// Orphan-per-deploy：gh-pages 的提交历史是负担不是资产——2026-10-20 事故证明烘焙进 bundle
// 的秘密会随历史提交永久留存（线上 404 也能从 git 历史挖出）。每次部署单提交重建并
// force-push 覆盖远端历史，历史中永远只有当前这一个干净提交。
run(`git show-ref --verify --quiet refs/heads/gh-pages && git branch -D gh-pages || true`)
run(`git worktree add --orphan -b gh-pages "${WT}"`)

// Replace worktree content with the build output
for (const entry of readdirSync(WT)) {
  if (entry === '.git') continue
  rmSync(join(WT, entry), { recursive: true, force: true })
}
for (const entry of readdirSync(join(ROOT, 'dist'))) {
  cpSync(join(ROOT, 'dist', entry), join(WT, entry), { recursive: true })
}
run(`git -C "${WT}" add -A`)
run(`git -C "${WT}" commit -m "deploy: build ${new Date().toISOString().slice(0, 16).replace('T', ' ')}"`)

if (noPush) {
  console.log('done (no push): gh-pages branch committed in worktree, push with')
  console.log(`  git -C "${WT}" push -f origin gh-pages`)
} else {
  run(`git -C "${WT}" push -f origin gh-pages`)
  run(`git worktree remove --force "${WT}"`)
  console.log('deployed to gh-pages')
}
