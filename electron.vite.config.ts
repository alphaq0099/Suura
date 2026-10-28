import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

const fromRoot = (p: string): string => resolve(__dirname, p)

/**
 * Injects the production Content-Security-Policy into index.html.
 *
 * It cannot live in the HTML statically: Vite's dev server injects an inline
 * react-refresh preamble script, which a `script-src 'self'` policy blocks, and
 * weakening the policy with 'unsafe-inline' permanently to make dev work is the
 * wrong trade. So dev runs without a meta policy and the built app gets a strict
 * one. `apply: 'build'` is what keeps it out of dev.
 *
 * Every custom scheme the UI loads a resource from has to be listed here, or the
 * request is blocked before it ever reaches the protocol handler in the main
 * process (which then looks like a broken handler rather than a policy).
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: player-art:",
  "media-src 'self' player-media: player-stream: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

function productionCspPlugin(): Plugin {
  return {
    name: 'player-production-csp',
    apply: 'build',
    transformIndexHtml(html: string): string {
      return html.replace(
        '<!--CSP_PLACEHOLDER-->',
        `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`
      )
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@core': fromRoot('src/core'),
        '@engine': fromRoot('src/engine'),
        '@shared': fromRoot('src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': fromRoot('src/shared')
      }
    }
  },
  renderer: {
    plugins: [react(), productionCspPlugin()],
    resolve: {
      alias: {
        '@renderer': fromRoot('src/renderer/src'),
        '@shared': fromRoot('src/shared')
      }
    }
  }
})
