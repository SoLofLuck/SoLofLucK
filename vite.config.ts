import { copyFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// Because GitHub Pages is static hosting, going directly to a path that does not
// really exist (/1, say — the hidden preview path behind the "Stay Tuned" gate)
// normally returns its own 404 page. Instead we also copy index.html to
// dist/404.html — GitHub Pages serves that file for every unmatched path, so our
// app's JS loads on every path and makes the routing decision in src/main.tsx
// (Stay Tuned or the real app) in the browser itself.
function copyIndexTo404(): Plugin {
  return {
    name: 'copy-index-to-404',
    closeBundle() {
      const outDir = resolve(__dirname, 'dist')
      copyFileSync(resolve(outDir, 'index.html'), resolve(outDir, '404.html'))
    },
  }
}

// This site will be published at the root (/) of its own domain (solofluck.xyz
// or similar). If a custom domain is used on GitHub Pages, write that domain
// into public/CNAME; if you want to publish it under the repository name
// (/SoLofLuck/, say), update the base value accordingly.
export default defineConfig({
  base: '/',
  plugins: [
    react(),
    copyIndexTo404(),
    // The Solana libraries (@solana/web3.js, spl-token, wallet adapters) expect
    // Node's built-in modules (crypto, stream, buffer and so on) in the
    // browser; without them, they fail with a runtime error.
    nodePolyfills({
      include: ['crypto', 'stream', 'buffer', 'util', 'process'],
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    }),
  ],
  optimizeDeps: {
    // @solana/zk-sdk contains a WASM module built with wasm-bindgen's "bundler"
    // target; when the dev server's dependency pre-bundling (optimizeDeps)
    // re-wraps that WASM, it crashes with `__wbindgen_export_2`. The production
    // build (vite build) is fine; we exclude it from pre-bundling so dev works.
    exclude: ['@solana/zk-sdk'],
  },
})
