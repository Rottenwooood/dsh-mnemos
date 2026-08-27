/**
 * Build the browser half of dsh-mnemos into lib/client.js.
 *
 * The module system serves this file at /plugins/dsh-mnemos/client.js and
 * expects the module-loader registration format:
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ...; return module.exports } })
 * Only `react` (a platform baseline external) is imported at runtime; every
 * DSH type is structural. esbuild resolves from the deepseek-harness store;
 * adjust ESBUILD_PATH for other machines.
 */
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const OUT = new URL('../lib/client.js', import.meta.url).pathname
const ID = 'dsh-mnemos'

// esbuild is not a dependency of this plugin (dev-time only); resolve it from
// the deepseek-harness workspace when this repo's own install lacks it.
const require = createRequire(import.meta.url)
const esbuildPath = process.env.ESBUILD_PATH
  ?? (() => {
    try {
      return require.resolve('esbuild')
    } catch {
      return '/home/c6h4o2/dev/deepseek-harness/node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/lib/main.js'
    }
  })()
const { build } = await import(esbuildPath)

mkdirSync(dirname(OUT), { recursive: true })

await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  loader: { '.tsx': 'tsx', '.ts': 'ts', '.js': 'js', '.css': 'text' },
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  outfile: OUT,
  write: true,
})

const body = readFileSync(OUT, 'utf8')
const wrapped = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(ID)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${body}
\t\treturn module.exports;
\t}
});
`
writeFileSync(OUT, wrapped)
console.log(`built ${OUT} (${wrapped.length} bytes)`)
