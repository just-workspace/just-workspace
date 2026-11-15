/**
 * Build a single plugin's frontend into a standalone ES module.
 * Usage: node build-plugin.mjs <plugin-folder-name>
 * Example: node build-plugin.mjs sample-notes
 *
 * Output: plugins/<name>/frontend/dist/plugin.mjs
 */

import { build } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'
import { readFile, writeFile, readdir, unlink } from 'fs/promises'

/**
 * Rollup plugin: replace `from "vue"` imports with window.__VUE__ global access.
 * This allows the plugin bundle to use the host app's Vue instance at runtime.
 */
function externalGlobals() {
  return {
    name: 'external-globals',
    renderChunk(code) {
      // Replace the ESM import statement with destructuring from the global
      return code.replace(
        /import\s*\{([^}]+)\}\s*from\s*["']vue["']\s*;?/g,
        'const {$1} = window.__VUE__;'
      )
    },
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url))

const pluginName = process.argv[2]
if (!pluginName) {
  console.error('Usage: node build-plugin.mjs <plugin-folder-name>')
  process.exit(1)
}

const pluginDir = resolve(__dirname, pluginName)
const entry = resolve(pluginDir, 'frontend/page.vue')

if (!existsSync(entry)) {
  console.error(`Not found: ${entry}`)
  process.exit(1)
}

console.log(`Building plugin: ${pluginName}`)

await build({
  root: pluginDir,
  plugins: [vue(), externalGlobals()],
  build: {
    lib: {
      entry,
      formats: ['es'],
      fileName: () => 'plugin.mjs',
    },
    outDir: resolve(pluginDir, 'frontend/dist'),
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      external: ['vue'],
      output: {
        globals: { vue: '__VUE__' },
        // Inline CSS into the JS bundle
        assetFileNames: '[name][extname]',
      },
    },
  },
  // Suppress logs
  logLevel: 'warn',
})

// Inline emitted CSS into plugin.mjs so the loader only needs the JS bundle.
const distDir = resolve(pluginDir, 'frontend/dist')
const cssFiles = (await readdir(distDir)).filter(f => f.endsWith('.css'))
if (cssFiles.length) {
  let css = ''
  for (const f of cssFiles) {
    css += await readFile(resolve(distDir, f), 'utf-8')
    await unlink(resolve(distDir, f))
  }
  const injector =
    `(function(){if(typeof document==='undefined')return;` +
    `var id='plugin-style-${pluginName}';if(document.getElementById(id))return;` +
    `var s=document.createElement('style');s.id=id;` +
    `s.textContent=${JSON.stringify(css)};` +
    `document.head.appendChild(s);})();\n`
  const jsPath = resolve(distDir, 'plugin.mjs')
  const js = await readFile(jsPath, 'utf-8')
  await writeFile(jsPath, injector + js)
  console.log(`  → inlined ${(css.length/1024).toFixed(1)} KB of CSS`)
}

console.log(`  → ${pluginName}/frontend/dist/plugin.mjs`)
