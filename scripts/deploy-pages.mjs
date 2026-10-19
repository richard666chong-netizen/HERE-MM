// Publish dist/ to the gh-pages branch for GitHub Pages ("Deploy from a branch").
// Usage: node scripts/deploy-pages.mjs [--no-push]   (--no-push: build + commit only)
import { execSync } from 'node:child_process'
import { rmSync, cpSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const WT = join(ROOT, '.gh-pages-worktree')
const noPush = process.argv.includes('--no-push')

const run = (cmd, opts = {}) => {
  console.log('> ' + cmd)
  execSync(cmd, { stdio: 'inherit', shell: 'bash', cwd: ROOT, ...opts })
}

if (!existsSync(join(ROOT, 'dist/index.html'))) {
  run('npm run build')
}

// Fresh (or reused) orphan worktree — keeps the main working tree untouched
if (existsSync(WT)) run(`git worktree remove --force "${WT}"`)
try { run('git worktree prune') } catch { /* ignore */ }
run(`git worktree add --orphan -b gh-pages "${WT}"`)

// Replace worktree content with the build output
for (const entry of readdirSync(WT)) {
  if (entry === '.git') continue
  rmSync(join(WT, entry), { recursive: true, force: true })
}
cpSync(join(ROOT, 'dist'), WT, { recursive: true })
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
