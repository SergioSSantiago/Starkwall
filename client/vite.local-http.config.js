import { defineConfig } from 'vite'
import wasm from 'vite-plugin-wasm'

export default defineConfig({
  plugins: [wasm()],
  server: {
    https: false,
    hmr: false,
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['utils.js', 'spiralLayout.js', 'game.js'],
      thresholds: {
        lines: 99,
        functions: 99,
        statements: 99,
        branches: 95,
      },
    },
  },
})
