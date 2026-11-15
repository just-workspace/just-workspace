/**
 * Build all plugins that have frontend/page.vue.
 */

import { readdirSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))

const dirs = readdirSync(__dirname, { withFileTypes: true })
  .filter(d => d.isDirectory() && existsSync(resolve(__dirname, d.name, 'frontend/page.vue')))
  .map(d => d.name)

if (dirs.length === 0) {
  console.log('No plugins with frontend/page.vue found.')
  process.exit(0)
}

console.log(`Found ${dirs.length} plugin(s) to build: ${dirs.join(', ')}`)

for (const name of dirs) {
  execFileSync('node', [resolve(__dirname, 'build-plugin.mjs'), name], {
    stdio: 'inherit',
    cwd: __dirname,
  })
}

console.log(`Done — ${dirs.length} plugin(s) built.`)
