import { defineConfig } from 'vite';
import mkcert from 'vite-plugin-mkcert';
import basicSsl from '@vitejs/plugin-basic-ssl';
import wasm from 'vite-plugin-wasm';

const useMkcert = process.env.VITE_USE_MKCERT === 'true';
const useBasicSsl = process.env.VITE_USE_BASIC_SSL === 'true';
const useHttps = useMkcert || useBasicSsl;

export default defineConfig({
  // Cartridge/embedded wallets are more reliable over HTTPS in local dev.
  // mkcert is opt-in (trusted cert, may require sudo).
  // basicSsl keeps HTTPS available without sudo for Controller flows.
  plugins: [
    ...(useMkcert ? [mkcert()] : []),
    ...(!useMkcert && useBasicSsl ? [basicSsl()] : []),
    wasm(),
  ],
  server: {
    https: useHttps,
    // Desactivar HMR para evitar bucle de recargas (WebSocket falla y el navegador reintenta)
    hmr: false,
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['utils.js', 'spiralLayout.js'],
      thresholds: {
        lines: 99,
        functions: 99,
        statements: 99,
        branches: 95,
      },
    },
  },
});
