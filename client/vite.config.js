import { defineConfig } from 'vite';
import mkcert from 'vite-plugin-mkcert';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
  // Cartridge/embedded wallets are more reliable over HTTPS in local dev.
  plugins: [mkcert(), wasm()],
  server: {
    https: true,
    // Desactivar HMR para evitar bucle de recargas (WebSocket falla y el navegador reintenta)
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
});
